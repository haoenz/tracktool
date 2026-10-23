import path from "node:path";
import {
  lstatSync,
  realpathSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { AppError } from "../domain/errors.js";
import type { WorkTask } from "../shared/work.js";
import { SqliteTasks } from "./task-store.js";
import { WorkFiles } from "./work-files.js";

export const EXPORT_RETENTION_MS = 24 * 60 * 60_000;
const active = (task: WorkTask) => ["queued", "running"].includes(task.status);
const within = (root: string, file: string) =>
  file === root || file.startsWith(root + path.sep);

/** Only isolated web exports are eligible; archive files and legacy outputs are never removed. */
export class ExportCleanup {
  private readonly downloads = new Map<string, number>();
  constructor(
    private readonly store: SqliteTasks,
    private readonly files: WorkFiles,
  ) {}

  private directory(task: WorkTask) {
    return ["archive:backup", "archive:rebuild"].includes(
      task.request.operation,
    )
      ? this.files.exportDirectory(task.request.output)
      : undefined;
  }

  private file(task: WorkTask, index: number) {
    const directory = this.directory(task);
    const file = task.output?.paths[index];
    if (
      !directory ||
      !task.output?.temporary ||
      !file ||
      (task.request.operation === "archive:backup"
        ? file !== path.join(directory, "Archive.zip")
        : path.dirname(file) !== path.join(directory, "collections"))
    )
      throw new AppError("USER_INPUT", "此结果不是可清理的临时导出文件");
    return file;
  }

  hold(task: WorkTask) {
    const directory = this.directory(task);
    if (!directory) return () => {};
    this.downloads.set(directory, (this.downloads.get(directory) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.downloads.get(directory) ?? 1) - 1;
      if (remaining) this.downloads.set(directory, remaining);
      else this.downloads.delete(directory);
    };
  }

  complete(id: string, index: number) {
    const task = this.store.read(id);
    if (!task || task.mode !== "apply" || active(task))
      throw new AppError("USER_INPUT", "结果尚不可下载");
    this.file(task, index);
    if (!task.downloadedFiles?.includes(index)) {
      if (task.exportsCleaned)
        throw new AppError("USER_INPUT", "临时导出文件已清理，请重新导出");
      // Persist the acknowledgement first so a crash or a failed unlink can be retried.
      this.store.change(id, (value) => {
        value.downloadedFiles = [...(value.downloadedFiles ?? []), index];
      });
    }
    this.sweep();
    return this.store.public(this.store.read(id)!);
  }

  sweep(now = Date.now()) {
    if (realpathSync(this.files.exports) !== this.files.exports)
      throw new AppError("FORBIDDEN", "临时导出目录不能是符号链接");
    this.store.db
      .transaction(() => {
        const rows = this.store.db
          .prepare(
            "SELECT body FROM tasks WHERE status IN ('queued','running') OR (json_extract(body, '$.request.operation') IN ('archive:backup','archive:rebuild') AND json_type(body, '$.exportsCleaned') IS NULL)",
          )
          .all() as { body: string }[];
        const tasks = rows.map((row) => JSON.parse(row.body) as WorkTask);
        const activePaths = tasks
          .filter(active)
          .flatMap((task) =>
            [
              ...task.request.inputs,
              task.request.output ?? "",
              task.request.archive ?? "",
            ].filter(Boolean),
          );
        const groups = new Map<string, WorkTask[]>();
        for (const task of tasks) {
          const directory = this.directory(task);
          if (directory)
            groups.set(directory, [...(groups.get(directory) ?? []), task]);
        }
        const protectedDirectory = (directory: string) =>
          this.downloads.has(directory) ||
          activePaths.some(
            (file) => within(directory, file) || within(file, directory),
          );
        for (const [directory, related] of groups) {
          if (protectedDirectory(directory)) continue;
          const task =
            related.find((value) => value.mode === "apply") ?? related[0]!;
          const applied = task.mode === "apply";
          const usable = ["succeeded", "partial"].includes(task.status);
          const expires = applied
            ? Date.parse(task.createdAt) + EXPORT_RETENTION_MS
            : Date.parse(task.expiresAt ?? task.updatedAt) +
              (task.expiresAt ? 0 : 15 * 60_000);
          const downloaded = task.downloadedFiles ?? [];
          if (applied && usable) {
            for (const index of downloaded) {
              const file = this.file(task, index);
              try {
                if (
                  realpathSync(path.dirname(file)) !== path.dirname(file) ||
                  lstatSync(file).isSymbolicLink()
                )
                  throw new AppError("FORBIDDEN", "临时导出文件不能是符号链接");
                unlinkSync(file);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
            }
          }
          const finished =
            applied &&
            usable &&
            !!task.output?.paths.length &&
            task.output.paths.every((_, index) => downloaded.includes(index));
          if (!finished && usable && now < expires) continue;
          this.removeDirectory(directory);
          for (const value of related)
            this.store.change(value.id, (current) => {
              current.exportsCleaned = true;
            });
        }
        // Also collect allocations abandoned before enqueue, including after a process crash.
        for (const entry of readdirSync(this.files.exports, {
          withFileTypes: true,
        })) {
          const directory = this.files.exportDirectory(
            path.join(this.files.exports, entry.name, "Archive.zip"),
          );
          if (
            !directory ||
            !entry.isDirectory() ||
            groups.has(directory) ||
            protectedDirectory(directory)
          )
            continue;
          if (now - lstatSync(directory).mtimeMs >= EXPORT_RETENTION_MS)
            this.removeDirectory(directory);
        }
      })
      .immediate();
  }

  private removeDirectory(directory: string) {
    try {
      if (realpathSync(directory) !== directory)
        throw new AppError("FORBIDDEN", "临时导出目录不能是符号链接");
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
