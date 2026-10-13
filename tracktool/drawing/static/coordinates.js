import gcoord from "./vendor/gcoord.js";

// Projects and archive geometry always remain WGS84. Convert only at the
// rendering boundary for the supplied Google gl=CN raster presets.
export function displayCoordinate(position, crs, inverse = false) {
  if (crs !== "gcj02") return position.slice();
  const [lon, lat] = position;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const shifted = inverse
    ? gcoord.transform([wrapped, lat], gcoord.GCJ02, gcoord.WGS84)
    : gcoord.transform([wrapped, lat], gcoord.WGS84, gcoord.GCJ02);
  return [shifted[0] + lon - wrapped, shifted[1], ...position.slice(2)];
}

export function displayGeometry(collection, crs) {
  if (crs !== "gcj02") return collection;
  const convert = (point) => displayCoordinate(point, crs);
  return {
    ...collection,
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates:
          feature.geometry.type === "MultiLineString"
            ? feature.geometry.coordinates.map((segment) =>
                segment.map(convert),
              )
            : feature.geometry.coordinates.map(convert),
      },
    })),
  };
}
