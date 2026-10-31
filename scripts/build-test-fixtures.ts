import Database from "better-sqlite3";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArchiveWriter,
  addEntry,
} from "../dist/node/infrastructure/archive/writer.js";
import { transaction } from "../dist/node/infrastructure/archive/database.js";
import type { Category } from "../dist/node/domain/archive.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "tracktool-fixtures-"));
try {
  await new ArchiveWriter().init(directory);
  const file = path.join(directory, "archive.sqlite3");
  const entries = JSON.parse(
    await readFile("tests/ts/fixtures/maps/entries.json", "utf8"),
  ) as { path: string; category: Category; kml: string }[];
  transaction(file, true, (db) => {
    for (const entry of entries)
      addEntry(db, entry.path, Buffer.from(entry.kml), entry.category);
  });
  const db = new Database(file);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode=DELETE");
  db.close();
  await copyFile(file, "tests/ts/fixtures/maps/archive.sqlite3");
} finally {
  await rm(directory, { recursive: true, force: true });
}
