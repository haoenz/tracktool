import type { Position } from "../shared/map.js";

export function trackBounds(
  coordinates: Position[],
): [[number, number], [number, number]] | undefined {
  if (!coordinates.length) return undefined;
  // Pick the shortest longitude arc so date-line crossings stay together.
  const lons = coordinates
    .map((p) => ((p[0] % 360) + 360) % 360)
    .sort((a, b) => a - b);
  let gap = -1,
    start = lons[0]!;
  for (let i = 0; i < lons.length; i++) {
    const next =
      lons[(i + 1) % lons.length]! + (i === lons.length - 1 ? 360 : 0);
    if (next - lons[i]! > gap) {
      gap = next - lons[i]!;
      start = next % 360;
    }
  }
  let west = Infinity,
    east = -Infinity,
    south = 90,
    north = -90;
  for (const [lon, lat] of coordinates) {
    let x = ((lon % 360) + 360) % 360;
    if (x < start - 1e-8) x += 360;
    west = Math.min(west, x);
    east = Math.max(east, x);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  if (west > 180) {
    west -= 360;
    east -= 360;
  }
  return [
    [west, south],
    [east, north],
  ];
}

export function compositionPadding(
  surround: { x: number; y: number },
  hasTitle: boolean,
  creditHeight: number,
) {
  // Insets are logical output pixels, independent of preview zoom or panels.
  return {
    top: surround.y + (hasTitle ? 90 : 55),
    bottom: surround.y + Math.max(55, creditHeight + 24),
    left: surround.x + 55,
    right: surround.x + 55,
  };
}
