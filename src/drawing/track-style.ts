import type { Feature, Position, SelectedTrack } from "../shared/map.js";
import type { MapStyle } from "../shared/map-state.js";

const colors = [
  "#2563eb",
  "#ea580c",
  "#16a34a",
  "#9333ea",
  "#0891b2",
  "#dc2626",
  "#a16207",
  "#db2777",
];

export function projectTrackColor(entry: string, style: MapStyle): string {
  if (!style.color_mode || style.color_mode === "uniform") return style.color;
  const key = style.color_mode === "category" ? entry.split("/")[0]! : entry;
  // Names keep their colors when the user adds, removes or reorders tracks.
  let hash = 0;
  for (const character of key)
    hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return colors[hash % colors.length]!;
}

export function trackColor(style: MapStyle): string | unknown[] {
  return !style.color_mode || style.color_mode === "uniform"
    ? style.color
    : ["coalesce", ["get", "project_color"], style.color];
}

export function trackEndpoints(
  track: SelectedTrack,
): { start: Position; end: Position } | undefined {
  const lines = track.geojson.features.flatMap((feature) =>
    feature.geometry.type === "MultiLineString"
      ? feature.geometry.coordinates
      : [],
  );
  const points = track.geojson.features.flatMap((feature) =>
    feature.geometry.type === "MultiPoint" ? feature.geometry.coordinates : [],
  );
  if (track.presentation) {
    const { settings, segments } = track.presentation;
    const byId = new Map(
      segments.map((segment) => [segment.segment_id, segment]),
    );
    const ignored = new Set(settings.ignored);
    let line = 0,
      point = 0,
      start: Position | undefined,
      end: Position | undefined;
    for (const id of settings.order) {
      if (ignored.has(id)) continue;
      const segment = byId.get(id);
      if (!segment?.point_count) continue;
      const coordinates =
        segment.point_count === 1 ? [points[point++]] : lines[line++];
      const first = coordinates?.[0],
        last = coordinates?.at(-1);
      if (first && last) {
        start ??= first;
        end = last;
      }
    }
    return start && end ? { start, end } : undefined;
  }
  const start = lines.find((line) => line.length)?.[0] ?? points[0];
  const end = lines.findLast((line) => line.length)?.at(-1) ?? points.at(-1);
  return start && end ? { start, end } : undefined;
}

export function trackSegmentFeatures(track: SelectedTrack): Feature[] {
  if (
    !track.presentation ||
    track.geojson.features.some((feature) => feature.properties.segment_id)
  )
    return track.geojson.features;
  const lines = track.geojson.features.flatMap((feature) =>
    feature.geometry.type === "MultiLineString"
      ? feature.geometry.coordinates
      : [],
  );
  const points = track.geojson.features.flatMap((feature) =>
    feature.geometry.type === "MultiPoint" ? feature.geometry.coordinates : [],
  );
  const { settings, segments } = track.presentation;
  const byId = new Map(
    segments.map((segment) => [segment.segment_id, segment]),
  );
  const ignored = new Set(settings.ignored);
  const features: Feature[] = [];
  let line = 0,
    point = 0;
  for (const id of settings.order) {
    if (ignored.has(id)) continue;
    const segment = byId.get(id);
    if (!segment?.point_count) continue;
    const coordinates =
      segment.point_count === 1 ? points[point++] : lines[line++];
    if (!coordinates) continue;
    features.push({
      type: "Feature",
      properties: { segment_id: id },
      geometry:
        segment.point_count === 1
          ? { type: "MultiPoint", coordinates: [coordinates as Position] }
          : {
              type: "MultiLineString",
              coordinates: [coordinates as Position[]],
            },
    });
  }
  // Presentation connections follow original segments and have no segment id.
  if (line < lines.length)
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "MultiLineString", coordinates: lines.slice(line) },
    });
  if (point < points.length)
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPoint", coordinates: points.slice(point) },
    });
  return features;
}

export function selectedTrackSegment(
  track: SelectedTrack,
  segment: string,
): SelectedTrack | undefined {
  const feature = trackSegmentFeatures(track).find(
    (item) => item.properties.segment_id === segment,
  );
  if (!feature) return;
  const points =
    feature.geometry.type === "MultiLineString"
      ? feature.geometry.coordinates.reduce(
          (count, line) => count + line.length,
          0,
        )
      : feature.geometry.coordinates.length;
  return {
    ...track,
    presentation: undefined,
    points,
    geojson: { type: "FeatureCollection", features: [feature] },
  };
}
