import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { upgradeSchema9 } from "../../scripts/upgrade-archive-schema9.js";
import {
  canonical,
  hashJson,
} from "../../dist/node/infrastructure/archive/identity.js";
import { verifyArchive } from "../../dist/node/infrastructure/archive/full-backup.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-schema9-"));
  directories.push(dir);
  const source = path.join(dir, "old.sqlite3"),
    output = path.join(dir, "new.sqlite3");
  copyFileSync("tests/ts/fixtures/maps/archive.sqlite3", source);
  const db = new Database(source);
  db.exec(
    "DROP TABLE track_gap_annotations; DROP TRIGGER presentation_no_update",
  );
  for (const row of db
    .prepare("SELECT id,settings_json FROM track_presentations")
    .all() as { id: string; settings_json: string }[]) {
    const settings = {
      ...JSON.parse(row.settings_json),
      default_connect: true,
      connections: [],
    };
    db.prepare(
      "UPDATE track_presentations SET settings_json=?,settings_sha256=? WHERE id=?",
    ).run(
      canonical(settings),
      hashJson({ ...settings, ignored: [...settings.ignored].sort() }),
      row.id,
    );
  }
  db.exec(
    "CREATE TRIGGER presentation_no_update BEFORE UPDATE ON track_presentations BEGIN SELECT RAISE(ABORT,'immutable presentation'); END; PRAGMA user_version=9",
  );
  db.close();
  return { dir, source, output };
}
it("upgrades a consistent WAL snapshot without changing source bytes, identities, originals or history", async () => {
  const { source, output } = fixture();
  const db = new Database(source);
  db.pragma("journal_mode=WAL");
  db.exec("UPDATE archive_meta SET revision=revision+1");
  const before = readFileSync(source),
    wal = readFileSync(source + "-wal");
  const result = await upgradeSchema9(source, output);
  expect(result.schema).toBe(10);
  expect(result.unclassified_connections).toBeGreaterThan(0);
  expect(readFileSync(source)).toEqual(before);
  expect(readFileSync(source + "-wal")).toEqual(wal);
  const upgraded = new Database(output);
  try {
    expect(verifyArchive(upgraded).archive_id).toBe(
      (
        db.prepare("SELECT archive_id FROM archive_meta").get() as {
          archive_id: string;
        }
      ).archive_id,
    );
    for (const table of [
      "archive_entries",
      "track_versions",
      "kml_objects",
      "track_operations",
      "track_operation_effects",
      "track_segment_sources",
    ])
      expect(
        upgraded.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ).toEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    expect(
      upgraded.prepare("SELECT * FROM track_gap_annotations").all(),
    ).toEqual([]);
    expect(() =>
      upgraded.exec("UPDATE track_presentations SET settings_json='{}'"),
    ).toThrow("immutable presentation");
    expect(() =>
      upgraded.exec(
        "INSERT INTO track_gap_annotations SELECT id,version_id,'a','b','tunnel' FROM track_presentations LIMIT 1",
      ),
    ).toThrow("immutable gap");
  } finally {
    upgraded.close();
    db.close();
  }
});
it("rejects corrupted old settings and publishes no partial archive", async () => {
  const { source, output, dir } = fixture();
  const db = new Database(source);
  db.exec(
    "DROP TRIGGER presentation_no_update; UPDATE track_presentations SET settings_sha256=printf('%064d',0)",
  );
  db.close();
  const before = readFileSync(source);
  await expect(upgradeSchema9(source, output)).rejects.toThrow("摘要校验失败");
  expect(readFileSync(source)).toEqual(before);
  expect(readdirSync(dir)).toEqual(["old.sqlite3"]);
});
it("refuses overwrite, self overwrite and unsupported schemas", async () => {
  const { source, output } = fixture();
  const before = readFileSync(source);
  await expect(upgradeSchema9(source, source)).rejects.toThrow("不能覆盖");
  await upgradeSchema9(source, output);
  await expect(upgradeSchema9(source, output)).rejects.toThrow("不能覆盖");
  await expect(upgradeSchema9(output, output + ".sqlite3")).rejects.toThrow(
    "必须是 schema 9",
  );
  expect(readFileSync(source)).toEqual(before);
});
