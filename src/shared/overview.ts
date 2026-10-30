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
/** Per-entry visibility shared by the browsing layer and the print renderer. */
export type OverviewVisibility = {
  all: boolean;
  exceptions: Record<string, string>;
};
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

export interface OverviewSortKey {
  name: string;
  dated: boolean;
  time: bigint;
}
/** Parse once per entry; sorting large manifests otherwise re-parses every comparison. */
export function overviewSortKey(entry: OverviewEntry): OverviewSortKey {
  return {
    name: entry.name,
    dated: !!entry.date,
    time:
      entry.start_time_us !== undefined
        ? BigInt(entry.start_time_us)
        : entry.date
          ? BigInt(Date.parse(`${entry.date}T00:00:00+08:00`)) * 1000n
          : 0n,
  };
}
export function compareOverviewSortKeys(
  a: OverviewSortKey,
  b: OverviewSortKey,
  sort: string,
): number {
  if (sort === "name") return a.name.localeCompare(b.name);
  if (!a.dated || !b.dated) return a.dated ? -1 : b.dated ? 1 : 0;
  const order = a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
  return sort === "date-asc" ? order : -order;
}
/** Shared by server pagination and client-side candidate merging. */
export function compareOverviewEntries(
  a: OverviewEntry,
  b: OverviewEntry,
  sort: string,
): number {
  return (
    compareOverviewSortKeys(overviewSortKey(a), overviewSortKey(b), sort) ||
    a.id.localeCompare(b.id)
  );
}
