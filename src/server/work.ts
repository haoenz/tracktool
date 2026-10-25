import { exportEncoding } from "../shared/export-format.js";
import { XmlWorkers } from "../infrastructure/xml/client.js";
import { LocalKmlFiles } from "../infrastructure/kml-files.js";
import { geojson } from "../domain/geometry.js";
import { pointCount, MAX_POINTS } from "../domain/trackdata.js";
import type { SelectedTrack } from "../shared/map.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { memberName } from "../domain/archive.js";
import { AppError } from "../domain/errors.js";
import { publicConfig } from "../domain/config.js";
import { userStateDir } from "../infrastructure/paths.js";
import type { ConfigStore } from "../services/ports.js";
import { WorkRequestSchema } from "../shared/work.js";
import { SqliteTasks } from "../infrastructure/task-store.js";
import { UploadCleanup } from "../infrastructure/upload-cleanup.js";
import { ExportCleanup } from "../infrastructure/export-cleanup.js";
import { WorkFiles } from "../infrastructure/work-files.js";
import { BusinessRunner } from "../infrastructure/work-runner.js";
import { TaskQueue } from "../infrastructure/task-queue.js";
import { ArchiveClient } from "../infrastructure/archive/client.js";
import { EditPreviews } from "../infrastructure/archive/edit-previews.js";
import { trackRoutes } from "./tracks.js";
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
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let engine:
    | Promise<{
        queue: TaskQueue;
        files: WorkFiles;
        edits: EditPreviews;
        runner: BusinessRunner;
        exports: ExportCleanup;
      }>
    | undefined;
  const get = () =>
    (engine ??= (async () => {
      const config = await configStore.load();
      const stateDir = path.resolve(options?.stateDir ?? userStateDir());
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
        edits = new EditPreviews(path.join(stateDir, "tasks.sqlite3")),
        runner = new BusinessRunner(
          files,
          configStore,
          envKey,
          options?.archive,
          edits,
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
      const cleanup = new UploadCleanup(store, files);
      const exports = new ExportCleanup(store, files);
      const sweep = () => {
        try {
          cleanup.sweep();
        } catch (error) {
          app.log.warn({ err: error }, "Upload cleanup will retry");
        }
        try {
          exports.sweep();
        } catch (error) {
          app.log.warn({ err: error }, "Export cleanup will retry");
        }
      };
      sweep();
      cleanupTimer = setInterval(sweep, 1000);
      cleanupTimer.unref();
      return { queue, files, edits, runner, exports };
    })());
  if (options)
    app.addHook("onReady", async () => {
      await get();
    });
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    if (engine) {
      const value = await engine;
      clearInterval(cleanupTimer);
      await value.queue.close();
      value.edits.close();
    }
  });
  trackRoutes(app, async () => {
    const value = await get();
    return {
      queue: value.queue,
      edits: value.edits,
      file: await value.runner.trackDatabase(),
    };
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
  // Editing a map selection works on explicit staging copies, never on archive originals.
  app.post("/api/work/selection-copy", async (request) => {
    const input = z
      .object({
        archive: z.string().min(1).max(4096),
        tracks: z
          .array(
            z.object({
              entry: z.string().min(1).max(4096),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(request.body);
    const { files } = await get();
    const archive = await files.resolve(input.archive);
    const client = new ArchiveClient();
    let batch: Awaited<ReturnType<WorkFiles["upload"]>> | undefined;
    try {
      const names = new Set<string>();
      for (const track of input.tracks) {
        memberName(track.entry);
        const bytes = await client.readBytes(archive, track.entry);
        if (createHash("sha256").update(bytes).digest("hex") !== track.sha256)
          throw new AppError("USER_INPUT", "源轨迹已变化，请重新选择后再处理");
        let name = path.posix.basename(track.entry);
        let suffix = 1;
        while (names.has(name))
          name = `${++suffix}-${path.posix.basename(track.entry)}`;
        names.add(name);
        const uploaded = await files.upload(
          name,
          Readable.from([bytes]),
          batch?.id,
        );
        batch = {
          ...uploaded,
          files: [...(batch?.files ?? []), ...uploaded.files],
          bytes: (batch?.bytes ?? 0) + uploaded.bytes,
        };
      }
      return batch!;
    } catch (error) {
      if (batch) await files.cleanup(batch.id);
      throw error;
    } finally {
      await client.close();
    }
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
  app.post("/api/work/preview", async (request) => {
    const input = WorkRequestSchema.parse(request.body);
    if (
      ["archive:backup", "archive:rebuild"].includes(input.operation) &&
      input.output !== undefined
    )
      throw new AppError(
        "USER_INPUT",
        "网页导出使用临时文件，不接受服务端输出路径",
      );
    return (await get()).queue.preview(input);
  });
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
      { queue, files, exports } = await get(),
      task = queue.store.read(taskId(request.params));
    if (
      !task ||
      task.mode !== "apply" ||
      ["queued", "running"].includes(task.status) ||
      !task.output?.paths[index]
    )
      throw new AppError("USER_INPUT", "结果尚不可下载");
    if (task.exportsCleaned || task.downloadedFiles?.includes(index))
      throw new AppError("USER_INPUT", "临时导出文件已清理，请重新导出");
    const release = exports.hold(task);
    reply.raw.once("close", release);
    const file = await files.resolve(task.output.paths[index]!);
    if (!(await lstat(file)).isFile())
      throw new AppError("USER_INPUT", "结果文件已移动或清理");
    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file)).replaceAll("'", "%27")}`,
    );
    const stream = createReadStream(file);
    stream.once("error", release);
    reply.header("Cache-Control", "no-store");
    return reply
      .type(
        task.request.operation === "archive:backup"
          ? exportEncoding(task.request.options).contentType
          : "application/octet-stream",
      )
      .send(stream);
  });
  app.post("/api/work/tasks/:id/download-complete", async (request) => {
    const { index } = z
      .object({ index: z.number().int().nonnegative() })
      .strict()
      .parse(request.body);
    return (await get()).exports.complete(taskId(request.params), index);
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
  app.post("/api/work/settings", async () => {
    throw new AppError("FORBIDDEN", "服务配置只能通过后台配置或 CLI 修改");
  });
}
