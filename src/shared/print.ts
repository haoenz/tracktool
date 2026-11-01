import type { Catalog } from "./map.js";
import { z } from "zod";
import {
  MapStateSchema,
  MapStyleSchema,
  MapTitleSchema,
  type MapState,
} from "./map-state.js";

export const PrintTrackSchema = z
  .object({
    entry: z.string().min(1).max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PrintTrack = z.infer<typeof PrintTrackSchema>;

export const PrintDocumentSchema = MapStateSchema.safeExtend({
  format: z.literal("tracktool-print"),
  version: z.literal(1),
  archive: z.string().max(4096),
  title: MapTitleSchema,
  tracks: z.array(PrintTrackSchema),
}).superRefine((value, ctx) => {
  if (
    new Set(value.tracks.map((track) => track.entry)).size !==
    value.tracks.length
  )
    ctx.addIssue({ code: "custom", message: "重复轨迹" });
});
export type PrintDocument = z.infer<typeof PrintDocumentSchema>;

export function printDocument(
  state: MapState,
  archive: string,
  tracks: PrintTrack[],
): PrintDocument {
  return {
    format: "tracktool-print",
    version: 1,
    archive,
    title: state.title,
    camera: { center: state.camera.center, zoom: state.camera.zoom },
    frame: {
      ratio: state.frame.ratio,
      width: state.frame.width,
      height: state.frame.height,
    },
    output: { width: state.output.width, height: state.output.height },
    style: MapStyleSchema.parse(state.style),
    tracks: tracks.map(({ entry, sha256 }) => ({ entry, sha256 })),
  };
}

export function mapExportFileName(name: string) {
  const stem = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  return `${[...stem].slice(0, 100).join("") || "tracktool-map"}.png`;
}

export interface MapExport {
  id: string;
  kind: "png";
  status: "queued" | "rendering" | "done" | "failed";
  phase: "preparing" | "resources" | "rendering" | "done" | "failed";
  created: number;
  expiresAt: number;
  fileName: string;
  title: string;
  width: number;
  height: number;
  trackCount: number;
  size?: number;
  error?: string;
  report?: Record<string, unknown>;
}

/** Documents always resolve by entry in the active archive, including drafts. */
export function resolvePrintTracks(document: PrintDocument, catalog: Catalog) {
  const byEntry = new Map(catalog.entries.map((entry) => [entry.entry, entry]));
  const tracks: Catalog["entries"] = [];
  let missing = 0;
  let changed = 0;
  for (const track of document.tracks) {
    const hit = byEntry.get(track.entry);
    if (!hit) missing++;
    else {
      tracks.push(hit);
      if (hit.sha256 !== track.sha256) changed++;
    }
  }
  const warnings: string[] = [];
  if (document.archive !== catalog.archive)
    warnings.push("文档来自其他轨迹库，已按当前库的 entry 路径匹配轨迹");
  if (missing) warnings.push(`${missing} 条轨迹已不存在`);
  if (changed) warnings.push(`${changed} 条轨迹已更新`);
  return { tracks, warnings };
}
