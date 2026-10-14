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
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
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
