import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { SqliteTasks } from "../../dist/node/infrastructure/task-store.js";
import { WorkFiles } from "../../dist/node/infrastructure/work-files.js";
import { UploadCleanup } from "../../dist/node/infrastructure/upload-cleanup.js";
import { WorkRequestSchema } from "../../dist/node/shared/work.js";

const teardown: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of teardown.splice(0).reverse()) await close(); });
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-upload-cleanup-"));
  teardown.push(() => rm(dir, { recursive: true, force: true }));
  const files = new WorkFiles(path.join(dir, "state"), [dir]);
  const store = new SqliteTasks(path.join(dir, "tasks.sqlite3"));
  teardown.push(() => store.close());
  const cleaner = new UploadCleanup(store, files);
  const upload = await files.upload("first.kml", Readable.from(["original"]));
  const input = upload.files[0]!;
  const enqueue = (inputs = [input]) => store.enqueue(WorkRequestSchema.parse({ operation: "archive:push", inputs }));
  return { dir, files, store, cleaner, upload, input, enqueue };
}

it.each(["succeeded", "failed", "partial", "cancelled", "interrupted"] as const)("cleans upload after apply %s while preserving server originals and unrelated batch files", async (status) => {
  const { dir, files, store, cleaner, upload, input, enqueue } = await setup();
  const other = await files.upload("other.kml", Readable.from(["other"]), upload.id);
  const original = path.join(dir, "server-original.kml");
  await writeFile(original, "original");
  const task = enqueue([input, original]);
  store.change(task.id, (value) => { value.mode = "apply"; });
  store.claim("test");
  store.finish(task.id, "test", status, {});
  cleaner.sweep();
  expect(existsSync(input)).toBe(false);
  expect(existsSync(original)).toBe(true);
  expect(existsSync(other.files[0]!)).toBe(true);
  expect(store.read(task.id)?.uploadsCleaned).toBe(true);
});

it("preserves successful previews until expiration; removes failed previews and empty batches", async () => {
  const { store, cleaner, upload, input, enqueue } = await setup();
  const task = enqueue();
  store.claim("test");
  store.finish(task.id, "test", "succeeded", {});
  cleaner.sweep();
  expect(existsSync(input)).toBe(true);
  cleaner.sweep(Date.now() + 16 * 60_000);
  expect(existsSync(input)).toBe(false);
  await expect(stat(upload.directory)).rejects.toThrow();
  expect(store.read(task.id)?.uploadsCleaned).toBe(true);
});

it("defers cleanup while another queued task uses the upload, then cleans after cancellation", async () => {
  const { store, cleaner, input, enqueue } = await setup();
  const failed = enqueue();
  store.claim("test");
  store.finish(failed.id, "test", "failed", {});
  const queued = enqueue();
  cleaner.sweep();
  expect(existsSync(input)).toBe(true);
  expect(store.read(failed.id)?.uploadsCleaned).not.toBe(true);
  store.cancel(queued.id, store.read(queued.id)!.revision);
  cleaner.sweep();
  expect(existsSync(input)).toBe(false);
  expect(store.read(failed.id)?.uploadsCleaned).toBe(true);
  expect(store.read(queued.id)?.uploadsCleaned).toBe(true);
});

it("startup recovery cleans interrupted imports without deleting task history", async () => {
  const { store, cleaner, input, enqueue } = await setup();
  const task = enqueue();
  store.claim("dead");
  store.db.prepare("UPDATE tasks SET lease=0 WHERE id=?").run(task.id);
  store.recover();
  cleaner.sweep();
  expect(existsSync(input)).toBe(false);
  expect(store.read(task.id)?.status).toBe("interrupted");
  expect(store.read(task.id)?.uploadsCleaned).toBe(true);
});
