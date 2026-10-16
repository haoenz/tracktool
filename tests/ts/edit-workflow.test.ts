import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import {
  transaction,
  readTransaction,
} from "../../dist/node/infrastructure/archive/database.js";
import { VersionStore } from "../../dist/node/infrastructure/archive/versions.js";
import { EditPreviews } from "../../dist/node/infrastructure/archive/edit-previews.js";
import {
  trackDetail,
  trackHistory,
  trackTimeline,
  operationDetail,
} from "../../dist/node/infrastructure/archive/track-reader.js";
import { downloadBytes } from "../../dist/node/infrastructure/archive/download.js";
import {
  EditRequestSchema,
  type EditRequest,
  type EditPreview,
  type VersionRef,
} from "../../dist/node/shared/track-edit.js";
import { WorkRequestSchema } from "../../dist/node/shared/work.js";
import { SqliteTasks } from "../../dist/node/infrastructure/task-store.js";
import { TaskQueue } from "../../dist/node/infrastructure/task-queue.js";
import type { WorkRunner } from "../../dist/node/services/work-ports.js";
import { createApp } from "../../dist/node/server/app.js";
import { DEFAULTS } from "../../dist/node/domain/config.js";
import type { WorkTask } from "../../dist/node/shared/work.js";

const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const raw = Buffer.from(
  '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>A</name><LineString><coordinates>120,30 120.01,30 120.02,30 120.03,30</coordinates></LineString></Placemark><Placemark><name>B</name><LineString><coordinates>120.04,30 120.05,30</coordinates></LineString></Placemark></Document></kml>',
);
const ref = (e: VersionRef): VersionRef => ({
  entry_id: e.entry_id,
  version_id: e.version_id,
  presentation_id: e.presentation_id,
  generation: e.generation,
  sha256: e.sha256,
});
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-p3-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  await new ArchiveWriter().init(dir);
  const file = path.join(dir, "archive.sqlite3"),
    state = path.join(dir, "tasks.sqlite3");
  const id = transaction(
    file,
    true,
    (db) => addEntry(db, "Default/2026-10-01 A.kml", raw, "Default").id,
  );
  let now = Date.now();
  const previews = new EditPreviews(state, () => now);
  cleanup.push(() => previews.close());
  const detail = trackDetail(file, id),
    version = new VersionStore(file);
  const request = (operation: EditRequest["operation"]): EditRequest =>
    EditRequestSchema.parse(
      operation.kind === "restore_group"
        ? { schema: 1, archive_id: detail.archive_id, operation }
        : {
            schema: 1,
            archive_id: detail.archive_id,
            target: ref(detail.entry),
            operation,
          },
    );
  const split = () =>
    request({
      kind: "split_segment",
      segment_id: detail.segments[0]!.segment_id,
      after_point_indices: [1],
    });
  return {
    dir,
    file,
    state,
    id,
    previews,
    detail,
    version,
    request,
    split,
    expire: () => {
      now += 86400001;
    },
  };
}
const apply = (p: EditPreview, key = `apply:${p.preview_id}`) => ({
  schema: 1 as const,
  archive_id: p.archive_id,
  preview_id: p.preview_id,
  preview_sha256: p.preview_sha256,
  request_key: key,
});
function snap(file: string) {
  return readTransaction(file, (db) => ({
    entries: db.prepare("SELECT * FROM archive_entries ORDER BY id").all(),
    meta: db.prepare("SELECT * FROM archive_meta").all(),
    versions: db.prepare("SELECT * FROM track_versions ORDER BY id").all(),
    objects: db.prepare("SELECT * FROM kml_objects ORDER BY sha256").all(),
  }));
}
it("persists a read-only preview, reopens it, publishes stable segments and keeps raw history", async () => {
  const f = await fixture(),
    before = snap(f.file),
    p = await f.previews.create(f.file, randomUUID(), f.split());
  expect(snap(f.file)).toEqual(before);
  expect(p.outputs[0]!.segments).toHaveLength(3);
  const reopened = new EditPreviews(f.state);
  try {
    expect(reopened.get(f.file, p.preview_id)).toEqual(p);
    expect(
      (await reopened.geometry(f.file, p.preview_id, 0)).segments,
    ).toHaveLength(3);
    const result = reopened.apply(f.file, apply(p));
    expect(result.entries[0]!.entry_id).toBe(f.id);
    expect(trackDetail(f.file, f.id).segments.map((s) => s.segment_id)).toEqual(
      p.outputs[0]!.segments.map((s) => s.segment_id),
    );
    expect(trackHistory(f.file, f.id).versions).toHaveLength(2);
    expect(
      Buffer.from(
        downloadBytes(f.file, {
          entry_id: f.id,
          version_id: f.detail.entry.version_id,
        }).bytes,
      ),
    ).toEqual(raw);
    expect(reopened.apply(f.file, apply(p))).toEqual(result);
  } finally {
    reopened.close();
  }
});
it.each(["manifest", "blob", "hash"])(
  "rejects tampered %s before writing archive",
  async (what) => {
    const f = await fixture(),
      p = await f.previews.create(f.file, randomUUID(), f.split()),
      before = snap(f.file),
      db = new Database(f.state),
      input = apply(p);
    if (what === "manifest")
      db.prepare(
        "UPDATE edit_previews SET manifest=json_set(manifest,'$.outputs[0].path','bad.kml') WHERE id=?",
      ).run(p.preview_id);
    else if (what === "blob")
      db.prepare(
        "UPDATE edit_preview_objects SET raw=X'00' WHERE preview_id=?",
      ).run(p.preview_id);
    else input.preview_sha256 = "0".repeat(64);
    db.close();
    expect(() => f.previews.apply(f.file, input)).toThrow(/校验/);
    expect(snap(f.file)).toEqual(before);
  },
);
it("rejects expired unapplied previews but replays committed receipts after expiry and cleanup", async () => {
  const f = await fixture(),
    p = await f.previews.create(f.file, randomUUID(), f.split()),
    unused = await f.previews.create(f.file, randomUUID(), f.split());
  const result = f.previews.apply(f.file, apply(p));
  f.expire();
  expect(() => f.previews.apply(f.file, apply(unused))).toThrow("过期");
  const db = new Database(f.state);
  db.exec("DELETE FROM edit_preview_objects;DELETE FROM edit_previews");
  db.close();
  expect(f.previews.apply(f.file, apply(p))).toEqual(result);
  expect(() =>
    f.previews.apply(f.file, { ...apply(p), preview_sha256: "0".repeat(64) }),
  ).toThrow("不同");
});
it("ignores unrelated revisions but rejects stale presentation generations even with identical raw bytes", async () => {
  const f = await fixture(),
    p = await f.previews.create(f.file, randomUUID(), f.split());
  transaction(f.file, true, (db) =>
    addEntry(db, "Default/unrelated.kml", raw, "Default"),
  );
  const settings = structuredClone(f.detail.settings);
  settings.default_connect = false;
  const presentation = await f.previews.create(
    f.file,
    randomUUID(),
    f.request({ kind: "presentation", settings }),
  );
  f.previews.apply(f.file, apply(presentation));
  expect(trackHistory(f.file, f.id).versions).toHaveLength(1);
  const timeline = trackTimeline(f.file, f.id);
  expect(timeline.events).toHaveLength(2);
  expect(timeline.events[0]).toMatchObject({
    kind: "presentation",
    title: "调整显示",
    current: true,
  });
  expect(timeline.events[1]!.current).toBe(false);
  expect(timeline.events[0]!.after.version_id).toBe(
    timeline.events[1]!.after.version_id,
  );
  expect(timeline.events[0]!.after.presentation_id).not.toBe(
    timeline.events[1]!.after.presentation_id,
  );

  expect(() => f.previews.apply(f.file, apply(p))).toThrow(/changed/);
  const d = trackDetail(f.file, f.id),
    next = EditRequestSchema.parse({ ...f.split(), target: ref(d.entry) });
  const valid = await f.previews.create(f.file, randomUUID(), next);
  transaction(f.file, true, (db) =>
    addEntry(db, "Default/another.kml", raw, "Default"),
  );
  expect(f.previews.apply(f.file, apply(valid)).entries).toHaveLength(1);
});
it("splits independent journeys atomically, restores their whole group and prevents duplicated active history", async () => {
  const f = await fixture(),
    outputs = f.detail.segments.map((s, i) => ({
      path: `Train/2026-10-01 new${i}.kml`,
      category: "Train" as const,
      segment_ids: [s.segment_id],
    }));
  const p = await f.previews.create(
      f.file,
      randomUUID(),
      f.request({ kind: "split_journey", outputs }),
    ),
    result = f.previews.apply(f.file, apply(p));
  expect(result.entries.map((e) => e.state)).toEqual([
    "superseded",
    "active",
    "active",
  ]);
  expect(new ArchiveWriter().status(f.file).entries).toBe(2);
  for (const entry of result.entries) {
    expect(trackTimeline(f.file, entry.entry_id).events[0]).toMatchObject({
      id: result.operation_id,
      kind: "split_journey",
      current: true,
    });
  }

  await expect(
    f.previews.create(
      f.file,
      randomUUID(),
      EditRequestSchema.parse({
        ...f.request({
          kind: "restore_version",
          version_id: f.detail.entry.version_id,
          presentation_id: f.detail.entry.presentation_id,
        }),
        target: ref(result.entries[0]!),
      }),
    ),
  ).rejects.toThrow("撤销原操作组");
  const restore = await f.previews.create(
    f.file,
    randomUUID(),
    f.request({
      kind: "restore_group",
      operation_id: result.operation_id,
      expected: result.entries.map(ref),
    }),
  );
  const undone = f.previews.apply(f.file, apply(restore));
  expect(undone.entries.find((e) => e.entry_id === f.id)!.state).toBe("active");
  expect(
    undone.entries
      .filter((e) => e.entry_id !== f.id)
      .every((e) => e.state === "source_only"),
  ).toBe(true);
  expect(new ArchiveWriter().status(f.file).entries).toBe(1);
  expect(f.previews.apply(f.file, apply(restore))).toEqual(undone);
});
it("rejects incomplete journey partitions and handles a path conflict arising after preview without partial outputs", async () => {
  const f = await fixture(),
    outputs = f.detail.segments.map((s, i) => ({
      path: `n${i}.kml`,
      category: null,
      segment_ids: [s.segment_id],
    }));
  await expect(
    f.previews.create(
      f.file,
      randomUUID(),
      f.request({ kind: "split_journey", outputs: [outputs[0]!, outputs[0]!] }),
    ),
  ).rejects.toThrow("只能分配");
  const p = await f.previews.create(
    f.file,
    randomUUID(),
    f.request({ kind: "split_journey", outputs }),
  );
  transaction(f.file, true, (db) => addEntry(db, "n1.kml", raw, null));
  const before = snap(f.file);
  expect(() => f.previews.apply(f.file, apply(p))).toThrow();
  expect(snap(f.file)).toEqual(before);
});
it("restores a fixed historical version with its original IDs and settings while retaining later versions", async () => {
  const f = await fixture(),
    p = await f.previews.create(f.file, randomUUID(), f.split());
  f.previews.apply(f.file, apply(p));
  const current = trackDetail(f.file, f.id),
    request = EditRequestSchema.parse({
      ...f.request({
        kind: "restore_version",
        version_id: f.detail.entry.version_id,
        presentation_id: f.detail.entry.presentation_id,
      }),
      target: ref(current.entry),
    });
  const preview = await f.previews.create(f.file, randomUUID(), request);
  f.previews.apply(f.file, apply(preview));
  expect(trackHistory(f.file, f.id).versions).toHaveLength(3);
  const after = trackDetail(f.file, f.id);
  expect(after.entry.sha256).toBe(f.detail.entry.sha256);
  expect(after.settings).toEqual(f.detail.settings);
  expect(after.segments).toEqual(f.detail.segments);
});
it("group restore detects later edits to any member at apply time", async () => {
  const f = await fixture(),
    p = await f.previews.create(f.file, randomUUID(), f.split()),
    result = f.previews.apply(f.file, apply(p));
  const undo = await f.previews.create(
    f.file,
    randomUUID(),
    f.request({
      kind: "restore_group",
      operation_id: result.operation_id,
      expected: result.entries.map(ref),
    }),
  );
  const d = trackDetail(f.file, f.id);
  f.version.publish({
    archive_id: d.archive_id,
    request_key: "later",
    kind: "presentation",
    algorithm_version: "test",
    params: {},
    inputs: [ref(d.entry)],
    outputs: [
      {
        kind: "presentation",
        entry_id: f.id,
        settings: { ...d.settings, default_connect: false },
      },
    ],
  });
  const before = snap(f.file);
  expect(() => f.previews.apply(f.file, apply(undo))).toThrow(/changed/);
  expect(snap(f.file)).toEqual(before);
});
it("cancellation before commit does not change the archive", async () => {
  const f = await fixture(),
    p = await f.previews.create(f.file, randomUUID(), f.split()),
    before = snap(f.file),
    controller = new AbortController();
  controller.abort();
  expect(() => f.previews.apply(f.file, apply(p), controller.signal)).toThrow(
    "取消",
  );
  expect(snap(f.file)).toEqual(before);
});
it("task queue forbids apply-as-preview and committed results survive late cancellation", async () => {
  const f = await fixture(),
    store = new SqliteTasks(f.state);
  const runner: WorkRunner = {
    normalize: async (r) => r,
    fingerprint: async () => {
      throw new Error("must not fingerprint edits");
    },
    run: async () => {
      const running = store.list().find((t) => t.status === "running")!;
      store.cancel(running.id, running.revision);
      return {
        output: { paths: [], committed: true, data: { operation_id: "saved" } },
      };
    },
  };
  const queue = new TaskQueue(store, runner);
  cleanup.push(() => queue.close());
  const p = await f.previews.create(f.file, randomUUID(), f.split());
  await expect(
    queue.preview(
      WorkRequestSchema.parse({
        operation: "track:apply",
        options: { trackApply: apply(p) },
      }),
    ),
  ).rejects.toThrow("不能作为预览");
  const task = await queue.applyEdit(apply(p));
  await until(
    () => store.read(task.id)!,
    (t) => t.status !== "running" && t.status !== "queued",
  );
  expect(store.read(task.id)!.status).toBe("succeeded");
});
async function until<T>(
  read: () => T | Promise<T>,
  done: (t: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const t = await read();
    if (done(t)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("task timeout");
}
it("CLI uses the same persisted preview and idempotent apply; dry runs leave both databases untouched", async () => {
  const f = await fixture(),
    config = path.join(f.dir, "config.json"),
    input = path.join(f.dir, "request.json");
  writeFileSync(config, JSON.stringify({ ...DEFAULTS, archive_path: f.dir }));
  writeFileSync(input, JSON.stringify(f.split()));
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["dist/node/cli/main.js", ...args, "--config", config],
      { encoding: "utf8", timeout: 15000 },
    );
  const before = snap(f.file),
    dry = run("track", "preview", input, "--dry-run");
  expect(dry.status, dry.stderr).toBe(0);
  expect(JSON.parse(dry.stdout).persisted).toBe(false);
  expect(snap(f.file)).toEqual(before);
  const plan = run("track", "preview", input, "--state-dir", f.dir);
  expect(plan.status, plan.stderr).toBe(0);
  const p = JSON.parse(plan.stdout) as EditPreview;
  const applied = run(
    "track",
    "apply",
    p.preview_id,
    "--sha",
    p.preview_sha256,
    "--state-dir",
    f.dir,
  );
  expect(applied.status, applied.stderr).toBe(0);
  const retry = run(
    "track",
    "apply",
    p.preview_id,
    "--sha",
    p.preview_sha256,
    "--state-dir",
    f.dir,
  );
  expect(retry.status, retry.stderr).toBe(0);
  expect(JSON.parse(retry.stdout)).toEqual(JSON.parse(applied.stdout));
  expect(
    JSON.parse(run("track", "history", f.id).stdout).versions,
  ).toHaveLength(2);
  expect(readFileSync(input, "utf8")).toBe(JSON.stringify(f.split()));
}, 30000);
it("HTTP edits use the fixed archive, survive restart, expose history and reject retired operations", async () => {
  const f = await fixture();
  let app = await createApp({
    configStore: { load: async () => ({ ...DEFAULTS, archive_path: f.dir }) },
    token: "test",
    work: { archive: f.dir, stateDir: path.join(f.dir, "web"), roots: [f.dir] },
  });
  cleanup.push(() => app.close());
  async function start() {
    await app.listen({ host: "127.0.0.1", port: 0 });
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }
  let base = await start();
  async function call(route: string, body?: unknown) {
    return fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-tracktool-token": "test",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  expect((await call("/api/tracks")).status).toBe(200);
  expect(
    (
      await call("/api/tracks/edit-previews", {
        ...f.split(),
        archive: "/tmp/untrusted.sqlite3",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/api/work/preview", {
        operation: "kml:to-multigeom",
        inputs: [],
        options: {},
      })
    ).status,
  ).toBe(400);
  const response = await call("/api/tracks/edit-previews", f.split());
  expect(response.status).toBe(202);
  const created = (await response.json()) as {
    task_id: string;
    preview_id: string;
  };
  const planned = await until(
    async () =>
      (await (
        await call(`/api/work/tasks/${created.task_id}`)
      ).json()) as WorkTask,
    (t) => !["queued", "running"].includes(t.status),
  );
  expect(planned.status, JSON.stringify(planned.error)).toBe("succeeded");
  await app.close();
  app = await createApp({
    configStore: { load: async () => ({ ...DEFAULTS, archive_path: f.dir }) },
    token: "test",
    work: { archive: f.dir, stateDir: path.join(f.dir, "web"), roots: [f.dir] },
  });
  base = await start();
  const p = (await (
    await call(`/api/tracks/edit-previews/${created.preview_id}`)
  ).json()) as EditPreview;
  const applied = (await (
    await call(`/api/tracks/edit-previews/${p.preview_id}/apply`, apply(p))
  ).json()) as { task_id: string };
  const done = await until(
    async () =>
      (await (
        await call(`/api/work/tasks/${applied.task_id}`)
      ).json()) as WorkTask,
    (t) => !["queued", "running"].includes(t.status),
  );
  expect(done.status, JSON.stringify(done.error)).toBe("succeeded");
  expect((await call(`/api/tracks/${f.id}/sources`)).status).toBe(200);
  expect(
    (await call(`/api/tracks/${f.id}/versions/${f.detail.entry.version_id}`))
      .status,
  ).toBe(200);
  const original = await call(
    `/api/tracks/${f.id}/versions/${f.detail.entry.version_id}/raw`,
  );
  expect(Buffer.from(await original.arrayBuffer())).toEqual(raw);
  const result = done.output!.data as { operation_id: string };
  expect(operationDetail(f.file, result.operation_id).effects).toHaveLength(1);
}, 30000);

it("regroups complete legacy members atomically, preserves display and restores the group", async () => {
  const f = await fixture();
  const second = transaction(
    f.file,
    true,
    (db) => addEntry(db, "Default/2026-10-01 B.kml", raw, "Default").id,
  );
  const members = [f.detail, trackDetail(f.file, second)];
  const op = {
    kind: "legacy_regroup" as const,
    expected: members.map((d) => ref(d.entry)),
    path: "Default/2026-10-01 regroup.kml",
    category: "Default" as const,
    segments: members.flatMap((d) =>
      d.settings.order.map((segment_id) => ({
        version_id: d.entry.version_id,
        segment_id,
      })),
    ),
    evidence: "synthetic complete legacy results; preserve old view",
  };
  const request = {
    schema: 1 as const,
    archive_id: f.detail.archive_id,
    operation: op,
  };
  const before = snap(f.file);
  const p = await f.previews.create(f.file, randomUUID(), request);
  expect(snap(f.file)).toEqual(before);
  expect(p.before).toHaveLength(2);
  expect(p.outputs[0]!.settings.connections).toHaveLength(2);
  expect(p.changes[0]!.added_points).toBe(0);
  expect(p.outputs[0]!.segments).toHaveLength(4);
  const result = f.previews.apply(f.file, apply(p));
  expect(result.entries.filter((e) => e.state === "active")).toHaveLength(1);
  expect(result.entries.filter((e) => e.state === "superseded")).toHaveLength(
    2,
  );
  expect(f.previews.apply(f.file, apply(p))).toEqual(result);
  const restored = f.version.restore(
    f.detail.archive_id,
    result.operation_id,
    randomUUID(),
    result.entries.map(ref),
  );
  expect(restored.entries.filter((e) => e.state === "active")).toHaveLength(2);
  expect(
    restored.entries.find(
      (e) => !members.some((m) => m.entry.entry_id === e.entry_id),
    )!.state,
  ).toBe("source_only");
  expect(Buffer.from(f.version.read(members[0]!.entry.version_id))).toEqual(
    raw,
  );
  const again = await f.previews.create(f.file, randomUUID(), {
    ...request,
    operation: {
      ...op,
      path: "Default/2026-10-01 regroup-again.kml",
      expected: members.map((m) => ref(f.version.current(m.entry.entry_id))),
    },
  });
  const reapplied = f.previews.apply(f.file, apply(again)),
    output = reapplied.entries.find((e) => e.state === "active")!;
  const d = trackDetail(f.file, output.entry_id);
  f.version.publish({
    archive_id: d.archive_id,
    request_key: randomUUID(),
    kind: "presentation",
    algorithm_version: "test",
    params: {},
    inputs: [ref(d.entry)],
    outputs: [
      {
        kind: "presentation",
        entry_id: output.entry_id,
        settings: { ...d.settings, ignored: [d.settings.order[0]!] },
      },
    ],
  });
  expect(() =>
    f.version.restore(
      d.archive_id,
      reapplied.operation_id,
      randomUUID(),
      reapplied.entries.map((e) => ref(f.version.current(e.entry_id))),
    ),
  ).toThrow(/changed/);
});
it("rejects partial, duplicate, mixed-category and stale regroup members without publishing", async () => {
  const f = await fixture();
  const other = transaction(
      f.file,
      true,
      (db) => addEntry(db, "Train/2026-10-01 B.kml", raw, "Train").id,
    ),
    d = trackDetail(f.file, other);
  const op = {
    kind: "legacy_regroup" as const,
    expected: [ref(f.detail.entry), ref(d.entry)],
    path: "Default/2026-10-01 grouped.kml",
    category: "Default" as const,
    segments: [
      ...f.detail.segments.map((s) => ({
        version_id: f.detail.entry.version_id,
        segment_id: s.segment_id,
      })),
      ...d.segments.map((s) => ({
        version_id: d.entry.version_id,
        segment_id: s.segment_id,
      })),
    ],
    evidence: "synthetic",
  };
  const request = {
      schema: 1 as const,
      archive_id: d.archive_id,
      operation: op,
    },
    before = snap(f.file);
  await expect(
    f.previews.create(f.file, randomUUID(), request),
  ).rejects.toThrow("不同分类");
  const same = transaction(
      f.file,
      true,
      (db) => addEntry(db, "Default/2026-10-01 C.kml", raw, "Default").id,
    ),
    c = trackDetail(f.file, same);
  op.expected[1] = ref(c.entry);
  op.segments.splice(
    2,
    2,
    ...c.segments.map((s) => ({
      version_id: c.entry.version_id,
      segment_id: s.segment_id,
    })),
  );
  await expect(
    f.previews.create(f.file, randomUUID(), {
      ...request,
      operation: { ...op, segments: op.segments.slice(1) },
    }),
  ).rejects.toThrow("全部段");
  await expect(
    f.previews.create(f.file, randomUUID(), {
      ...request,
      operation: { ...op, expected: [op.expected[0]!, op.expected[0]!] },
    }),
  ).rejects.toThrow("重复");
  const p = await f.previews.create(f.file, randomUUID(), request);
  f.version.publish({
    archive_id: d.archive_id,
    request_key: randomUUID(),
    kind: "presentation",
    algorithm_version: "test",
    params: {},
    inputs: [ref(c.entry)],
    outputs: [
      {
        kind: "presentation",
        entry_id: same,
        settings: { ...c.settings, default_connect: false },
      },
    ],
  });
  const current = snap(f.file);
  expect(() => f.previews.apply(f.file, apply(p))).toThrow("changed");
  expect(snap(f.file)).toEqual(current);
  expect(f.version.current(f.id)).toEqual(f.detail.entry);
  expect(before.entries).toHaveLength(2);
});

it("regroup preserves ignored segments and their latent connections without adding a cross-file edge", async () => {
  const f = await fixture(),
    second = transaction(
      f.file,
      true,
      (db) => addEntry(db, "Default/2026-10-01 other.kml", raw, "Default").id,
    );
  f.version.publish({
    archive_id: f.detail.archive_id,
    request_key: randomUUID(),
    kind: "presentation",
    algorithm_version: "test",
    params: {},
    inputs: [ref(f.detail.entry)],
    outputs: [
      {
        kind: "presentation",
        entry_id: f.id,
        settings: {
          ...f.detail.settings,
          ignored: [f.detail.settings.order[0]!],
        },
      },
    ],
  });
  const members = [trackDetail(f.file, f.id), trackDetail(f.file, second)];
  const p = await f.previews.create(f.file, randomUUID(), {
    schema: 1,
    archive_id: f.detail.archive_id,
    operation: {
      kind: "legacy_regroup",
      expected: members.map((d) => ref(d.entry)),
      path: "Default/2026-10-01 hidden-regroup.kml",
      category: "Default",
      segments: members.flatMap((d) =>
        d.settings.order.map((segment_id) => ({
          version_id: d.entry.version_id,
          segment_id,
        })),
      ),
      evidence: "synthetic visibility test",
    },
  });
  expect(p.outputs[0]!.settings.ignored).toHaveLength(1);
  expect(p.outputs[0]!.settings.connections).toHaveLength(2);
  expect(
    (await f.previews.geometry(f.file, p.preview_id, 0)).connections,
  ).toHaveLength(1);
  expect(p.changes[0]!.before_edges).toHaveLength(1);
  expect(p.changes[0]!.after_edges).toHaveLength(1);
});

it.each(["set_tag", "fill_altitude"] as const)(
  "%s previews preserve segment settings, history and reject stale apply",
  async (kind) => {
    const f = await fixture();
    const request = f.request(
      kind === "set_tag" ? { kind, tag: "徒步" } : { kind },
    );
    const transformed = Buffer.from(
      raw
        .toString()
        .replace("<name>A</name>", "<name>徒步</name>")
        .replace("120,30 ", "120,30,42 "),
    );
    const before = snap(f.file);
    const p = await f.previews.create(
      f.file,
      randomUUID(),
      request,
      undefined,
      async () => transformed,
    );
    const stale = await f.previews.create(
      f.file,
      randomUUID(),
      request,
      undefined,
      async () => transformed,
    );
    expect(snap(f.file)).toEqual(before);
    if (kind === "fill_altitude")
      expect(p.altitude).toEqual({ filled: 1, remaining: 5 });
    expect(p.outputs[0]!.settings).toEqual(f.detail.settings);
    expect(p.outputs[0]!.segments.map((s) => s.segment_id)).toEqual(
      f.detail.segments.map((s) => s.segment_id),
    );
    const result = f.previews.apply(f.file, apply(p));
    expect(result.entries[0]!.entry_id).toBe(f.id);
    expect(
      Buffer.from(downloadBytes(f.file, { entry_id: f.id }).bytes),
    ).toEqual(transformed);
    expect(
      Buffer.from(
        downloadBytes(f.file, {
          entry_id: f.id,
          version_id: f.detail.entry.version_id,
        }).bytes,
      ),
    ).toEqual(raw);
    expect(trackHistory(f.file, f.id).versions).toHaveLength(2);
    expect(() => f.previews.apply(f.file, apply(stale))).toThrow();
    expect(f.previews.apply(f.file, apply(p))).toEqual(result);
  },
);

it("property transforms reject unexpected geometry changes without modifying the archive", async () => {
  const f = await fixture(),
    before = snap(f.file);
  await expect(
    f.previews.create(
      f.file,
      randomUUID(),
      f.request({ kind: "fill_altitude" }),
      undefined,
      async () => Buffer.from(raw.toString().replace("120.01,30 ", "")),
    ),
  ).rejects.toThrow("分段或点数");
  expect(snap(f.file)).toEqual(before);
});

it("direct HTTP download pins displayed content and creates neither tasks nor temporary files", async () => {
  const f = await fixture();
  const oldSha = f.detail.entry.sha256;
  const preview = await f.previews.create(f.file, randomUUID(), f.split());
  f.previews.apply(f.file, apply(preview));
  const currentSha = trackDetail(f.file, f.id).entry.sha256;
  expect(currentSha).not.toBe(oldSha);
  const app = await createApp({
    configStore: { load: async () => ({ ...DEFAULTS, archive_path: f.dir }) },
    token: "test",
    work: { archive: f.dir, stateDir: path.join(f.dir, "web"), roots: [f.dir] },
  });
  cleanup.push(() => app.close());
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const get = (url: string) =>
    fetch(base + url, { headers: { "x-tracktool-token": "test" } });
  const before = snap(f.file);
  const uploads = path.join(f.dir, "web", "uploads");
  const files = readdirSync(uploads, { recursive: true });
  const tasks = await (await get("/api/work/tasks")).json();
  const old = await get(`/api/tracks/${f.id}/download?sha256=${oldSha}`);
  expect(old.status).toBe(200);
  expect(Buffer.from(await old.arrayBuffer())).toEqual(raw);
  expect(old.headers.get("content-type")).toContain(
    "application/vnd.google-earth.kml+xml",
  );
  expect(old.headers.get("content-disposition")).toContain("attachment;");
  const current = await get(
    `/api/tracks/${f.id}/download?sha256=${currentSha}`,
  );
  expect(current.status).toBe(200);
  expect(Buffer.from(await current.arrayBuffer())).toEqual(
    Buffer.from(downloadBytes(f.file, { entry_id: f.id }).bytes),
  );
  expect(
    (await get(`/api/tracks/${f.id}/download?sha256=${"f".repeat(64)}`)).status,
  ).toBe(400);
  expect((await get(`/api/tracks/${f.id}/download`)).status).toBe(400);
  expect(readdirSync(uploads, { recursive: true })).toEqual(files);
  expect(await (await get("/api/work/tasks")).json()).toEqual(tasks);
  expect(snap(f.file)).toEqual(before);
});

it("split journeys store their selected activity tags atomically", async () => {
  const f = await fixture(),
    xml = new XmlWorkers(1, 0);
  cleanup.push(() => xml.close());
  const outputs = f.detail.segments.map((segment, i) => ({
    path: `Default/result-${i}.kml`,
    category: "Default" as const,
    tag: i ? "驾车" : "徒步",
    segment_ids: [segment.segment_id],
  }));
  const before = snap(f.file);
  const preview = await f.previews.create(
    f.file,
    randomUUID(),
    f.request({ kind: "split_journey", outputs }),
    undefined,
    async (bytes, op) => {
      if (op.kind !== "set_tag") throw Error("unexpected operation");
      const result = await xml.run(bytes, {
        kind: "edit",
        operation: { kind: "set-tag", tag: op.tag, create: true },
      });
      return Buffer.from(result.edit!.outputs[0]!.xml);
    },
  );
  expect(snap(f.file)).toEqual(before);
  const result = f.previews.apply(f.file, apply(preview));
  for (const output of outputs) {
    const entry = result.entries.find((e) => e.path === output.path)!;
    expect(
      (
        await xml.run(
          downloadBytes(f.file, { entry_id: entry.entry_id }).bytes,
          { kind: "content" },
        )
      ).content!.tag,
    ).toBe(output.tag);
  }
});
