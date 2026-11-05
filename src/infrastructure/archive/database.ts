import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { AppError } from "../../domain/errors.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
import { resolvePath } from "../paths.js";
import { SCHEMA_VERSION } from "./schema.js";
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
      : path.join(p, "archive.sqlite3");
}
/** Connection counters; the archive worker reuses one session per file. */
export const databaseStats = { opens: 0 };
type Shared = { file: string; db: Database.Database };
let shared: Shared | undefined;
let sharedEnabled = false;
/** The archive worker handles one message at a time, so it can keep a single
 * connection open for the whole process instead of re-opening per operation. */
export function enableSharedConnections() {
  sharedEnabled = true;
}
export function resetSharedConnections() {
  if (!shared) return;
  try {
    if (shared.db.inTransaction) shared.db.exec("ROLLBACK");
  } catch {
    /* Closing below reports the real failure. */
  }
  shared.db.close();
  shared = undefined;
}
function sharedDatabase(file: string, write: boolean): Database.Database {
  if (shared && shared.file !== file) resetSharedConnections();
  if (!shared) {
    const db = connect(file, write);
    // connect() opens an implicit transaction; the session owns the boundaries.
    if (db.inTransaction) db.exec("COMMIT");
    shared = { file, db };
  }
  return shared.db;
}
let nesting = 0;
type Scope = { db: Database.Database; nested: boolean; name: string };
function beginScope(file: string, write: boolean): Scope {
  const db = sharedDatabase(file, write),
    nested = db.inTransaction,
    name = `tracktool_scope_${++nesting}`;
  if (nested) db.exec(`SAVEPOINT ${name}`);
  else db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  return { db, nested, name };
}
function commitScope({ db, nested, name }: Scope) {
  db.exec(nested ? `RELEASE ${name}` : "COMMIT");
}
function rollbackScope({ db, nested, name }: Scope) {
  if (nested) db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
  else if (db.inTransaction) db.exec("ROLLBACK");
}
/** One connection can be re-entered: an index write runs inside the read
 * snapshot that triggered it, so inner calls become savepoints. */
async function sharedScope<T>(
  file: string,
  write: boolean,
  run: (db: Database.Database) => T | Promise<T>,
): Promise<T> {
  const scope = beginScope(file, write);
  try {
    const result = await run(scope.db);
    commitScope(scope);
    return result;
  } catch (error) {
    rollbackScope(scope);
    throw error;
  } finally {
    nesting--;
  }
}
export function connect(file: string, write = false): Database.Database {
  let db: Database.Database;
  databaseStats.opens++;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 30_000 });
  } catch (cause) {
    throw new AppError(
      "USER_INPUT",
      `找不到或无法打开 SQLite 轨迹库：${file}；请检查路径或使用 archive init 创建归档`,
      { cause },
    );
  }
  try {
    db.pragma("foreign_keys=ON");
    db.function("tracktool_can_delete", { varargs: true }, () => 0);
    db.pragma("synchronous=FULL");
    const version = db.pragma("user_version", { simple: true });
    if (version !== SCHEMA_VERSION)
      throw new AppError(
        "USER_INPUT",
        `不支持的轨迹库格式：${String(version)}，当前格式为 ${SCHEMA_VERSION}；请按安装升级文档先升级归档，不能仅修改版本号`,
      );
    // Concurrent first opens of a DELETE-mode database can fail journal-mode
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
export function schemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}
export function transaction<T>(
  file: string,
  write: boolean,
  run: (db: Database.Database) => T,
): T {
  if (sharedEnabled) {
    const scope = beginScope(file, write);
    try {
      const result = run(scope.db);
      commitScope(scope);
      return result;
    } catch (error) {
      rollbackScope(scope);
      throw error;
    } finally {
      nesting--;
    }
  }
  return independentTransaction(file, write, run);
}
/** Derived index writes must not upgrade a reader's older WAL snapshot. */
export function independentTransaction<T>(
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
  if (!row) throw new AppError("USER_INPUT", `缺少 KML 对象：${digest}`);
  if (row.codec !== "zlib" || row.raw_size > MAX_KML_BYTES)
    throw new AppError(
      "USER_INPUT",
      "KML 内容超过 128 MiB 读取限制或使用了不支持的编码",
    );
  let bytes: Buffer;
  try {
    bytes = inflateSync(row.payload, { maxOutputLength: MAX_KML_BYTES });
  } catch (cause) {
    throw new AppError("USER_INPUT", "KML 对象已损坏", { cause });
  }
  if (
    bytes.length !== row.raw_size ||
    createHash("sha256").update(bytes).digest("hex") !== digest
  )
    throw new AppError("USER_INPUT", `KML 对象校验失败：${digest}`);
  return bytes;
}

/** Keep the same snapshot open while a disposable XML worker parses an original. */
export async function snapshot<T>(
  file: string,
  run: (db: Database.Database) => Promise<T>,
): Promise<T> {
  if (sharedEnabled) return sharedScope(file, false, run);
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

/** Read-only archive access: no journal-mode changes, recovery, indexing or receipts. */
export function readTransaction<T>(
  file: string,
  run: (db: Database.Database) => T,
): T {
  const db = new Database(file, {
    readonly: true,
    fileMustExist: true,
    timeout: 30000,
  });
  try {
    if (schemaVersion(db) !== SCHEMA_VERSION)
      throw new AppError("USER_INPUT", "轨迹库格式不受支持");
    db.pragma("query_only=ON");
    db.exec("BEGIN");
    return run(db);
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
}
