import type Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import { validatePresentation } from "../../domain/track-version.js";
import {
  bindSegments,
  evaluatePresentation,
} from "../../domain/presentation.js";
import { geojson } from "../../domain/geometry.js";
import type { TrackData, TrackSegment } from "../../domain/trackdata.js";
import type { ProjectTrack } from "../../shared/project-track.js";
import type { Presentation, SegmentManifest } from "../../shared/track-edit.js";
import { presentationDigest, hashJson } from "./identity.js";

export const DISPLAY_VERSION = 1;
export function resolveTrack(
  db: Database.Database,
  track: { entry: string; sha256?: string } | ProjectTrack,
): ProjectTrack {
  const archive = (
    db.prepare("SELECT archive_id FROM archive_meta").get() as {
      archive_id: string;
    }
  ).archive_id;
  const explicit = track as ProjectTrack;
  if (explicit.entry_id) {
    if (explicit.archive_id !== archive)
      throw new AppError("USER_INPUT", "项目引用的轨迹库身份不同，需重新关联");
    const row = db
      .prepare(
        "SELECT v.sha256 FROM track_versions v JOIN track_presentations p ON p.version_id=v.id WHERE v.entry_id=? AND v.id=? AND p.id=?",
      )
      .get(explicit.entry_id, explicit.version_id, explicit.presentation_id) as
      { sha256: string } | undefined;
    if (!row || row.sha256 !== track.sha256)
      throw new AppError(
        "USER_INPUT",
        "项目固定版本缺失或校验失败，需重新关联",
      );
    return explicit;
  }
  if (track.sha256) {
    const rows = db
      .prepare(
        "SELECT v.entry_id,v.id AS version_id,p.id AS presentation_id,v.sha256,p.settings_json FROM track_versions v JOIN track_presentations p ON p.version_id=v.id WHERE v.path=? AND v.sha256=? AND v.version_no=1 AND p.rowid=(SELECT min(rowid) FROM track_presentations WHERE version_id=v.id)",
      )
      .all(track.entry, track.sha256) as {
      entry_id: string;
      version_id: string;
      presentation_id: string;
      sha256: string;
      settings_json: string;
    }[];
    if (rows.length !== 1)
      throw new AppError(
        "USER_INPUT",
        "旧项目无法唯一关联原始基线，需明确重新关联；不会跟随最新轨迹",
      );
    const { settings_json, ...row } = rows[0]!;
    const settings = {
      ...(JSON.parse(settings_json) as Presentation),
      default_connect: false,
      ignored: [],
      connections: [],
    };
    return {
      entry: track.entry,
      archive_id: archive,
      ...row,
      override: { settings, sha256: presentationDigest(settings) },
    };
  }
  const row = db
    .prepare(
      "SELECT id AS entry_id,current_version_id AS version_id,current_presentation_id AS presentation_id FROM archive_entries WHERE path=? AND state='active'",
    )
    .get(track.entry) as
    | { entry_id: string; version_id: string; presentation_id: string }
    | undefined;
  if (!row) throw new AppError("USER_INPUT", `活动轨迹不存在：${track.entry}`);
  const { sha256 } = db
    .prepare("SELECT sha256 FROM track_versions WHERE id=?")
    .get(row.version_id) as { sha256: string };
  return { entry: track.entry, archive_id: archive, ...row, sha256 };
}
export function readPresentation(db: Database.Database, ref: ProjectTrack) {
  const row = db
    .prepare(
      "SELECT v.manifest_status,v.manifest_error,p.settings_json,p.settings_sha256 FROM track_versions v JOIN track_presentations p ON p.version_id=v.id WHERE v.id=? AND v.entry_id=? AND v.sha256=? AND p.id=?",
    )
    .get(ref.version_id, ref.entry_id, ref.sha256, ref.presentation_id) as
    | {
        manifest_status: string;
        manifest_error: string | null;
        settings_json: string;
        settings_sha256: string;
      }
    | undefined;
  if (!row || row.manifest_status !== "ready")
    throw new AppError("USER_INPUT", row?.manifest_error ?? "段清单不可用");
  const segments = (
    db
      .prepare(
        "SELECT segment_id,ordinal,locator_json,geometry_kind,source_kind,point_count,time_status FROM track_segments WHERE version_id=? ORDER BY ordinal",
      )
      .all(ref.version_id) as (Omit<SegmentManifest, "locator"> & {
      locator_json: string;
    })[]
  ).map(({ locator_json, ...s }) => ({
    ...s,
    locator: JSON.parse(locator_json) as number[],
  }));
  const settings = validatePresentation(
    ref.override?.settings ?? JSON.parse(row.settings_json),
    segments.map((s) => s.segment_id),
  );
  const sha = ref.override?.sha256 ?? row.settings_sha256;
  if (presentationDigest(settings) !== sha)
    throw new AppError("USER_INPUT", "展示设置校验失败");
  const current = !!db
    .prepare(
      "SELECT 1 FROM archive_entries WHERE id=? AND current_version_id=? AND current_presentation_id=? AND state='active'",
    )
    .get(ref.entry_id, ref.version_id, ref.presentation_id);
  return {
    segments,
    settings,
    current,
    key: hashJson([
      ref.archive_id,
      ref.version_id,
      ref.presentation_id,
      ref.sha256,
      sha,
      DISPLAY_VERSION,
    ]),
  };
}
export function displayed(
  data: TrackData,
  segments: SegmentManifest[],
  settings: Presentation,
) {
  const view = evaluatePresentation(bindSegments(data, segments), settings);
  const lines: TrackSegment[] = view.connections.map((c) => ({
    kind: "LineString",
    geometry_id: `connection:${c.from}:${c.to}`,
    longitude: Float64Array.from(c.coordinates, (p) => p[0]),
    latitude: Float64Array.from(c.coordinates, (p) => p[1]),
    altitude: null,
    time_us: null,
  }));
  const trackData = {
    ...data,
    tracks: [
      {
        index: 1,
        placemark_id: "",
        name: data.name,
        segments: [...view.segments, ...lines],
      },
    ],
  };
  return { view, data: trackData, geojson: () => geojson(trackData) };
}
