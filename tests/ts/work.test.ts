import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  copyFile,
  symlink,
  utimes,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { createApp } from "../../dist/node/server/app.js";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
import { SqliteTasks } from "../../dist/node/infrastructure/task-store.js";
import { TaskQueue } from "../../dist/node/infrastructure/task-queue.js";
import { WorkFiles } from "../../dist/node/infrastructure/work-files.js";
import { BusinessRunner } from "../../dist/node/infrastructure/work-runner.js";
import { AppError } from "../../dist/node/domain/errors.js";
import { WorkRequestSchema } from "../../dist/node/shared/work.js";
import type { WorkTask, WorkRequest } from "../../dist/node/shared/work.js";
import type { WorkRunner } from "../../dist/node/services/work-ports.js";
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-m6-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function until<T>(
  get: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await get();
    if (done(value)) return value;
    await delay(30);
  }
  throw new Error("Timed out waiting for task");
}
const body = (operation = "exif:set"): WorkRequest =>
  WorkRequestSchema.parse({ operation, inputs: [], options: {} });
function fake(overrides: Partial<WorkRunner> = {}): WorkRunner {
  return {
    normalize: async (r) => r,
    fingerprint: async () => "stable",
    run: async () => ({ output: { paths: [] } }),
    ...overrides,
  };
}
it("SQLite claims one writer across connections, compares revisions and appends events atomically", async () => {
  const d = await tmp(),
    a = new SqliteTasks(path.join(d, "tasks.sqlite3")),
    b = new SqliteTasks(path.join(d, "tasks.sqlite3"));
  cleanup.push(
    () => a.close(),
    () => b.close(),
  );
  const task = a.enqueue(body()),
    running = a.claim("one")!;
  expect(running.id).toBe(task.id);
  expect(b.claim("two")).toBeUndefined();
  a.change(
    task.id,
    (t) => {
      t.progress = { completed: 1, total: 2 };
    },
    [{ type: "log", level: "INFO", message: "first" }],
    "one",
  );
  expect(b.read(task.id)?.events).toHaveLength(1);
  expect(() =>
    b.change(
      task.id,
      () => {},
      [{ type: "log", level: "INFO", message: "stale" }],
      undefined,
      0,
    ),
  ).toThrow("变化");
  expect(a.read(task.id)?.events).toHaveLength(1);
  a.finish(task.id, "one", "succeeded", { output: { paths: [] } });
  expect(a.read(task.id)?.status).toBe("succeeded");
});
it("expired leases become interrupted, while queued work remains queued and live owners are not interrupted", async () => {
  const d = await tmp();
  let now = 10000;
  const a = new SqliteTasks(path.join(d, "tasks.sqlite3"), () => now);
  cleanup.push(() => a.close());
  const first = a.enqueue(body());
  a.claim("owner");
  const second = a.enqueue(body());
  expect(a.recover()).toBe(0);
  now += 16000;
  expect(a.recover()).toBe(1);
  expect(a.read(first.id)?.status).toBe("interrupted");
  expect(a.read(second.id)?.status).toBe("queued");
  expect(a.claim("new")?.id).toBe(second.id);
});
it("queue previews without writes, applies once, and rejects expired or changed plans", async () => {
  const d = await tmp();
  let fingerprint = "before",
    writes = 0;
  const queue = new TaskQueue(
    new SqliteTasks(path.join(d, "tasks.sqlite3")),
    fake({
      fingerprint: async () => fingerprint,
      run: async (_r, mode) => {
        if (mode === "apply") writes++;
        return { output: { paths: [] } };
      },
    }),
  );
  cleanup.push(() => queue.close());
  queue.start();
  const preview = await queue.preview(body());
  await until(
    () => queue.store.read(preview.id),
    (t) => t?.status === "succeeded",
  );
  expect(writes).toBe(0);
  fingerprint = "after";
  await expect(queue.apply(preview.id)).rejects.toThrow("变化");
  fingerprint = "before";
  const applied = await queue.apply(preview.id);
  await until(
    () => queue.store.read(applied.id),
    (t) => t?.status === "succeeded",
  );
  expect(writes).toBe(1);
  await expect(queue.apply(preview.id)).rejects.toThrow("已经");
  const next = await queue.retry(applied.id);
  await until(
    () => queue.store.read(next.id),
    (t) => t?.status === "succeeded",
  );
  queue.store.change(next.id, (t) => {
    t.expiresAt = "2000-01-01T00:00:00.000Z";
  });
  await expect(queue.apply(next.id)).rejects.toThrow("过期");
});
it("cancel handles queued and running work; a clean shutdown persists interruption without retrying writes", async () => {
  const d = await tmp(),
    file = path.join(d, "tasks.sqlite3");
  const runner = fake({
    run: async (_r, _m, signal) => {
      await delay(60000, undefined, { signal });
      return { output: { paths: [] } };
    },
  });
  const queue = new TaskQueue(new SqliteTasks(file), runner);
  queue.start();
  const first = await queue.preview(body());
  await until(
    () => queue.store.read(first.id),
    (t) => t?.status === "running",
  );
  const second = await queue.preview(body());
  queue.store.cancel(second.id, queue.store.read(second.id)!.revision);
  expect(queue.store.read(second.id)?.status).toBe("cancelled");
  queue.store.cancel(first.id, queue.store.read(first.id)!.revision);
  await until(
    () => queue.store.read(first.id),
    (t) => t?.status === "cancelled",
  );
  const third = await queue.preview(body());
  await until(
    () => queue.store.read(third.id),
    (t) => t?.status === "running",
  );
  await queue.close();
  const reopened = new SqliteTasks(file);
  cleanup.push(() => reopened.close());
  expect(reopened.read(third.id)?.status).toBe("interrupted");
});
it("a queued apply rechecks its fingerprint before calling any mutation", async () => {
  const d = await tmp();
  let signature = "a",
    hold = false,
    writes = 0;
  const runner = fake({
      fingerprint: async () => signature,
      run: async (_r, mode, signal) => {
        if (hold) await delay(200, undefined, { signal });
        if (mode === "apply") writes++;
        return { output: { paths: [] } };
      },
    }),
    queue = new TaskQueue(
      new SqliteTasks(path.join(d, "tasks.sqlite3")),
      runner,
    );
  cleanup.push(() => queue.close());
  queue.start();
  const preview = await queue.preview(body());
  await until(
    () => queue.store.read(preview.id),
    (t) => t?.status === "succeeded",
  );
  hold = true;
  await queue.preview(body());
  const apply = await queue.apply(preview.id);
  signature = "b";
  await until(
    () => queue.store.read(apply.id),
    (t) => t?.status === "failed",
  );
  expect(writes).toBe(0);
});
async function server(host = "127.0.0.1") {
  const dir = await tmp(),
    archive = path.join(dir, "archive");
  await mkdir(archive);
  await copyFile(
    "tests/ts/fixtures/maps/archive.sqlite3",
    path.join(archive, "archive.sqlite3"),
  );
  const config = path.join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      archive_path: archive,
      google_api_key: "fixture-private-key",
    }),
  );
  const app = await createApp({
    configStore: new FileConfigStore({ path: config }),
    token: "work-test",
    work: { stateDir: path.join(dir, "state"), roots: [dir], archive },
  });
  const address = await app.listen({ host, port: 0 });
  cleanup.push(() => app.close());
  const call = async <T>(route: string, body?: unknown): Promise<T> => {
    const r = await fetch(address + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Tracktool-Token": "work-test",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await r.json()) as T & { error?: { message: string } };
    if (!r.ok) throw new Error(data.error?.message || String(r.status));
    return data;
  };
  const settled = (id: string) =>
    until(
      () => call<WorkTask>("/api/work/tasks/" + id),
      (t) => !["queued", "running"].includes(t.status),
    );
  return { dir, archive, config, app, address, call, settled };
}
it("HTTP media upload → preview → execute → download survives page reload semantics and cleans staging", async () => {
  const { address, call, settled } = await server();
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  const response = await fetch(
    address + "/api/work/uploads?name=" + encodeURIComponent("中文.jpg"),
    {
      method: "POST",
      headers: {
        "X-Tracktool-Token": "work-test",
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    },
  );
  expect(response.status).toBe(200);
  const uploaded = (await response.json()) as { id: string; files: string[] };
  const task = await call<WorkTask>("/api/work/preview", {
    operation: "exif:set",
    inputs: uploaded.files,
    options: { tags: { "IPTC:City": "杭州" } },
  });
  const preview = await settled(task.id);
  expect(preview.status, JSON.stringify(preview.error)).toBe("succeeded");
  expect(await readFile(uploaded.files[0]!)).toEqual(bytes);
  const apply = await call<WorkTask>(`/api/work/tasks/${task.id}/apply`, {}),
    result = await settled(apply.id);
  expect(result.status, JSON.stringify(result.error)).toBe("succeeded");
  expect(result.output?.paths).toEqual(uploaded.files);
  const download = await fetch(
    address + `/api/work/tasks/${apply.id}/download?index=0`,
    { headers: { "X-Tracktool-Token": "work-test" } },
  );
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(Buffer.from(await download.arrayBuffer())).not.toEqual(bytes);
  expect(await readFile(uploaded.files[0]! + "_original")).toEqual(bytes);
  expect(
    (await call<{ tasks: WorkTask[] }>("/api/work/tasks")).tasks.map(
      (t) => t.id,
    ),
  ).toContain(apply.id);
  expect(JSON.stringify(result)).not.toContain("fixture-private-key");
  await call("/api/work/uploads/" + uploaded.id + "/cleanup", {});
  expect(existsSync(uploaded.files[0]!)).toBe(false);
});
it("HTTP archive init, push, backup, download and delete call the shared services and expose downloadable results", async () => {
  const { dir, call, settled } = await server(),
    archive = path.join(dir, "new-archive"),
    source = path.join(dir, "2026-10-01 轨迹.kml");
  await copyFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml", source);
  async function run(request: unknown) {
    const p = await call<WorkTask>("/api/work/preview", request);
    const preview = await settled(p.id);
    expect(preview.status, JSON.stringify(preview.error)).toBe("succeeded");
    const a = await call<WorkTask>(`/api/work/tasks/${p.id}/apply`, {});
    const value = await settled(a.id);
    expect(value.status, JSON.stringify(value.error)).toBe("succeeded");
    return value;
  }
  await run({ operation: "archive:init", archive });
  await run({
    operation: "archive:push",
    archive,
    inputs: [source],
    options: { category: "Default", keep: true },
  });
  expect(
    (
      await call<{ catalog: { entries: unknown[] } }>("/api/work/catalog", {
        archive,
      })
    ).catalog.entries,
  ).toHaveLength(1);
  const backup = await run({ operation: "archive:backup", archive });
  expect(backup.output?.paths[0]).toBe(path.join(archive, "Archive.zip"));
  const downloaded = await run({
    operation: "archive:download",
    archive,
    options: { name: "2026-10-01 轨迹.kml" },
  });
  expect(await readFile(downloaded.output!.paths[0]!)).toEqual(
    await readFile(source),
  );
  const catalog = () =>
    call<{ catalog: { entries: unknown[] } }>("/api/work/catalog", { archive });
  expect((await catalog()).catalog.entries).toHaveLength(1);
  const removed = await run({
    operation: "archive:delete",
    archive,
    options: { name: "2026-10-01 轨迹.kml" },
  });
  expect(removed.output?.paths).toEqual([]);
  expect((await catalog()).catalog.entries).toHaveLength(0);
  expect(await readFile(downloaded.output!.paths[0]!)).toEqual(
    await readFile(source),
  );
});
it("HTTP rejects stale file/config previews, unknown paths, symlink aliases and unauthenticated uploads", async () => {
  const { dir, config, address, call, settled } = await server(),
    source = path.join(dir, "a.jpg");
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toFile(source);
  const p = await call<WorkTask>("/api/work/preview", {
    operation: "exif:set",
    inputs: [source],
    options: { make: "SONY" },
  });
  expect((await settled(p.id)).status).toBe("succeeded");
  await new FileConfigStore({ path: config }).set("log_level", "DEBUG");
  await expect(call(`/api/work/tasks/${p.id}/apply`, {})).rejects.toThrow(
    "变化",
  );
  expect(existsSync(source + "_original")).toBe(false);
  await expect(call("/api/work/files?path=/etc")).rejects.toThrow("开放");
  await symlink(source, path.join(dir, "alias.jpg"));
  await expect(
    call("/api/work/preview", {
      operation: "exif:set",
      inputs: [path.join(dir, "alias.jpg")],
    }),
  ).rejects.toThrow("符号链接");
  const upload = await fetch(address + "/api/work/uploads?name=x.jpg", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: "bytes",
  });
  expect(upload.status).toBe(403);
  await expect(
    call("/api/work/files?path=" + encodeURIComponent(path.join(dir, "state"))),
  ).rejects.toThrow("任务数据库");
});
it("partial media failures remain itemized while independent files finish", async () => {
  const { dir, call, settled } = await server(),
    good = path.join(dir, "good.jpg"),
    bad = path.join(dir, "bad.jpg");
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toFile(good);
  await writeFile(bad, "");
  const task = await call<WorkTask>("/api/work/preview", {
      operation: "exif:show-missing",
      inputs: [good, bad],
      options: { parallel: true },
    }),
    result = await settled(task.id);
  expect(result.status).toBe("partial");
  expect(result.result?.items.map((i) => i.status)).toEqual([
    "skipped",
    "failed",
  ]);
  await expect(call(`/api/work/tasks/${task.id}/apply`, {})).rejects.toThrow();
});
it("fingerprints detect same-size edits with preserved mtimes and output collisions", async () => {
  const d = await tmp(),
    file = path.join(d, "track.kml"),
    config = new FileConfigStore({ path: path.join(d, "config.json") });
  await writeFile(file, "abc");
  await utimes(file, 1700000000, 1700000000);
  const files = new WorkFiles(path.join(d, "state"), [d]);
  await files.prepare();
  const runner = new BusinessRunner(files, config);
  const req = body("kml:type");
  req.inputs = [file];
  const before = await runner.fingerprint(req, new AbortController().signal);
  await writeFile(file, "xyz");
  await utimes(file, 1700000000, 1700000000);
  expect(await runner.fingerprint(req, new AbortController().signal)).not.toBe(
    before,
  );
  const changed = await runner.fingerprint(req, new AbortController().signal);
  await writeFile(path.join(d, "new-output.kml"), "occupied");
  expect(await runner.fingerprint(req, new AbortController().signal)).not.toBe(
    changed,
  );
});
it("schema rejects arbitrary operations, injected tag arguments and unbounded selections", () => {
  expect(() => WorkRequestSchema.parse({ operation: "shell:exec" })).toThrow();
  expect(() =>
    WorkRequestSchema.parse({
      operation: "exif:set",
      options: { tags: { "-execute": "1" } },
    }),
  ).toThrow();
  expect(() =>
    WorkRequestSchema.parse({
      operation: "exif:set",
      inputs: Array(501).fill("/a"),
    }),
  ).toThrow();
  expect(new AppError("USER_INPUT", "test").code).toBe("USER_INPUT");
});
it("a killed worker is not replayed and another process can recover its lease", async () => {
  const { spawn } = await import("node:child_process");
  const d = await tmp(),
    file = path.join(d, "tasks.sqlite3");
  const storeModule = new URL(
      "../../dist/node/infrastructure/task-store.js",
      import.meta.url,
    ).href,
    queueModule = new URL(
      "../../dist/node/infrastructure/task-queue.js",
      import.meta.url,
    ).href;
  const script = `import {SqliteTasks} from ${JSON.stringify(storeModule)};import {TaskQueue} from ${JSON.stringify(queueModule)};const q=new TaskQueue(new SqliteTasks(${JSON.stringify(file)}),{normalize:async r=>r,fingerprint:async()=>"x",run:async()=>{console.log("RUNNING");await new Promise(r=>setTimeout(r,60000));return {output:{paths:[]}};}});q.start();const a=await q.preview({operation:"exif:set",inputs:[],options:{}});console.log(a.id);setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  try {
    await until(
      () => output,
      (v) => v.includes("RUNNING") && /[0-9a-f]{8}-[0-9a-f-]{27}/.test(v),
    );
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  const restarted = new SqliteTasks(file, () => Date.now() + 16000);
  cleanup.push(() => restarted.close());
  expect(restarted.recover()).toBe(1);
  const task = restarted.list()[0]!;
  expect(task.status).toBe("interrupted");
  expect(restarted.claim("replacement")).toBeUndefined();
  expect(
    task.events.some(
      (e) => e.event.type === "log" && e.event.message.includes("不会自动重复"),
    ),
  ).toBe(true);
});
it("LAN-bound HTTP accepts local-network uploads while keeping task API token checks", async () => {
  const { app } = await server("0.0.0.0");
  const port = (app.server.address() as { port: number }).port,
    interfaces = os.networkInterfaces();
  const ip =
      Object.values(interfaces)
        .flat()
        .find((i) => i?.family === "IPv4" && !i.internal)?.address ??
      "127.0.0.1",
    base = `http://${ip}:${port}`;
  expect((app.server.address() as { address: string }).address).toBe("0.0.0.0");
  const response = await fetch(base + "/api/work/uploads?name=lan.txt", {
    method: "POST",
    headers: {
      "X-Tracktool-Token": "work-test",
      "Content-Type": "application/octet-stream",
      Origin: base,
    },
    body: "uploaded from another device",
  });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { files: string[] };
  expect(await readFile(data.files[0]!, "utf8")).toBe(
    "uploaded from another device",
  );
  expect((await fetch(base + "/api/work/tasks")).status).toBe(403);
});
it("apply preserves successful files and exposes per-file failures if an external write fails", async () => {
  const { dir, call, settled } = await server(),
    good = path.join(dir, "good.jpg"),
    bad = path.join(dir, "bad.jpg");
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toFile(good);
  await writeFile(bad, "");
  const preview = await call<WorkTask>("/api/work/preview", {
    operation: "exif:set",
    inputs: [good, bad],
    options: { tags: { "IPTC:City": "City" }, parallel: true },
  });
  expect((await settled(preview.id)).status).toBe("succeeded");
  const apply = await call<WorkTask>(`/api/work/tasks/${preview.id}/apply`, {}),
    result = await settled(apply.id);
  expect(result.status).toBe("partial");
  expect(result.result?.items.map((i) => i.status)).toEqual([
    "succeeded",
    "failed",
  ]);
  expect(result.output?.paths).toEqual([good]);
  expect(existsSync(good + "_original")).toBe(true);
  expect(await readFile(bad, "utf8")).toBe("");
});
it("web grouping cannot follow a destination folder symlink outside the opened root", async () => {
  const { dir, call, settled } = await server(),
    outside = await tmp(),
    input = path.join(dir, "media");
  await mkdir(input);
  await writeFile(path.join(input, "a.jpg"), "photo");
  await writeFile(path.join(input, "b.mov"), "video");
  await symlink(
    outside,
    path.join(input, "IMG"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const task = await call<WorkTask>("/api/work/preview", {
    operation: "exif:group",
    inputs: [input],
  });
  const result = await settled(task.id);
  expect(["partial", "failed"]).toContain(result.status);
  expect(existsSync(path.join(outside, "a.jpg"))).toBe(false);
  await expect(call(`/api/work/tasks/${task.id}/apply`, {})).rejects.toThrow();
});
it("completed task and its events remain readable after closing and reopening the HTTP server", async () => {
  const { dir, archive, config, app, call, settled } = await server();
  const task = await call<WorkTask>("/api/work/preview", {
    operation: "archive:status",
    archive,
  });
  const complete = await settled(task.id);
  expect(complete.status).toBe("succeeded");
  await app.close();
  const next = await createApp({
    configStore: new FileConfigStore({ path: config }),
    token: "restart",
    work: { stateDir: path.join(dir, "state"), roots: [dir], archive },
  });
  const address = await next.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => next.close());
  const response = await fetch(address + "/api/work/tasks/" + task.id, {
      headers: { "X-Tracktool-Token": "restart" },
    }),
    saved = (await response.json()) as WorkTask;
  expect(saved.status).toBe("succeeded");
  expect(saved.events).toEqual(complete.events);
  expect(saved.output).toEqual(complete.output);
});
it("map selections produce isolated copies, reject changed fingerprints and enforce file roots", async () => {
  const { archive, call } = await server();
  const selected = await call<{ tracks: { entry: string; sha256: string }[] }>(
    "/api/selection",
    {
      archive,
      entries: ["Default/2026-10-01 中文.kml", "Train/same.kml"],
    },
  );
  expect(selected.tracks).toHaveLength(2);
  const tracks = selected.tracks.map(({ entry, sha256 }) => ({
    entry,
    sha256,
  }));
  const copied = await call<{ id: string; files: string[] }>(
    "/api/work/selection-copy",
    { archive, tracks },
  );
  expect(copied.files).toHaveLength(2);
  expect(new Set(copied.files).size).toBe(2);
  expect(await readFile(copied.files[0]!, "utf8")).toContain("kml");
  await writeFile(copied.files[0]!, "changed staging copy");
  const again = await call<{ tracks: { sha256: string }[] }>("/api/selection", {
    archive,
    entries: tracks.map((t) => t.entry),
  });
  expect(again.tracks.map((t) => t.sha256)).toEqual(
    tracks.map((t) => t.sha256),
  );
  const before = await call<{ uploads: unknown[] }>("/api/work/uploads");
  await expect(
    call("/api/work/selection-copy", {
      archive,
      tracks: [tracks[0], { ...tracks[1], sha256: "0".repeat(64) }],
    }),
  ).rejects.toThrow("源轨迹已变化");
  expect(
    (await call<{ uploads: unknown[] }>("/api/work/uploads")).uploads,
  ).toHaveLength(before.uploads.length);
  await expect(
    call("/api/work/selection-copy", { archive: "/etc", tracks }),
  ).rejects.toThrow("不在已开放");
});
it("web settings reject every server configuration write while CLI configuration remains available", async () => {
  const { archive, config, call } = await server();
  const before = await readFile(config);
  for (const key of [
    "archive_path",
    "log_level",
    "kml_backup_dir_name",
    "google_api_key",
    "track_tag.Default",
    "output_filters",
  ]) {
    await expect(
      call("/api/work/settings", { key, value: "changed" }),
    ).rejects.toThrow("只能通过后台配置或 CLI 修改");
  }
  expect(await readFile(config)).toEqual(before);
  expect((await call<{ archive: string }>("/api/work/bootstrap")).archive).toBe(
    archive,
  );
  await new FileConfigStore({ path: config }).set("log_level", "DEBUG");
  expect((await new FileConfigStore({ path: config }).load()).log_level).toBe(
    "DEBUG",
  );
});

it.each(["archive:pop", "kml:to-multigeom"])(
  "retains historical %s tasks and downloads but rejects new requests, retries and queued execution",
  async (operation) => {
    const { dir, call, address } = await server();
    // Initialize the lazy task store, then seed records written by the older release.
    await call("/api/work/tasks");
    const store = new SqliteTasks(path.join(dir, "state/tasks.sqlite3"));
    cleanup.push(() => store.close());
    const output = path.join(dir, "old-download.kml");
    await writeFile(output, "original downloaded bytes");
    const old = store.enqueue(body());
    store.db
      .prepare("UPDATE tasks SET status='succeeded',body=? WHERE id=?")
      .run(
        JSON.stringify({
          ...old,
          status: "succeeded",
          mode: "apply",
          request: { ...old.request, operation },
          output: { paths: [output] },
        }),
        old.id,
      );
    const listed = await call<{ tasks: WorkTask[] }>("/api/work/tasks");
    expect(listed.tasks.find((t) => t.id === old.id)?.request.operation).toBe(
      operation,
    );
    expect(
      (await call<WorkTask>(`/api/work/tasks/${old.id}`)).output?.paths,
    ).toEqual([output]);
    const response = await fetch(
      address + `/api/work/tasks/${old.id}/download?index=0`,
      { headers: { "X-Tracktool-Token": "work-test" } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("original downloaded bytes");
    await expect(call(`/api/work/tasks/${old.id}/retry`, {})).rejects.toThrow();
    await expect(
      call("/api/work/preview", {
        operation,
        options: { name: "a.kml" },
      }),
    ).rejects.toThrow();
    const preview = store.enqueue(body());
    store.db
      .prepare("UPDATE tasks SET status='succeeded',body=? WHERE id=?")
      .run(
        JSON.stringify({
          ...preview,
          status: "succeeded",
          fingerprint: "old",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          request: { ...preview.request, operation },
        }),
        preview.id,
      );
    await expect(
      call(`/api/work/tasks/${preview.id}/apply`, {}),
    ).rejects.toThrow();
    let calls = 0;
    const isolated = new SqliteTasks(path.join(dir, "legacy-queue.sqlite3")),
      queue = new TaskQueue(
        isolated,
        fake({
          fingerprint: async () => {
            calls++;
            return "unchanged";
          },
          run: async () => {
            calls++;
            return { output: { paths: [] } };
          },
        }),
      );
    cleanup.push(() => queue.close());
    const queued = isolated.enqueue(body());
    isolated.db.prepare("UPDATE tasks SET body=? WHERE id=?").run(
      JSON.stringify({
        ...queued,
        request: { ...queued.request, operation },
      }),
      queued.id,
    );
    queue.start();
    await until(
      () => isolated.read(queued.id),
      (t) => t?.status === "failed",
    );
    expect(calls).toBe(0);
    expect(await readFile(output, "utf8")).toBe("original downloaded bytes");
  },
);
it("import preview distinguishes new, duplicate, conflict and invalid files without moving sources", async () => {
  const { dir, archive, call, settled } = await server();
  const bytes = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  const file = path.join(dir, "2026-10-01 导入检查.kml");
  await writeFile(file, bytes);
  const preview = () =>
    call<WorkTask>("/api/work/preview", {
      operation: "archive:push",
      archive,
      inputs: [file],
      options: { keep: true },
    }).then((t) => settled(t.id));
  const fresh = await preview();
  expect(fresh.status).toBe("succeeded");
  expect(fresh.output?.data).toMatchObject({
    import_items: [{ status: "new", category: "Train" }],
  });
  expect(await readFile(file)).toEqual(bytes);
  const applied = await call<WorkTask>(`/api/work/tasks/${fresh.id}/apply`, {});
  expect((await settled(applied.id)).status).toBe("succeeded");
  const duplicate = await preview();
  expect(duplicate.output?.data).toMatchObject({
    import_items: [{ status: "duplicate" }],
  });
  const changed = Buffer.from(
    bytes.toString().replace("</kml>", "<!-- distinct --> </kml>"),
  );
  await writeFile(file, changed);
  const conflict = await preview();
  expect(conflict.output?.data).toMatchObject({
    import_items: [{ status: "conflict" }],
  });
  const attempted = await call<WorkTask>(
    `/api/work/tasks/${conflict.id}/apply`,
    {},
  );
  expect((await settled(attempted.id)).status).toBe("failed");
  expect(await readFile(file)).toEqual(changed);
  const bad = path.join(dir, "2026-10-01 异常.kml");
  await writeFile(bad, "<kml>");
  const invalid = await call<WorkTask>("/api/work/preview", {
    operation: "archive:push",
    archive,
    inputs: [bad],
    options: { keep: true },
  });
  const result = await settled(invalid.id);
  expect(result.status).toBe("partial");
  expect(result.output?.data).toMatchObject({
    import_items: [{ status: "invalid" }],
  });
  expect(await readFile(bad, "utf8")).toBe("<kml>");
});

it("web import defaults to no Backup and rejects a mixed invalid batch without importing valid files", async () => {
  const { dir, archive, call, settled } = await server();
  const bytes = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  const good = path.join(dir, "2026-10-01 原子入库.kml"), bad = path.join(dir, "2026-10-02 异常.kml");
  await writeFile(good, bytes);
  await writeFile(bad, "<kml>");
  const catalog = () => call<{ catalog: { entries: unknown[] } }>("/api/work/catalog", { archive });
  const before = (await catalog()).catalog.entries.length;
  const mixed = await call<WorkTask>("/api/work/preview", { operation: "archive:push", archive, inputs: [good, bad] });
  const rejected = await settled(mixed.id);
  expect(rejected.status).toBe("partial");
  expect(rejected.output?.data).toMatchObject({ import_items: [{ status: "new" }, { status: "invalid" }] });
  await expect(call(`/api/work/tasks/${mixed.id}/apply`, {})).rejects.toThrow();
  expect((await catalog()).catalog.entries).toHaveLength(before);
  for (let attempt = 0; attempt < 2; attempt++) {
    const queued = await call<WorkTask>("/api/work/preview", { operation: "archive:push", archive, inputs: [good], options: { keep: false } });
    const preview = await settled(queued.id);
    expect(preview.request.options.keep).toBe(true);
    expect(preview.output?.data).toMatchObject({ import_items: [{ status: attempt ? "duplicate" : "new" }] });
    const apply = await call<WorkTask>(`/api/work/tasks/${queued.id}/apply`, {});
    const done = await settled(apply.id);
    expect(done.status, JSON.stringify(done.error)).toBe("succeeded");
    expect(done.output?.committed).toBe(true);
    expect((await catalog()).catalog.entries).toHaveLength(before + 1);
    expect(await readFile(good)).toEqual(bytes);
    await expect(stat(path.join(archive, "Backup"))).rejects.toThrow();
  }
});

it("HTTP uploaded imports clean copies after both success and invalid preview, and require reupload", async () => {
  const { address, archive, call, settled } = await server();
  const upload = async (name: string, bytes: Uint8Array) => {
    const response = await fetch(address + "/api/work/uploads?name=" + encodeURIComponent(name), {
      method: "POST",
      headers: { "X-Tracktool-Token": "work-test", "Content-Type": "application/octet-stream" },
      body: Buffer.from(bytes),
    });
    expect(response.ok).toBe(true);
    return response.json() as Promise<{ files: string[] }>;
  };
  const bytes = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  for (const valid of [true, false]) {
    const batch = await upload(valid ? "2026-10-01 清理.kml" : "2026-10-02 坏文件.kml", valid ? bytes : Buffer.from("<kml>"));
    const plan = await call<WorkTask>("/api/work/preview", { operation: "archive:push", archive, inputs: batch.files });
    await settled(plan.id);
    let id = plan.id;
    if (valid) {
      expect(existsSync(batch.files[0]!)).toBe(true);
      id = (await call<WorkTask>(`/api/work/tasks/${plan.id}/apply`, {})).id;
      expect((await settled(id)).status).toBe("succeeded");
    }
    const cleaned = await until(() => call<WorkTask>("/api/work/tasks/" + id), (task) => task.uploadsCleaned === true);
    expect(existsSync(batch.files[0]!)).toBe(false);
    expect(cleaned.request.inputs).toEqual(batch.files);
    await expect(call(`/api/work/tasks/${id}/retry`, {})).rejects.toThrow("重新上传");
    if (valid) {
      expect((await call<WorkTask>(`/api/work/tasks/${plan.id}/apply`, {})).id).toBe(id);
      const again = await upload("2026-10-01 清理.kml", bytes);
      const repeated = await call<WorkTask>("/api/work/preview", { operation: "archive:push", archive, inputs: again.files });
      expect((await settled(repeated.id)).output?.data).toMatchObject({ import_items: [{ status: "duplicate" }] });
    }
  }
});


it("per-file import names and categories match preview and atomic publication", async () => {
  const { dir, archive, call, settled } = await server();
  const bytes = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  const files = [path.join(dir, "2026-10-01 原始一.kml"), path.join(dir, "2026-10-01 原始二.kml")];
  for (const file of files) await writeFile(file, bytes);
  const importFiles = [
    { path: files[0], name: "2026-10-02 修改一.kml", category: "Default" },
    { path: files[1], name: "2026-10-03 修改二.kml", category: "Flight" },
  ];
  const plan = await call<WorkTask>("/api/work/preview", { operation: "archive:push", archive, inputs: files, options: { importFiles } });
  expect((await settled(plan.id)).output?.data).toMatchObject({ import_items: [
    { member: "Default/2026-10/2026-10-02 修改一.kml", status: "new" },
    { member: "Flight/2026-10/2026-10-03 修改二.kml", status: "new" },
  ] });
  const applied = await call<WorkTask>(`/api/work/tasks/${plan.id}/apply`, {});
  const done = await settled(applied.id);
  expect(done.status).toBe("succeeded");
  expect(done.output?.data).toMatchObject({ import_items: [
    { member: "Default/2026-10/2026-10-02 修改一.kml", entryId: expect.any(String) },
    { member: "Flight/2026-10/2026-10-03 修改二.kml", entryId: expect.any(String) },
  ] });
  expect((await call<WorkTask>(`/api/work/tasks/${plan.id}/apply`, {})).id).toBe(applied.id);
  for (const file of files) expect(await readFile(file)).toEqual(bytes);
  for (const overrides of [
    [{ path: files[0], name: "../2026-10-01.kml" }],
    [{ path: files[0] }, { path: files[0] }],
    [{ path: files[1] }],
  ]) await expect(call("/api/work/preview", { operation: "archive:push", archive, inputs: [files[0]], options: { importFiles: overrides } })).rejects.toThrow();
});
