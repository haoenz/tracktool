import { AppError } from "./errors.js";
import { distance, driftIndices, splitIndices } from "./kml-edit.js";
import {
  validatePresentation,
  type Presentation,
  type SegmentManifest,
} from "./track-version.js";
import type { TrackData, TrackSegment } from "./trackdata.js";
import type { PointRange } from "./segment-edit.js";

export type BoundSegment = TrackSegment &
  Pick<SegmentManifest, "segment_id" | "source_kind">;
export type DisplayConnection = {
  kind: "connection";
  from: string;
  to: string;
  coordinates: [[number, number], [number, number]];
  distance_m: number;
};
/** IDs belong to a version, never to the shared content-addressed geometry cache. */
export function bindSegments(
  data: TrackData,
  manifest: SegmentManifest[],
): BoundSegment[] {
  const geometries = data.tracks.flatMap((t) => t.segments);
  if (geometries.length !== manifest.length)
    throw new AppError("USER_INPUT", "轨迹片段清单与几何数据不一致");
  const ids = new Set<string>();
  return manifest.map((s, i) => {
    const g = geometries[i]!;
    if (
      s.ordinal !== i ||
      ids.has(s.segment_id) ||
      g.kind !== s.geometry_kind ||
      g.longitude.length !== s.point_count ||
      g.latitude.length !== s.point_count ||
      (g.altitude !== null && g.altitude.length !== s.point_count) ||
      (g.time_us !== null && g.time_us.length !== s.point_count)
    )
      throw new AppError("USER_INPUT", "轨迹片段清单与几何数据不一致");
    ids.add(s.segment_id);
    return { ...g, segment_id: s.segment_id, source_kind: s.source_kind };
  });
}
export function resolvedEdges(
  settings: Presentation,
  ids: string[],
): { from: string; to: string }[] {
  const value = validatePresentation(settings, ids);
  const ignored = new Set(value.ignored);
  return value.gaps
    .filter(
      (e) =>
        e.reason === "tunnel" && !ignored.has(e.from) && !ignored.has(e.to),
    )
    .map(({ from, to }) => ({ from, to }));
}
function point(s: TrackSegment, i: number): [number, number] {
  return [s.longitude[i]!, s.latitude[i]!];
}
export function evaluatePresentation(
  segments: BoundSegment[],
  settings: Presentation,
  showTunnels = true,
) {
  const resolved = resolvedEdges(
    settings,
    segments.map((s) => s.segment_id),
  );
  const edges = showTunnels ? resolved : [],
    byId = new Map(segments.map((s) => [s.segment_id, s])),
    ignored = new Set(settings.ignored);
  const visible = settings.order
    .filter((id) => !ignored.has(id))
    .map((id) => byId.get(id)!);
  const connections: DisplayConnection[] = [];
  for (const { from, to } of edges) {
    const a = byId.get(from)!,
      b = byId.get(to)!;
    const start = point(a, a.longitude.length - 1),
      end = point(b, 0),
      meters = distance(start, end);
    if (meters > 0)
      connections.push({
        kind: "connection",
        from,
        to,
        coordinates: [start, end],
        distance_m: meters,
      });
  }
  const totals = {
    measured_m: 0,
    hand_drawn_m: 0,
    unknown_m: 0,
    connection_m: connections.reduce((n, e) => n + e.distance_m, 0),
    measured_timed_m: 0,
    measured_seconds: 0,
    measured_speed_mps: null as number | null,
  };
  for (const s of visible)
    for (let i = 1; i < s.longitude.length; i++) {
      const meters = distance(point(s, i - 1), point(s, i));
      if (s.source_kind === "measured") totals.measured_m += meters;
      else if (s.source_kind === "hand_drawn") totals.hand_drawn_m += meters;
      else totals.unknown_m += meters;
      if (s.source_kind === "measured" && s.time_us) {
        const delta = Number(s.time_us[i]! - s.time_us[i - 1]!) / 1e6;
        if (delta > 0) {
          totals.measured_timed_m += meters;
          totals.measured_seconds += delta;
        }
      }
    }
  if (totals.measured_seconds > 0)
    totals.measured_speed_mps =
      totals.measured_timed_m / totals.measured_seconds;
  return { segments: visible, edges, connections, totals };
}
/** Detection returns explicit indices/ranges. Only subsequent editing changes content. */
export function detectSegmentGaps(
  segment: TrackSegment,
  options: { gapSeconds: number; gapMeters: number },
): number[] {
  timed(segment);
  thresholds(options);
  return splitIndices(texts(segment), Array.from(segment.time_us!), {
    kind: "split",
    stem: "",
    points: [],
    auto: true,
    ...options,
  });
}
export function detectSegmentDrift(
  segment: TrackSegment,
  options: {
    speedMps: number;
    jumpMeters: number;
    returnMeters: number;
    maxSeconds: number;
  },
): PointRange[] {
  timed(segment);
  thresholds(options);
  const indices = [
      ...driftIndices(texts(segment), Array.from(segment.time_us!), {
        kind: "prune",
        stem: "",
        points: [],
        auto: true,
        ...options,
      }),
    ].sort((a, b) => a - b),
    ranges: PointRange[] = [];
  for (const i of indices) {
    const last = ranges.at(-1);
    if (last?.end === i) last.end++;
    else ranges.push({ start: i, end: i + 1 });
  }
  return ranges;
}
function texts(s: TrackSegment) {
  return Array.from(s.longitude, (lon, i) => `${lon} ${s.latitude[i]}`);
}
function timed(s: TrackSegment) {
  if (!s.time_us || s.time_us.length !== s.longitude.length)
    throw new AppError("USER_INPUT", "自动检测需要完整的轨迹时间戳");
}
function thresholds(options: Record<string, number>) {
  if (Object.values(options).some((n) => !Number.isFinite(n) || n < 0))
    throw new AppError("USER_INPUT", "检测阈值必须是非负有限数");
}
