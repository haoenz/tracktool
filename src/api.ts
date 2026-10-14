/** Supported Node API. Returned typed arrays are owned by the caller. */
import { LocalKmlFiles } from "./infrastructure/kml-files.js";
import { checkCancelled } from "./domain/errors.js";
import { XmlWorkers } from "./infrastructure/xml/client.js";
import { ArchiveClient } from "./infrastructure/archive/client.js";
export type {
  TrackData,
  TrackFeature,
  TrackSegment,
} from "./domain/trackdata.js";
export { AppError } from "./domain/errors.js";
export async function readTrackData(file: string, signal?: AbortSignal) {
  checkCancelled(signal);
  const xml = new XmlWorkers(1, 0);
  try {
    return (
      await xml.run(
        (await new LocalKmlFiles().read(file)).bytes,
        { kind: "tracks", source: file },
        signal,
      )
    ).tracks!;
  } finally {
    await xml.close();
  }
}
/** Each read uses its own consistent SQLite snapshot; close releases the worker. */
export function openArchive(path: string) {
  const client = new ArchiveClient();
  return {
    listEntries: async () => (await client.catalog(path)).entries,
    readBytes: (entry: string, signal?: AbortSignal) =>
      client.readBytes(path, entry, signal),
    readTrackData: (entry: string, signal?: AbortSignal) =>
      client.readTrackData(path, entry, signal),
    close: () => client.close(),
    [Symbol.asyncDispose]: () => client.close(),
  };
}
/** JSON wire contract v1: microseconds as decimal strings, missing numeric values as null. */
export function encodeTrackData(
  data: import("./domain/trackdata.js").TrackData,
) {
  return {
    schema: 1 as const,
    ...data,
    tracks: data.tracks.map((track) => ({
      ...track,
      segments: track.segments.map((segment) => ({
        ...segment,
        longitude: Array.from(segment.longitude),
        latitude: Array.from(segment.latitude),
        altitude:
          segment.altitude === null
            ? null
            : Array.from(segment.altitude, (n) => (Number.isNaN(n) ? null : n)),
        time_us:
          segment.time_us === null ? null : Array.from(segment.time_us, String),
      })),
    })),
  };
}
