declare module "vt-pbf" {
  import type { TileFeature } from "geojson-vt";
  const encoder: {
    fromGeojsonVt(
      layers: Record<string, { features: TileFeature[] }>,
      options: { version: number; extent: number },
    ): Uint8Array;
  };
  export default encoder;
}
