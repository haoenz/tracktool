import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import path from "node:path";
import { AppError } from "../../domain/errors.js";
import type { Category } from "../../domain/archive.js";
import type { EntrySnapshot } from "../../domain/track-version.js";
import { syncFile, syncDirectory, temporary } from "../durable-files.js";
import { readManifest } from "../xml/manifest.js";
import { rawObject, schemaVersion } from "./database.js";
import { hashJson, stableId } from "./identity.js";
import { MIGRATE_3 } from "./schema-v4.js";
import { MIGRATE_1 } from "./schema.js";
import { VERSION_SCHEMA_3 } from "./schema-v3.js";
import {
  insertOperation,
  insertVersion,
  insertPresentation,
  publishEntry,
  insertLocation,
} from "./versions.js";
import {
  snapshotDatabase,
  verifyArchive,
  removeStaging,
} from "./full-backup.js";

export type MigrationFault = (
  point:
    | "migration-backup"
    | "migration-ddl"
    | "migration-baseline"
    | "migration-before-commit",
) => void | Promise<void>;
export async function migrateArchive(
  file: string,
  fault: MigrationFault = () => {},
): Promise<string | undefined> {
  const db = new Database(file, { fileMustExist: true, timeout: 30_000 });
  let stage: string | undefined;
  try {
    db.pragma("foreign_keys=ON");
    db.pragma("synchronous=FULL");
    const version = schemaVersion(db);
    if (version === 4) {
      verifyArchive(db);
      return;
    }
    if (version !== 1 && version !== 2 && version !== 3)
      throw new AppError(
        "USER_INPUT",
        `Unsupported database schema ${version}`,
      );
    if (db.prepare("SELECT 1 FROM file_operations LIMIT 1").get())
      throw new AppError(
        "USER_INPUT",
        "Run archive recover before migration; pending file operations cannot be migrated",
      );
    const dataVersion = db.pragma("data_version", { simple: true });
    const backup = `${file}.schema${version}-${randomUUID()}.sqlite3`;
    stage = temporary(backup);
    const baseline = await snapshotDatabase(db, stage);
    syncFile(stage);
    linkSync(stage, backup);
    syncDirectory(path.dirname(backup));
    await fault("migration-backup");
    db.exec("BEGIN EXCLUSIVE");
    if (
      dataVersion !== db.pragma("data_version", { simple: true }) ||
      version !== schemaVersion(db)
    )
      throw new AppError(
        "USER_INPUT",
        "Archive changed during migration backup; retry migration",
      );
    if (version === 3) {
      db.exec(MIGRATE_3);
      db.exec(
        "UPDATE archive_meta SET revision=revision+1,storage_revision=storage_revision+1 WHERE singleton=1",
      );
      await fault("migration-ddl");
      verifyArchive(db);
      await fault("migration-before-commit");
      db.exec("COMMIT");
      return backup;
    }
    if (version === 1) db.exec(MIGRATE_1);
    const old = db
      .prepare(
        "SELECT id,path,sha256,category,filename_date FROM archive_entries ORDER BY id",
      )
      .all() as {
      id: string;
      path: string;
      sha256: string;
      category: Category | null;
      filename_date: string | null;
    }[];
    db.exec(`DROP TRIGGER entry_insert; DROP TRIGGER entry_update; DROP TRIGGER entry_delete;
      DROP INDEX entries_content; DROP INDEX entries_category_date;
      DROP TABLE file_operations;
      ALTER TABLE archive_entries RENAME TO legacy_entries;
      ALTER TABLE export_receipts RENAME TO legacy_receipts;
      ALTER TABLE archive_meta ADD COLUMN storage_revision INTEGER NOT NULL DEFAULT 0 CHECK(storage_revision>=0);
      ALTER TABLE map_projects ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1);`);
    db.exec(VERSION_SCHEMA_3);
    db.exec(
      "INSERT INTO export_receipts SELECT target,'kml_zip',revision,NULL FROM legacy_receipts; DROP TABLE legacy_receipts;",
    );
    await fault("migration-ddl");
    const created = new Date().toISOString();
    for (const row of old) {
      const versionId = stableId(
        `${baseline.archive_id}:${row.id}:migration-v1`,
      );
      const operation = stableId(`${versionId}:operation`);
      const entry: EntrySnapshot = {
        entry_id: row.id,
        path: row.path,
        category: row.category,
        filename_date: row.filename_date,
        sha256: row.sha256,
        version_id: versionId,
        presentation_id: stableId(`${versionId}:migration-display-v1`),
        generation: 1,
        state: "active",
      };
      const bytes = rawObject(db, row.sha256),
        manifest = readManifest(bytes, (n) =>
          stableId(`${versionId}:segment:${n}`),
        );
      insertOperation(db, {
        id: operation,
        kind: "migration_baseline",
        params: { source_schema: version },
        algorithm_version: "migration-v1",
        created_at: created,
        request_key: `migration-v1:${row.id}`,
        request_sha256: hashJson(row),
        result: { operation_id: operation, entries: [entry] },
      });
      insertVersion(
        db,
        entry,
        operation,
        created,
        bytes,
        manifest,
        "migration_baseline",
        1,
      );
      insertPresentation(db, entry, operation, created, {
        schema: 1,
        default_connect: false,
        order: manifest.segments.map((s) => s.segment_id),
        ignored: [],
        connections: [],
      });
      publishEntry(db, entry, null, operation);
      insertLocation(db, entry, operation, {
        container: path.resolve(file),
        member: row.path,
        display_name: path.basename(row.path),
        source_role: "legacy_result",
        evidence: { source_schema: version, entry_id: row.id },
      });
    }
    await fault("migration-baseline");
    if (
      db
        .prepare(
          `SELECT 1 FROM legacy_entries l LEFT JOIN active_archive_entries a ON a.id=l.id
      WHERE a.id IS NULL OR a.path<>l.path OR a.sha256<>l.sha256 OR a.category IS NOT l.category OR a.filename_date IS NOT l.filename_date LIMIT 1`,
        )
        .get() ||
      (
        db.prepare("SELECT count(*) AS n FROM archive_entries").get() as {
          n: number;
        }
      ).n !== old.length
    )
      throw new AppError(
        "TOOL",
        "Migration baseline differs from original entries",
      );
    db.exec("DROP TABLE legacy_entries");
    db.prepare(
      "UPDATE archive_meta SET revision=?,storage_revision=1 WHERE singleton=1",
    ).run(baseline.revision + 1);
    db.pragma("user_version=3");
    db.exec(MIGRATE_3);
    verifyArchive(db);
    await fault("migration-before-commit");
    db.exec("COMMIT");
    return backup;
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
    if (stage) removeStaging(stage);
  }
}
