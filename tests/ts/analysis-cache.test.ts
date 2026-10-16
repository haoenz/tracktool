import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TrackAnalysisCache,
  CURRENT_ANALYSIS_KEY,
} from "../../dist/node/infrastructure/archive/analysis-cache.js";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import {
  readTransaction,
  transaction,
} from "../../dist/node/infrastructure/archive/database.js";
import { SCHEMA_4 } from "../../dist/node/infrastructure/archive/schema-v4.js";
import { migrateArchive } from "../../dist/node/infrastructure/archive/migrate.js";
import { fullBackup } from "../../dist/node/infrastructure/archive/full-backup.js";
import {
  previewDeletion,
  deleteEntry,
} from "../../dist/node/infrastructure/archive/deletion.js";
import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
import type { XmlPort } from "../../dist/node/services/ports.js";
import { downloadBytes } from "../../dist/node/infrastructure/archive/download.js";
import { VersionStore } from "../../dist/node/infrastructure/archive/versions.js";

const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
const raw = Buffer.from(
  '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track><when>2026-10-16T00:00:00Z</when><when>2026-10-16T00:01:00Z</when><when>2026-10-16T00:02:00Z</when><gx:coord>120 30 10</gx:coord><gx:coord>120.001 30 20</gx:coord><gx:coord>120.002 30 30</gx:coord></gx:Track></Placemark></Document></kml>',
);
async function fixture(schema = 5, keepIngestCache = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-analysis-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.sqlite3");
  if (schema === 5) await new ArchiveWriter().init(dir);
  else {
    const db = new Database(file);
    db.exec(SCHEMA_4);
    db.exec(
      "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'analysis-test')",
    );
    db.close();
  }
  const entry = transaction(file, true, (db) =>
    addEntry(db, "a.kml", raw, "Default"),
  );
  if (schema === 5 && !keepIngestCache)
    transaction(file, true, (db) =>
      db.exec("DELETE FROM track_analysis_cache"),
    );
  const workers = new XmlWorkers();
  clean.push(() => workers.close());
  const run = vi.fn<XmlPort["run"]>((...args) => workers.run(...args));
  const cache = new TrackAnalysisCache({ run });
  return { dir, file, entry, run, cache };
}
const rows = (file: string) =>
  readTransaction(file, (db) =>
    db.prepare("SELECT * FROM track_analysis_cache").all(),
  );
const stamp = (file: string) =>
  readTransaction(file, (db) =>
    db.prepare("SELECT revision,storage_revision FROM archive_meta").get(),
  );
function remove(file: string, id: string) {
  const plan = previewDeletion(file, { entry_id: id });
  deleteEntry(file, {
    archive_id: plan.archive_id,
    expected: plan.expected,
    request_key: `delete:${id}`,
  });
}

it("persists summaries and compressed profiles across instances without history or revision changes", async () => {
  const { file, entry, run, cache } = await fixture();
  const before = stamp(file);
  const result = await cache.get(file, entry.id, entry.sha256);
  expect(result.elapsed_s).toBe(120);
  expect(run).toHaveBeenCalledTimes(1);
  const stored = rows(file) as {
    profile_blob: Buffer;
    summary_json: string;
    profile_raw_size: number;
  }[];
  expect(stored).toHaveLength(1);
  expect(stored[0]!.profile_blob.length).toBeLessThan(
    stored[0]!.profile_raw_size,
  );
  expect(JSON.parse(stored[0]!.summary_json)).not.toHaveProperty("samples");
  const unused = vi
    .fn<XmlPort["run"]>()
    .mockRejectedValue(new Error("must hit cache"));
  expect(
    await new TrackAnalysisCache({ run: unused }).get(
      file,
      entry.id,
      entry.sha256,
    ),
  ).toEqual(result);
  expect(unused).not.toHaveBeenCalled();
  expect(stamp(file)).toEqual(before);
  expect(downloadBytes(file, { entry_id: entry.id }).bytes).toEqual(raw);
});

it("deduplicates concurrent requests and shares identical content across entries", async () => {
  const { file, entry, run, cache } = await fixture();
  const other = transaction(file, true, (db) =>
    addEntry(db, "b.kml", raw, "Default"),
  );
  transaction(file, true, (db) => db.exec("DELETE FROM track_analysis_cache"));
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      cache.get(file, i % 2 ? entry.id : other.id, entry.sha256),
    ),
  );
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    results.every((r) => JSON.stringify(r) === JSON.stringify(results[0])),
  ).toBe(true);
  expect(rows(file)).toHaveLength(1);
  await expect(cache.get(file, "missing", entry.sha256)).rejects.toThrow(
    "Entry not found",
  );
  await expect(cache.get(file, entry.id, "a".repeat(64))).rejects.toThrow(
    "版本已不可用",
  );
});

it("keeps one row when independent cache instances compute concurrently", async () => {
  const { file, entry, run, cache } = await fixture();
  await Promise.all([
    cache.get(file, entry.id, entry.sha256),
    new TrackAnalysisCache({ run }).get(file, entry.id, entry.sha256),
  ]);
  expect(rows(file)).toHaveLength(1);
});

it("invalidates by parser, algorithm and actual calculation parameters", async () => {
  const { file, entry, run, cache } = await fixture();
  await cache.get(file, entry.id, entry.sha256);
  for (const key of [
    {
      ...CURRENT_ANALYSIS_KEY,
      parser_version: CURRENT_ANALYSIS_KEY.parser_version + 1,
    },
    {
      ...CURRENT_ANALYSIS_KEY,
      analysis_version: CURRENT_ANALYSIS_KEY.analysis_version + 1,
    },
    {
      ...CURRENT_ANALYSIS_KEY,
      params: { ...CURRENT_ANALYSIS_KEY.params, moving_kmh: 100 },
    },
  ]) {
    const value = await new TrackAnalysisCache({ run }, key).get(
      file,
      entry.id,
      entry.sha256,
    );
    if (key.params.moving_kmh === 100) expect(value.moving_s).toBe(0);
  }
  expect(run).toHaveBeenCalledTimes(4);
  expect(rows(file)).toHaveLength(4);
});

it.each(["profile", "summary", "size", "params"])(
  "rebuilds corrupted %s without revision changes",
  async (part) => {
    const { file, entry, run, cache } = await fixture();
    const expected = await cache.get(file, entry.id, entry.sha256),
      before = stamp(file);
    transaction(file, true, (db) =>
      db.exec(
        {
          profile: "UPDATE track_analysis_cache SET profile_blob=x'00'",
          summary: "UPDATE track_analysis_cache SET summary_json='{}'",
          size: "UPDATE track_analysis_cache SET profile_raw_size=1",
          params: "UPDATE track_analysis_cache SET params_json='{}'",
        }[part]!,
      ),
    );
    expect(await cache.get(file, entry.id, entry.sha256)).toEqual(expected);
    expect(run).toHaveBeenCalledTimes(2);
    expect(rows(file)).toHaveLength(1);
    expect(stamp(file)).toEqual(before);
  },
);

it("returns results when writes fail and never caches failed calculations", async () => {
  const { file, entry, run, cache } = await fixture();
  const failure = new TrackAnalysisCache({
    run: async () => {
      throw new Error("compute failed");
    },
  });
  await expect(failure.get(file, entry.id, entry.sha256)).rejects.toThrow(
    "compute failed",
  );
  expect(rows(file)).toHaveLength(0);
  transaction(file, true, (db) =>
    db.exec(
      "CREATE TRIGGER block_cache BEFORE INSERT ON track_analysis_cache BEGIN SELECT RAISE(FAIL,'write unavailable'); END",
    ),
  );
  expect((await cache.get(file, entry.id, entry.sha256)).elapsed_s).toBe(120);
  expect(rows(file)).toHaveLength(0);
  transaction(file, true, (db) => db.exec("DROP TRIGGER block_cache"));
  await cache.get(file, entry.id, entry.sha256);
  expect(run).toHaveBeenCalledTimes(2);
  expect(rows(file)).toHaveLength(1);
});

it("cancelling one subscriber does not abort another subscriber's computation", async () => {
  const { file, entry, run, cache } = await fixture();
  const controller = new AbortController();
  const first = cache.get(file, entry.id, entry.sha256, controller.signal);
  const firstRejected = expect(first).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const second = cache.get(file, entry.id, entry.sha256);
  controller.abort();
  await firstRejected;
  expect((await second).elapsed_s).toBe(120);
  expect(run).toHaveBeenCalledTimes(1);
  expect(rows(file)).toHaveLength(1);
});

it("preserves shared cache until its last original object is deleted", async () => {
  const { file, entry, cache } = await fixture();
  const other = transaction(file, true, (db) =>
    addEntry(db, "b.kml", raw, "Default"),
  );
  await cache.get(file, entry.id, entry.sha256);
  remove(file, entry.id);
  expect(rows(file)).toHaveLength(1);
  remove(file, other.id);
  expect(rows(file)).toHaveLength(0);
});

it("new versions are analyzed during publication while history retains its own cache", async () => {
  const { file, entry, cache, run } = await fixture();
  const first = await cache.get(file, entry.id, entry.sha256);
  const store = new VersionStore(file),
    current = store.current(entry.id);
  const archive = readTransaction(
    file,
    (db) =>
      (
        db.prepare("SELECT archive_id FROM archive_meta").get() as {
          archive_id: string;
        }
      ).archive_id,
  );
  const changed = Buffer.from(raw.toString().replace("120.002", "120.004"));
  const result = store.publish({
    archive_id: archive,
    request_key: "change",
    kind: "prune",
    algorithm_version: "test",
    params: {},
    inputs: [current],
    outputs: [
      {
        kind: "version",
        entry_id: entry.id,
        path: "a.kml",
        category: "Default",
        raw: changed,
      },
    ],
  });
  const next = result.entries[0]!;
  expect(
    (await cache.get(file, entry.id, next.sha256)).distance_m,
  ).toBeGreaterThan(first.distance_m);
  expect(await cache.get(file, entry.id, entry.sha256)).toEqual(first);
  expect(run).toHaveBeenCalledTimes(1);
  expect(rows(file)).toHaveLength(2);
});

it("migrates schema 4 with a complete backup, rollback and no eager analysis", async () => {
  const { file, entry, cache } = await fixture(4);
  const before = stamp(file);
  expect((await cache.get(file, entry.id, entry.sha256)).elapsed_s).toBe(120);
  expect(
    readTransaction(file, (db) => db.pragma("user_version", { simple: true })),
  ).toBe(4);
  await expect(
    migrateArchive(file, (stage) => {
      if (stage === "migration-before-commit") throw new Error("fault");
    }),
  ).rejects.toThrow("fault");
  expect(stamp(file)).toEqual(before);
  expect(
    readTransaction(file, (db) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='track_analysis_cache'",
        )
        .get(),
    ),
  ).toBeUndefined();
  const backup = await migrateArchive(file);
  expect(
    readTransaction(backup!, (db) =>
      db.pragma("user_version", { simple: true }),
    ),
  ).toBe(4);
  expect(downloadBytes(backup!, { entry_id: entry.id }).bytes).toEqual(raw);
  expect(
    readTransaction(file, (db) => db.pragma("user_version", { simple: true })),
  ).toBe(6);
  expect(rows(file)).toHaveLength(0);
  const after = stamp(file) as { revision: number };
  expect(after.revision).toBe((before as { revision: number }).revision);
  expect(await migrateArchive(file)).toBeUndefined();
  await cache.get(file, entry.id, entry.sha256);
  expect(rows(file)).toHaveLength(1);
});

it("full backups include cached profiles and can reuse them", async () => {
  const { file, dir, entry, cache } = await fixture();
  const value = await cache.get(file, entry.id, entry.sha256);
  const backup = path.join(dir, "full.sqlite3");
  await fullBackup(file, backup);
  const unused = vi
    .fn<XmlPort["run"]>()
    .mockRejectedValue(new Error("must hit"));
  expect(
    await new TrackAnalysisCache({ run: unused }).get(
      backup,
      entry.id,
      entry.sha256,
    ),
  ).toEqual(value);
  expect(unused).not.toHaveBeenCalled();
});

it("imports persist analysis before the first read and reuse identical content", async () => {
  const { file, entry, cache, run } = await fixture(5, true);
  expect(rows(file)).toHaveLength(1);
  expect((await cache.get(file, entry.id, entry.sha256)).elapsed_s).toBe(120);
  expect(run).not.toHaveBeenCalled();
  const before = rows(file);
  transaction(file, true, (db) => addEntry(db, "same.kml", raw, "Default"));
  expect(rows(file)).toEqual(before);
});

it("rolls back ingestion if its statistics cannot be stored", async () => {
  const { file } = await fixture(5, true);
  const before = stamp(file);
  transaction(file, true, (db) =>
    db.exec(
      "CREATE TRIGGER fail_analysis BEFORE INSERT ON track_analysis_cache BEGIN SELECT RAISE(ABORT,'analysis storage failed'); END",
    ),
  );
  expect(() =>
    transaction(file, true, (db) =>
      addEntry(
        db,
        "new.kml",
        Buffer.from(raw.toString().replace("120.002", "120.006")),
        "Default",
      ),
    ),
  ).toThrow("analysis storage failed");
  expect(stamp(file)).toEqual(before);
  expect(
    readTransaction(file, (db) =>
      db.prepare("SELECT count(*) AS n FROM kml_objects").get(),
    ),
  ).toEqual({ n: 1 });
  expect(
    readTransaction(file, (db) =>
      db.prepare("SELECT count(*) AS n FROM track_versions").get(),
    ),
  ).toEqual({ n: 1 });
  expect(rows(file)).toHaveLength(1);
});

it("preserves unparseable imported originals without fabricating analysis", async () => {
  const { file } = await fixture(5, true);
  const invalid = Buffer.from("invalid original KML");
  const entry = transaction(file, true, (db) =>
    addEntry(db, "invalid.kml", invalid, "Default"),
  );
  expect(downloadBytes(file, { entry_id: entry.id }).bytes).toEqual(invalid);
  expect(rows(file)).toHaveLength(1);
});
