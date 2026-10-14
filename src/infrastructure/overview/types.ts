import { z } from "zod";
import {
  OverviewBounds,
  OverviewCrs,
  OverviewEntry,
  OverviewSummary,
  OverviewVersion,
} from "../../shared/overview.js";
export const FORMAT = 2;
export const LIMITS = {
  diskBytes: 512 * 1024 ** 2,
  buildBytes: 128 * 1024 ** 2,
  memoryBytes: 32 * 1024 ** 2,
  memoryTiles: 512,
  indexTiles: 4096,
  indexHeapBytes: 256 * 1024 ** 2,
  tileBytes: 4 * 1024 ** 2,
  points: 3_000_000,
  entries: 50_000,
  detailPoints: 200_000,
};
export const Manifest = z.object({
  format: z.literal(FORMAT),
  version: OverviewVersion,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  archiveId: z.string(),
  revision: z.number().int(),
  crs: OverviewCrs,
  createdAt: z.number(),
  geometryHash: z.string(),
  geometryBytes: z.number(),
  bounds: OverviewBounds.nullable(),
  summary: OverviewSummary,
  entries: z.array(OverviewEntry).max(LIMITS.entries),
});
export type Manifest = z.infer<typeof Manifest>;
export interface SourceStamp {
  archiveId: string;
  revision: number;
}
export interface BuildRequest {
  source: string;
  root: string;
  crs: OverviewCrs;
  fingerprint: string;
  stamp: SourceStamp;
  budget: number;
}
export type OverviewCommand =
  | { op: "build"; request: BuildRequest }
  | {
      op: "tile";
      root: string;
      version: string;
      z: number;
      x: number;
      y: number;
      indexTiles: number;
    }
  | { op: "detail"; root: string; version: string; id: string }
  | { op: "reset" };
