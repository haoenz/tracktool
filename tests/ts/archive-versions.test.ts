import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_3 } from "../../dist/node/infrastructure/archive/schema-v3.js";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import { ArchiveStore } from "../../dist/node/infrastructure/archive/store.js";
import {
  SCHEMA,
  MIGRATE_1,
} from "../../dist/node/infrastructure/archive/schema.js";
import {
  transaction,
  rawObject,
} from "../../dist/node/infrastructure/archive/database.js";
import {
  migrateArchive,
  type MigrationFault,
} from "../../dist/node/infrastructure/archive/migrate.js";
import {
  fullBackup,
  restoreBackup,
  verifyArchive,
} from "../../dist/node/infrastructure/archive/full-backup.js";
import {
  VersionStore,
  archiveId,
  currentEntry,
  type PublishRequest,
} from "../../dist/node/infrastructure/archive/versions.js";
import { digest } from "../../dist/node/infrastructure/durable-files.js";
import { readManifest } from "../../dist/node/infrastructure/xml/manifest.js";
import type {
  EntrySnapshot,
  Presentation,
} from "../../dist/node/domain/track-version.js";

const directories: string[] = [];
function temporary() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-versions-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const kml = (coordinates = "120,30 121,31") =>
  Buffer.from(
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString><coordinates>${coordinates}</coordinates></LineString></Placemark></Document></kml>`,
  );
const raw = kml();
function legacy(version = 2) {
  const directory = temporary(),
    file = path.join(directory, "archive.sqlite3"),
    db = new Database(file);
  db.pragma("foreign_keys=ON");
  db.exec(SCHEMA);
  if (version === 2) db.exec(MIGRATE_1);
  else db.pragma("user_version=1");
  db.exec("BEGIN");
  db.prepare(
    "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'legacy-fixture')",
  ).run();
  addEntry(db, "a.kml", raw, "Train");
  addEntry(db, "bad.kml", Buffer.from("broken XML"), null);
  db.prepare("INSERT INTO map_projects VALUES ('trip','{}','old-time')").run();
  if (version === 2)
    db.prepare("INSERT INTO export_receipts VALUES ('old.zip',2)").run();
  db.exec("COMMIT");
  db.close();
  return { directory, file };
}
function rows(file: string, sql: string): unknown[] {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
function logical(file: string): unknown {
  const db = new Database(file, { readonly: true });
  try {
    return {
      schema: db.pragma("user_version", { simple: true }),
      tables: (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map(({ name }) => ({
        name,
        rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      })),
    };
  } finally {
    db.close();
  }
}
async function initialized(version = 5) {
  const directory = temporary(),
    file = path.join(directory, "archive.sqlite3"),
    writer = new ArchiveWriter();
  if (version === 5) await writer.init(directory);
  else {
    const db = new Database(file);
    db.exec(SCHEMA_3);
    db.prepare(
      "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'schema3')",
    ).run();
    db.close();
  }
  const entry = transaction(file, true, (db) => {
    const e = addEntry(db, "a.kml", raw, "Train");
    return currentEntry(db, e.id);
  });
  return {
    directory,
    file,
    writer,
    entry,
    store: new VersionStore(file),
    archive: transaction(file, false, archiveId),
  };
}
function change(
  archive: string,
  input: EntrySnapshot,
  key: string,
  bytes = kml("120,30 122,32"),
): PublishRequest {
  return {
    archive_id: archive,
    request_key: key,
    kind: "prune",
    algorithm_version: "test-v1",
    params: {},
    inputs: [input],
    outputs: [
      {
        kind: "version",
        entry_id: input.entry_id,
        path: input.path,
        category: input.category,
        raw: bytes,
      },
    ],
  };
}
function settings(file: string, entry: EntrySnapshot): Presentation {
  return JSON.parse(
    (
      rows(
        file,
        `SELECT settings_json FROM track_presentations WHERE id='${entry.presentation_id}'`,
      )[0] as { settings_json: string }
    ).settings_json,
  ) as Presentation;
}
it.each([1, 2])(
  "migrates schema %s without changing raw bytes, entry identity, caches or projects",
  async (version) => {
    const { file } = legacy(version),
      original = logical(file);
    const backup = await migrateArchive(file);
    expect(logical(backup!)).toEqual(original);
    expect(
      rows(
        file,
        "SELECT id,path,sha256,category,filename_date FROM active_archive_entries ORDER BY path",
      ),
    ).toEqual(
      rows(
        backup!,
        "SELECT id,path,sha256,category,filename_date FROM archive_entries ORDER BY path",
      ),
    );
    expect(
      rows(
        file,
        "SELECT sha256,codec,raw_size,payload FROM kml_objects ORDER BY sha256",
      ),
    ).toEqual(
      rows(
        backup!,
        "SELECT sha256,codec,raw_size,payload FROM kml_objects ORDER BY sha256",
      ),
    );
    expect(
      rows(file, "SELECT name,state,updated_at,generation FROM map_projects"),
    ).toEqual([
      { name: "trip", state: "{}", updated_at: "old-time", generation: 1 },
    ]);
    expect(
      rows(
        file,
        "SELECT origin,manifest_status FROM track_versions ORDER BY path",
      ),
    ).toEqual([
      { origin: "migration_baseline", manifest_status: "ready" },
      { origin: "migration_baseline", manifest_status: "unavailable" },
    ]);
    expect(
      rows(
        file,
        "SELECT json_extract(settings_json,'$.default_connect') AS connected FROM track_presentations",
      ),
    ).toEqual([{ connected: 0 }, { connected: 0 }]);
    const db = new Database(file);
    expect(verifyArchive(db)).toMatchObject({
      schema: 6,
      revision: 3,
      storage_revision: 1,
    });
    db.close();
    const migrated = logical(file);
    expect(await migrateArchive(file)).toBeUndefined();
    expect(logical(file)).toEqual(migrated);
  },
);
it.each([
  "migration-backup",
  "migration-ddl",
  "migration-baseline",
  "migration-before-commit",
] as Parameters<MigrationFault>[0][])(
  "rolls back every durable migration phase: %s",
  async (point) => {
    const { file, directory } = legacy(),
      before = logical(file);
    await expect(
      migrateArchive(file, (p) => {
        if (p === point) throw new Error("injected failure");
      }),
    ).rejects.toThrow("injected failure");
    expect(logical(file)).toEqual(before);
    const backups = readdirSync(directory).filter((n) =>
      n.includes(".schema2-"),
    );
    expect(backups).toHaveLength(1);
    expect(logical(path.join(directory, backups[0]!))).toEqual(before);
  },
);
it("rejects changes made while the migration backup was being prepared", async () => {
  const { file } = legacy();
  await expect(
    migrateArchive(file, (p) => {
      if (p === "migration-backup") {
        const db = new Database(file);
        db.prepare("UPDATE map_projects SET state='changed'").run();
        db.close();
      }
    }),
  ).rejects.toThrow("changed during migration backup");
  expect(rows(file, "PRAGMA user_version")).toEqual([{ user_version: 2 }]);
  expect(rows(file, "SELECT state FROM map_projects")).toEqual([
    { state: "changed" },
  ]);
});
it("locates mixed geometries without treating untimed lines as hand drawing or changing bytes", () => {
  const bytes = Buffer.from(
    `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><!-- comment --><Placemark><MultiGeometry><gx:MultiTrack><gx:Track><when>2026-01-01T00:00:00Z</when><gx:coord>120 30</gx:coord><gx:coord>121 31</gx:coord></gx:Track></gx:MultiTrack><LineString><coordinates>121,31 122,32</coordinates></LineString></MultiGeometry></Placemark></Document></kml>`,
  );
  const manifest = readManifest(bytes, String);
  expect(manifest.status).toBe("ready");
  expect(
    manifest.segments.map((s) => [
      s.locator,
      s.geometry_kind,
      s.point_count,
      s.time_status,
      s.source_kind,
    ]),
  ).toEqual([
    [[0, 0, 0, 0, 0], "gx:Track", 2, "mismatch", "unknown"],
    [[0, 0, 0, 1], "LineString", 2, "absent", "unknown"],
  ]);
});
it("keeps versions and deduplicates objects, rejects stale refs and replays request keys", async () => {
  const { file, store, entry, archive } = await initialized(),
    request = change(archive, entry, "edit");
  const result = store.publish(request),
    updated = result.entries[0]!;
  expect(store.publish(request)).toEqual(result);
  expect(store.history(entry.entry_id)).toHaveLength(2);
  expect(Buffer.from(store.read(entry.version_id))).toEqual(raw);
  expect(() =>
    store.publish({ ...request, params: { different: true } }),
  ).toThrow("Idempotency");
  expect(() => store.publish({ ...request, request_key: "stale" })).toThrow(
    "changed since preview",
  );
  expect(() =>
    store.publish({
      ...change(archive, updated, "wrong-archive"),
      archive_id: "other",
    }),
  ).toThrow("identity");
  const restored = store.restoreVersion(
    archive,
    updated,
    entry.version_id,
    entry.presentation_id,
    "restore-version",
  );
  expect(
    store.restoreVersion(
      archive,
      updated,
      entry.version_id,
      entry.presentation_id,
      "restore-version",
    ),
  ).toEqual(restored);
  expect(store.history(entry.entry_id)).toHaveLength(3);
  expect(rows(file, "SELECT sha256 FROM kml_objects")).toHaveLength(2);
  expect(restored.entries[0]!.sha256).toBe(entry.sha256);
  expect(restored.entries[0]!.version_id).not.toBe(entry.version_id);
});
it("stores presentation snapshots separately and rolls invalid settings back completely", async () => {
  const { file, store, entry, archive } = await initialized(),
    initial = settings(file, entry),
    before = logical(file);
  const request: PublishRequest = {
    archive_id: archive,
    request_key: "settings",
    kind: "presentation",
    algorithm_version: "test-v1",
    params: {},
    inputs: [entry],
    outputs: [
      {
        kind: "presentation",
        entry_id: entry.entry_id,
        settings: { ...initial, order: [] },
      },
    ],
  };
  expect(() => store.publish(request)).toThrow("every version segment");
  expect(logical(file)).toEqual(before);
  request.outputs = [
    {
      kind: "presentation",
      entry_id: entry.entry_id,
      settings: { ...initial, default_connect: false },
    },
  ];
  const output = store.publish(request).entries[0]!;
  expect(output.version_id).toBe(entry.version_id);
  expect(output.generation).toBe(2);
  expect(settings(file, entry)).toEqual(initial);
  expect(settings(file, output).default_connect).toBe(false);
  expect(rows(file, "SELECT * FROM kml_objects")).toHaveLength(1);
});
it("publishes and restores a split group atomically and protects later edits", async () => {
  const { file, store, entry, archive } = await initialized(),
    initial = logical(file);
  const request: PublishRequest = {
    archive_id: archive,
    request_key: "split",
    kind: "split_journey",
    algorithm_version: "test-v1",
    params: {},
    inputs: [entry],
    outputs: [
      { kind: "version", path: "a.kml", category: "Train", raw },
      { kind: "state", entry_id: entry.entry_id, state: "superseded" },
    ],
  };
  expect(() => store.publish(request)).toThrow();
  expect(logical(file)).toEqual(initial);
  request.outputs = [
    { kind: "version", path: "first.kml", category: "Train", raw },
    {
      kind: "version",
      path: "second.kml",
      category: "Default",
      raw: kml("122,32 123,33"),
    },
    { kind: "state", entry_id: entry.entry_id, state: "superseded" },
  ];
  const result = store.publish(request);
  expect(
    rows(file, "SELECT path FROM active_archive_entries ORDER BY path"),
  ).toEqual([{ path: "first.kml" }, { path: "second.kml" }]);
  expect(() =>
    store.restore(
      archive,
      result.operation_id,
      "incomplete",
      result.entries.slice(1),
    ),
  ).toThrow("complete operation group");
  const restored = store.restore(
    archive,
    result.operation_id,
    "undo",
    result.entries,
  );
  expect(
    store.restore(archive, result.operation_id, "undo", result.entries),
  ).toEqual(restored);
  expect(rows(file, "SELECT path FROM active_archive_entries")).toEqual([
    { path: "a.kml" },
  ]);
  const redone = store.restore(
    archive,
    restored.operation_id,
    "redo",
    restored.entries,
  );
  const modified = store.publish(
    change(
      archive,
      redone.entries.find((e) => e.path === "first.kml")!,
      "later",
    ),
  );
  expect(() =>
    store.restore(
      archive,
      redone.operation_id,
      "unsafe",
      redone.entries.map(
        (e) => modified.entries.find((m) => m.entry_id === e.entry_id) ?? e,
      ),
    ),
  ).toThrow("group changed");
});
it("supplements provenance without making the display revision dirty; rejects cycles and wrong source hashes", async () => {
  const { file, store, entry, archive } = await initialized(),
    changed = store.publish(change(archive, entry, "edit")).entries[0]!;
  const sourceSegment = settings(file, entry).order[0]!,
    outputSegment = settings(file, changed).order[0]!;
  const before = new ArchiveWriter().status(file);
  const link = {
    archive_id: archive,
    request_key: "link",
    locations: [
      {
        version_id: entry.version_id,
        sha256: entry.sha256,
        location: {
          container: "/external/original.kml",
          member: null,
          display_name: "original.kml",
          source_role: "verified_original" as const,
          evidence: { method: "byte comparison" },
        },
      },
    ],
    lineage: [
      {
        version_id: changed.version_id,
        segment_id: outputSegment,
        source: {
          source_version_id: entry.version_id,
          source_segment_id: sourceSegment,
          start: 0,
          end_exclusive: 2,
          evidence_kind: "manual" as const,
          evidence: { checked: true },
        },
      },
    ],
  };
  store.linkSources(link);
  const after = new ArchiveWriter().status(file);
  expect(after.revision).toBe(before.revision);
  expect(after.storage_revision!).toBeGreaterThan(before.storage_revision!);
  const state = logical(file);
  expect(() =>
    store.linkSources({
      ...link,
      request_key: "wrong",
      locations: [{ ...link.locations[0]!, sha256: "0".repeat(64) }],
    }),
  ).toThrow("Source bytes");
  expect(() =>
    store.linkSources({
      ...link,
      request_key: "cycle",
      locations: [],
      lineage: [
        {
          version_id: entry.version_id,
          segment_id: sourceSegment,
          source: {
            ...link.lineage[0]!.source,
            source_version_id: changed.version_id,
            source_segment_id: outputSegment,
          },
        },
      ],
    }),
  ).toThrow("cyclic");
  expect(() =>
    store.linkSources({
      ...link,
      request_key: "bounds",
      locations: [],
      lineage: [
        {
          ...link.lineage[0]!,
          source: { ...link.lineage[0]!.source, end_exclusive: 3 },
        },
      ],
    }),
  ).toThrow("exceeds segment");
  expect(logical(file)).toEqual(state);
});
it("enforces immutable history and matching entry/version/presentation ownership", async () => {
  const { file, store, entry, archive } = await initialized();
  store.publish(change(archive, entry, "edit"));
  for (const sql of [
    "DELETE FROM archive_entries",
    "DELETE FROM track_versions",
    "UPDATE track_versions SET origin='imported'",
    "UPDATE kml_objects SET raw_size=0",
    "DELETE FROM kml_objects",
    "UPDATE archive_entries SET generation=generation+1,current_presentation_id='missing'",
    "UPDATE archive_entries SET path='different.kml',generation=generation+1",
  ]) {
    const before = logical(file);
    expect(() => transaction(file, true, (db) => db.exec(sql))).toThrow();
    expect(logical(file)).toEqual(before);
  }
});
it("legacy schema 3 pop recovery withdraws the active entry and retains every historical object", async () => {
  const { file, directory, store, entry, archive, writer } =
    await initialized(3);
  const current = store.publish(change(archive, entry, "edit")).entries[0]!;
  const crashing = new ArchiveWriter(undefined, (p) => {
    if (p === "target-durable") throw new Error("crash");
  });
  transaction(file, true, (db) =>
    db
      .prepare(
        "INSERT INTO file_operations VALUES ('legacy','pop',?,?,NULL,?,?)",
      )
      .run(
        current.entry_id,
        current.sha256,
        path.join(directory, "out", "a.kml"),
        current.generation,
      ),
  );
  await expect(crashing.recover(file)).rejects.toThrow("crash");
  expect(writer.status(file).pending).toBe(1);
  expect(store.current(entry.entry_id).state).toBe("active");
  await expect(
    fullBackup(file, path.join(directory, "pending.sqlite3")),
  ).rejects.toThrow("Pending");
  await writer.recover(file);
  expect(writer.status(file)).toMatchObject({ entries: 0, pending: 0 });
  expect(store.current(entry.entry_id).state).toBe("withdrawn");
  expect(store.history(entry.entry_id)).toHaveLength(2);
  expect(Buffer.from(store.read(entry.version_id))).toEqual(raw);
  expect(digest(readFileSync(path.join(directory, "out", "a.kml")))).toBe(
    current.sha256,
  );
  expect(() => new ArchiveStore().readBytes(file, "a.kml")).toThrow(
    "not found",
  );
  expect(rows(file, "SELECT * FROM kml_objects")).toHaveLength(2);
});
it("verifies full WAL snapshots and restores all logical tables into a new library", async () => {
  const { file, directory, store, entry, archive } = await initialized();
  store.publish(change(archive, entry, "edit"));
  const holding = new Database(file);
  holding.pragma("journal_mode=WAL");
  holding
    .prepare(
      "INSERT INTO map_projects(name,state,updated_at) VALUES ('trip','{}','now')",
    )
    .run();
  const expected = logical(file),
    backup = path.join(directory, "full.sqlite3");
  await fullBackup(file, backup);
  expect(logical(backup)).toEqual(expected);
  const target = path.join(directory, "restored");
  await restoreBackup(backup, target);
  expect(logical(path.join(target, "archive.sqlite3"))).toEqual(expected);
  await expect(fullBackup(file, backup)).rejects.toThrow("never overwritten");
  await expect(restoreBackup(backup, target)).rejects.toThrow("new or empty");
  holding.close();
});
it.each(["backup-snapshot", "backup-published", "restore-published"] as const)(
  "keeps the source intact and cleans publication after %s failure",
  async (point) => {
    const { file, directory } = await initialized(),
      before = logical(file),
      output = path.join(directory, "full.sqlite3");
    const fail = (p: string) => {
      if (p === point) throw new Error("disk failure");
    };
    if (point === "restore-published") {
      await expect(
        restoreBackup(file, path.join(directory, "restored"), fail),
      ).rejects.toThrow("disk failure");
      expect(
        existsSync(path.join(directory, "restored", "archive.sqlite3")),
      ).toBe(false);
    } else {
      await expect(fullBackup(file, output, fail)).rejects.toThrow(
        "disk failure",
      );
      expect(existsSync(output)).toBe(false);
    }
    expect(logical(file)).toEqual(before);
    transaction(file, false, (db) =>
      expect(Buffer.from(rawObject(db, digest(raw)))).toEqual(raw),
    );
  },
);

it("recovers the original database after SIGKILL during a real migration transaction", async () => {
  const { file } = legacy(),
    before = logical(file);
  const moduleUrl = new URL(
    "../../dist/node/infrastructure/archive/migrate.js",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {migrateArchive} from ${JSON.stringify(moduleUrl)}; await migrateArchive(process.argv[1], point => { if(point === 'migration-before-commit') process.kill(process.pid,'SIGKILL'); });`,
      file,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal, result.stderr).toBe("SIGKILL");
  expect(new ArchiveWriter().status(file)).toMatchObject({
    schema: 2,
    entries: 2,
  });
  expect(logical(file)).toEqual(before);
});

it("retains source-only originals outside the active catalog", async () => {
  const { file, store, archive } = await initialized();
  const imported = store.publish({
    archive_id: archive,
    request_key: "earlier",
    kind: "import",
    algorithm_version: "test-v1",
    params: {},
    inputs: [],
    outputs: [
      {
        kind: "version",
        path: "original.kml",
        category: null,
        raw: kml("118,28 119,29"),
        origin: "imported",
        state: "source_only",
      },
    ],
  }).entries[0]!;
  expect(rows(file, "SELECT path FROM active_archive_entries")).toEqual([
    { path: "a.kml" },
  ]);
  expect(Buffer.from(store.read(imported.version_id))).toEqual(
    kml("118,28 119,29"),
  );
});

it("refuses stale recovery intents before publishing a target and blocks edits while pending", async () => {
  const { file, directory, writer, store, entry, archive } =
    await initialized();
  const output = path.join(directory, "out");
  transaction(file, true, (db) =>
    db
      .prepare(
        "INSERT INTO file_operations VALUES ('pending','push',?,?,NULL,?,?)",
      )
      .run(
        entry.entry_id,
        entry.sha256,
        path.join(output, "a.kml"),
        entry.generation,
      ),
  );
  expect(() => store.publish(change(archive, entry, "blocked"))).toThrow(
    "pending file operation",
  );
  transaction(file, true, (db) =>
    db
      .prepare("UPDATE archive_entries SET generation=generation+1 WHERE id=?")
      .run(entry.entry_id),
  );
  await expect(writer.recover(file)).rejects.toThrow("changed since preview");
  expect(existsSync(path.join(output, "a.kml"))).toBe(false);
  expect(writer.status(file).pending).toBe(1);
});
