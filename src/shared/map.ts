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
  attribution: string;
  kind: string;
  format: string;
  content: string[];
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
}
