import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";
import type { TrackData, TrackSegment } from "../domain/trackdata.js";
export const PARSER_VERSION = 2,
  SERIALIZATION_VERSION = 1;
const array = z.string().nullable();
const schema = z.object({
  version: z.literal(1),
  name: z.string(),
  track_tags: z.string(),
  start_name: z.string(),
  end_name: z.string(),
  tracks: z.array(
    z.object({
      index: z.number().int().positive(),
      placemark_id: z.string(),
      name: z.string(),
      segments: z.array(
        z.object({
          kind: z.enum(["LineString", "gx:Track"]),
          geometry_id: z.string(),
          longitude: z.string(),
          latitude: z.string(),
          altitude: array,
          time_us: array,
        }),
      ),
    }),
  ),
});
function encode(values: Float64Array | BigInt64Array | null): string | null {
  if (!values) return null;
  const buffer = Buffer.allocUnsafe(values.length * 8);
  if (values instanceof BigInt64Array)
    values.forEach((v, i) => buffer.writeBigInt64LE(v, i * 8));
  else values.forEach((v, i) => buffer.writeDoubleLE(v, i * 8));
  return buffer.toString("base64");
}
function bytes(value: string): Buffer {
  // Linear character scan: grouped repetition over a 20+ MiB string can exhaust V8's regexp stack.
  const unpadded = value.replace(/={1,2}$/, "");
  if (
    value.length % 4 ||
    /[^A-Za-z0-9+/]/.test(unpadded) ||
    value.length - unpadded.length > 2
  )
    throw new Error("Invalid index base64");
  const b = Buffer.from(value, "base64");
  if (b.length % 8) throw new Error("Misaligned index array");
  return b;
}
function doubles(value: string): Float64Array {
  const b = bytes(value),
    v = new Float64Array(b.length / 8);
  for (let i = 0; i < v.length; i++) v[i] = b.readDoubleLE(i * 8);
  return v;
}
function times(value: string): BigInt64Array {
  const b = bytes(value),
    v = new BigInt64Array(b.length / 8);
  for (let i = 0; i < v.length; i++) v[i] = b.readBigInt64LE(i * 8);
  return v;
}
export function serialize(data: TrackData): Buffer {
  return deflateSync(
    Buffer.from(
      JSON.stringify({
        version: 1,
        name: data.name,
        track_tags: data.track_tags,
        start_name: data.start_name,
        end_name: data.end_name,
        tracks: data.tracks.map((t) => ({
          ...t,
          segments: t.segments.map((s) => ({
            ...s,
            longitude: encode(s.longitude),
            latitude: encode(s.latitude),
            altitude: encode(s.altitude),
            time_us: encode(s.time_us),
          })),
        })),
      }),
    ),
  );
}
export function deserialize(payload: Uint8Array, source = ""): TrackData {
  const parsed = schema.parse(
    JSON.parse(
      inflateSync(payload, { maxOutputLength: 256 * 1024 * 1024 }).toString(
        "utf8",
      ),
    ),
  );
  const { version: _version, ...metadata } = parsed;
  void _version;
  return {
    source,
    ...metadata,
    tracks: parsed.tracks.map((t) => ({
      ...t,
      segments: t.segments.map((s) => {
        const segment: TrackSegment = {
          ...s,
          longitude: doubles(s.longitude),
          latitude: doubles(s.latitude),
          altitude: s.altitude === null ? null : doubles(s.altitude),
          time_us: s.time_us === null ? null : times(s.time_us),
        };
        const n = segment.longitude.length;
        if (
          !n ||
          segment.latitude.length !== n ||
          (segment.altitude && segment.altitude.length !== n) ||
          (segment.time_us && segment.time_us.length !== n)
        )
          throw new Error("Index coordinate lengths differ");
        for (let i = 0; i < n; i++)
          if (
            !Number.isFinite(segment.longitude[i]) ||
            Math.abs(segment.longitude[i]!) > 180 ||
            !Number.isFinite(segment.latitude[i]) ||
            Math.abs(segment.latitude[i]!) > 90 ||
            (segment.altitude &&
              !Number.isFinite(segment.altitude[i]) &&
              !Number.isNaN(segment.altitude[i]))
          )
            throw new Error("Invalid indexed coordinate");
        return segment;
      }),
    })),
  };
}
