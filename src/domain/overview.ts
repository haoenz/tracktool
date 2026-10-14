import type { Feature, LineString, Point } from "geojson";
import { AppError } from "./errors.js";
import { roundEven } from "./geometry.js";
import { displayCoordinate } from "../shared/coordinates.js";
import type { Position } from "../shared/map.js";
import type { OverviewCrs } from "../shared/overview.js";

export const OVERVIEW_TILING = {
  extent: 8192,
  tolerance: 4,
  buffer: 128,
  maxZoom: 18,
  indexMaxZoom: 5,
  indexMaxPoints: 100000,
};
export interface DisplayProperties {
  trackId: string;
  kind: string;
  segmentId: string;
  part: number;
  role: "line" | "point";
  minLineZoom: number;
}
export type DisplayFeature = Feature<LineString | Point, DisplayProperties>;
export function project([x, y]: Position): Position {
  return [
    (x + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + (y * Math.PI) / 360)) / Math.PI) / 2,
  ];
}
function unproject([x, y]: Position): Position {
  return [
    x * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
  ];
}
/** Split in projected space, so added seam vertices stay on the original line. */
export function splitOverviewLine(coords: Position[]): Position[][] {
  let previous = project(coords[0]!),
    world = Math.floor(previous[0]);
  let part: Position[] = [[previous[0] - world, previous[1]]];
  const parts: Position[][] = [];
  for (let i = 1; i < coords.length; i++) {
    const current = project(coords[i]!);
    current[0] += roundEven(previous[0] - current[0]);
    while (current[0] < world || current[0] > world + 1) {
      const east = current[0] > world + 1,
        boundary = east ? world + 1 : world;
      const t = (boundary - previous[0]) / (current[0] - previous[0]);
      const y = previous[1] + t * (current[1] - previous[1]);
      const edge: Position = [east ? 1 : 0, y];
      const last = part.at(-1)!;
      if (last[0] !== edge[0] || last[1] !== edge[1]) part.push(edge);
      if (part.length > 1) parts.push(part.map(unproject));
      world += east ? 1 : -1;
      part = [[east ? 0 : 1, y]];
    }
    part.push([current[0] - world, current[1]]);
    previous = current;
  }
  if (part.length > 1) parts.push(part.map(unproject));
  return parts;
}
export function overviewFeatures(
  id: string,
  segments: Position[][],
  crs: OverviewCrs,
  kind = "Unknown",
): DisplayFeature[] {
  const result: DisplayFeature[] = [];
  for (const [s, raw] of segments.entries()) {
    if (
      !raw.length ||
      raw.some((p) => !p.every(Number.isFinite) || Math.abs(p[1]) > 85.05112878)
    )
      throw new AppError(
        "USER_INPUT",
        "轨迹包含空分段、无效坐标或超出 Web Mercator 纬度范围",
      );
    const coordinates = raw.map((p) => displayCoordinate(p, crs));
    const base = { kind, trackId: id, segmentId: `${id}:${s}`, part: 0 };
    if (coordinates.length === 1) {
      const p = coordinates[0]!;
      result.push({
        type: "Feature",
        properties: { ...base, role: "point", minLineZoom: 25 },
        geometry: {
          type: "Point",
          coordinates: [((((p[0] + 180) % 360) + 360) % 360) - 180, p[1]],
        },
      });
      continue;
    }
    for (const [part, line] of splitOverviewLine(coordinates).entries()) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of line) {
        const [x, y] = project(p);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const minLineZoom = Math.max(
        0,
        Math.min(
          25,
          Math.ceil(Math.log2(2 / (512 * Math.max(maxX - minX, maxY - minY)))),
        ),
      );
      const properties = { ...base, part, minLineZoom };
      result.push({
        type: "Feature",
        properties: { ...properties, role: "line" },
        geometry: { type: "LineString", coordinates: line },
      });
      if (minLineZoom > 0)
        result.push({
          type: "Feature",
          properties: { ...properties, role: "point" },
          geometry: { type: "Point", coordinates: line[0]! },
        });
    }
  }
  if (!result.length) throw new AppError("USER_INPUT", "轨迹没有可显示的几何");
  return result;
}
/** Cover actual line intervals, not just endpoints, and allow east > 180. */
export class OverviewExtent {
  private intervals: [number, number][] = [];
  private south = Infinity;
  private north = -Infinity;
  add(features: DisplayFeature[]) {
    for (const f of features) {
      const coords =
        f.geometry.type === "Point"
          ? [f.geometry.coordinates]
          : f.geometry.coordinates;
      let west = Infinity,
        east = -Infinity;
      for (const p of coords) {
        west = Math.min(west, p[0]!);
        east = Math.max(east, p[0]!);
        this.south = Math.min(this.south, p[1]!);
        this.north = Math.max(this.north, p[1]!);
      }
      this.intervals.push([west, east]);
    }
  }
  bounds(): [number, number, number, number] | null {
    const merged: [number, number][] = [];
    for (const span of this.intervals.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    if (!merged.length) return null;
    let gap = -1,
      west = -180,
      east = 180;
    for (let i = 0; i < merged.length; i++) {
      const a = merged[i]!,
        b = merged[(i + 1) % merged.length]!;
      const next = b[0] + (i === merged.length - 1 ? 360 : 0);
      if (next - a[1] > gap) {
        gap = next - a[1];
        west = b[0];
        east = a[1] + (a[1] < b[0] ? 360 : 0);
      }
    }
    return [west, this.south, east, this.north];
  }
}
