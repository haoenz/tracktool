import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import {
  SCHEMA,
  MIGRATE_1,
} from "../../dist/node/infrastructure/archive/schema.js";
import { SCHEMA_3 } from "../../dist/node/infrastructure/archive/schema-v3.js";
import {
  transaction,
  readTransaction,
} from "../../dist/node/infrastructure/archive/database.js";
import {
  VersionStore,
  archiveId,
  currentEntry,
  publishVersions,
  type PublishRequest,
} from "../../dist/node/infrastructure/archive/versions.js";
import {
  deleteEntry,
  deleteEntryInTransaction,
  previewDeletion,
  type DeleteFault,
} from "../../dist/node/infrastructure/archive/deletion.js";
import {
  downloadBytes,
  downloadFile,
} from "../../dist/node/infrastructure/archive/download.js";
import {
  fullBackup,
  restoreBackup,
  verifyArchive,
} from "../../dist/node/infrastructure/archive/full-backup.js";
import { migrateArchive } from "../../dist/node/infrastructure/archive/migrate.js";
import { digest } from "../../dist/node/infrastructure/durable-files.js";
import type { EntrySnapshot } from "../../dist/node/domain/track-version.js";

const dirs: string[] = [];
const raw = (x = 121) =>
  Buffer.from(
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>120,30 ${x},31</coordinates></LineString></Placemark></kml>`,
  );
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
async function fixture(schema = 4) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-delete-"));
  dirs.push(dir);
  const file = path.join(dir, "archive.sqlite3"),
    writer = new ArchiveWriter();
  if (schema === 4) await writer.init(dir);
  else {
    const db = new Database(file);
    db.exec(schema === 3 ? SCHEMA_3 : SCHEMA + MIGRATE_1);
    db.prepare(
      "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'fixture')",
    ).run();
    db.close();
  }
  const id = transaction(
    file,
    true,
    (db) => addEntry(db, "a.kml", raw(), "Train").id,
  );
  return {
    dir,
    file,
    writer,
    id,
    store: new VersionStore(file),
    archive: readTransaction(file, archiveId),
  };
}
function snapshot(file: string) {
  return readTransaction(file, (db) => ({
    schema: db.pragma("user_version", { simple: true }),
    tables: Object.fromEntries(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map(({ name }) => [
        name,
        db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
    ),
  }));
}
const entry = (file: string, id: string) =>
  readTransaction(file, (db) => currentEntry(db, id));
const rows = (file: string, sql: string) =>
  readTransaction(file, (db) => db.prepare(sql).all());
function request(file: string, id: string, key = "delete") {
  const p = previewDeletion(file, { entry_id: id });
  return { archive_id: p.archive_id, request_key: key, expected: p.expected };
}
function edit(
  archive: string,
  input: EntrySnapshot,
  key = "edit",
): PublishRequest {
  return {
    archive_id: archive,
    request_key: key,
    kind: "prune",
    algorithm_version: "test",
    params: {},
    inputs: [input],
    outputs: [
      {
        kind: "version",
        entry_id: input.entry_id,
        path: input.path,
        category: input.category,
        raw: raw(122),
      },
    ],
  };
}
it("rolls back replacement publication and legacy cleanup together on failure", async () => {
  const { file, id, archive } = await fixture();
  const deletion = request(file, id, "replace-cleanup");
  const before = snapshot(file);
  const replace = (fail: boolean) =>
    transaction(file, true, (db) => {
      const imported = publishVersions(db, {
        archive_id: archive,
        request_key: "replacement-import",
        kind: "import",
        algorithm_version: "test",
        params: {},
        inputs: [],
        outputs: [
          {
            kind: "version",
            path: "original.kml",
            category: "Train",
            raw: raw(),
            origin: "imported",
          },
        ],
      });
      publishVersions(
        db,
        edit(archive, imported.entries[0]!, "replacement-edit"),
      );
      deleteEntryInTransaction(db, deletion, (point) => {
        if (fail && point === "delete-before-commit")
          throw new Error("rollback replacement");
      });
      return imported.entries[0]!.entry_id;
    });
  expect(() => replace(true)).toThrow("rollback replacement");
  expect(snapshot(file)).toEqual(before);
  const replacement = replace(false);
  expect(rows(file, "SELECT id FROM archive_entries")).toEqual([
    { id: replacement },
  ]);
  expect(
    rows(file, "SELECT version_no FROM track_versions ORDER BY version_no"),
  ).toEqual([{ version_no: 1 }, { version_no: 2 }]);
  expect(() => entry(file, id)).toThrow("Entry not found");
});
it.each([2, 3, 4])(
  "downloads schema %s with no recovery, database writes or target overwrite",
  async (schema) => {
    const { file, dir, id } = await fixture(schema);
    const db = new Database(file);
    db.pragma("journal_mode=DELETE");
    db.prepare(
      `INSERT INTO file_operations(id,operation,entry_id,sha256,source,target${schema >= 3 ? ",expected_generation" : ""}) VALUES ('pending','push',?,?,?,?${schema >= 3 ? ",1" : ""})`,
    ).run(
      id,
      digest(raw()),
      path.join(dir, "source.kml"),
      path.join(dir, "Backup/a.kml"),
    );
    db.close();
    const before = snapshot(file),
      bytes = readFileSync(file);
    expect(Buffer.from(downloadBytes(file, { name: "a" }).bytes)).toEqual(
      raw(),
    );
    const target = downloadFile(file, { entry_id: id }, path.join(dir, "out"))
      .paths[0]!;
    expect(readFileSync(target)).toEqual(raw());
    expect(() =>
      downloadFile(file, { name: "a" }, path.join(dir, "out")),
    ).toThrow("overwrite");
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "file");
    expect(() => downloadFile(file, { name: "a" }, blocked)).toThrow();
    expect(existsSync(path.join(dir, "Backup/a.kml"))).toBe(false);
    expect(snapshot(file)).toEqual(before);
    expect(readFileSync(file)).toEqual(bytes);
    expect(existsSync(file + "-wal")).toBe(false);
  },
);
it("downloads exact current, historical and source-only versions without altering settings", async () => {
  const { file, store, archive, id } = await fixture(),
    original = entry(file, id);
  store.publish(edit(archive, original));
  const source = store.publish({
    archive_id: archive,
    request_key: "source",
    kind: "import",
    algorithm_version: "test",
    params: {},
    inputs: [],
    outputs: [
      {
        kind: "version",
        path: "source.kml",
        category: null,
        raw: raw(123),
        state: "source_only",
      },
    ],
  }).entries[0]!;
  const before = snapshot(file);
  expect(Buffer.from(downloadBytes(file, { entry_id: id }).bytes)).toEqual(
    raw(122),
  );
  expect(
    Buffer.from(
      downloadBytes(file, { entry_id: id, version_id: original.version_id })
        .bytes,
    ),
  ).toEqual(raw());
  expect(
    Buffer.from(
      downloadBytes(file, {
        entry_id: source.entry_id,
        version_id: source.version_id,
      }).bytes,
    ),
  ).toEqual(raw(123));
  expect(() =>
    downloadBytes(file, { entry_id: id, version_id: source.version_id }),
  ).toThrow("does not belong");
  expect(snapshot(file)).toEqual(before);
  deleteEntry(file, request(file, source.entry_id));
  expect(store.history(source.entry_id)).toEqual([]);
});
it("deletes all owned history, prevents replay, frees the path and preserves an earlier backup/download", async () => {
  const { file, dir, id, store, archive } = await fixture(),
    original = entry(file, id),
    change = edit(archive, original);
  const edited = store.publish(change);
  store.restoreVersion(
    archive,
    edited.entries[0]!,
    original.version_id,
    original.presentation_id,
    "restore",
  );
  const output = downloadFile(file, { entry_id: id }, path.join(dir, "out"))
    .paths[0]!;
  const backup = path.join(dir, "before.sqlite3");
  await fullBackup(file, backup);
  const previous = snapshot(backup),
    plan = previewDeletion(file, { entry_id: id }),
    before = new ArchiveWriter().status(file);
  expect(plan).toMatchObject({
    versions: 3,
    presentations: 3,
    segments: 3,
    removable_objects: 2,
    dependencies: [],
  });
  const req = request(file, id),
    result = deleteEntry(file, req);
  expect(result).toMatchObject({
    entry_id: id,
    versions: 3,
    deleted_objects: 2,
  });
  for (const table of [
    "archive_entries",
    "track_versions",
    "track_segments",
    "track_presentations",
    "track_operation_inputs",
    "track_operation_effects",
    "track_source_locations",
    "track_segment_sources",
    "kml_objects",
    "kml_index",
  ])
    expect(rows(file, `SELECT * FROM ${table}`), table).toEqual([]);
  expect(() => store.read(original.version_id)).toThrow("not found");
  expect(() => store.publish(change)).toThrow("deleted members");
  expect(() =>
    store.restore(archive, edited.operation_id, "undo", edited.entries),
  ).toThrow("deleted members");
  expect(new ArchiveWriter().status(file).revision).toBeGreaterThan(
    before.revision,
  );
  const replacement = transaction(file, true, (db) =>
    addEntry(db, "a.kml", raw(), "Train"),
  );
  expect(replacement.id).not.toBe(id);
  expect(deleteEntry(file, req)).toEqual(result);
  expect(rows(file, "SELECT * FROM archive_entries")).toHaveLength(1);
  expect(() =>
    deleteEntry(file, {
      ...request(file, replacement.id),
      request_key: req.request_key,
    }),
  ).toThrow("Idempotency");
  expect(readFileSync(output)).toEqual(raw());
  expect(snapshot(backup)).toEqual(previous);
  const restored = path.join(dir, "restored");
  await restoreBackup(backup, restored);
  expect(snapshot(path.join(restored, "archive.sqlite3"))).toEqual(previous);
  const afterBackup = path.join(dir, "after.sqlite3");
  await fullBackup(file, afterBackup);
  expect(rows(afterBackup, "SELECT * FROM track_deletions")).toHaveLength(1);
  readTransaction(afterBackup, verifyArchive);
});
it("keeps shared content and other split members but disables shared-operation undo", async () => {
  const { file, store, id, archive } = await fixture(),
    original = entry(file, id);
  const req: PublishRequest = {
    archive_id: archive,
    request_key: "split",
    kind: "split_journey",
    algorithm_version: "test",
    params: {},
    inputs: [original],
    outputs: [
      { kind: "version", path: "child1.kml", raw: raw(), category: null },
      { kind: "version", path: "child2.kml", raw: raw(), category: null },
      { kind: "state", entry_id: id, state: "superseded" },
    ],
  };
  const group = store.publish(req),
    first = group.entries.find((e) => e.path === "child1.kml")!,
    second = group.entries.find((e) => e.path === "child2.kml")!;
  expect(
    previewDeletion(file, { entry_id: id })
      .dependencies.map((d) => d.id)
      .sort(),
  ).toEqual([first.entry_id, second.entry_id].sort());
  const otherHistory = store.history(second.entry_id);
  expect(previewDeletion(file, { entry_id: first.entry_id })).toMatchObject({
    removable_objects: 0,
    shared_objects: 1,
    dependencies: [],
  });
  deleteEntry(file, request(file, first.entry_id, "first"));
  expect(store.history(second.entry_id)).toEqual(otherHistory);
  expect(Buffer.from(store.read(second.version_id))).toEqual(raw());
  expect(() =>
    store.restore(archive, group.operation_id, "undo", group.entries),
  ).toThrow("deleted members");
  deleteEntry(file, request(file, second.entry_id, "second"));
  expect(rows(file, "SELECT * FROM kml_objects")).toHaveLength(1);
  deleteEntry(file, request(file, id, "source"));
  expect(rows(file, "SELECT * FROM kml_objects")).toHaveLength(0);
});
it("blocks incoming segment provenance independently of operation inputs", async () => {
  const { file, store, id, archive } = await fixture(),
    original = entry(file, id);
  const otherId = transaction(
      file,
      true,
      (db) => addEntry(db, "b.kml", raw(122), null).id,
    ),
    other = entry(file, otherId);
  const segment = (version: string) =>
    (
      rows(
        file,
        `SELECT segment_id FROM track_segments WHERE version_id='${version}'`,
      )[0] as { segment_id: string }
    ).segment_id;
  store.linkSources({
    archive_id: archive,
    request_key: "link",
    locations: [],
    lineage: [
      {
        version_id: other.version_id,
        segment_id: segment(other.version_id),
        source: {
          source_version_id: original.version_id,
          source_segment_id: segment(original.version_id),
          evidence_kind: "manual",
          evidence: {},
        },
      },
    ],
  });
  const before = snapshot(file);
  expect(previewDeletion(file, { entry_id: id }).dependencies).toEqual([
    { kind: "trajectory", id: otherId, detail: "b.kml" },
  ]);
  expect(() => deleteEntry(file, request(file, id))).toThrow("b.kml");
  expect(snapshot(file)).toEqual(before);
  deleteEntry(file, request(file, otherId, "output"));
  deleteEntry(file, request(file, id, "source"));
  readTransaction(file, verifyArchive);
});
it.each(["entry", "version", "presentation", "legacy"])(
  "rechecks a newly saved %s project dependency before deleting",
  async (kind) => {
    const { file, id, store, archive } = await fixture(),
      original = entry(file, id);
    store.publish(edit(archive, original));
    const req = request(file, id);
    const reference = {
      entry: { entry_id: id },
      version: { version_id: original.version_id },
      presentation: { presentation_id: original.presentation_id },
      legacy: { entry: original.path, sha256: original.sha256 },
    }[kind]!;
    transaction(file, true, (db) =>
      db
        .prepare(
          "INSERT INTO map_projects(name,state,updated_at) VALUES ('my-trip',?,'now')",
        )
        .run(JSON.stringify({ tracks: [reference] })),
    );
    const before = snapshot(file);
    expect(previewDeletion(file, { entry_id: id }).dependencies).toMatchObject([
      { kind: "project", id: "my-trip" },
    ]);
    expect(() => deleteEntry(file, req)).toThrow("my-trip");
    expect(snapshot(file)).toEqual(before);
  },
);
it("rejects stale references, changed archives, pending file intents and reused edit keys", async () => {
  const { file, id, archive, store } = await fixture(),
    req = request(file, id);
  expect(() => deleteEntry(file, { ...req, archive_id: "elsewhere" })).toThrow(
    "identity",
  );
  store.publish(edit(archive, entry(file, id)));
  expect(() => deleteEntry(file, req)).toThrow("changed since preview");
  const current = entry(file, id),
    fresh = request(file, id);
  expect(() => deleteEntry(file, { ...fresh, request_key: "edit" })).toThrow(
    "request key already used",
  );
  transaction(file, true, (db) =>
    db
      .prepare(
        "INSERT INTO file_operations VALUES ('pending','push',?,?,NULL,'unused',?)",
      )
      .run(id, current.sha256, current.generation),
  );
  const before = snapshot(file);
  expect(previewDeletion(file, { entry_id: id }).dependencies).toMatchObject([
    { kind: "pending", id: "pending" },
  ]);
  expect(() => deleteEntry(file, fresh)).toThrow("pending");
  expect(snapshot(file)).toEqual(before);
});
it.each(["delete-history", "delete-before-commit"] as const)(
  "rolls back all tables and receipts on %s exceptions and SIGKILL",
  async (point) => {
    const { file, id, store, archive } = await fixture();
    store.publish(edit(archive, entry(file, id)));
    const req = request(file, id),
      before = snapshot(file);
    const fault: DeleteFault = (p) => {
      if (p === point) throw new Error("fault");
    };
    expect(() => deleteEntry(file, req, fault)).toThrow("fault");
    expect(snapshot(file)).toEqual(before);
    const module = path.resolve("dist/node/infrastructure/archive/deletion.js");
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import {deleteEntry} from ${JSON.stringify(module)}; deleteEntry(${JSON.stringify(file)},${JSON.stringify(req)},p=>{if(p===${JSON.stringify(point)}) process.kill(process.pid,'SIGKILL')});`,
    ]);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe("SIGKILL");
    expect(snapshot(file)).toEqual(before);
    deleteEntry(file, req);
    readTransaction(file, verifyArchive);
  },
);
it("keeps ordinary SQL history deletion blocked and rejects new pop intents", async () => {
  const { file, id, store, archive } = await fixture();
  store.publish(edit(archive, entry(file, id)));
  const before = snapshot(file);
  for (const table of [
    "archive_entries",
    "track_versions",
    "track_segments",
    "track_presentations",
    "track_operation_inputs",
    "track_operation_effects",
    "kml_objects",
  ])
    expect(
      () =>
        transaction(file, true, (db) =>
          db.prepare(`DELETE FROM ${table}`).run(),
        ),
      table,
    ).toThrow("controlled deletion");
  expect(() =>
    transaction(file, true, (db) =>
      db
        .prepare(
          "INSERT INTO file_operations VALUES ('new','pop',?,?,NULL,'unused',1)",
        )
        .run(id, digest(raw())),
    ),
  ).toThrow("CHECK constraint failed");
  expect(snapshot(file)).toEqual(before);
});
it("explicitly migrates schema 3 preserving history and can roll back its new DDL", async () => {
  const { file, id, store, archive } = await fixture(3);
  store.publish(edit(archive, entry(file, id)));
  const before = snapshot(file);
  const { entry_id, version_id, presentation_id, generation, sha256 } = entry(
    file,
    id,
  );
  expect(() =>
    deleteEntry(file, {
      archive_id: archive,
      request_key: "bad",
      expected: { entry_id, version_id, presentation_id, generation, sha256 },
    }),
  ).toThrow("schema 4");
  await expect(
    migrateArchive(file, (p) => {
      if (p === "migration-ddl") throw new Error("fault");
    }),
  ).rejects.toThrow("fault");
  expect(snapshot(file)).toEqual(before);
  const backup = await migrateArchive(file);
  expect(snapshot(backup!)).toEqual(before);
  const after = snapshot(file);
  expect(after.schema).toBe(4);
  for (const [table, contents] of Object.entries(before.tables))
    if (table !== "archive_meta")
      expect(after.tables[table], table).toEqual(contents);
  expect(after.tables.track_deletions).toEqual([]);
  deleteEntry(file, request(file, id));
});
it("requires legacy schema 3 pop recovery before migration and retains its withdrawn semantics", async () => {
  const { file, dir, id, writer } = await fixture(3),
    target = path.join(dir, "old-pop.kml");
  transaction(file, true, (db) =>
    db
      .prepare("INSERT INTO file_operations VALUES ('old','pop',?,?,NULL,?,1)")
      .run(id, digest(raw()), target),
  );
  await expect(migrateArchive(file)).rejects.toThrow(/recover|pending/i);
  await writer.recover(file);
  expect(readFileSync(target)).toEqual(raw());
  expect(entry(file, id).state).toBe("withdrawn");
  expect(rows(file, "SELECT * FROM track_versions")).toHaveLength(1);
  await migrateArchive(file);
  expect(entry(file, id).state).toBe("withdrawn");
  deleteEntry(file, request(file, id));
  expect(readFileSync(target)).toEqual(raw());
});
