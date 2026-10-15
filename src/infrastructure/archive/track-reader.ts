import type Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import { validatePresentation } from "../../domain/track-version.js";
import type { SegmentInput } from "../../domain/segment-edit.js";
import type {
  EditGeometry,
  TrackDetail,
  VersionSummary,
  SegmentManifest,
} from "../../shared/track-edit.js";
import {
  bindSegments,
  evaluatePresentation,
} from "../../domain/presentation.js";
import { readTransaction, rawObject, schemaVersion } from "./database.js";
import { archiveId, currentEntry } from "./versions.js";
import { presentationDigest } from "./identity.js";
import { XmlWorkers } from "../xml/client.js";

export function requireVersioned(db: Database.Database) {
  if (schemaVersion(db) < 4)
    throw new AppError(
      "USER_INPUT",
      "段编辑需要 schema 4；请先备份并显式执行 archive migrate",
    );
}
export function versionInput(
  db: Database.Database,
  entryId: string,
  versionId: string,
  presentationId: string,
): SegmentInput {
  requireVersioned(db);
  const row = db
    .prepare(
      "SELECT v.sha256,v.manifest_status,p.settings_json,p.settings_sha256 FROM track_versions v JOIN track_presentations p ON p.version_id=v.id WHERE v.id=? AND v.entry_id=? AND p.id=?",
    )
    .get(versionId, entryId, presentationId) as
    | {
        sha256: string;
        manifest_status: string;
        settings_json: string;
        settings_sha256: string;
      }
    | undefined;
  if (!row || row.manifest_status !== "ready")
    throw new AppError("USER_INPUT", "来源版本或段清单不可用");
  const segments = segmentRows(db, versionId);
  const settings = validatePresentation(
    JSON.parse(row.settings_json),
    segments.map((s) => s.segment_id),
  );
  if (presentationDigest(settings) !== row.settings_sha256)
    throw new AppError("USER_INPUT", "展示设置校验失败");
  return {
    version_id: versionId,
    raw: rawObject(db, row.sha256),
    segments,
    settings,
  };
}
function segmentRows(
  db: Database.Database,
  versionId: string,
): SegmentManifest[] {
  return (
    db
      .prepare(
        "SELECT segment_id,ordinal,locator_json,geometry_kind,source_kind,point_count,time_status FROM track_segments WHERE version_id=? ORDER BY ordinal",
      )
      .all(versionId) as (Omit<SegmentManifest, "locator"> & {
      locator_json: string;
    })[]
  ).map(({ locator_json, ...s }) => ({
    ...s,
    locator: JSON.parse(locator_json) as number[],
  }));
}
export function trackCatalog(file: string, search = "", cursor = 0) {
  return readTransaction(file, (db) => {
    requireVersioned(db);
    const rows = db
      .prepare(
        "SELECT id,path FROM archive_entries WHERE state='active' AND instr(lower(path),lower(?))>0 ORDER BY path LIMIT 201 OFFSET ?",
      )
      .all(search, cursor) as { id: string; path: string }[];
    return {
      archive_id: archiveId(db),
      entries: rows.slice(0, 200),
      next_cursor: rows.length > 200 ? cursor + 200 : null,
    };
  });
}
export function trackDetail(
  file: string,
  entryId: string,
  versionId?: string,
  presentationId?: string,
  cursor = 0,
): TrackDetail {
  return readTransaction(file, (db) => {
    requireVersioned(db);
    const entry = currentEntry(db, entryId),
      version = versionId ?? entry.version_id;
    const row = db
      .prepare(
        "SELECT manifest_status,manifest_error FROM track_versions WHERE entry_id=? AND id=?",
      )
      .get(entryId, version) as
      { manifest_status: string; manifest_error: string | null } | undefined;
    if (!row) throw new AppError("USER_INPUT", "版本不存在");
    const selected =
      presentationId ??
      (version === entry.version_id
        ? entry.presentation_id
        : (
            db
              .prepare(
                "SELECT id FROM track_presentations WHERE version_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
              )
              .get(version) as { id: string }
          ).id);
    const p = db
      .prepare(
        "SELECT settings_json,settings_sha256 FROM track_presentations WHERE id=? AND version_id=?",
      )
      .get(selected, version) as
      { settings_json: string; settings_sha256: string } | undefined;
    if (!p) throw new AppError("USER_INPUT", "展示快照不属于该版本");
    const segments = segmentRows(db, version),
      settings = validatePresentation(
        JSON.parse(p.settings_json),
        segments.map((s) => s.segment_id),
      );
    if (presentationDigest(settings) !== p.settings_sha256)
      throw new AppError("USER_INPUT", "展示设置校验失败");
    return {
      archive_id: archiveId(db),
      entry,
      settings,
      segments: segments.slice(cursor, cursor + 500),
      next_cursor: segments.length > cursor + 500 ? cursor + 500 : null,
      ...row,
    };
  });
}
export function trackHistory(file: string, entryId: string, cursor = 0) {
  return readTransaction(file, (db) => {
    requireVersioned(db);
    currentEntry(db, entryId);
    const rows = db
      .prepare(
        "SELECT id,version_no,created_at,origin,operation_id,sha256 FROM track_versions WHERE entry_id=? ORDER BY version_no DESC LIMIT 51 OFFSET ?",
      )
      .all(entryId, cursor) as Omit<VersionSummary, "presentations">[];
    return {
      versions: rows.slice(0, 50).map((v) => ({
        ...v,
        presentations: db
          .prepare(
            "SELECT id,created_at FROM track_presentations WHERE version_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
          )
          .all(v.id) as VersionSummary["presentations"],
      })),
      next_cursor: rows.length > 50 ? cursor + 50 : null,
    };
  });
}
export function operationDetail(file: string, id: string) {
  return readTransaction(file, (db) => {
    requireVersioned(db);
    const op = db
      .prepare(
        "SELECT id,kind,params_json,created_at FROM track_operations WHERE id=?",
      )
      .get(id) as
      | { id: string; kind: string; params_json: string; created_at: string }
      | undefined;
    if (!op) throw new AppError("USER_INPUT", "操作不存在");
    const effects = (
      db
        .prepare(
          "SELECT entry_id,before_json,after_json FROM track_operation_effects WHERE operation_id=? ORDER BY entry_id",
        )
        .all(id) as {
        entry_id: string;
        before_json: string | null;
        after_json: string;
      }[]
    ).map((e) => ({
      entry_id: e.entry_id,
      before: e.before_json ? JSON.parse(e.before_json) : null,
      after: JSON.parse(e.after_json),
    }));
    const deleted = !!db
      .prepare(
        "SELECT 1 FROM track_operation_deletions WHERE operation_id=? LIMIT 1",
      )
      .get(id);
    return { archive_id: archiveId(db), ...op, effects, deleted };
  });
}
export async function inputGeometry(
  input: SegmentInput,
  signal?: AbortSignal,
): Promise<EditGeometry> {
  const xml = new XmlWorkers(1, 0);
  try {
    const data = (
      await xml.run(
        input.raw,
        { kind: "tracks", source: "edit-preview" },
        signal,
      )
    ).tracks!;
    const display = evaluatePresentation(
      bindSegments(data, input.segments),
      input.settings,
    );
    return {
      segments: display.segments.map((s) => ({
        segment_id: s.segment_id,
        coordinates: Array.from(
          s.longitude,
          (lon, i) => [lon, s.latitude[i]!] as [number, number],
        ),
      })),
      connections: display.connections.map((c) => c.coordinates),
    };
  } finally {
    await xml.close();
  }
}
