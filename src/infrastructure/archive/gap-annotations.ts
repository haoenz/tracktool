import type Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import type { Presentation } from "../../shared/track-edit.js";

/** Reconstruct the logical snapshot; annotations have exactly one SQL source. */
export function annotatedSettings(
  db: Database.Database,
  presentationId: string,
  json: string,
): unknown {
  const settings = JSON.parse(json);
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    "gaps" in settings
  )
    throw new AppError("USER_INPUT", "展示设置存储格式无效");
  const gaps = db
    .prepare(
      "SELECT from_segment_id AS `from`,to_segment_id AS `to`,reason FROM track_gap_annotations WHERE presentation_id=? ORDER BY from_segment_id,to_segment_id",
    )
    .all(presentationId) as Presentation["gaps"];
  return { ...settings, gaps };
}
