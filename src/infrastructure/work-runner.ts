import Database from "better-sqlite3";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { entryName, filenameDate } from "../domain/archive.js";
import { parseBool, resolveApiKey, tagMap } from "../domain/config.js";
import { AppError, checkCancelled, errorInfo } from "../domain/errors.js";
import { createContext } from "../services/context.js";
import { KmlService } from "../services/kml-service.js";
import type { ConfigStore } from "../services/ports.js";
import type { WorkRunner } from "../services/work-ports.js";
import type { BatchResult, TaskEvent } from "../shared/contracts.js";
import type { ImportItem, WorkOutput, WorkRequest } from "../shared/work.js";
import { ArchiveClient } from "./archive/client.js";
import { databasePath } from "./archive/database.js";
import { EditPreviews } from "./archive/edit-previews.js";
import { fillEndpointLocations } from "./archive/endpoint-locations.js";
import { readZip } from "./archive/zip.js";
import { GoogleElevation } from "./elevation.js";
import { GoogleGeocode } from "./geocode.js";
import { ImportPreviewCache } from "./import-preview-cache.js";
import { LocalKmlFiles } from "./kml-files.js";
import { WorkFiles } from "./work-files.js";
import { WorkRequestInspector } from "./work-request.js";
import { XmlWorkers } from "./xml/client.js";
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
  private readonly importPreviews = new ImportPreviewCache();
  private readonly inspector: WorkRequestInspector;
  constructor(
    readonly files: WorkFiles,
    private readonly config: ConfigStore,
    private readonly envKey?: string,
    defaultArchive?: string,
    private readonly edits?: EditPreviews,
  ) {
    this.inspector = new WorkRequestInspector(
      files,
      config,
      envKey,
      defaultArchive,
    );
  }
  normalize(request: WorkRequest): Promise<WorkRequest> {
    return this.inspector.normalize(request);
  }
  fingerprint(request: WorkRequest, signal: AbortSignal): Promise<string> {
    return this.inspector.fingerprint(request, signal);
  }
  private async fillImportedLocations(
    database: string,
    entries: string[],
    xml: XmlWorkers,
    key: string,
    signal: AbortSignal,
    report: (event: TaskEvent) => void,
  ) {
    if (!entries.length) return;
    report({
      type: "log",
      level: "INFO",
      message: `正在补全 ${entries.length} 条轨迹的起终点行政区`,
    });
    if (!key) {
      report({
        type: "log",
        level: "WARNING",
        message: "未配置 Google API key，已跳过起终点行政区补全",
      });
      return;
    }
    try {
      const summary = await fillEndpointLocations(
        database,
        xml,
        new GoogleGeocode(),
        key,
        signal,
        {
          entries,
          onProgress: (value) => {
            if (typeof value.error === "string")
              report({
                type: "log",
                level: "WARNING",
                message: `起终点行政区补全失败：${value.error}`,
              });
          },
        },
      );
      report({
        type: "log",
        level: "INFO",
        message: `起终点行政区补全完成：保存 ${summary.saved} 个端点，复用 ${summary.reused} 个，失败 ${summary.failed} 条轨迹`,
      });
    } catch (error) {
      report({
        type: "log",
        level: "WARNING",
        message:
          error instanceof AppError && error.code === "CANCELLED"
            ? "起终点行政区补全已取消"
            : `起终点行政区补全失败，轨迹已正常入库：${error instanceof Error ? error.message : String(error)}`,
      });
    }
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
            data: await this.edits.create(
              file,
              p.id,
              p.request,
              signal,
              async (raw, operation) => {
                const config = await this.config.load();
                const xml = new XmlWorkers();
                try {
                  if (operation.kind === "set_tag") {
                    if (!tagMap(config).has(operation.tag))
                      throw new AppError(
                        "USER_INPUT",
                        "未知活动标签，请刷新后重新选择",
                      );
                    const result = await xml.run(
                      raw,
                      {
                        kind: "edit",
                        operation: {
                          kind: "set-tag",
                          tag: operation.tag,
                          create: true,
                        },
                      },
                      signal,
                    );
                    return Buffer.from(result.edit!.outputs[0]!.xml);
                  }
                  const locations = (
                    await xml.run(
                      raw,
                      { kind: "edit", operation: { kind: "altitude-targets" } },
                      signal,
                    )
                  ).edit!.locations!;
                  if (!locations.length) return raw;
                  const values = await new GoogleElevation().get(
                    locations,
                    resolveApiKey(config, this.envKey),
                    signal,
                  );
                  const result = await xml.run(
                    raw,
                    {
                      kind: "edit",
                      operation: { kind: "altitude-apply", values },
                    },
                    signal,
                  );
                  return Buffer.from(result.edit!.outputs[0]!.xml);
                } finally {
                  await xml.close();
                }
              },
            ),
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
      elevation = new GoogleElevation();
    const ctx = createContext({ config, mode, signal, report, xml }),
      kml = new KmlService(
        new ScopedKmlFiles(this.files),
        xml,
        archive,
        elevation,
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
    try {
      checkCancelled(signal);
      report({
        type: "log",
        level: "INFO",
        message: `${mode === "plan" ? "预览" : "执行"} ${request.operation}；输入 ${input.length} 项`,
      });
      if (request.operation.startsWith("archive:")) {
        const kind = request.operation.slice(8);
        if (kind === "push") {
          const files = await kmlInputs();
          const db = new Database(databasePath(database), {
            readonly: true,
            fileMustExist: true,
          });
          const existing = new Map(
            (
              db
                .prepare(`SELECT path,sha256 FROM active_archive_entries`)
                .all() as { path: string; sha256: string }[]
            ).map((e) => [e.path, e.sha256]),
          );
          db.close();
          const items: ImportItem[] = [];
          const failures = new Map<string, ReturnType<typeof errorInfo>>();
          const adjustments = new Map(
            (o.importFiles ?? []).map((item) => [item.path, item]),
          );
          const tags = tagMap(config);
          for (const file of files) {
            checkCancelled(signal);
            let sourceTag: string | undefined;
            try {
              const adjustment = adjustments.get(file);
              const tag = adjustment?.tag;
              const readPreview = async () => {
                const source = await new ScopedKmlFiles(this.files).read(file);
                const cached = await this.importPreviews.inspect(
                  source,
                  xml,
                  tag,
                  signal,
                );
                return {
                  source: { ...source, sha256: cached.sha256 },
                  content: { tag: cached.tag },
                  category: (tags.get(cached.tag) ?? null) as
                    "Default" | "Train" | "Flight" | null,
                };
              };
              let { source, content, category } =
                mode === "plan"
                  ? await readPreview()
                  : await kml.importContent(ctx, file);
              sourceTag = content.tag || undefined;
              if (tag !== undefined) {
                category = (tags.get(tag) ?? null) as typeof category;
                if (content.tag !== tag && mode === "apply") {
                  await kml.edit(ctx, file, {
                    kind: "set-tag",
                    tag,
                    create: true,
                  });
                  ({ source, content, category } = await kml.importContent(
                    ctx,
                    file,
                  ));
                  category = (tags.get(tag) ?? null) as typeof category;
                }
              }
              const chosen = category ?? o.category;
              if (!chosen)
                throw new AppError(
                  "USER_INPUT",
                  "无法识别活动标签，请选择活动标签",
                );
              const name = adjustment?.name ?? source.name;
              if (!/\d{4}-\d{2}-\d{2}/.test(name))
                throw new AppError(
                  "USER_INPUT",
                  "名称需包含行程日期，例如 2026-10-01 徒步.kml",
                );
              filenameDate(name);
              const member = entryName(name, chosen),
                sha = existing.get(member);
              const status = !sha
                ? "new"
                : sha === source.sha256
                  ? "duplicate"
                  : "conflict";
              items.push({
                path: file,
                member,
                category: chosen,
                tag: tag ?? (content.tag || undefined),
                sourceTag,
                status,
                reason:
                  status === "new"
                    ? "新增轨迹"
                    : status === "duplicate"
                      ? "与已有轨迹或本批次文件重复，将跳过"
                      : "已有同名轨迹，但内容不同；请修改名称或移除此文件",
              });
              if (!sha) existing.set(member, source.sha256);
            } catch (e) {
              if (e instanceof AppError && e.code === "CANCELLED") throw e;
              failures.set(file, errorInfo(e));
              items.push({
                path: file,
                tag: sourceTag,
                sourceTag,
                status: "invalid",
                reason: e instanceof Error ? e.message : String(e),
              });
            }
            if (mode === "plan")
              report({
                type: "progress",
                completed: items.length,
                total: files.length,
              });
          }
          output.data = { import_items: items };
          if (
            mode === "apply" &&
            items.some((i) => i.status === "invalid" || i.status === "conflict")
          )
            throw new AppError(
              "USER_INPUT",
              "入库校验失败，本批次未写入任何轨迹；请修正后重新上传",
            );
          // Preview already validated every file; do not parse the batch a second time.
          // Conflicts retain their existing successful-plan status and are blocked by apply.
          if (
            mode === "plan" &&
            !items.some((item) => item.status === "conflict")
          ) {
            result = {
              items: items.map((item) =>
                item.status === "invalid"
                  ? {
                      status: "failed",
                      path: item.path,
                      error: failures.get(item.path)!,
                    }
                  : { status: "succeeded", path: item.path },
              ),
              exitCode: items.some((item) => item.status === "invalid") ? 3 : 0,
            };
          }
          if (mode === "apply")
            result = await kml.push(
              ctx,
              files,
              database,
              backup,
              false,
              o.category,
              o.importFiles,
            );
          if (mode === "apply") {
            output.committed = true;
            const imported = new Database(databasePath(database), {
              readonly: true,
              fileMustExist: true,
            });
            try {
              for (const item of items) {
                const entry = imported
                  .prepare(`SELECT id FROM active_archive_entries WHERE path=?`)
                  .get(item.member) as { id: string } | undefined;
                item.entryId = entry?.id;
              }
            } finally {
              imported.close();
            }
            if (parseBool(config.auto_fill_locations) ?? true)
              await this.fillImportedLocations(
                database,
                items
                  .filter((item) => item.status === "new" && item.entryId)
                  .map((item) => item.entryId!),
                xml,
                key,
                signal,
                report,
              );
          }
        } else if (kind === "init" || kind === "import-zip") {
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
          const target = request.output!;
          if (!this.files.exportDirectory(target))
            throw new AppError("USER_INPUT", "临时导出目录无效，请重新导出");
          output.temporary = true;
          output.data = await kml.archiveOperation(ctx, {
            kind: "backup",
            exportOptions: { format: o.format, compression: o.compression },
            temporary: true,
            entries: o.entries,
            database,
            output: target,
          });
          paths.add(target);
        } else if (kind === "rebuild") {
          const target = request.output!;
          if (!this.files.exportDirectory(target))
            throw new AppError("USER_INPUT", "临时导出目录无效，请重新导出");
          output.temporary = true;
          output.data = await kml.archiveOperation(ctx, {
            kind: "rebuild",
            entries: o.entries,
            database,
            output: target,
          });
          for (const category of ["Default", "Train", "Flight"])
            for (const suffix of [".kml", ".Mobile.kml"])
              paths.add(path.join(target, category + suffix));
        } else
          output.data = await kml.archiveOperation(ctx, {
            kind: kind as "status" | "recover",
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
            o.keep !== false,
            !!o.connected,
            [
              database,
              path.join(directory, "Archive.zip"),
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
              const value = await kml.importContent(ctx, file);
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
        throw new AppError("USER_INPUT", "不支持的轨迹操作");
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
      await archive.close();
      await xml.close();
    }
  }
  trackDatabase(): Promise<string> {
    return this.inspector.trackDatabase();
  }
}
