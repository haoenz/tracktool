import { AppError } from "./errors.js";
export interface TrackSegment {
  kind: "LineString" | "gx:Track";
  geometry_id: string;
  longitude: Float64Array;
  latitude: Float64Array;
  altitude: Float64Array | null;
  time_us: BigInt64Array | null;
}
export interface TrackFeature {
  index: number;
  placemark_id: string;
  name: string;
  segments: TrackSegment[];
}
export interface TrackData {
  source: string;
  name: string;
  track_tags: string;
  start_name: string;
  end_name: string;
  tracks: TrackFeature[];
}
export const MAX_POINTS = 2_000_000;
export const MAX_KML_BYTES = 128 * 1024 * 1024;
export function pointCount(data: TrackData): number {
  return data.tracks.reduce(
    (n, t) => n + t.segments.reduce((m, s) => m + s.longitude.length, 0),
    0,
  );
}
const numeric = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
export function coordinateNumber(
  text: string,
  field: "longitude" | "latitude" | "altitude",
  location: string,
): number {
  const n = Number(text),
    limit = field === "longitude" ? 180 : field === "latitude" ? 90 : Infinity;
  if (!numeric.test(text) || !Number.isFinite(n) || Math.abs(n) > limit)
    throw new AppError(
      "USER_INPUT",
      `${location}: Invalid ${field} ${JSON.stringify(text)}`,
    );
  return n;
}
/** Gregorian day arithmetic and integer microseconds: no millisecond/floating timestamp round trip. */
export function timestamp(text: string, location = ""): bigint {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      text,
    );
  const fail = () => {
    throw new AppError(
      "USER_INPUT",
      `${location}: Invalid timestamp ${JSON.stringify(text)}`,
    );
  };
  if (!m) return fail();
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetH = Number(m[10] ?? 0),
    offsetM = Number(m[11] ?? 0);
  if (
    y < 1 ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > months[mo - 1]! ||
    h > 23 ||
    mi > 59 ||
    s > 59 ||
    offsetH > 23 ||
    offsetM > 59
  )
    return fail();
  const before = (year: number) =>
    365 * (year - 1) +
    Math.floor((year - 1) / 4) -
    Math.floor((year - 1) / 100) +
    Math.floor((year - 1) / 400);
  const days =
    before(y) -
    before(1970) +
    months.slice(0, mo - 1).reduce((a, b) => a + b, 0) +
    d -
    1;
  const offset = (offsetH * 60 + offsetM) * 60 * (m[9] === "-" ? -1 : 1);
  return (
    BigInt(days * 86400 + h * 3600 + mi * 60 + s - offset) * 1_000_000n +
    BigInt((m[7] ?? "").slice(0, 6).padEnd(6, "0"))
  );
}
