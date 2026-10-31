import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  EXPORT_RETENTION_MS,
  ExportCleanup,
} from "../../dist/node/infrastructure/export-cleanup.js";
import { SqliteTasks } from "../../dist/node/infrastructure/task-store.js";
import { WorkFiles } from "../../dist/node/infrastructure/work-files.js";
import type { WorkTask } from "../../dist/node/shared/work.js";
import { WorkRequestSchema } from "../../dist/node/shared/work.js";

const teardown: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close();
});
async function setup(
  zip = true,
  status: WorkTask["status"] = "succeeded",
  mode: "plan" | "apply" = "apply",
) {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tracktool-export-cleanup-"),
  );
  teardown.push(() => rm(dir, { recursive: true, force: true }));
  const files = new WorkFiles(path.join(dir, "state"), [dir]);
  const output = await files.exportOutput(zip);
  const directory = files.exportDirectory(output)!;
  const store = new SqliteTasks(path.join(dir, "tasks.sqlite3"));
  teardown.push(() => store.close());
  const cleaner = new ExportCleanup(store, files);
  const task = store.enqueue(
    WorkRequestSchema.parse({
      operation: zip ? "archive:backup" : "archive:rebuild",
      output,
    }),
    undefined,
    mode === "apply",
  );
  store.claim("test");
  const paths = zip
    ? [output]
    : [path.join(output, "Train.kml"), path.join(output, "Train.Mobile.kml")];
  await mkdir(path.dirname(paths[0]!), { recursive: true });
  for (const file of paths) await writeFile(file, "exported bytes");
  if (status !== "running")
    store.finish(task.id, "test", status, {
      output: { paths, temporary: true },
      fingerprint: "same",
    });
  return {
    dir,
    files,
    output,
    directory,
    store,
    cleaner,
    task: store.read(task.id)!,
    paths,
  };
}

it("deletes acknowledged files individually and removes the batch only after all downloads", async () => {
  const { cleaner, paths, directory, store, task } = await setup(false);
  cleaner.sweep();
  expect(paths.every(existsSync)).toBe(true);
  expect(() => cleaner.complete(task.id, 2)).toThrow("临时导出");
  const partial = cleaner.complete(task.id, 0);
  expect(partial.downloadedFiles).toEqual([0]);
  expect(existsSync(paths[0]!)).toBe(false);
  expect(existsSync(paths[1]!)).toBe(true);
  expect(partial.exportsCleaned).not.toBe(true);
  cleaner.complete(task.id, 0);
  cleaner.complete(task.id, 1);
  expect(existsSync(directory)).toBe(false);
  expect(store.read(task.id)?.exportsCleaned).toBe(true);
  expect(() => cleaner.complete(task.id, 1)).not.toThrow();
});

it("retains unacknowledged and concurrent downloads, then cleans from durable acknowledgements after restart", async () => {
  const { cleaner, paths, store, task, files } = await setup();
  const releaseOne = cleaner.hold(task);
  const releaseTwo = cleaner.hold(task);
  cleaner.sweep(Date.now() + EXPORT_RETENTION_MS + 1000);
  expect(existsSync(paths[0]!)).toBe(true);
  cleaner.complete(task.id, 0);
  releaseOne();
  releaseOne();
  cleaner.sweep();
  expect(existsSync(paths[0]!)).toBe(true);
  releaseTwo();
  new ExportCleanup(store, files).sweep();
  expect(existsSync(paths[0]!)).toBe(false);
  expect(store.read(task.id)?.downloadedFiles).toEqual([0]);
});

it("expires abandoned exports without marking them downloaded or depending on the 200-task UI limit", async () => {
  const { cleaner, directory, store, task } = await setup();
  for (let index = 0; index < 205; index++) {
    const next = store.enqueue(
      WorkRequestSchema.parse({ operation: "archive:status" }),
    );
    store.claim("history");
    store.finish(next.id, "history", "succeeded", {});
  }
  expect(store.list().some((value) => value.id === task.id)).toBe(false);
  cleaner.sweep(Date.now() + EXPORT_RETENTION_MS + 1000);
  expect(existsSync(directory)).toBe(false);
  expect(store.read(task.id)?.downloadedFiles).toBeUndefined();
  expect(() => cleaner.complete(task.id, 0)).toThrow("已清理");
});

it("defers deletion while a queued task references the temporary file", async () => {
  const { cleaner, store, task, paths } = await setup();
  const consumer = store.enqueue(
    WorkRequestSchema.parse({ operation: "archive:push", inputs: paths }),
  );
  cleaner.complete(task.id, 0);
  expect(existsSync(paths[0]!)).toBe(true);
  store.cancel(consumer.id, consumer.revision);
  cleaner.sweep();
  expect(existsSync(paths[0]!)).toBe(false);
});

it("keeps applied files after their preview expires and marks both records when consumed", async () => {
  const { cleaner, store, task, paths } = await setup(
    true,
    "succeeded",
    "plan",
  );
  const applied = store.enqueue(
    WorkRequestSchema.parse(task.request),
    store.read(task.id)!,
  );
  store.claim("apply");
  store.finish(applied.id, "apply", "succeeded", {
    output: { paths, temporary: true },
  });
  cleaner.sweep(Date.now() + 16 * 60_000);
  expect(existsSync(paths[0]!)).toBe(true);
  cleaner.complete(applied.id, 0);
  expect(store.read(task.id)?.exportsCleaned).toBe(true);
  expect(store.read(applied.id)?.exportsCleaned).toBe(true);
});

it.each(["failed", "cancelled", "interrupted"] as const)(
  "cleans %s output but leaves unrelated files untouched",
  async (status) => {
    const { dir, cleaner, directory } = await setup(true, status);
    const original = path.join(dir, "Archive.zip");
    await writeFile(original, "CLI output");
    cleaner.sweep();
    expect(existsSync(directory)).toBe(false);
    expect(await readFile(original, "utf8")).toBe("CLI output");
  },
);

it("keeps queued or running exports and removes leftovers after lease recovery", async () => {
  const { cleaner, store, task, directory } = await setup(true, "running");
  cleaner.sweep(Date.now() + EXPORT_RETENTION_MS + 1000);
  expect(existsSync(directory)).toBe(true);
  store.db.prepare("UPDATE tasks SET lease=0 WHERE id=?").run(task.id);
  store.recover();
  cleaner.sweep();
  expect(existsSync(directory)).toBe(false);
});

it("expires unsubmitted previews and orphan allocations but preserves current allocations", async () => {
  const { cleaner, files, directory } = await setup(true, "succeeded", "plan");
  const old = files.exportDirectory(await files.exportOutput(true))!;
  const current = files.exportDirectory(await files.exportOutput(true))!;
  const past = new Date(Date.now() - EXPORT_RETENTION_MS - 1000);
  await utimes(old, past, past);
  cleaner.sweep(Date.now() + 16 * 60_000);
  expect(existsSync(directory)).toBe(false);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(current)).toBe(true);
});

it("refuses external paths, path traversal, and symlink swaps without deleting their targets", async () => {
  const { cleaner, files, store, task, paths, dir } = await setup();
  const original = path.join(dir, "original.zip");
  await writeFile(original, "original bytes");
  expect(
    files.exportDirectory(path.join(files.exports, "..", "original.zip")),
  ).toBeUndefined();
  await expect(files.exportOutput(true, original)).rejects.toThrow(
    "受管临时目录",
  );
  const external = store.enqueue(
    WorkRequestSchema.parse({ operation: "archive:backup", output: original }),
    undefined,
    true,
  );
  store.claim("external");
  store.finish(external.id, "external", "succeeded", {
    output: { paths: [original] },
  });
  expect(() => cleaner.complete(external.id, 0)).toThrow("临时导出");
  await rm(paths[0]!);
  await symlink(original, paths[0]!);
  expect(() => cleaner.complete(task.id, 0)).toThrow("符号链接");
  expect(await readFile(original, "utf8")).toBe("original bytes");
});
