import { z } from "zod";
import type { Presentation, SegmentManifest } from "./track-edit.js";
export type Position = [number, number];
export type Geometry =
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "MultiPoint"; coordinates: Position[] };
export interface Feature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: Geometry;
}
export interface TrackGeoJSON {
  type: "FeatureCollection";
  features: Feature[];
}
export interface SelectedTrack {
  entry: string;
  sha256: string;
  points: number;
  geojson: TrackGeoJSON;
  presentation?: {
    settings: Presentation;
    segments: SegmentManifest[];
    current: boolean;
  };
}
export interface Selection {
  archive: string;
  tracks: SelectedTrack[];
  errors: { entry: string; error: string }[];
}
export interface Catalog {
  archive: string;
  entries: {
    id: string;
    entry: string;
    sha256: string;
    name: string;
    kind: string;
    date: string;
  }[];
}
export interface MapPreset {
  id: string;
  name: string;
  group: string;
  tile_size: number;
  tile_display_size: number;
  maxzoom: number;
  minzoom: number;
  crs: string;
  imagery: boolean;
  has_text: boolean;
  overlay_only: boolean;
  attribution: string;
  kind: string;
  format: string;
  content: string[];
  scheme: string;
  addressing: string;
  coverage: string;
  content_note: string;
  available: boolean;
  category: string;
}
export interface MapConfig {
  versions: Record<string, unknown>;
  vectorMaxZoom: number;
  basemaps: MapPreset[];
  overlays: MapPreset[];
  vectorLayers: Record<string, Record<string, string>>;
  attribution: string;
  customVectorAttribution: string;
  cacheTime: number;
}
export const SelectionRequest = z
  .object({
    archive: z.string().min(1).max(4096),
    entries: z.array(z.string().min(1).max(4096)).max(200),
  })
  .refine(
    (v) => new Set(v.entries).size === v.entries.length,
    "选择中有重复归档路径",
  );
