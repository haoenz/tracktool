import { z } from "zod";

export const OverviewCrs = z.enum(["wgs84", "gcj02"]);
export type OverviewCrs = z.infer<typeof OverviewCrs>;
export const OverviewVersion = z.string().regex(/^[a-f0-9]{32}$/);
export const OverviewBounds = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);
export const OverviewEntry = z.object({
  id: z.string(),
  entry: z.string(),
  name: z.string(),
  kind: z.string(),
  date: z.string(),
  start_time_us: z
    .string()
    .regex(/^-?\d+$/)
    .optional(),
  tags: z.string().optional(),
  distance_m: z.number().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  display_key: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  points: z.number().int().nonnegative(),
  segments: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type OverviewEntry = z.infer<typeof OverviewEntry>;
export const OverviewSummary = z.object({
  entries: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  points: z.number().int().nonnegative(),
});
export interface OverviewProgress {
  completed: number;
  total: number;
  phase: "reading" | "indexing";
}
export interface OverviewStatus {
  state: "unconfigured" | "building" | "ready" | "error";
  crs: OverviewCrs;
  updating: boolean;
  version: string | null;
  revision?: number;
  bounds?: z.infer<typeof OverviewBounds> | null;
  summary?: z.infer<typeof OverviewSummary>;
  progress?: OverviewProgress;
  error?: string;
  tiles?: string;
  maxZoom: number;
}

/** Shared by server pagination and client-side candidate merging. */
export function compareOverviewEntries(
  a: OverviewEntry,
  b: OverviewEntry,
  sort: string,
): number {
  if (sort === "name")
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (!a.date || !b.date)
    return (a.date ? -1 : b.date ? 1 : 0) || a.id.localeCompare(b.id);
  const time = (entry: OverviewEntry) =>
    entry.start_time_us !== undefined
      ? BigInt(entry.start_time_us)
      : BigInt(Date.parse(`${entry.date}T00:00:00+08:00`)) * 1000n;
  const left = time(a),
    right = time(b);
  const order = left < right ? -1 : left > right ? 1 : 0;
  return (sort === "date-asc" ? order : -order) || a.id.localeCompare(b.id);
}
