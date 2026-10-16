import path from "node:path";
import { lstatSync, realpathSync, unlinkSync, rmdirSync } from "node:fs";
import type { WorkTask, ImportItem } from "../shared/work.js";
import { SqliteTasks } from "./task-store.js";
import { WorkFiles } from "./work-files.js";

const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
};

/** Deletes only managed upload files, never CLI/server originals or whole batches. */
export class UploadCleanup {
  constructor(private store: SqliteTasks, private files: WorkFiles) {}

  sweep(now = Date.now()) {
    // The same database lock protects enqueue/claim and the final reference check.
    this.store.db.transaction(() => {
      const rows = this.store.db.prepare("SELECT body FROM tasks WHERE status IN ('queued','running') OR (json_extract(body, '$.request.operation') = 'archive:push' AND json_type(body, '$.uploadsCleaned') IS NULL)").all() as { body: string }[];
      const tasks = rows.map((row) => JSON.parse(row.body) as WorkTask);
      const active = tasks.filter((t) => ["queued", "running"].includes(t.status));
      for (const task of tasks) {
        if (task.request.operation !== "archive:push" || task.uploadsCleaned || ["queued", "running"].includes(task.status)) continue;
        const items = (task.output?.data as { import_items?: ImportItem[] } | undefined)?.import_items;
        const finished = task.mode === "apply" || task.status !== "succeeded" ||
          items?.some((item) => ["invalid", "conflict"].includes(item.status)) ||
          (!!task.expiresAt && Date.parse(task.expiresAt) <= now);
        if (!finished) continue;
        const files = task.request.inputs.filter((file) => {
          const parts = path.relative(this.files.uploads, file).split(path.sep);
          return parts.length === 2 && /^[0-9a-f-]{36}$/.test(parts[0]!) && parts[1] !== ".." && parts[1] !== ".";
        });
        if (!files.length) {
          this.store.change(task.id, (value) => { value.uploadsCleaned = false; });
          continue;
        }
        let complete = true;
        for (const file of files) {
          if (active.some((other) => [...other.request.inputs, other.request.output ?? ""].filter(Boolean).some((input) => within(input, file) || within(file, input)))) {
            complete = false;
            continue;
          }
          try {
            const directory = path.dirname(file);
            if (realpathSync(directory) !== path.join(realpathSync(this.files.uploads), path.basename(directory)) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
              complete = false;
              continue;
            }
            unlinkSync(file);
            try { rmdirSync(directory); } catch { /* Other uploaded files still use this batch. */ }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
          }
        }
        if (complete) {
          this.store.change(task.id, (value) => { value.uploadsCleaned = true; });
          if (task.previewId) this.store.change(task.previewId, (value) => { value.uploadsCleaned = true; });
        }
      }
    }).immediate();
  }
}
