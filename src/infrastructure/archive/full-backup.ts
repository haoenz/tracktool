import Database from "better-sqlite3";
import path from "node:path";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { AppError } from "../../domain/errors.js";
import type { ArchiveResult } from "../../domain/archive.js";
import { validatePresentation } from "../../domain/track-version.js";
import { rawObject, schemaVersion, transaction } from "./database.js";
import { presentationDigest } from "./identity.js";
import {
  present,
  syncDirectory,
  syncFile,
  temporary,
} from "../durable-files.js";

export type BackupFault = (
  point: "backup-snapshot" | "backup-published" | "restore-published",
) => void | Promise<void>;
export type ArchiveStamp = {
  archive_id: string;
  revision: number;
  storage_revision: number | null;
  schema: number;
};
export function verifyArchive(db: Database.Database): ArchiveStamp {
  const schema = schemaVersion(db);
  if (![1, 2, 3, 4].includes(schema))
    throw new AppError("USER_INPUT", `Unsupported backup schema ${schema}`);
  if (
    db.pragma("integrity_check", { simple: true }) !== "ok" ||
    (db.pragma("foreign_key_check") as unknown[]).length
  )
    throw new AppError("USER_INPUT", "Database integrity check failed");
  if (db.prepare("SELECT 1 FROM file_operations LIMIT 1").get())
    throw new AppError(
      "USER_INPUT",
      "Pending file operations; run archive recover before backup, restore or migration",
    );
  const meta = db
    .prepare(
      `SELECT archive_id,revision,${schema >= 3 ? "storage_revision" : "NULL AS storage_revision"} FROM archive_meta WHERE singleton=1`,
    )
    .get() as Omit<ArchiveStamp, "schema"> | undefined;
  if (!meta) throw new AppError("USER_INPUT", "Archive metadata missing");
  for (const row of db
    .prepare("SELECT sha256 FROM kml_objects")
    .iterate() as Iterable<{ sha256: string }>)
    rawObject(db, row.sha256);
  if (schema >= 3) {
    if (
      db
        .prepare(
          `SELECT 1 FROM archive_entries e JOIN track_versions v ON v.id=e.current_version_id
      WHERE e.path<>v.path OR e.category IS NOT v.category OR e.filename_date IS NOT v.filename_date LIMIT 1`,
        )
        .get()
    )
      throw new AppError(
        "USER_INPUT",
        "Entry metadata differs from current version",
      );
    for (const row of db
      .prepare(
        "SELECT version_id,settings_json,settings_sha256 FROM track_presentations",
      )
      .iterate() as Iterable<{
      version_id: string;
      settings_json: string;
      settings_sha256: string;
    }>) {
      const ids = (
        db
          .prepare(
            "SELECT segment_id FROM track_segments WHERE version_id=? ORDER BY ordinal",
          )
          .all(row.version_id) as { segment_id: string }[]
      ).map((s) => s.segment_id);
      if (
        presentationDigest(
          validatePresentation(JSON.parse(row.settings_json), ids),
        ) !== row.settings_sha256
      )
        throw new AppError("USER_INPUT", "Presentation digest mismatch");
    }
  }
  return { ...meta, schema };
}
export function removeStaging(file: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(file + suffix, { force: true });
}
/** Online SQLite backup includes WAL commits; copying the main file alone is unsafe. */
export async function snapshotDatabase(
  source: Database.Database,
  stage: string,
): Promise<ArchiveStamp> {
  await source.backup(stage);
  const backup = new Database(stage, { fileMustExist: true });
  try {
    const stamp = verifyArchive(backup);
    backup.pragma("journal_mode=DELETE");
    return stamp;
  } finally {
    backup.close();
  }
}
function undoPublication(stage: string, output: string): void {
  if (present(stage) && present(output)) {
    const a = lstatSync(stage),
      b = lstatSync(output);
    if (a.dev === b.dev && a.ino === b.ino) {
      unlinkSync(output);
      syncDirectory(path.dirname(output));
    }
  }
}
export async function fullBackup(
  file: string,
  output: string,
  fault: BackupFault = () => {},
): Promise<ArchiveResult> {
  if (!output.toLowerCase().endsWith(".sqlite3") || present(output))
    throw new AppError(
      "USER_INPUT",
      "Full backup requires a new .sqlite3 target; existing files are never overwritten",
    );
  mkdirSync(path.dirname(output), { recursive: true });
  const stage = temporary(output),
    source = new Database(file, { readonly: true, fileMustExist: true });
  let published = false;
  try {
    const stamp = await snapshotDatabase(source, stage);
    await fault("backup-snapshot");
    syncFile(stage);
    linkSync(stage, output);
    published = true;
    syncDirectory(path.dirname(output));
    await fault("backup-published");
    if (stamp.schema >= 3)
      transaction(file, true, (db) => {
        const current = db
          .prepare("SELECT archive_id FROM archive_meta")
          .get() as { archive_id: string };
        if (current.archive_id !== stamp.archive_id || schemaVersion(db) < 3)
          throw new AppError("USER_INPUT", "Archive changed while backing up");
        db.prepare(
          "INSERT INTO export_receipts VALUES (?,'full_backup',?,?) ON CONFLICT(target,kind) DO UPDATE SET revision=excluded.revision,storage_revision=excluded.storage_revision",
        ).run(path.resolve(output), stamp.revision, stamp.storage_revision);
      });
    return {
      message:
        "Full SQLite backup verified; includes original bytes, versions, provenance, presentations and projects",
      paths: [output],
    };
  } catch (error) {
    if (published) undoPublication(stage, output);
    throw error;
  } finally {
    source.close();
    removeStaging(stage);
  }
}
export async function restoreBackup(
  file: string,
  directory: string,
  fault: BackupFault = () => {},
): Promise<ArchiveResult> {
  if (
    present(directory) &&
    (lstatSync(directory).isSymbolicLink() ||
      !lstatSync(directory).isDirectory() ||
      readdirSync(directory).length)
  )
    throw new AppError(
      "USER_INPUT",
      "Restore requires a new or empty archive directory",
    );
  mkdirSync(directory, { recursive: true });
  const output = path.join(directory, "archive.sqlite3"),
    stage = temporary(output);
  const source = new Database(file, { readonly: true, fileMustExist: true });
  let published = false;
  try {
    await snapshotDatabase(source, stage);
    syncFile(stage);
    linkSync(stage, output);
    published = true;
    syncDirectory(directory);
    await fault("restore-published");
    return {
      message: "Full backup restored and verified; source backup retained",
      paths: [output],
    };
  } catch (error) {
    if (published) undoPublication(stage, output);
    throw error;
  } finally {
    source.close();
    removeStaging(stage);
  }
}
