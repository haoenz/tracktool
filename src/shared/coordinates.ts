import coordinateModule from "gcoord";
import type { Position } from "./map.js";

// gcoord's CommonJS default works in Node and the browser; its declarations
// expose a different default shape under NodeNext than under Bundler resolution.
const gcoord = coordinateModule as unknown as {
  transform(position: number[], from: string, to: string): number[];
  GCJ02: string;
  WGS84: string;
};

/** Canonical data stays WGS84; retain the world offset at the display boundary. */
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
