import { AppError } from "./errors.js";
import type { Presentation, SegmentManifest } from "./track-version.js";
import {
  SegmentEditSchema,
  type SegmentEdit,
  type PointRange,
} from "../shared/track-edit.js";
export { SegmentEditSchema, PointRangeSchema } from "../shared/track-edit.js";
export type { SegmentEdit, PointRange } from "../shared/track-edit.js";
export type SegmentInput = {
  version_id: string;
  raw: Uint8Array;
  segments: SegmentManifest[];
  settings: Presentation;
};
export type SegmentLineage = {
  ordinal: number;
  source_version_id: string;
  source_segment_id: string;
  start: number;
  end_exclusive: number;
  evidence_kind: "exact" | "ordered_subsequence" | "manual";
  evidence: Record<string, unknown>;
};
export type SegmentEditResult = {
  raw: Uint8Array;
  segments: SegmentManifest[];
  settings: Presentation;
  sources: SegmentLineage[];
  changes: {
    added_points: number;
    removed_points: number;
    removed_ranges: { segment_id: string; start: number; end: number }[];
    removed_connections: Presentation["connections"];
    before_edges: { from: string; to: string }[];
    after_edges: { from: string; to: string }[];
    warnings: string[];
  };
};
export function checkedEdit(input: unknown): SegmentEdit {
  const result = SegmentEditSchema.safeParse(input);
  if (!result.success) throw new AppError("USER_INPUT", result.error.message);
  return result.data;
}
export function checkedRanges(
  ranges: PointRange[],
  count: number,
): PointRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let end = 0;
  for (const r of sorted) {
    if (
      r.start < end ||
      r.end > count ||
      r.start < 0 ||
      r.end <= r.start ||
      !Number.isInteger(r.start) ||
      !Number.isInteger(r.end)
    )
      throw new AppError(
        "USER_INPUT",
        "Point ranges overlap or exceed segment bounds",
      );
    end = r.end;
  }
  return sorted;
}
export function keptRanges(removed: PointRange[], count: number): PointRange[] {
  const kept: PointRange[] = [];
  let start = 0;
  for (const r of checkedRanges(removed, count)) {
    if (start < r.start) kept.push({ start, end: r.start });
    start = r.end;
  }
  if (start < count) kept.push({ start, end: count });
  if (!kept.length)
    throw new AppError(
      "USER_INPUT",
      "Cannot remove every point; use ignore to hide a segment",
    );
  return kept;
}
/** Remap incident overrides to the first/last child; explicitly break every new internal edge. */
export function splitSettings(
  settings: Presentation,
  id: string,
  children: string[],
): Presentation {
  return {
    ...settings,
    order: settings.order.flatMap((s) => (s === id ? children : [s])),
    ignored: settings.ignored.flatMap((s) => (s === id ? children : [s])),
    connections: [
      ...settings.connections.map((e) => ({
        ...e,
        from: e.from === id ? children.at(-1)! : e.from,
        to: e.to === id ? children[0]! : e.to,
      })),
      ...children
        .slice(1)
        .map((to, i) => ({ from: children[i]!, to, connect: false })),
    ],
  };
}
export function insertSettings(
  settings: Presentation,
  after: string | null,
  id: string,
): { settings: Presentation; removed: Presentation["connections"] } {
  const at = after === null ? 0 : settings.order.indexOf(after) + 1;
  if (after !== null && at === 0)
    throw new AppError("USER_INPUT", "Unknown insertion segment");
  const left = new Set(settings.order.slice(0, at)),
    right = new Set(settings.order.slice(at));
  // Any old cross-boundary override would bypass the newly inserted geometry.
  const removed = settings.connections.filter(
    (e) => left.has(e.from) && right.has(e.to),
  );
  return {
    settings: {
      ...settings,
      order: [...settings.order.slice(0, at), id, ...settings.order.slice(at)],
      connections: settings.connections.filter(
        (e) => !(left.has(e.from) && right.has(e.to)),
      ),
    },
    removed,
  };
}
