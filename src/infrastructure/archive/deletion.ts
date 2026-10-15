import type Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import {
  DeleteRequestSchema,
  type DeleteRequest,
  type DeletePreview,
  type DeleteResult,
  type DeleteDependency,
} from "../../shared/archive-actions.js";
import { readTransaction, schemaVersion, transaction } from "./database.js";
import { archiveId, checkRef, currentEntry } from "./versions.js";
import { selectEntry, type EntrySelector } from "./download.js";
import { canonical, hashJson } from "./identity.js";

function requireDeletionSchema(db: Database.Database): void {
  if (schemaVersion(db) !== 4)
    throw new AppError(
      "USER_INPUT",
      "Deletion requires schema 4; run archive migrate explicitly",
    );
}
function dependencies(
  db: Database.Database,
  entryId: string,
): DeleteDependency[] {
  const result: DeleteDependency[] = [];
  const dependent = db
    .prepare(
      `SELECT DISTINCT e.id,e.path FROM track_segment_sources s
    JOIN track_versions source ON source.id=s.source_version_id
    JOIN track_versions output ON output.id=s.version_id JOIN archive_entries e ON e.id=output.entry_id
    WHERE source.entry_id=? AND output.entry_id<>?
    UNION SELECT DISTINCT e.id,e.path FROM track_operation_inputs i
    JOIN track_versions source ON source.id=i.version_id
    JOIN track_versions output ON output.operation_id=i.operation_id JOIN archive_entries e ON e.id=output.entry_id
    WHERE source.entry_id=? AND output.entry_id<>?`,
    )
    .all(entryId, entryId, entryId, entryId) as { id: string; path: string }[];
  for (const item of dependent)
    result.push({ kind: "trajectory", id: item.id, detail: item.path });
  for (const item of db
    .prepare("SELECT id FROM file_operations WHERE entry_id=?")
    .all(entryId) as { id: string }[])
    result.push({
      kind: "pending",
      id: item.id,
      detail: "Run archive recover before deleting this track",
    });
  const versions = db
    .prepare("SELECT id,path,sha256 FROM track_versions WHERE entry_id=?")
    .all(entryId) as { id: string; path: string; sha256: string }[];
  const versionIds = new Set(versions.map((v) => v.id));
  const presentations = new Set(
    (
      db
        .prepare(
          "SELECT p.id FROM track_presentations p JOIN track_versions v ON v.id=p.version_id WHERE v.entry_id=?",
        )
        .all(entryId) as { id: string }[]
    ).map((p) => p.id),
  );
  function references(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(references);
    const obj = value as Record<string, unknown>;
    if (
      obj.entry_id === entryId ||
      (typeof obj.version_id === "string" && versionIds.has(obj.version_id)) ||
      (typeof obj.presentation_id === "string" &&
        presentations.has(obj.presentation_id))
    )
      return true;
    if (
      typeof obj.entry === "string" &&
      versions.some(
        (v) =>
          obj.entry === v.path &&
          (obj.sha256 === undefined || obj.sha256 === v.sha256),
      )
    )
      return true;
    return Object.values(obj).some(references);
  }
  for (const project of db
    .prepare("SELECT name,state FROM map_projects ORDER BY name")
    .all() as { name: string; state: string }[]) {
    try {
      if (references(JSON.parse(project.state)))
        result.push({
          kind: "project",
          id: project.name,
          detail: "Project references this track or a historical version",
        });
    } catch {
      result.push({
        kind: "project",
        id: project.name,
        detail: "Project cannot be parsed; dependencies must be resolved first",
      });
    }
  }
  return result;
}
function previewIn(db: Database.Database, entryId: string): DeletePreview {
  requireDeletionSchema(db);
  const entry = currentEntry(db, entryId);
  const count = (sql: string) =>
    (db.prepare(sql).get(entryId) as { n: number }).n;
  const objects = db
    .prepare(
      `SELECT DISTINCT v.sha256, EXISTS(SELECT 1 FROM track_versions other WHERE other.sha256=v.sha256 AND other.entry_id<>v.entry_id) OR EXISTS(SELECT 1 FROM file_operations f WHERE f.sha256=v.sha256 AND f.entry_id<>v.entry_id) AS shared FROM track_versions v WHERE v.entry_id=?`,
    )
    .all(entryId) as { sha256: string; shared: number }[];
  const { entry_id, version_id, presentation_id, generation, sha256 } = entry;
  return {
    archive_id: archiveId(db),
    expected: { entry_id, version_id, presentation_id, generation, sha256 },
    path: entry.path,
    versions: count(
      "SELECT count(*) AS n FROM track_versions WHERE entry_id=?",
    ),
    presentations: count(
      "SELECT count(*) AS n FROM track_presentations WHERE version_id IN (SELECT id FROM track_versions WHERE entry_id=?)",
    ),
    segments: count(
      "SELECT count(*) AS n FROM track_segments WHERE version_id IN (SELECT id FROM track_versions WHERE entry_id=?)",
    ),
    removable_objects: objects.filter((o) => !o.shared).length,
    shared_objects: objects.filter((o) => o.shared).length,
    dependencies: dependencies(db, entryId),
  };
}
export function previewDeletion(
  file: string,
  selector: EntrySelector,
): DeletePreview {
  return readTransaction(file, (db) => {
    requireDeletionSchema(db);
    return previewIn(db, selectEntry(db, selector).id);
  });
}
export type DeleteFault = (
  point: "delete-history" | "delete-before-commit",
) => void;
export function deleteEntry(
  file: string,
  input: DeleteRequest,
  fault: DeleteFault = () => {},
): DeleteResult {
  return transaction(file, true, (db) =>
    deleteEntryInTransaction(db, input, fault),
  );
}
/** Allow a checked migration to publish replacements and remove legacy entries atomically. */
export function deleteEntryInTransaction(
  db: Database.Database,
  input: DeleteRequest,
  fault: DeleteFault = () => {},
): DeleteResult {
  if (!db.inTransaction) throw new Error("Deletion requires a transaction");
  const parsed = DeleteRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError("USER_INPUT", parsed.error.message);
  const request = parsed.data,
    hash = hashJson(request);
  {
    requireDeletionSchema(db);
    if (archiveId(db) !== request.archive_id)
      throw new AppError("USER_INPUT", "Archive identity changed");
    const prior = db
      .prepare(
        "SELECT request_sha256,result_json FROM track_deletions WHERE request_key=?",
      )
      .get(request.request_key) as
      { request_sha256: string; result_json: string } | undefined;
    if (prior) {
      if (prior.request_sha256 !== hash)
        throw new AppError(
          "USER_INPUT",
          "Idempotency key reused with different deletion request",
        );
      return JSON.parse(prior.result_json) as DeleteResult;
    }
    checkRef(db, request.expected, true);
    const plan = previewIn(db, request.expected.entry_id);
    if (plan.dependencies.length)
      throw new AppError(
        "USER_INPUT",
        `Deletion blocked by dependencies: ${plan.dependencies.map((d) => `${d.kind}: ${d.id} (${d.detail})`).join("; ")}`,
      );
    const id = request.expected.entry_id;
    const scope = new Map<string, Set<number>>();
    function collect(table: string, where: string) {
      const rows = db
        .prepare(`SELECT rowid AS row_id FROM ${table} WHERE ${where}`)
        .all(id) as { row_id: number }[];
      scope.set(table, new Set(rows.map((r) => r.row_id)));
    }
    const owned =
      "version_id IN (SELECT id FROM track_versions WHERE entry_id=?)";
    for (const table of [
      "track_segment_sources",
      "track_source_locations",
      "track_presentations",
      "track_segments",
      "track_operation_inputs",
    ])
      collect(table, owned);
    collect("track_operation_effects", "entry_id=?");
    collect("track_versions", "entry_id=?");
    collect("archive_entries", "id=?");
    collect(
      "kml_objects",
      "sha256 IN (SELECT sha256 FROM track_versions WHERE entry_id=?)",
    );
    const operations = db
      .prepare(
        `SELECT operation_id FROM track_versions WHERE entry_id=?
      UNION SELECT operation_id FROM track_operation_effects WHERE entry_id=?
      UNION SELECT operation_id FROM track_operation_inputs WHERE ${owned}
      UNION SELECT operation_id FROM track_presentations WHERE ${owned}
      UNION SELECT operation_id FROM track_segment_sources WHERE ${owned}
      UNION SELECT operation_id FROM track_source_locations WHERE ${owned}`,
      )
      .all(id, id, id, id, id, id) as { operation_id: string }[];
    const result: DeleteResult = {
      entry_id: id,
      path: plan.path,
      versions: plan.versions,
      deleted_objects: plan.removable_objects,
    };
    db.prepare("INSERT INTO track_deletions VALUES (?,?,?,?,?)").run(
      request.request_key,
      hash,
      id,
      new Date().toISOString(),
      canonical(result),
    );
    for (const operation of operations)
      db.prepare("INSERT INTO track_operation_deletions VALUES (?,?,?)").run(
        operation.operation_id,
        id,
        request.request_key,
      );
    db.function("tracktool_can_delete", { varargs: true }, (table, row) =>
      scope.get(String(table))?.has(Number(row)) ? 1 : 0,
    );
    try {
      for (const table of [
        "track_segment_sources",
        "track_source_locations",
        "track_operation_inputs",
        "track_operation_effects",
        "track_presentations",
        "track_segments",
        "track_versions",
      ]) {
        const remove = db.prepare(`DELETE FROM ${table} WHERE rowid=?`);
        for (const row of scope.get(table)!) remove.run(row);
      }
      fault("delete-history");
      db.prepare("DELETE FROM archive_entries WHERE id=?").run(id);
      const clean = db.prepare(
        "DELETE FROM kml_objects WHERE rowid=? AND NOT EXISTS(SELECT 1 FROM track_versions WHERE sha256=kml_objects.sha256) AND NOT EXISTS(SELECT 1 FROM file_operations WHERE sha256=kml_objects.sha256)",
      );
      let removed = 0;
      for (const row of scope.get("kml_objects")!)
        removed += clean.run(row).changes;
      if (removed !== result.deleted_objects)
        throw new AppError(
          "TOOL",
          "Object deletion count differs from the checked plan",
        );
      if ((db.pragma("foreign_key_check") as unknown[]).length)
        throw new AppError("TOOL", "Deletion would leave invalid references");
      fault("delete-before-commit");
      return result;
    } finally {
      db.function("tracktool_can_delete", { varargs: true }, () => 0);
    }
  }
}
