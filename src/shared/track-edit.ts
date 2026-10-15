import { z } from "zod";
import { ArchiveRefSchema } from "./archive-actions.js";
const id = z.string().min(1).max(200);
export const PresentationSchema = z
  .object({
    schema: z.literal(1),
    default_connect: z.boolean(),
    order: z.array(id).max(10000),
    ignored: z.array(id).max(10000),
    connections: z
      .array(z.object({ from: id, to: id, connect: z.boolean() }).strict())
      .max(20000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const positions = new Map(v.order.map((s, i) => [s, i]));
    if (positions.size !== v.order.length) fail("duplicate segment in order");
    if (new Set(v.ignored).size !== v.ignored.length)
      fail("duplicate ignored segment");
    if (v.ignored.some((s) => !positions.has(s)))
      fail("unknown ignored segment");
    const edges = new Set<string>();
    for (const edge of v.connections) {
      const from = positions.get(edge.from),
        to = positions.get(edge.to);
      if (from === undefined || to === undefined)
        fail("unknown connection endpoint");
      else if (from >= to) fail("connection must follow segment order");
      const key = JSON.stringify([edge.from, edge.to]);
      if (edges.has(key)) fail("duplicate connection override");
      edges.add(key);
    }
  });
export type Presentation = z.infer<typeof PresentationSchema>;
export type EntryState = "active" | "superseded" | "withdrawn" | "source_only";
export type VersionRef = {
  entry_id: string;
  version_id: string;
  presentation_id: string;
  generation: number;
  sha256: string;
};
export type EntrySnapshot = VersionRef & {
  path: string;
  category: "Default" | "Train" | "Flight" | null;
  filename_date: string | null;
  state: EntryState;
};
export type SegmentManifest = {
  segment_id: string;
  ordinal: number;
  locator: number[];
  geometry_kind: "gx:Track" | "LineString";
  source_kind: "measured" | "hand_drawn" | "unknown";
  point_count: number;
  time_status: "present" | "absent" | "mismatch";
};
export type Manifest = {
  status: "ready" | "unavailable";
  error: string | null;
  segments: SegmentManifest[];
};
const index = z
  .number()
  .int()
  .nonnegative()
  .max(2_000_000 - 1);
export const PointRangeSchema = z
  .object({ start: index, end: z.number().int().positive().max(2_000_000) })
  .strict()
  .refine((r) => r.start < r.end, "Empty point range");
export type PointRange = z.infer<typeof PointRangeSchema>;
const coordinate = z.union([
  z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
  ]),
  z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
    z.number().finite(),
  ]),
]);
const snap = z
  .object({ segment_id: id, endpoint: z.enum(["start", "end"]) })
  .strict();
export const SegmentEditSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("split_segment"),
      segment_id: id,
      after_point_indices: z.array(index).min(1).max(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prune"),
      segment_id: id,
      ranges: z.array(PointRangeSchema).min(1).max(10000),
    })
    .strict(),
  z.object({ kind: z.literal("reverse"), segment_id: id }).strict(),
  z
    .object({
      kind: z.literal("draw"),
      after_segment_id: id.nullable(),
      coordinates: z.array(coordinate).min(2).max(2_000_000),
      snap_start: snap.optional(),
      snap_end: snap.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("compose"),
      segments: z
        .array(
          z
            .object({
              version_id: id,
              segment_id: id,
              reverse: z.boolean().default(false),
            })
            .strict(),
        )
        .min(1)
        .max(10000),
      default_connect: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal("presentation"), settings: PresentationSchema })
    .strict(),
]);
export type SegmentEdit = z.infer<typeof SegmentEditSchema>;
export const HistoricalRefSchema = ArchiveRefSchema.omit({ generation: true });
const targetOperation = z.discriminatedUnion("kind", [
  ...SegmentEditSchema.options,
  z
    .object({ kind: z.literal("set_tag"), tag: z.string().min(1).max(200) })
    .strict(),
  z.object({ kind: z.literal("fill_altitude") }).strict(),
  z
    .object({
      kind: z.literal("split_journey"),
      outputs: z
        .array(
          z
            .object({
              path: z.string().min(1).max(4096),
              category: z.enum(["Default", "Train", "Flight"]).nullable(),
              segment_ids: z.array(id).min(1).max(10000),
            })
            .strict(),
        )
        .min(2)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restore_version"),
      version_id: id,
      presentation_id: id,
    })
    .strict(),
]);
export const EditRequestSchema = z.union([
  z
    .object({
      schema: z.literal(1),
      archive_id: id,
      operation: z
        .object({
          kind: z.literal("legacy_regroup"),
          expected: z.array(ArchiveRefSchema).min(2).max(100),
          path: z.string().min(1).max(4096),
          category: z.enum(["Default", "Train", "Flight"]).nullable(),
          segments: z
            .array(z.object({ version_id: id, segment_id: id }).strict())
            .min(1)
            .max(10000),
          evidence: z.string().min(1).max(4000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      schema: z.literal(1),
      archive_id: id,
      target: ArchiveRefSchema,
      sources: z.array(HistoricalRefSchema).max(1000).default([]),
      operation: targetOperation,
    })
    .strict(),
  z
    .object({
      schema: z.literal(1),
      archive_id: id,
      operation: z
        .object({
          kind: z.literal("restore_group"),
          operation_id: id,
          expected: z.array(ArchiveRefSchema).min(1).max(101),
        })
        .strict(),
    })
    .strict(),
]);
export type EditRequest = z.infer<typeof EditRequestSchema>;
export const EditApplySchema = z
  .object({
    schema: z.literal(1),
    archive_id: id,
    preview_id: z.string().uuid(),
    preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    request_key: id,
  })
  .strict();
export type EditApply = z.infer<typeof EditApplySchema>;
export type TrackDetail = {
  archive_id: string;
  entry: EntrySnapshot;
  settings: Presentation;
  segments: SegmentManifest[];
  next_cursor: number | null;
  manifest_status: string;
  manifest_error: string | null;
};
export type VersionSummary = {
  id: string;
  version_no: number;
  created_at: string;
  origin: string;
  operation_id: string;
  sha256: string;
  presentations: { id: string; created_at: string }[];
};
export type EditPreview = {
  preview_id: string;
  preview_sha256: string;
  archive_id: string;
  created_at: string;
  expires_at: string;
  operation: EditRequest["operation"];
  before: EntrySnapshot[];
  outputs: {
    path: string;
    state: EntryState;
    sha256: string;
    segments: SegmentManifest[];
    settings: Presentation;
  }[];
  changes: {
    added_points: number;
    removed_points: number;
    removed_ranges: { segment_id: string; start: number; end: number }[];
    removed_connections: Presentation["connections"];
    before_edges: { from: string; to: string }[];
    after_edges: { from: string; to: string }[];
    warnings: string[];
  }[];
};
export type EditGeometry = {
  segments: { segment_id: string; coordinates: [number, number][] }[];
  connections: [number, number][][];
};
