import {
  nearestPoint,
  betterMatch,
  validateTrackOrder,
} from "../../domain/media-track.js";
import type { NearestPoint } from "../../domain/media-track.js";
import { formatWall } from "../../domain/media-time.js";
import type { MediaTime } from "../../domain/media-time.js";
import type { XmlPort } from "../../services/ports.js";
import path from "node:path";
import type Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import {
  MAX_POINTS,
  MAX_KML_BYTES,
  pointCount,
} from "../../domain/trackdata.js";
import type { TrackData } from "../../domain/trackdata.js";
import { geojson } from "../../domain/geometry.js";
import type { Catalog, Selection } from "../../shared/map.js";
import type { Project } from "../../shared/project.js";
import { XmlWorkers } from "../xml/client.js";

import { deserialize, serialize, PARSER_VERSION } from "../track-index.js";
import { databasePath, transaction, rawObject, snapshot } from "./database.js";
// RAM cache is separate from the unchanged 2m-point selection/input limit.
const CACHE_POINTS = 500_000;
type IndexRow = {
  status: string;
  geometry: Buffer | null;
  error: string | null;
};
/** Lives only in the serial archive worker; snapshots never cross threads. */
export class ArchiveStore {
  constructor(private readonly xml: XmlPort = new XmlWorkers(1, 0)) {}
  private cache = new Map<string, { data: TrackData; points: number }>();
  private points = 0;
  private mediaValidated = new WeakSet<TrackData>();
  readonly stats = { xml: 0, indexHits: 0, memoryHits: 0 };
  readBytes(input: string, entry: string): Uint8Array {
    return transaction(databasePath(input), false, (db) => {
      const row = db
        .prepare("SELECT sha256 FROM archive_entries WHERE path=?")
        .get(entry) as { sha256: string } | undefined;
      if (!row)
        throw new AppError("USER_INPUT", `Archive member not found: ${entry}`);
      return rawObject(db, row.sha256);
    });
  }
  async readTrackData(input: string, entry: string) {
    const archive = databasePath(input);
    return snapshot(archive, async (db) => {
      const row = db
        .prepare("SELECT sha256 FROM archive_entries WHERE path=?")
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
          .prepare("SELECT path,category FROM archive_entries ORDER BY path")
          .all() as { path: string; category: string | null }[]
      ).map((e) => ({
        entry: e.path,
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
    // Separate WAL writer: the caller's snapshot can survive a concurrent pop.
    transaction(file, true, (writer) => {
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
  async selection(
    input: string,
    entries: string[],
    expected: Record<string, string> = {},
  ): Promise<Selection> {
    if (entries.length > 200 || new Set(entries).size !== entries.length)
      throw new AppError("USER_INPUT", "每次最多选择 200 条不同的完整归档路径");
    const archive = databasePath(input);
    return snapshot(archive, async (db) => {
      const result: Selection = { archive, tracks: [], errors: [] };
      let selected = 0;
      for (const entry of entries)
        try {
          const row = db
            .prepare(
              "SELECT e.sha256,o.raw_size FROM archive_entries e JOIN kml_objects o ON e.sha256=o.sha256 WHERE e.path=?",
            )
            .get(entry) as { sha256: string; raw_size: number } | undefined;
          if (!row)
            throw new AppError(
              "USER_INPUT",
              `KML entry not found: ${entry}; use a complete archive member path`,
            );
          if (row.raw_size > MAX_KML_BYTES)
            throw new AppError(
              "USER_INPUT",
              "KML entry exceeds the 128 MiB read limit",
            );
          const key = JSON.stringify([archive, row.sha256, PARSER_VERSION]);
          let hit = this.cache.get(key);
          if (!hit) {
            const data = await this.read(db, archive, entry, row.sha256),
              points = pointCount(data);
            if (points > MAX_POINTS)
              throw new AppError(
                "USER_INPUT",
                "单条轨迹超过 200 万点，请先拆分后再选择",
              );
            while (
              this.cache.size &&
              (this.points + points > CACHE_POINTS || this.cache.size >= 128)
            ) {
              const first = this.cache.keys().next().value!;
              this.points -= this.cache.get(first)!.points;
              this.cache.delete(first);
            }
            hit = { data, points };
            if (points <= CACHE_POINTS) {
              this.cache.set(key, hit);
              this.points += points;
            }
          } else {
            this.stats.memoryHits++;
            this.cache.delete(key);
            this.cache.set(key, hit);
          }
          selected += hit.points;
          if (selected > MAX_POINTS)
            throw new AppError(
              "USER_INPUT",
              "本次选择超过 200 万点，请减少所选轨迹",
            );
          if (expected[entry] && expected[entry] !== row.sha256)
            throw new AppError(
              "USER_INPUT",
              "源内容已变化；请重新选择该轨迹并保存为新项目",
            );
          result.tracks.push({
            entry,
            sha256: row.sha256,
            points: hit.points,
            geojson: geojson(hit.data),
          });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          result.errors.push({ entry, error: error.message });
        }
      return result;
    });
  }
  async nearest(
    input: string,
    time: MediaTime,
    multiday: boolean,
    tolerance: number,
  ): Promise<NearestPoint | undefined> {
    const archive = databasePath(input);
    const dates = [0, ...(multiday ? [-1, 1] : [])].map((day) =>
      formatWall(time.wall + BigInt(day) * 86_400_000_000n, "-").slice(0, 10),
    );
    return snapshot(archive, async (db) => {
      const entries = db
        .prepare("SELECT path,sha256 FROM archive_entries ORDER BY path")
        .all() as { path: string; sha256: string }[];
      let best: NearestPoint | undefined;
      for (const entry of entries) {
        const parts = entry.path.split("/"),
          name = parts.at(-1)!;
        if (
          parts.length >= 3 &&
          /^\d{4}-\d{2}$/.test(parts[1]!) &&
          !dates.some((date) => date.startsWith(parts[1]!))
        )
          continue;
        if (!dates.some((date) => name.includes(date))) continue;
        try {
          const key = JSON.stringify([archive, entry.sha256, PARSER_VERSION]);
          let hit = this.cache.get(key);
          if (!hit) {
            const data = await this.read(db, archive, entry.path, entry.sha256),
              points = pointCount(data);
            while (
              this.cache.size &&
              (this.points + points > CACHE_POINTS || this.cache.size >= 128)
            ) {
              const first = this.cache.keys().next().value!;
              this.points -= this.cache.get(first)!.points;
              this.cache.delete(first);
            }
            hit = { data, points };
            if (points <= CACHE_POINTS) {
              this.cache.set(key, hit);
              this.points += points;
            }
          } else this.stats.memoryHits++;
          if (!this.mediaValidated.has(hit.data)) {
            validateTrackOrder(hit.data, name);
            this.mediaValidated.add(hit.data);
          }
          const candidate = nearestPoint(
            hit.data,
            name,
            time.instant,
            tolerance,
            false,
          );
          if (candidate && betterMatch(candidate, best)) best = candidate;
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "USER_INPUT")
            throw error;
        }
      }
      return best;
    });
  }
  projects(input: string): string[] {
    return transaction(databasePath(input), false, (db) =>
      (
        db.prepare("SELECT name FROM map_projects ORDER BY name").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
  }
  load(input: string, name: string): unknown {
    return transaction(databasePath(input), false, (db) => {
      const row = db
        .prepare("SELECT state FROM map_projects WHERE name=?")
        .get(name) as { state: string } | undefined;
      if (!row) throw new AppError("USER_INPUT", `项目不存在：${name}`);
      return JSON.parse(row.state);
    });
  }
  save(input: string, name: string, state: Project): void {
    if (!name.trim() || [...name].length > 120)
      throw new AppError("USER_INPUT", "项目名称需为 1–120 字");
    transaction(databasePath(input), true, (db) => {
      // Revalidate content inside the write reservation; no check/save race with another CLI.
      for (const t of state.tracks) {
        const row = db
          .prepare("SELECT sha256 FROM archive_entries WHERE path=?")
          .get(t.entry) as { sha256: string } | undefined;
        if (row?.sha256 !== t.sha256)
          throw new AppError("USER_INPUT", "源轨迹缺失或变化，不能保存项目");
      }
      db.prepare(
        "INSERT INTO map_projects VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at",
      ).run(name, JSON.stringify(state));
    });
  }
}
