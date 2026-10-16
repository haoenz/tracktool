import { resolvePath } from "../paths.js";
import Database from "better-sqlite3";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { AppError } from "../../domain/errors.js";
import { CATEGORIES, memberName } from "../../domain/archive.js";
import type {
  ArchiveRequest,
  ArchiveResult,
  ArchiveStatus,
  Category,
} from "../../domain/archive.js";
import { DEFAULTS, tagMap } from "../../domain/config.js";
import {
  activeEntries,
  schemaVersion,
  connect,
  rawObject,
  snapshot,
  transaction,
} from "./database.js";
import { SCHEMA_5 } from "./schema-v5.js";
import { downloadFile } from "./download.js";
import { previewDeletion, deleteEntry, type DeleteFault } from "./deletion.js";
import { migrateArchive, type MigrationFault } from "./migrate.js";
import { fullBackup, restoreBackup, type BackupFault } from "./full-backup.js";
import {
  addVersionedEntry,
  archiveId,
  currentEntry,
  checkRef,
  publishVersions,
  type SourceLocation,
} from "./versions.js";
import {
  digest,
  exclusive,
  present,
  sameFile,
  syncDirectory,
  syncFile,
  temporary,
} from "../durable-files.js";
import { readZip, writeZip } from "./zip.js";
import { readManifest } from "../xml/manifest.js";
import { XmlWorkers } from "../xml/client.js";
import type { XmlPort } from "../../services/ports.js";
import { rebuild } from "./collections.js";
import { exportDisplay } from "./display-export.js";
export type FaultPoint =
  | Parameters<DeleteFault>[0]
  | Parameters<MigrationFault>[0]
  | Parameters<BackupFault>[0]
  | "push-entry-written"
  | "push-before-commit"
  | "intent-committed"
  | "target-durable"
  | "source-removed"
  | "before-export-publish"
  | "export-published"
  | "before-export-commit";
export type FaultHook = (point: FaultPoint) => void | Promise<void>;
type Entry = { id: string; path: string; sha256: string };
export function addEntry(
  db: Database.Database,
  name: string,
  raw: Uint8Array,
  category: Category | null,
  location?: SourceLocation,
): Entry {
  if (schemaVersion(db) >= 3)
    return addVersionedEntry(db, name, raw, category, location);
  memberName(name);
  if (!name.toLowerCase().endsWith(".kml"))
    throw new AppError("USER_INPUT", "Archive entries must be KML");
  const sha256 = digest(raw);
  const old = db
    .prepare("SELECT id,path,sha256 FROM archive_entries WHERE path=?")
    .get(name) as Entry | undefined;
  if (old) {
    if (old.sha256 !== sha256)
      throw new AppError(
        "USER_INPUT",
        `Archive path conflict; source retained: ${name}`,
      );
    return old;
  }
  db.prepare("INSERT OR IGNORE INTO kml_objects VALUES (?, 'zlib', ?, ?)").run(
    sha256,
    raw.length,
    deflateSync(raw),
  );
  const id = randomUUID().replaceAll("-", "");
  db.prepare("INSERT INTO archive_entries VALUES (?, ?, ?, ?, ?)").run(
    id,
    name,
    sha256,
    category,
    /\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? null,
  );
  return { id, path: name, sha256 };
}
export class ArchiveWriter {
  constructor(
    private readonly xml: XmlPort = new XmlWorkers(1, 0),
    private readonly fault: FaultHook = () => {},
  ) {}
  async execute(request: ArchiveRequest): Promise<ArchiveResult> {
    switch (request.kind) {
      case "init":
        return this.init(request.directory, request.zip);
      case "status":
        return {
          message: "Archive status",
          status: this.status(request.database),
        };
      case "migrate": {
        const backup = await this.migrate(request.database);
        return {
          message: backup
            ? `Schema 4 ready; pre-migration backup: ${backup}`
            : "Schema 4 ready",
          paths: backup ? [backup] : [],
        };
      }
      case "full-backup":
        return fullBackup(request.database, request.output, this.fault);
      case "restore-backup":
        return restoreBackup(request.backup, request.directory, this.fault);
      case "recover":
        return {
          message: "Recovery completed",
          count: await this.recover(request.database),
        };
      case "backup":
        return this.backup(request.database, request.output, request.entries);
      case "rebuild":
        return rebuild(request.database, request.output, this.xml, request.entries);
      case "push":
        return this.push(request);
      case "download":
        return downloadFile(
          request.database,
          request,
          request.output,
          request.preview,
        );
      case "delete-preview":
        return {
          message: "Deletion preview; archive unchanged",
          deletion_preview: previewDeletion(request.database, request),
        };
      case "delete":
        return {
          message: "Track and its history deleted",
          deletion: deleteEntry(request.database, request.request),
        };
      default:
        throw new AppError("USER_INPUT", "Unsupported archive operation");
    }
  }
  status(file: string): ArchiveStatus {
    return transaction(file, false, (db) => {
      const meta = db
        .prepare(
          `SELECT revision,zip_revision,zip_target,views_revision,${schemaVersion(db) >= 3 ? "storage_revision" : "NULL AS storage_revision"} FROM archive_meta`,
        )
        .get() as Omit<ArchiveStatus, "entries" | "pending" | "zip_fresh">;
      return {
        ...meta,
        schema: schemaVersion(db),
        entries: (
          db
            .prepare(`SELECT count(*) AS n FROM ${activeEntries(db)}`)
            .get() as {
            n: number;
          }
        ).n,
        pending: (
          db.prepare("SELECT count(*) AS n FROM file_operations").get() as {
            n: number;
          }
        ).n,
        zip_fresh:
          meta.zip_revision === meta.revision &&
          !!meta.zip_target &&
          existsSync(meta.zip_target) &&
          lstatSync(meta.zip_target).isFile(),
      };
    });
  }
  migrate(file: string): Promise<string | undefined> {
    return migrateArchive(file, this.fault);
  }
  async init(directory: string, zip?: string): Promise<ArchiveResult> {
    const target = path.join(directory, "archive.sqlite3");
    if (present(target))
      throw new AppError("USER_INPUT", `Database already exists: ${target}`);
    if (
      !zip &&
      ["Archive.zip", "archive.json"].some((n) =>
        present(path.join(directory, n)),
      )
    )
      throw new AppError(
        "USER_INPUT",
        "Legacy archive exists; use archive import-zip explicitly",
      );
    mkdirSync(directory, { recursive: true });
    const stage = temporary(target);
    const db = new Database(stage);
    let published = false;
    try {
      db.pragma("foreign_keys=ON");
      db.pragma("synchronous=FULL");
      db.exec("BEGIN");
      db.exec(SCHEMA_5);
      db.prepare(
        "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,?)",
      ).run(randomUUID().replaceAll("-", ""));
      if (zip)
        await readZip(zip, async (name, bytes) => {
          let category: Category | null = CATEGORIES.includes(
            name.split("/")[0] as Category,
          )
            ? (name.split("/")[0] as Category)
            : null;
          if (!name.includes("/")) {
            try {
              category =
                (tagMap(DEFAULTS).get(
                  (await this.xml.run(bytes, { kind: "content" })).content!.tag,
                ) as Category | undefined) ?? null;
            } catch (e) {
              if (!(e instanceof AppError) || e.code !== "USER_INPUT") throw e;
            }
          }
          addEntry(db, name, bytes, category, {
            container: resolvePath(zip),
            member: name,
            display_name: path.basename(name),
            source_role: "imported_file",
            evidence: {},
          });
        });
      if (
        db.pragma("integrity_check", { simple: true }) !== "ok" ||
        (db.pragma("foreign_key_check") as unknown[]).length
      )
        throw new AppError("USER_INPUT", "Database integrity check failed");
      for (const row of db
        .prepare("SELECT sha256 FROM kml_objects")
        .iterate() as Iterable<{ sha256: string }>)
        rawObject(db, row.sha256);
      db.exec("COMMIT");
      db.pragma("journal_mode=WAL");
      db.close();
      syncFile(stage);
      linkSync(stage, target);
      published = true;
      syncDirectory(directory);
      return {
        message: zip
          ? "ZIP imported; original bytes preserved"
          : "Archive initialized",
        paths: [target],
      };
    } catch (cause) {
      if (
        published &&
        present(stage) &&
        present(target) &&
        lstatSync(stage).ino === lstatSync(target).ino
      )
        unlinkSync(target);
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        "USER_INPUT",
        "Archive initialization failed; no existing database replaced",
        { cause },
      );
    } finally {
      if (db.open) {
        if (db.inTransaction) db.exec("ROLLBACK");
        db.close();
      }
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        rmSync(stage + suffix, { force: true });
    }
  }
  async recover(file: string): Promise<number> {
    const db = connect(file, true, [1, 2, 3, 4, 5]);
    try {
      const operations = db
        .prepare("SELECT * FROM file_operations ORDER BY rowid")
        .all() as {
        id: string;
        operation: string;
        entry_id: string;
        sha256: string;
        source: string | null;
        target: string;
        expected_generation?: number;
      }[];
      for (const op of operations) {
        const current =
          schemaVersion(db) >= 3 ? currentEntry(db, op.entry_id) : null;
        if (current)
          checkRef(
            db,
            {
              ...current,
              generation: op.expected_generation!,
              sha256: op.sha256,
            },
            true,
          );
        const raw = rawObject(db, op.sha256);
        exclusive(op.target, raw, true);
        await this.fault("target-durable");
        if (
          op.operation === "push" &&
          op.source &&
          resolvePath(op.source) !== resolvePath(op.target) &&
          present(op.source)
        ) {
          if (!sameFile(op.source, raw))
            throw new AppError(
              "USER_INPUT",
              `Source changed; retained for manual recovery: ${op.source}`,
            );
          unlinkSync(op.source);
          syncDirectory(path.dirname(op.source));
          await this.fault("source-removed");
        }
        db.prepare("DELETE FROM file_operations WHERE id=?").run(op.id);
        if (op.operation === "pop" && current)
          publishVersions(db, {
            archive_id: archiveId(db),
            request_key: `file-pop:${op.id}`,
            kind: "withdraw",
            algorithm_version: "pop-v1",
            params: { file_operation: op.id },
            inputs: [current],
            outputs: [
              { kind: "state", entry_id: current.entry_id, state: "withdrawn" },
            ],
          });
        else if (op.operation === "pop")
          db.prepare("DELETE FROM archive_entries WHERE id=? AND sha256=?").run(
            op.entry_id,
            op.sha256,
          );
      }
      if (schemaVersion(db) < 3)
        db.exec(
          "DELETE FROM kml_objects WHERE sha256 NOT IN (SELECT sha256 FROM archive_entries) AND sha256 NOT IN (SELECT sha256 FROM file_operations)",
        );
      db.exec("COMMIT");
      return operations.length;
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  }
  async push(
    request: Extract<ArchiveRequest, { kind: "push" }>,
  ): Promise<ArchiveResult> {
    if (request.move) await this.recover(request.database);
    const warnings: string[] = [];
    const db = connect(request.database, true);
    try {
      for (const input of request.entries) {
        if (lstatSync(input.source).isSymbolicLink())
          throw new AppError(
            "USER_INPUT",
            `Refusing symbolic link: ${input.source}`,
          );
        const bytes = readFileSync(input.source);
        if (digest(bytes) !== input.sha256)
          throw new AppError("USER_INPUT", `Source changed: ${input.source}`);
        if (!request.move) {
          const manifest = readManifest(bytes, (ordinal) => String(ordinal));
          if (manifest.status !== "ready" || !manifest.segments.some((segment) => segment.point_count > 0))
            throw new AppError("USER_INPUT", `Invalid track: ${input.source}: ${manifest.error ?? "no track points"}`);
        }
        const entry = addEntry(db, input.member, bytes, input.category, {
          container: resolvePath(input.source),
          member: null,
          display_name: path.basename(input.source),
          source_role: "imported_file",
          evidence: {},
        });
        await this.fault("push-entry-written");
        if (!request.move) continue;
        const target = path.join(
          resolvePath(request.backup),
          path.basename(input.source),
        );
        if (target === input.source) continue;
        if (present(target) && !sameFile(target, bytes)) {
          warnings.push(`Backup conflict; source retained: ${input.source}`);
          continue;
        }
        db.prepare(
          `INSERT OR IGNORE INTO file_operations(id,operation,entry_id,sha256,source,target${schemaVersion(db) >= 3 ? ",expected_generation" : ""}) VALUES (?, 'push', ?, ?, ?, ?${schemaVersion(db) >= 3 ? ",?" : ""})`,
        ).run(
          randomUUID().replaceAll("-", ""),
          entry.id,
          entry.sha256,
          input.source,
          target,
          ...(schemaVersion(db) >= 3
            ? [currentEntry(db, entry.id).generation]
            : []),
        );
      }
      await this.fault("push-before-commit");
      db.exec("COMMIT");
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
    if (request.move) {
      await this.fault("intent-committed");
      await this.recover(request.database);
    }
    return {
      message:
        "Tracks archived; run archive rebuild / backup to refresh derived files",
      count: request.entries.length,
      warnings,
    };
  }
  async backup(file: string, output: string, selected?: string[]): Promise<ArchiveResult> {
    if (!output.toLowerCase().endsWith(".zip") || output === file)
      throw new AppError("USER_INPUT", "Backup target must be a .zip file");
    mkdirSync(path.dirname(output), { recursive: true });
    const stage = temporary(output);
    const previous = temporary(output);
    let published = false;
    let retained = false;
    const warnings: string[] = [];
    try {
      const revision = await snapshot(file, async (db) => {
        const rev = (
          db.prepare("SELECT revision FROM archive_meta").get() as {
            revision: number;
          }
        ).revision;
        let entries = db
          .prepare(`SELECT path,sha256 FROM ${activeEntries(db)} ORDER BY path`)
          .all() as Entry[];
        if (selected) {
          const requested = new Set(selected);
          entries = entries.filter((e) => requested.has(e.path));
          if (!requested.size || entries.length !== requested.size)
            throw new AppError("USER_INPUT", "部分所选轨迹已不存在，请返回列表重新选择");
        }
        const expectedHashes: string[] = [];
        function* originals() {
          for (const e of entries) {
            const unavailable =
              schemaVersion(db) >= 3 &&
              (db
                .prepare(
                  "SELECT v.manifest_status FROM archive_entries e JOIN track_versions v ON v.id=e.current_version_id WHERE e.path=?",
                )
                .get(e.path) as { manifest_status: string } | false);
            const fallback =
              unavailable && unavailable.manifest_status !== "ready";
            if (fallback)
              warnings.push(
                `${e.path}: 段清单不可用，ZIP 中保留原字节，未应用展示设置`,
              );
            const raw = fallback
              ? rawObject(db, e.sha256)
              : exportDisplay(db, e.path);
            expectedHashes.push(digest(raw));
            yield { path: e.path, raw };
          }
        }
        await writeZip(stage, originals());
        let index = 0;
        await readZip(stage, (name, raw) => {
          const expected = entries[index++];
          if (
            !expected ||
            expected.path !== name ||
            expectedHashes[index - 1] !== digest(raw)
          )
            throw new AppError("USER_INPUT", "ZIP verification failed");
        });
        if (index !== entries.length)
          throw new AppError("USER_INPUT", "ZIP verification failed");
        return rev;
      });
      await this.fault("before-export-publish");
      const db = connect(file, true);
      try {
        const newer = db
          .prepare(
            `SELECT revision FROM export_receipts WHERE target=?${schemaVersion(db) >= 3 ? " AND kind='kml_zip'" : ""}`,
          )
          .get(output) as { revision: number } | undefined;
        if (newer && newer.revision > revision)
          throw new AppError(
            "USER_INPUT",
            "A newer snapshot was already exported to this target",
          );
        if (present(output)) {
          if (lstatSync(output).isSymbolicLink())
            throw new AppError(
              "USER_INPUT",
              "Refusing symbolic link backup target",
            );
          linkSync(output, previous);
        }
        renameSync(stage, output);
        published = true;
        syncDirectory(path.dirname(output));
        await this.fault("export-published");
        if (!selected) {
        db.prepare(
          "UPDATE archive_meta SET zip_revision=?,zip_target=? WHERE singleton=1",
        ).run(revision, output);
        db.prepare(
          schemaVersion(db) >= 3
            ? "INSERT INTO export_receipts VALUES (?,'kml_zip',?,NULL) ON CONFLICT(target,kind) DO UPDATE SET revision=excluded.revision"
            : "INSERT INTO export_receipts VALUES (?,?) ON CONFLICT(target) DO UPDATE SET revision=excluded.revision",
        ).run(output, revision);
        }
        await this.fault("before-export-commit");
        db.exec("COMMIT");
      } catch (error) {
        if (published) {
          try {
            if (present(previous)) renameSync(previous, output);
            else unlinkSync(output);
            syncDirectory(path.dirname(output));
          } catch {
            retained = true;
            throw new AppError(
              "TOOL",
              `Export rollback needs recovery; previous copy: ${previous}`,
              { cause: error },
            );
          }
        }
        throw error;
      } finally {
        if (db.inTransaction) db.exec("ROLLBACK");
        db.close();
      }
      return {
        message: "Display ZIP export complete",
        paths: [output],
        warnings,
      };
    } finally {
      rmSync(stage, { force: true });
      if (!retained) rmSync(previous, { force: true });
    }
  }
}
