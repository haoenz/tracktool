import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { AppError, checkCancelled } from "../domain/errors.js";
import { TAGS as T } from "../domain/tags.js";
import { coordinate, gpsTags } from "../domain/media.js";
import { parseMediaTime, formatWall } from "../domain/media-time.js";
import { resolveApiKey } from "../domain/config.js";
import type { ConfigStore } from "../services/ports.js";
import type { WorkRunner } from "../services/work-ports.js";
import type { WorkRequest, WorkOutput } from "../shared/work.js";
import { WorkRequestSchema } from "../shared/work.js";
import { previewDeletion } from "./archive/deletion.js";
import type { TaskEvent, BatchResult } from "../shared/contracts.js";
import { createContext } from "../services/context.js";
import { KmlService } from "../services/kml-service.js";
import { MediaService } from "../services/media-service.js";
import { ArchiveClient } from "./archive/client.js";
import { readZip } from "./archive/zip.js";
import { XmlWorkers } from "./xml/client.js";
import { LocalKmlFiles } from "./kml-files.js";
import { LocalMediaFiles } from "./media-files.js";
import { ExifMetadata } from "./metadata.js";
import { GoogleElevation } from "./elevation.js";
import { GoogleGeocode } from "./geocode.js";
import { WorkFiles } from "./work-files.js";
import { EditPreviews } from "./archive/edit-previews.js";
import { databasePath } from "./archive/database.js";
const archiveNeeded = (op: string) =>
  op.startsWith("archive:") ||
  ["kml:merge", "exif:geotag", "exif:repair", "exif:repair-vid"].includes(op);
class ScopedMediaFiles extends LocalMediaFiles {
  constructor(private readonly policy: WorkFiles) {
    super();
  }
  async preflight(...args: Parameters<LocalMediaFiles["preflight"]>) {
    for (const plan of args[0])
      for (const action of plan) {
        await this.policy.resolve(action.file, false);
        if ("output" in action) await this.policy.resolve(action.output, false);
      }
    return super.preflight(...args);
  }
  async moveFolder(file: string, folder: string, plan: boolean) {
    await this.policy.resolve(
      path.join(path.dirname(file), folder, path.basename(file)),
      false,
    );
    return super.moveFolder(file, folder, plan);
  }
  async mkdir(file: string) {
    await this.policy.resolve(file, false);
    return super.mkdir(file);
  }
  async renameDirectory(source: string, target: string) {
    await this.policy.resolve(source);
    await this.policy.resolve(target, false);
    return super.renameDirectory(source, target);
  }
}
class ScopedKmlFiles extends LocalKmlFiles {
  constructor(private readonly policy: WorkFiles) {
    super();
  }
  async write(...args: Parameters<LocalKmlFiles["write"]>) {
    await this.policy.resolve(args[0], false);
    return super.write(...args);
  }
}
export class BusinessRunner implements WorkRunner {
  constructor(
    readonly files: WorkFiles,
    private readonly config: ConfigStore,
    private readonly envKey?: string,
    private readonly defaultArchive?: string,
    private readonly edits?: EditPreviews,
  ) {}
  async normalize(request: WorkRequest): Promise<WorkRequest> {
    const value = WorkRequestSchema.parse(request);
    if (value.operation.startsWith("track:")) {
      if (value.inputs.length || value.output)
        throw new AppError("USER_INPUT", "轨迹编辑只接受库内固定引用");
      if (
        value.operation === "track:preview"
          ? !value.options.trackPreview
          : !value.options.trackApply
      )
        throw new AppError("USER_INPUT", "缺少编辑请求");
      value.archive = await this.trackDatabase();
      return value;
    }
    value.inputs = await Promise.all(
      [...new Set(value.inputs)].map((p) => this.files.resolve(p)),
    );
    if (archiveNeeded(value.operation)) {
      const archive =
        value.archive ||
        this.defaultArchive ||
        String((await this.config.load()).archive_path || "");
      if (!archive) throw new AppError("USER_INPUT", "请选择归档目录");
      value.archive = await this.files.resolve(
        archive,
        !["archive:init", "archive:import-zip"].includes(value.operation),
      );
      if (path.basename(value.archive) === "archive.sqlite3")
        value.archive = path.dirname(value.archive);
    } else delete value.archive;
    if (value.output)
      value.output = await this.files.resolve(value.output, false);
    if (
      (value.operation.startsWith("kml:") ||
        value.operation.startsWith("exif:") ||
        ["archive:push", "archive:import-zip"].includes(value.operation)) &&
      !value.inputs.length
    )
      throw new AppError("USER_INPUT", "请选择输入文件或目录");
    if (
      ["exif:group", "exif:repair-vid"].includes(value.operation) &&
      (value.inputs.length !== 1 ||
        !(await lstat(value.inputs[0]!)).isDirectory())
    )
      throw new AppError("USER_INPUT", "此操作需要选择一个媒体目录");
    if (value.operation === "kml:merge" && !value.output)
      throw new AppError("USER_INPUT", "合并轨迹需要指定输出文件");
    if (["archive:download", "archive:delete"].includes(value.operation)) {
      if (
        !value.options.name &&
        !value.options.entryId &&
        !value.options.deletion
      )
        throw new AppError("USER_INPUT", "请选择轨迹");
      if (value.operation === "archive:delete") {
        if (value.output)
          throw new AppError("USER_INPUT", "删除操作不生成下载文件");
        if (!value.options.deletion) {
          const plan = previewDeletion(
            path.join(value.archive!, "archive.sqlite3"),
            {
              name: value.options.name,
              entry_id: value.options.entryId,
              category: value.options.category,
            },
          );
          value.options.deletion = {
            archive_id: plan.archive_id,
            expected: plan.expected,
            request_key: randomUUID(),
          };
        }
      } else {
        value.output ??= path.join(this.files.uploads, randomUUID());
        const relative = path.relative(this.files.uploads, value.output);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
          throw new AppError("FORBIDDEN", "网页下载只能写入受管暂存目录");
        if (value.options.deletion)
          throw new AppError("USER_INPUT", "下载不接受删除参数");
      }
    }
    if (value.operation === "kml:set-tag" && !value.options.tag)
      throw new AppError("USER_INPUT", "请选择活动标签");
    if (
      ["kml:split", "kml:prune"].includes(value.operation) &&
      !value.options.auto &&
      !value.options.points?.length
    )
      throw new AppError("USER_INPUT", "请输入处理点或启用自动检测");
    if (
      value.operation === "exif:shift-altitude" &&
      value.options.delta === undefined
    )
      throw new AppError("USER_INPUT", "请输入海拔偏移量");
    if (["archive:push", "kml:merge"].includes(value.operation)) {
      const backupName = String(
        (await this.config.load()).kml_backup_dir_name || "Backup",
      );
      if (
        path.basename(backupName) !== backupName ||
        backupName === "." ||
        backupName === ".."
      )
        throw new AppError("USER_INPUT", "备份目录名必须是单个目录名称");
      await this.files.resolve(path.join(value.archive!, backupName), false);
    }
    return value;
  }
  async fingerprint(
    request: WorkRequest,
    signal: AbortSignal,
  ): Promise<string> {
    // Resolve again after queueing: symlink swaps cannot expand accessible paths.
    await this.normalize(request);
    const keys = new Set(request.inputs);
    if (request.output) {
      keys.add(request.output);
      keys.add(path.dirname(request.output));
    }
    for (const input of request.inputs) {
      keys.add(path.dirname(input));
      if ((await lstat(input)).isDirectory()) {
        for (const file of await this.files.regularPaths(input)) keys.add(file);
        if (request.operation === "exif:repair-vid")
          for (const folder of ["VID", "VID_original"]) {
            const child = path.join(input, folder);
            keys.add(child);
            for (const file of await this.files.regularPaths(child))
              keys.add(file);
          }
      }
    }
    const values: unknown[] = [];
    for (const file of [...keys].sort()) {
      checkCancelled(signal);
      if (/archive\.sqlite3(?:-wal|-shm)?$/.test(file)) continue;
      values.push([file, await this.files.fileSignature(file, signal)]);
    }
    if (request.archive) {
      const dbfile = path.join(request.archive, "archive.sqlite3");
      let database: Database.Database | undefined;
      try {
        database = new Database(dbfile, {
          readonly: true,
          fileMustExist: true,
        });
        if (request.operation === "archive:recover")
          for (const row of database
            .prepare("SELECT source,target FROM file_operations")
            .all() as { source: string | null; target: string }[]) {
            if (row.source) await this.files.resolve(row.source, false);
            await this.files.resolve(row.target, false);
          }
        values.push([
          "archive",
          database.pragma("user_version", { simple: true }),
          database.prepare("SELECT * FROM archive_meta").get(),
          database.prepare("SELECT * FROM file_operations ORDER BY id").all(),
        ]);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (!["archive:init", "archive:import-zip"].includes(request.operation))
          throw new AppError(
            "USER_INPUT",
            "无法读取归档，请检查目录或先显式升级数据库",
            { cause: error },
          );
        values.push([
          "archive",
          await this.files.fileSignature(dbfile, signal),
        ]);
      } finally {
        database?.close();
      }
    }
    const config = await this.config.load();
    return createHash("sha256")
      .update(
        JSON.stringify([
          request,
          values,
          config,
          resolveApiKey(config, this.envKey),
        ]),
      )
      .digest("hex");
  }
  async run(
    request: WorkRequest,
    mode: "plan" | "apply",
    signal: AbortSignal,
    report: (event: TaskEvent) => void,
  ): Promise<{ output: WorkOutput; result?: BatchResult }> {
    if (request.operation.startsWith("track:")) {
      if (!this.edits) throw new AppError("USER_INPUT", "编辑工作流尚未初始化");
      const file = await this.trackDatabase();
      if (request.operation === "track:preview") {
        const p = request.options.trackPreview!;
        return {
          output: {
            paths: [],
            data: await this.edits.create(file, p.id, p.request, signal),
          },
        };
      }
      return {
        output: {
          paths: [],
          data: this.edits.apply(file, request.options.trackApply!, signal),
          committed: true,
        },
      };
    }
    const config = await this.config.load(),
      xml = new XmlWorkers(),
      archive = new ArchiveClient(),
      backend = new ExifMetadata(
        undefined,
        30_000,
        String(config.output_filters || ""),
        (message) => report({ type: "log", level: "WARNING", message }),
      ),
      mediaFiles = new ScopedMediaFiles(this.files),
      elevation = new GoogleElevation();
    const ctx = createContext({ config, mode, signal, report, xml }),
      kml = new KmlService(
        new ScopedKmlFiles(this.files),
        xml,
        archive,
        elevation,
      ),
      media = new MediaService(
        backend,
        mediaFiles,
        elevation,
        new GoogleGeocode(),
        archive,
      );
    const o = request.options,
      input = request.inputs,
      first = input[0]!,
      directory = request.archive!,
      database = directory ? path.join(directory, "archive.sqlite3") : "",
      backup = directory
        ? path.join(directory, String(config.kml_backup_dir_name || "Backup"))
        : "",
      key = resolveApiKey(config, this.envKey),
      output: WorkOutput = { paths: [] };
    let result: BatchResult | undefined;
    const mediaOptions = {
      overwrite: o.overwrite,
      parallel: o.parallel,
      failedFolder: o.failedFolder,
      force: o.force,
      verify: o.verify,
      multiday: o.multiday,
      maxSeconds: o.maxSeconds,
      maxDistance: o.maxDistance,
    };
    const conversion = {
      ...mediaOptions,
      output: request.output,
      offset: o.offset,
      policy: o.policy,
      source: o.source,
      make: o.make,
      model: o.model,
    };
    const paths = new Set<string>();
    const kmlInputs = async () => {
      const values: string[] = [];
      for (const name of input) {
        if ((await lstat(name)).isDirectory())
          values.push(
            ...(await readdir(name, { withFileTypes: true }))
              .filter(
                (e) => e.isFile() && e.name.toLowerCase().endsWith(".kml"),
              )
              .map((e) => path.join(name, e.name)),
          );
        else values.push(name);
      }
      return values.sort();
    };
    const mediaInput = input.length === 1 ? first : input;
    try {
      checkCancelled(signal);
      report({
        type: "log",
        level: "INFO",
        message: `${mode === "plan" ? "预览" : "执行"} ${request.operation}；输入 ${input.length} 项`,
      });
      if (request.operation.startsWith("archive:")) {
        const kind = request.operation.slice(8);
        if (kind === "push")
          result = await kml.push(
            ctx,
            await kmlInputs(),
            database,
            backup,
            !o.keep,
            o.category,
          );
        else if (kind === "init" || kind === "import-zip") {
          if (mode === "plan") {
            try {
              await lstat(path.join(directory, "archive.sqlite3"));
              throw new AppError("USER_INPUT", "目标目录已经存在归档数据库");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            if (kind === "import-zip") await readZip(first, () => {});
          }
          output.data = await kml.archiveOperation(ctx, {
            kind: "init",
            directory,
            ...(kind === "import-zip" ? { zip: first } : {}),
          });
        } else if (kind === "download") {
          const value = await kml.archiveOperation(ctx, {
            kind: "download",
            database,
            name: o.name,
            entry_id: o.entryId,
            category: o.category,
            version_id: o.versionId,
            output: request.output!,
          });
          output.data = value;
          value.paths?.forEach((p) => paths.add(p));
        } else if (kind === "delete") {
          if (!o.deletion)
            throw new AppError("USER_INPUT", "删除需要固定的预览引用");
          output.data = await kml.archiveOperation(
            ctx,
            mode === "plan"
              ? {
                  kind: "delete-preview",
                  database,
                  entry_id: o.deletion.expected.entry_id,
                }
              : { kind: "delete", database, request: o.deletion },
          );
        } else if (kind === "backup") {
          const target = request.output || path.join(directory, "Archive.zip");
          output.data = await kml.archiveOperation(ctx, {
            kind: "backup",
            database,
            output: target,
          });
          paths.add(target);
        } else if (kind === "rebuild") {
          const target = request.output || directory;
          output.data = await kml.archiveOperation(ctx, {
            kind: "rebuild",
            database,
            output: target,
          });
          for (const category of ["Default", "Train", "Flight"])
            for (const suffix of [".kml", ".Mobile.kml"])
              paths.add(path.join(target, category + suffix));
        } else
          output.data = await kml.archiveOperation(ctx, {
            kind: kind as "status" | "recover" | "migrate",
            database,
          });
      } else if (request.operation.startsWith("kml:")) {
        const files = await kmlInputs();
        if (request.operation === "kml:merge") {
          await kml.merge(
            ctx,
            files,
            request.output!,
            database,
            backup,
            !!o.keep,
            !!o.connected,
            [
              database,
              path.join(directory, "Archive.zip"),
              path.join(directory, "archive.json"),
              ...["Default", "Train", "Flight"].flatMap((c) =>
                [".kml", ".Mobile.kml"].map((ext) =>
                  path.join(directory, c + ext),
                ),
              ),
            ],
          );
          paths.add(request.output!);
        } else {
          const rows: unknown[] = [];
          result = await kml.batch(ctx, files, async (file) => {
            const stem = path.basename(file, path.extname(file));
            if (request.operation === "kml:type") {
              const value = await kml.content(ctx, file);
              rows.push({
                file,
                category: value.category,
                tag: value.content.tag,
              });
              return;
            }
            if (request.operation === "kml:fill-altitude") {
              await kml.fillAltitude(ctx, file, key);
              paths.add(file);
              return;
            }
            const operation =
              request.operation === "kml:set-tag"
                ? { kind: "set-tag" as const, tag: o.tag!, create: !!o.create }
                : request.operation === "kml:split"
                  ? {
                      kind: "split" as const,
                      stem,
                      points: o.points ?? [],
                      auto: !!o.auto,
                      gapSeconds: o.gapSeconds ?? 300,
                      gapMeters: o.gapMeters ?? 500,
                    }
                  : request.operation === "kml:prune"
                    ? {
                        kind: "prune" as const,
                        stem,
                        points: o.points ?? [],
                        auto: !!o.auto,
                        speedMps: o.speedMps ?? 30,
                        jumpMeters: o.jumpMeters ?? 100,
                        returnMeters: o.returnMeters ?? 30,
                        maxSeconds: o.maxSeconds ?? 120,
                      }
                    : undefined;
            if (!operation)
              throw new AppError("USER_INPUT", "不支持的轨迹操作");
            const target = request.output;
            if (target && files.length > 1)
              throw new AppError(
                "USER_INPUT",
                "单个输出路径只能用于单个输入文件",
              );
            for (const p of await kml.edit(ctx, file, operation, target))
              paths.add(p);
          });
          if (rows.length) output.data = rows;
        }
      } else {
        switch (request.operation) {
          case "exif:info": {
            const rows: unknown[] = [];
            result = await kml.batch(
              ctx,
              (await mediaFiles.discover(mediaInput)).map((f) => f.path),
              async (file) => {
                const tags = await backend.read(
                    file,
                    [...T.POSITION_TAGS, T.MAKE, T.MODEL, ...T.VIDEO_TIME_TAGS],
                    signal,
                  ),
                  time = parseMediaTime(tags);
                rows.push({
                  file,
                  timestamp: time
                    ? formatWall(time.wall, "-") + time.offset
                    : null,
                  tags,
                });
              },
            );
            output.data = rows;
            break;
          }
          case "exif:show-missing": {
            const value = await media.missing(
              ctx,
              mediaInput,
              o.missingTags ?? [T.POSITION, T.ALTITUDE],
              mediaOptions,
            );
            result = value.batch;
            output.data = value.rows;
            break;
          }
          case "exif:set":
            result = await media.set(
              ctx,
              mediaInput,
              {
                ...gpsTags(
                  o.position ? coordinate(o.position) : undefined,
                  o.altitude,
                ),
                ...(o.make ? { [T.MAKE]: o.make } : {}),
                ...(o.model ? { [T.MODEL]: o.model } : {}),
                ...o.tags,
              },
              mediaOptions,
            );
            break;
          case "exif:shift-time":
            result = await media.shiftTime(
              ctx,
              mediaInput,
              o.by,
              o.offset,
              mediaOptions,
            );
            break;
          case "exif:shift-altitude":
            result = await media.shiftAltitude(
              ctx,
              mediaInput,
              o.delta!,
              mediaOptions,
            );
            break;
          case "exif:geotag":
            result = await media.geotag(
              ctx,
              mediaInput,
              database,
              mediaOptions,
            );
            break;
          case "exif:fill-altitude":
            result = await media.fillAltitude(
              ctx,
              mediaInput,
              key,
              mediaOptions,
            );
            break;
          case "exif:set-location":
            result = await media.setLocation(
              ctx,
              mediaInput,
              key,
              o.language ?? "en",
              mediaOptions,
            );
            break;
          case "exif:to-mp4":
            result = await media.convert(ctx, mediaInput, conversion);
            break;
          case "exif:group":
            result = await media.group(ctx, first);
            break;
          case "exif:repair":
            result = await media.repair(
              ctx,
              mediaInput,
              database,
              key,
              mediaOptions,
            );
            break;
          case "exif:repair-vid":
            result = await media.repairVideo(
              ctx,
              first,
              database,
              key,
              conversion,
            );
            break;
        }
        // Preserve business action previews as structured data for the confirmation screen.
        const mediaResult = result as
          (BatchResult & { plans?: unknown }) | undefined;
        if (mediaResult?.plans) output.data = mediaResult.plans;
        if (result)
          for (const item of result.items)
            if (item.status !== "failed") paths.add(item.path);
        if (mediaResult?.plans && Array.isArray(mediaResult.plans))
          for (const plan of mediaResult.plans)
            if (Array.isArray(plan))
              for (const action of plan)
                if (
                  action &&
                  typeof action === "object" &&
                  "output" in action &&
                  typeof action.output === "string"
                )
                  paths.add(action.output);
        if (
          request.operation === "exif:repair" ||
          request.operation === "exif:repair-vid"
        )
          for (const item of result?.items ?? [])
            if (item.status !== "failed")
              paths.add(
                path.join(
                  path.dirname(item.path),
                  "GoogleAltOK",
                  path.basename(item.path),
                ),
              );
      }
      if (mode === "plan" && request.operation.startsWith("kml:"))
        for (const target of paths) {
          if (input.includes(target)) continue;
          // Directory inputs may contain the in-place source; other occupied outputs are conflicts.
          if (
            input.some((p) => path.dirname(target) === p) &&
            !["kml:split", "kml:prune", "kml:merge"].includes(request.operation)
          )
            continue;
          if (["kml:set-tag", "kml:fill-altitude"].includes(request.operation))
            continue;
          try {
            await lstat(target);
            throw new AppError("USER_INPUT", `输出已存在：${target}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      output.paths =
        mode === "apply"
          ? (
              await Promise.all(
                [...paths].map(async (p) => {
                  try {
                    const resolved = await this.files.resolve(p);
                    return (await lstat(resolved)).isFile()
                      ? resolved
                      : undefined;
                  } catch {
                    return undefined;
                  }
                }),
              )
            ).filter((p): p is string => !!p)
          : [...paths];
      return {
        output,
        result: result
          ? { items: result.items, exitCode: result.exitCode }
          : undefined,
      };
    } finally {
      await backend.close();
      await archive.close();
      await xml.close();
    }
  }
  async trackDatabase() {
    const configured =
      this.defaultArchive ||
      String((await this.config.load()).archive_path || "");
    if (!configured) throw new AppError("USER_INPUT", "未配置轨迹库");
    return databasePath(await this.files.resolve(configured));
  }
}
