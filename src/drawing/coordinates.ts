import type { Position, TrackGeoJSON } from "../shared/map.js";
import { displayCoordinate } from "../shared/coordinates.js";
export { displayCoordinate } from "../shared/coordinates.js";

// Projects and archive geometry always remain WGS84. Convert only at the
// rendering boundary for the supplied Google gl=CN raster presets.
export function displayGeometry(
  collection: TrackGeoJSON,
  crs: string,
): TrackGeoJSON {
  if (crs !== "gcj02") return collection;
  const convert = (point: Position) => displayCoordinate(point, crs);
  return {
    ...collection,
    features: collection.features.map((feature) => ({
      ...feature,
      geometry:
        feature.geometry.type === "MultiLineString"
          ? {
              type: "MultiLineString",
              coordinates: feature.geometry.coordinates.map((segment) =>
                segment.map(convert),
              ),
            }
          : {
              type: "MultiPoint",
              coordinates: feature.geometry.coordinates.map(convert),
            },
    })),
  };
}
