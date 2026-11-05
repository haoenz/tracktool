import path from "node:path";
import { lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { AppError, checkCancelled } from "../domain/errors.js";
import { resolveApiKey, tagMap } from "../domain/config.js";
import type { ConfigStore } from "../services/ports.js";
import { WorkRequestSchema, type WorkRequest } from "../shared/work.js";
import { previewDeletion } from "./archive/deletion.js";
import { databasePath } from "./archive/database.js";
import type { WorkFiles } from "./work-files.js";

const archiveNeeded = (op: string) =>
  op.startsWith("archive:") || op === "kml:merge";

/** Validation, path resolution and fingerprints for work requests. */
export class WorkRequestInspector {
  constructor(
    readonly files: WorkFiles,
    private readonly config: ConfigStore,
    private readonly envKey?: string,
    private readonly defaultArchive?: string,
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
    if (value.options.importFiles) {
      if (value.operation !== "archive:push")
        throw new AppError("USER_INPUT", "逐文件设置仅适用于轨迹入库");
      const tags = tagMap(await this.config.load());
      const seen = new Set<string>();
      for (const item of value.options.importFiles) {
        item.path = await this.files.resolve(item.path);
        if (!value.inputs.includes(item.path) || seen.has(item.path))
          throw new AppError(
            "USER_INPUT",
            "逐文件设置必须对应本次上传的文件，且不能重复",
          );
        if (item.tag !== undefined && !tags.has(item.tag))
          throw new AppError("USER_INPUT", `未知活动标签：${item.tag}`);
        seen.add(item.path);
      }
    }
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
    if (["archive:backup", "archive:rebuild"].includes(value.operation))
      value.output = await this.files.exportOutput(
        value.operation === "archive:backup",
        value.output,
        value.options,
      );
    else if (value.output)
      value.output = await this.files.resolve(value.output, false);
    if (
      (value.operation.startsWith("kml:") ||
        ["archive:push", "archive:import-zip"].includes(value.operation)) &&
      !value.inputs.length
    )
      throw new AppError("USER_INPUT", "请选择输入文件或目录");
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
    if (value.operation === "archive:push") value.options.keep = true;
    if (value.operation === "kml:merge" && value.options.keep === false) {
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
    // Only explicitly selected directories are scanned recursively; their
    // parents are watched one level deep so unrelated sibling writes (output,
    // staging) do not invalidate a preview.
    const keys = new Map<string, boolean>();
    const add = (value: string, deep = false) =>
      keys.set(value, keys.get(value) === true || deep);
    for (const input of request.inputs) {
      add(path.dirname(input));
      if ((await lstat(input)).isDirectory()) {
        add(input, true);
        for (const file of await this.files.regularPaths(input)) add(file);
      } else add(input);
    }
    if (request.output) {
      add(request.output);
      add(path.dirname(request.output));
    }
    const values: unknown[] = [],
      hashes = new Map<string, string>();
    for (const file of [...keys.keys()].sort()) {
      checkCancelled(signal);
      if (/archive\.sqlite3(?:-wal|-shm)?$/.test(file)) continue;
      values.push([
        file,
        await this.files.fileSignature(
          file,
          signal,
          hashes,
          keys.get(file) === true,
        ),
      ]);
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
          await this.files.fileSignature(dbfile, signal, hashes),
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

  async trackDatabase() {
    const configured =
      this.defaultArchive ||
      String((await this.config.load()).archive_path || "");
    if (!configured) throw new AppError("USER_INPUT", "未配置轨迹库");
    return databasePath(await this.files.resolve(configured));
  }
}
