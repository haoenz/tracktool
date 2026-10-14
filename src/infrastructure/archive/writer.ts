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
import { connect, rawObject, snapshot, transaction } from "./database.js";
import { SCHEMA, MIGRATE_1 } from "./schema.js";
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
import { XmlWorkers } from "../xml/client.js";
import type { XmlPort } from "../../services/ports.js";
import { rebuild } from "./collections.js";
export type FaultPoint =
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
): Entry {
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
      case "migrate":
        this.migrate(request.database);
        return { message: "Schema 2 ready" };
      case "recover":
        return {
          message: "Recovery completed",
          count: await this.recover(request.database),
        };
      case "backup":
        return this.backup(request.database, request.output);
      case "rebuild":
        return rebuild(request.database, request.output, this.xml);
      case "push":
        return this.push(request);
      case "pop":
        return this.pop(request);
    }
  }
  status(file: string): ArchiveStatus {
    return transaction(file, false, (db) => {
      const meta = db
        .prepare(
          "SELECT revision,zip_revision,zip_target,views_revision FROM archive_meta",
        )
        .get() as Omit<ArchiveStatus, "entries" | "pending" | "zip_fresh">;
      return {
        ...meta,
        entries: (
          db.prepare("SELECT count(*) AS n FROM archive_entries").get() as {
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
  migrate(file: string): void {
    if (!existsSync(file))
      throw new AppError("USER_INPUT", `Database missing: ${file}`);
    const db = new Database(file, { fileMustExist: true, timeout: 30_000 });
    try {
      db.pragma("foreign_keys=ON");
      db.pragma("synchronous=FULL");
      db.exec("BEGIN EXCLUSIVE");
      const version = db.pragma("user_version", { simple: true });
      if (version === 1) db.exec(MIGRATE_1);
      else if (version !== 2)
        throw new AppError(
          "USER_INPUT",
          `Unsupported database schema ${String(version)}`,
        );
      if ((db.pragma("foreign_key_check") as unknown[]).length)
        throw new AppError("USER_INPUT", "Foreign key check failed");
      db.exec("COMMIT");
      db.pragma("journal_mode=WAL");
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
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
      db.exec(SCHEMA);
      db.exec(MIGRATE_1);
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
          addEntry(db, name, bytes, category);
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
    const db = connect(file, true);
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
      }[];
      for (const op of operations) {
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
        if (op.operation === "pop")
          db.prepare("DELETE FROM archive_entries WHERE id=? AND sha256=?").run(
            op.entry_id,
            op.sha256,
          );
      }
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
    await this.recover(request.database);
    const warnings: string[] = [];
    transaction(request.database, true, (db) => {
      for (const input of request.entries) {
        if (lstatSync(input.source).isSymbolicLink())
          throw new AppError(
            "USER_INPUT",
            `Refusing symbolic link: ${input.source}`,
          );
        const bytes = readFileSync(input.source);
        if (digest(bytes) !== input.sha256)
          throw new AppError("USER_INPUT", `Source changed: ${input.source}`);
        const entry = addEntry(db, input.member, bytes, input.category);
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
          "INSERT OR IGNORE INTO file_operations VALUES (?, 'push', ?, ?, ?, ?)",
        ).run(
          randomUUID().replaceAll("-", ""),
          entry.id,
          entry.sha256,
          input.source,
          target,
        );
      }
    });
    await this.fault("intent-committed");
    await this.recover(request.database);
    return {
      message:
        "Tracks archived; run archive rebuild / backup to refresh derived files",
      count: request.entries.length,
      warnings,
    };
  }
  async pop(
    request: Extract<ArchiveRequest, { kind: "pop" }>,
  ): Promise<ArchiveResult> {
    if (/[\\/]/.test(request.name))
      throw new AppError(
        "USER_INPUT",
        "Use an exact filename or stem, without a directory",
      );
    let output = "";
    const select = (db: Database.Database): Entry => {
      const rows = (
        db
          .prepare(
            "SELECT id,path,sha256,category FROM archive_entries ORDER BY path",
          )
          .all() as (Entry & { category: Category | null })[]
      ).filter(
        (e) =>
          (!request.category || e.category === request.category) &&
          [
            path.basename(e.path),
            path.basename(e.path, path.extname(e.path)),
          ].includes(request.name),
      );
      if (rows.length !== 1)
        throw new AppError(
          "USER_INPUT",
          rows.length
            ? `Ambiguous name; use --type: ${rows.map((e) => e.path).join(", ")}`
            : `Entry not found: ${request.name}`,
        );
      const entry = rows[0]!;
      output = path.join(request.output, path.basename(entry.path));
      if (present(output))
        throw new AppError(
          "USER_INPUT",
          `Refusing to overwrite existing target: ${output}`,
        );
      return entry;
    };
    if (request.preview) {
      const db = new Database(request.database, {
        readonly: true,
        fileMustExist: true,
        timeout: 30_000,
      });
      try {
        select(db);
      } finally {
        db.close();
      }
      return { message: "Would pop track", paths: [output] };
    }
    await this.recover(request.database);
    transaction(request.database, true, (db) => {
      const entry = select(db);
      if (
        db
          .prepare("SELECT 1 FROM file_operations WHERE entry_id=?")
          .get(entry.id)
      )
        throw new AppError(
          "USER_INPUT",
          "Entry has a pending file operation; run archive recover and retry",
        );
      db.prepare(
        "INSERT INTO file_operations VALUES (?, 'pop', ?, ?, NULL, ?)",
      ).run(randomUUID().replaceAll("-", ""), entry.id, entry.sha256, output);
    });
    await this.fault("intent-committed");
    await this.recover(request.database);
    return { message: "Track popped", paths: [output] };
  }
  async backup(file: string, output: string): Promise<ArchiveResult> {
    if (!output.toLowerCase().endsWith(".zip") || output === file)
      throw new AppError("USER_INPUT", "Backup target must be a .zip file");
    mkdirSync(path.dirname(output), { recursive: true });
    const stage = temporary(output);
    const previous = temporary(output);
    let published = false;
    let retained = false;
    try {
      const revision = await snapshot(file, async (db) => {
        const rev = (
          db.prepare("SELECT revision FROM archive_meta").get() as {
            revision: number;
          }
        ).revision;
        const entries = db
          .prepare("SELECT path,sha256 FROM archive_entries ORDER BY path")
          .all() as Entry[];
        function* originals() {
          for (const e of entries)
            yield { path: e.path, raw: rawObject(db, e.sha256) };
        }
        await writeZip(stage, originals());
        let index = 0;
        await readZip(stage, (name, raw) => {
          const expected = entries[index++];
          if (
            !expected ||
            expected.path !== name ||
            expected.sha256 !== digest(raw)
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
          .prepare("SELECT revision FROM export_receipts WHERE target=?")
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
        db.prepare(
          "UPDATE archive_meta SET zip_revision=?,zip_target=? WHERE singleton=1",
        ).run(revision, output);
        db.prepare(
          "INSERT INTO export_receipts VALUES (?,?) ON CONFLICT(target) DO UPDATE SET revision=excluded.revision",
        ).run(output, revision);
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
      return { message: "ZIP backup complete", paths: [output] };
    } finally {
      rmSync(stage, { force: true });
      if (!retained) rmSync(previous, { force: true });
    }
  }
}
