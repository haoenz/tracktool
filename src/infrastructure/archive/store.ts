import type Database from "better-sqlite3";
import path from "node:path";
import { AppError } from "../../domain/errors.js";
import { LruStore } from "../../domain/lru.js";
import type { TrackData } from "../../domain/trackdata.js";
import { pointCount } from "../../domain/trackdata.js";
import type { XmlPort } from "../../services/ports.js";
import type { Catalog } from "../../shared/map.js";
import { XmlWorkers } from "../xml/client.js";

import { deserialize, PARSER_VERSION, serialize } from "../track-index.js";
import {
  databasePath,
  independentTransaction,
  rawObject,
  snapshot,
  transaction,
} from "./database.js";
// Bound cached geometry independently of input limits.
const CACHE_POINTS = 500_000;
type IndexRow = {
  status: string;
  geometry: Buffer | null;
  error: string | null;
};
/** Lives only in the serial archive worker; snapshots never cross threads. */
export class ArchiveStore {
  constructor(private readonly xml: XmlPort = new XmlWorkers(1, 0)) {}
  private cache = new LruStore<string, { data: TrackData; points: number }>(
    128,
    CACHE_POINTS,
    (value) => value.points,
  );
  readonly stats = { xml: 0, indexHits: 0, memoryHits: 0 };
  readBytes(input: string, entry: string): Uint8Array {
    return transaction(databasePath(input), false, (db) => {
      const row = db
        .prepare(`SELECT sha256 FROM active_archive_entries WHERE path=?`)
        .get(entry) as { sha256: string } | undefined;
      if (!row)
        throw new AppError("USER_INPUT", `Archive member not found: ${entry}`);
      return rawObject(db, row.sha256);
    });
  }
  readObject(input: string, digest: string): Uint8Array {
    return transaction(databasePath(input), false, (db) =>
      rawObject(db, digest),
    );
  }
  async readTrackData(input: string, entry: string) {
    const archive = databasePath(input);
    return snapshot(archive, async (db) => {
      const row = db
        .prepare(`SELECT sha256 FROM active_archive_entries WHERE path=?`)
        .get(entry) as { sha256: string } | undefined;
      if (!row)
        throw new AppError("USER_INPUT", `Archive member not found: ${entry}`);
      return {
        data: await this.read(db, archive, entry, row.sha256),
        sha256: row.sha256,
      };
    });
  }
  catalog(input: string): Catalog {
    const archive = databasePath(input);
    return transaction(archive, false, (db) => ({
      archive,
      entries: (
        db
          .prepare(
            `SELECT id,path,sha256,category FROM active_archive_entries ORDER BY path`,
          )
          .all() as {
          id: string;
          path: string;
          sha256: string;
          category: string | null;
        }[]
      ).map((e) => ({
        id: e.id,
        entry: e.path,
        sha256: e.sha256,
        name: path.posix.basename(e.path),
        kind: e.category ?? "Unknown",
        date: /\d{4}-\d{2}-\d{2}/.exec(path.posix.basename(e.path))?.[0] ?? "",
      })),
    }));
  }
  private async read(
    db: Database.Database,
    file: string,
    entry: string,
    digest: string,
  ): Promise<TrackData> {
    const row = db
      .prepare(
        "SELECT status,geometry,error FROM kml_index WHERE sha256=? AND parser_version=?",
      )
      .get(digest, PARSER_VERSION) as IndexRow | undefined;
    const source = `${file}!/${entry}`;
    if (row?.status === "error")
      throw new AppError("USER_INPUT", `${source}: ${row.error}`);
    if (row?.geometry)
      try {
        const data = deserialize(row.geometry, source);
        this.stats.indexHits++;
        return data;
      } catch {
        /* Disposable index: verify raw original before rebuilding. */
      }
    const raw = rawObject(db, digest);
    let data: TrackData | undefined, error: string | undefined;
    try {
      this.stats.xml++;
      data = (await this.xml.run(raw, { kind: "tracks", source })).tracks;
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "USER_INPUT") throw e;
      error = e.message;
    }
    // Separate WAL writer: the caller's snapshot can survive a concurrent deletion.
    independentTransaction(file, true, (writer) => {
      if (
        !writer.prepare("SELECT 1 FROM kml_objects WHERE sha256=?").get(digest)
      )
        return;
      writer
        .prepare("DELETE FROM kml_index WHERE sha256=? AND parser_version!=?")
        .run(digest, PARSER_VERSION);
      const segments = data?.tracks.flatMap((t) => t.segments) ?? [];
      let min: bigint | undefined, max: bigint | undefined;
      for (const s of segments)
        if (s.time_us)
          for (const time of s.time_us) {
            if (min === undefined || time < min) min = time;
            if (max === undefined || time > max) max = time;
          }
      const metadata = data
        ? {
            name: data.name,
            track_tags: data.track_tags,
            tracks: data.tracks.length,
            segments: segments.length,
            points: pointCount(data),
            altitude: segments.some((s) => s.altitude !== null),
            time_min_us:
              min === undefined
                ? null
                : (
                    JSON as JSON & { rawJSON: (value: string) => unknown }
                  ).rawJSON(String(min)),
            time_max_us:
              max === undefined
                ? null
                : (
                    JSON as JSON & { rawJSON: (value: string) => unknown }
                  ).rawJSON(String(max)),
          }
        : {};
      writer
        .prepare("INSERT OR REPLACE INTO kml_index VALUES (?,?,?,?,?,?)")
        .run(
          digest,
          PARSER_VERSION,
          error ? "error" : "ok",
          JSON.stringify(metadata),
          data ? serialize(data) : null,
          error ?? null,
        );
    });
    if (error || !data) throw new AppError("USER_INPUT", `${source}: ${error}`);
    return data;
  }
}
