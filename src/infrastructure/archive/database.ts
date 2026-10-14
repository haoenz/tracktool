import Database from "better-sqlite3";
import { statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { resolvePath } from "../paths.js";
import { AppError } from "../../domain/errors.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
export function databasePath(input: string): string {
  if (!input) throw new AppError("USER_INPUT", "请先选择 SQLite 归档");
  const p = resolvePath(input);
  let directory = false;
  try {
    directory = statSync(p).isDirectory();
  } catch {
    /* Existing file check below, never create. */
  }
  return directory
    ? path.join(p, "archive.sqlite3")
    : p.endsWith(".sqlite3")
      ? p
      : path.join(path.dirname(p), "archive.sqlite3");
}
export function connect(file: string, write = false): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 30_000 });
  } catch (cause) {
    throw new AppError(
      "USER_INPUT",
      `SQLite archive not found or cannot open: ${file}; run archive import-zip explicitly`,
      { cause },
    );
  }
  try {
    db.pragma("foreign_keys=ON");
    db.pragma("synchronous=FULL");
    const version = db.pragma("user_version", { simple: true });
    if (version !== 2)
      throw new AppError(
        "USER_INPUT",
        `Unsupported database schema ${String(version)}; expected 2; run archive migrate`,
      );
    // Concurrent first opens of an older DELETE-mode database can fail journal-mode
    // conversion immediately, before SQLite's normal BEGIN busy timeout applies.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        db.pragma("journal_mode=WAL");
        break;
      } catch (error) {
        if (
          (error as { code?: string }).code !== "SQLITE_BUSY" ||
          Date.now() >= deadline
        )
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function transaction<T>(
  file: string,
  write: boolean,
  run: (db: Database.Database) => T,
): T {
  const db = connect(file, write);
  try {
    const result = run(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
export function rawObject(db: Database.Database, digest: string): Uint8Array {
  const row = db
    .prepare("SELECT codec,raw_size,payload FROM kml_objects WHERE sha256=?")
    .get(digest) as
    { codec: string; raw_size: number; payload: Buffer } | undefined;
  if (!row) throw new AppError("USER_INPUT", `Missing KML object: ${digest}`);
  if (row.codec !== "zlib" || row.raw_size > MAX_KML_BYTES)
    throw new AppError(
      "USER_INPUT",
      "KML entry exceeds the 128 MiB read limit or uses an unsupported codec",
    );
  let bytes: Buffer;
  try {
    bytes = inflateSync(row.payload, { maxOutputLength: MAX_KML_BYTES });
  } catch (cause) {
    throw new AppError("USER_INPUT", "Corrupt KML object", { cause });
  }
  if (
    bytes.length !== row.raw_size ||
    createHash("sha256").update(bytes).digest("hex") !== digest
  )
    throw new AppError(
      "USER_INPUT",
      `KML object integrity check failed: ${digest}`,
    );
  return bytes;
}

/** Keep the same snapshot open while a disposable XML worker parses an original. */
export async function snapshot<T>(
  file: string,
  run: (db: Database.Database) => Promise<T>,
): Promise<T> {
  const db = connect(file);
  try {
    const result = await run(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
