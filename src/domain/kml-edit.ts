import GeographicLib from "geographiclib-geodesic";
import { AppError } from "./errors.js";
import { timestamp } from "./trackdata.js";
export type EditOperation =
  | { kind: "set-tag"; tag: string; create: boolean }
  | {
      kind: "split";
      stem: string;
      points: string[];
      auto: boolean;
      gapSeconds: number;
      gapMeters: number;
    }
  | {
      kind: "prune";
      stem: string;
      points: string[];
      auto: boolean;
      speedMps: number;
      jumpMeters: number;
      returnMeters: number;
      maxSeconds: number;
    }
  | { kind: "to-multigeom" }
  | { kind: "altitude-targets" }
  | { kind: "altitude-apply"; values: (number | null)[] };
export type EditResult = {
  outputs: { name?: string; xml: string }[];
  count?: number;
  locations?: [number, number][];
  warnings?: string[];
};
export const xmlText = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export const kmlRoot = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">${body}</kml>`;
export function editTime(value: string): bigint {
  const s = value.trim();
  return timestamp(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
}
export function coordinate(value: string): [number, number] {
  const parts = value.trim().split(/\s+/).map(Number);
  const [lon, lat] = parts;
  if (
    lon === undefined ||
    lat === undefined ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  )
    throw new AppError("USER_INPUT", `Invalid coordinate: ${value}`);
  return [lon, lat];
}
export function distance(a: [number, number], b: [number, number]): number {
  return GeographicLib.Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0]).s12!;
}
export function splitIndices(
  coords: string[],
  times: bigint[],
  op: Extract<EditOperation, { kind: "split" }>,
): number[] {
  const indices: number[] = [];
  if (op.auto) {
    const points = coords.map(coordinate);
    for (let i = 0; i < coords.length - 1; i++)
      if (
        Number(times[i + 1]! - times[i]!) / 1e6 >= op.gapSeconds &&
        distance(points[i]!, points[i + 1]!) >= op.gapMeters
      )
        indices.push(i);
  } else
    for (const point of op.points) {
      if (/^-?\d{1,3}(\.\d+)?\s-?\d{1,2}(\.\d+)?\s\d+(\.\d+)?$/.test(point)) {
        const i = coords.indexOf(point);
        if (i < 0)
          throw new AppError("USER_INPUT", `Point not found: ${point}`);
        indices.push(i);
      } else {
        const t = editTime(point);
        let best = 0;
        const abs = (n: bigint) => (n < 0n ? -n : n);
        for (let i = 1; i < times.length; i++)
          if (
            abs(times[i]! - t) < abs(times[best]! - t) ||
            (abs(times[i]! - t) === abs(times[best]! - t) &&
              times[i]! < times[best]!)
          )
            best = i;
        indices.push(best);
      }
    }
  if (indices.includes(coords.length - 1))
    throw new AppError("USER_INPUT", "Cannot split at the last point");
  return [...new Set(indices)].sort((a, b) => a - b);
}
export function driftIndices(
  coords: string[],
  times: bigint[],
  op: Extract<EditOperation, { kind: "prune" }>,
): Set<number> {
  const points = coords.map(coordinate);
  const remove = new Set<number>();
  let i = 0;
  while (i < points.length - 1) {
    const step = distance(points[i]!, points[i + 1]!);
    const delta = Number(times[i + 1]! - times[i]!) / 1e6;
    if (
      step >= op.jumpMeters ||
      (delta <= 0 ? Infinity : step / delta) >= op.speedMps
    ) {
      let found = -1;
      for (let k = i + 1; k < points.length; k++) {
        if (Number(times[k]! - times[i]!) / 1e6 > op.maxSeconds) break;
        if (distance(points[i]!, points[k]!) <= op.returnMeters) {
          found = k;
          break;
        }
      }
      if (found > i + 1) {
        for (let k = i + 1; k < found; k++) remove.add(k);
        i = found;
        continue;
      }
    }
    i++;
  }
  return remove;
}
