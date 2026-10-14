import { XmlWorkers } from "../infrastructure/xml/client.js";
import { LocalKmlFiles } from "../infrastructure/kml-files.js";
import { geojson } from "../domain/geometry.js";
import { pointCount, MAX_POINTS } from "../domain/trackdata.js";
import type { SelectedTrack } from "../shared/map.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { AppError } from "../domain/errors.js";
import { DEFAULTS, publicConfig } from "../domain/config.js";
import type { ConfigStore } from "../services/ports.js";
import { WorkRequestSchema } from "../shared/work.js";
import { SqliteTasks } from "../infrastructure/task-store.js";
import { WorkFiles } from "../infrastructure/work-files.js";
import { BusinessRunner } from "../infrastructure/work-runner.js";
import { TaskQueue } from "../infrastructure/task-queue.js";
import { ArchiveClient } from "../infrastructure/archive/client.js";
export interface WorkOptions {
  stateDir?: string;
  roots?: string[];
  archive?: string;
}
export function workRoutes(
  app: FastifyInstance,
  configStore: ConfigStore,
  envKey?: string,
  options?: WorkOptions,
) {
  let engine: Promise<{ queue: TaskQueue; files: WorkFiles }> | undefined;
  const get = () =>
    (engine ??= (async () => {
      const config = await configStore.load();
      const stateDir = path.resolve(
        options?.stateDir ??
          path.join(
            path.dirname(
              (configStore as { path?: string }).path ??
                path.join(os.homedir(), ".config/tracktool/config.json"),
            ),
            "web",
          ),
      );
      const roots = [
        ...new Set(
          (
            options?.roots ?? [
              process.cwd(),
              options?.archive || String(config.archive_path || ""),
            ]
          )
            .filter(Boolean)
            .map((p) => path.resolve(p)),
        ),
      ];
      const files = new WorkFiles(stateDir, roots);
      await files.prepare();
      const store = new SqliteTasks(path.join(stateDir, "tasks.sqlite3")),
        runner = new BusinessRunner(
          files,
          configStore,
          envKey,
          options?.archive,
        ),
        queue = new TaskQueue(store, runner);
      await files.sweep(
        store
          .list()
          .filter((t) => ["running", "queued"].includes(t.status))
          .flatMap((t) => [
            ...t.request.inputs,
            t.request.output ?? "",
            t.request.archive ?? "",
          ]),
      );
      queue.start();
      return { queue, files };
    })());
  if (options)
    app.addHook("onReady", async () => {
      await get();
    });
  app.addHook("onClose", async () => {
    if (engine) await (await engine).queue.close();
  });
  app.get("/api/work/bootstrap", async () => ({
    roots: (await get()).files.roots,
    archive:
      options?.archive ?? String((await configStore.load()).archive_path ?? ""),
    config: publicConfig(await configStore.load(), envKey),
  }));
  app.get("/api/work/files", async (request) =>
    (await get()).files.list(
      z.object({ path: z.string().optional() }).parse(request.query).path,
    ),
  );
  app.addContentTypeParser(
    "application/octet-stream",
    (request, payload, done) => done(null, payload),
  );
  app.get("/api/work/uploads", async () => ({
    uploads: await (await get()).files.uploadList(),
  }));
  app.post("/api/work/uploads", async (request) => {
    const query = z
      .object({ name: z.string().min(1), id: z.string().optional() })
      .parse(request.query);
    return (await get()).files.upload(
      query.name,
      request.body as Readable,
      query.id,
    );
  });
  app.post("/api/work/uploads/:id/cleanup", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params),
      { files, queue } = await get();
    const directory = path.join(files.uploads, id);
    if (
      queue.store
        .list()
        .some(
          (t) =>
            ["queued", "running"].includes(t.status) &&
            [
              ...t.request.inputs,
              t.request.output ?? "",
              t.request.archive ?? "",
            ].some(
              (p) => p === directory || p.startsWith(directory + path.sep),
            ),
        )
    )
      throw new AppError("USER_INPUT", "此批次仍有排队或执行中的任务");
    await files.cleanup(id);
    return { ok: true };
  });
  app.get("/api/work/tasks", async () => ({
    tasks: (await get()).queue.store.list(),
  }));
  const taskId = (params: unknown) =>
    z.object({ id: z.string().uuid() }).parse(params).id;
  app.get("/api/work/tasks/:id", async (request) => {
    const task = (await get()).queue.store.read(taskId(request.params));
    if (!task) throw new AppError("USER_INPUT", "任务不存在");
    return (await get()).queue.store.public(task);
  });
  app.post("/api/work/preview", async (request) =>
    (await get()).queue.preview(WorkRequestSchema.parse(request.body)),
  );
  app.post("/api/work/tasks/:id/apply", async (request) =>
    (await get()).queue.apply(taskId(request.params)),
  );
  app.post("/api/work/tasks/:id/retry", async (request) =>
    (await get()).queue.retry(taskId(request.params)),
  );
  app.post("/api/work/tasks/:id/cancel", async (request) => {
    const { revision } = z
        .object({ revision: z.number().int().nonnegative() })
        .parse(request.body),
      { queue } = await get();
    return queue.store.public(
      queue.store.cancel(taskId(request.params), revision),
    );
  });
  app.get("/api/work/tasks/:id/download", async (request, reply) => {
    const { index } = z
        .object({ index: z.coerce.number().int().nonnegative() })
        .parse(request.query),
      { queue, files } = await get(),
      task = queue.store.read(taskId(request.params));
    if (
      !task ||
      task.mode !== "apply" ||
      ["queued", "running"].includes(task.status) ||
      !task.output?.paths[index]
    )
      throw new AppError("USER_INPUT", "结果尚不可下载");
    const file = await files.resolve(task.output.paths[index]!);
    if (!(await lstat(file)).isFile())
      throw new AppError("USER_INPUT", "结果文件已移动或清理");
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file)).replaceAll("'", "%27")}`,
    );
    return reply.type("application/octet-stream").send(createReadStream(file));
  });
  app.post("/api/work/tasks/:id/geometry", async (request, reply) => {
    const { queue, files } = await get(),
      task = queue.store.read(taskId(request.params));
    if (!task || ["queued", "running"].includes(task.status))
      throw new AppError("USER_INPUT", "请等待任务完成");
    const candidates =
      task.mode === "apply" ? (task.output?.paths ?? []) : task.request.inputs;
    const inputs: string[] = [];
    for (const p of candidates) {
      const source = await files.resolve(p);
      if ((await lstat(source)).isDirectory())
        inputs.push(
          ...(await files.regularPaths(source)).filter((n) =>
            n.toLowerCase().endsWith(".kml"),
          ),
        );
      else if (source.toLowerCase().endsWith(".kml")) inputs.push(source);
    }
    if (!inputs.length || inputs.length > 200)
      throw new AppError("USER_INPUT", "请选择 1–200 个 KML 结果查看地图");
    const xml = new XmlWorkers(),
      reader = new LocalKmlFiles(),
      tracks: SelectedTrack[] = [],
      cancel = new AbortController();
    let total = 0;
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) cancel.abort();
    });
    try {
      for (const file of [...new Set(inputs)]) {
        const source = await reader.read(file),
          data = (
            await xml.run(
              source.bytes,
              { kind: "tracks", source: file },
              cancel.signal,
            )
          ).tracks!,
          points = pointCount(data);
        total += points;
        if (total > MAX_POINTS)
          throw new AppError("USER_INPUT", "地图检查超过 200 万点，请缩小范围");
        tracks.push({
          entry: file,
          sha256: source.sha256,
          points,
          geojson: geojson(data),
        });
      }
      return { tracks };
    } finally {
      await xml.close();
    }
  });
  app.post("/api/work/catalog", async (request) => {
    const { archive } = z.object({ archive: z.string() }).parse(request.body),
      { files } = await get(),
      file = await files.resolve(archive);
    const client = new ArchiveClient();
    try {
      return {
        catalog: await client.catalog(file),
        status: (
          await client.execute({
            kind: "status",
            database:
              path.basename(file) === "archive.sqlite3"
                ? file
                : path.join(file, "archive.sqlite3"),
          })
        ).status,
      };
    } finally {
      await client.close();
    }
  });
  app.post("/api/work/settings", async (request) => {
    const { key, value } = z
      .object({
        key: z.enum(Object.keys(DEFAULTS) as [string, ...string[]]),
        value: z.string().max(8192),
      })
      .strict()
      .parse(request.body);
    const store = configStore as ConfigStore & {
      set?: (key: string, value: string, plan?: boolean) => Promise<unknown>;
    };
    if (!store.set) throw new AppError("FORBIDDEN", "当前配置是只读的");
    if (key === "archive_path" && value)
      await (await get()).files.resolve(value, false);
    if (
      key === "kml_backup_dir_name" &&
      (!value ||
        path.basename(value) !== value ||
        value === "." ||
        value === "..")
    )
      throw new AppError("USER_INPUT", "备份目录名必须是单个目录名称");
    await store.set(key, value);
    return { data: publicConfig(await configStore.load(), envKey) };
  });
}
