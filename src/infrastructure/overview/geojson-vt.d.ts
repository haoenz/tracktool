// Narrow declarations for the locked 4.0.3 API; older DefinitelyTyped geometry
// declarations describe line geometry as points and cannot model MVT rings.
declare module "geojson-vt" {
  import type { GeoJSON } from "geojson";
  export interface TileFeature {
    type: 1 | 2 | 3;
    geometry: number[][] | number[][][];
    tags?: Record<string, string | number | boolean>;
    id?: number;
  }
  export interface TileIndex {
    getTile(
      z: number,
      x: number,
      y: number,
    ): { features: TileFeature[] } | null;
    tileCoords: { z: number; x: number; y: number }[];
  }
  export default function geojsonvt(
    data: GeoJSON,
    options: {
      extent: number;
      tolerance: number;
      buffer: number;
      maxZoom: number;
      indexMaxZoom: number;
      indexMaxPoints: number;
    },
  ): TileIndex;
}
