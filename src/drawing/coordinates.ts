import type { Position, TrackGeoJSON } from "../shared/map.js";
import gcoord from "gcoord";

// Projects and archive geometry always remain WGS84. Convert only at the
// rendering boundary for the supplied Google gl=CN raster presets.
export function displayCoordinate(
  position: Position,
  crs: string,
  inverse = false,
): Position {
  if (crs !== "gcj02") return [...position];
  const [lon, lat] = position;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const shifted = inverse
    ? gcoord.transform([wrapped, lat], gcoord.GCJ02, gcoord.WGS84)
    : gcoord.transform([wrapped, lat], gcoord.WGS84, gcoord.GCJ02);
  return [shifted[0]! + lon - wrapped, shifted[1]!];
}

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
