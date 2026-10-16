import type { EditGeometry, EditPreview } from "./track-edit.js";

/** Geometry is full WGS84 geometry; its array offsets are the real segment indices. */
export function nearestPoint(
  coordinates: [number, number][],
  p: [number, number],
) {
  let best = -1,
    distance = Infinity;
  coordinates.forEach(([x, y], index) => {
    const dx = ((((x - p[0] + 180) % 360) + 360) % 360) - 180;
    const d = (dx * Math.cos((p[1] * Math.PI) / 180)) ** 2 + (y - p[1]) ** 2;
    if (d < distance) {
      best = index;
      distance = d;
    }
  });
  return best;
}

export function previewAnnotations(
  before: EditGeometry | undefined,
  preview: EditPreview,
  after?: EditGeometry,
): EditGeometry["segments"] {
  if (!before) return [];
  const annotations: EditGeometry["segments"] = [];
  for (const change of preview.changes)
    for (const range of change.removed_ranges) {
      const coords = before.segments
        .find((s) => s.segment_id === range.segment_id)
        ?.coordinates.slice(range.start, range.end);
      if (coords?.length)
        annotations.push({ segment_id: "ux-delete", coordinates: coords });
    }
  if (preview.operation.kind === "split_segment") {
    const op = preview.operation;
    const coords = before.segments.find(
      (s) => s.segment_id === op.segment_id,
    )?.coordinates;
    for (const index of op.after_point_indices)
      if (coords?.[index])
        annotations.push({
          segment_id: "ux-break",
          coordinates: [coords[index]],
        });
  }
  if (preview.operation.kind === "draw" && !after) {
    annotations.push({
      segment_id: "ux-add",
      coordinates: preview.operation.coordinates.map(([x, y]) => [x, y]),
    });
  } else if (["compose", "draw"].includes(preview.operation.kind) && after) {
    const originals = new Set(before.segments.map((s) => s.segment_id));
    for (const segment of after.segments)
      if (!originals.has(segment.segment_id))
        annotations.push({ ...segment, segment_id: "ux-add" });
  }
  return annotations;
}
