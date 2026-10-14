import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { AppError } from "../../domain/errors.js";
import {
  overviewFeatures,
  OverviewExtent,
  OVERVIEW_TILING,
  type DisplayFeature,
} from "../../domain/overview.js";
import { pointCount } from "../../domain/trackdata.js";
import type { OverviewEntry, OverviewProgress } from "../../shared/overview.js";
import { rawObject } from "../archive/database.js";
import { deserialize, PARSER_VERSION } from "../track-index.js";
import { withDocument } from "../xml/document.js";
import { readTrackData } from "../xml/trackdata.js";
import {
  atomic,
  encodeObject,
  fingerprint,
  generation,
  objectPath,
  openSource,
  readObject,
  stampIn,
  type Coordinates,
} from "./files.js";
import { FORMAT, LIMITS, type BuildRequest, type Manifest } from "./types.js";

export function encodedTile(
  index: ReturnType<typeof geojsonvt>,
  z: number,
  x: number,
  y: number,
) {
  const raw = index.getTile(z, x, y);
  const features = (raw?.features ?? []).filter((f) =>
    f.tags?.role === "point"
      ? z < Number(f.tags.minLineZoom)
      : z >= Number(f.tags?.minLineZoom),
  );
  const bytes = vtpbf.fromGeojsonVt(
    { tracks: { features } },
    { extent: OVERVIEW_TILING.extent, version: 2 },
  );
  if (bytes.byteLength > LIMITS.tileBytes)
    throw new AppError("TOOL", "当前区域轨迹瓦片过大，请放大地图");
  return gzipSync(bytes);
}
export async function buildOverview(
  request: BuildRequest,
  progress: (p: OverviewProgress) => void,
): Promise<Manifest> {
  const { root, source, crs } = request;
  const version = randomBytes(16).toString("hex"),
    stage = path.join(root, `staging-${version}`);
  await mkdir(stage, { recursive: true });
  await mkdir(path.join(root, "objects"), { recursive: true });
  const db = openSource(source),
    entries: OverviewEntry[] = [],
    extent = new OverviewExtent();
  const geometryHash = createHash("sha256");
  const output = await open(path.join(stage, "geometry.ndjson"), "w", 0o600);
  let geometryBytes = 0,
    written = 0,
    points = 0;
  const account = (bytes: number) => {
    written += bytes;
    if (written > request.budget)
      throw new AppError("TOOL", "概览构建超过磁盘预留预算");
  };
  try {
    db.exec("BEGIN");
    const stamp = stampIn(db);
    if (fingerprint(stamp, crs) !== request.fingerprint)
      throw new AppError("CANCELLED", "轨迹库已更新，准备构建最新版本");
    const rows = db
      .prepare(
        "SELECT id,path,sha256,category,filename_date FROM archive_entries ORDER BY id",
      )
      .all() as {
      id: string;
      path: string;
      sha256: string;
      category: string | null;
      filename_date: string | null;
    }[];
    if (rows.length > LIMITS.entries)
      throw new AppError(
        "TOOL",
        "轨迹条目超过当前概览容量，请调整后台容量方案",
      );
    const indexed = db.prepare(
      "SELECT geometry FROM kml_index WHERE sha256=? AND parser_version=? AND status='ok'",
    );
    for (const [i, row] of rows.entries()) {
      const entry: OverviewEntry = {
        id: row.id,
        entry: row.path,
        name: path.posix.basename(row.path),
        kind: row.category ?? "Unknown",
        date: row.filename_date ?? "",
        sha256: row.sha256,
        points: 0,
        segments: 0,
      };
      let features: DisplayFeature[];
      try {
        let value: Coordinates;
        try {
          value = await readObject(root, row.sha256);
        } catch {
          let data;
          const cached = indexed.get(row.sha256, PARSER_VERSION) as
            { geometry: Buffer | null } | undefined;
          if (cached?.geometry)
            try {
              data = deserialize(cached.geometry);
            } catch {
              /* Regenerate disposable index. */
            }
          data ??= withDocument(rawObject(db, row.sha256), (doc) =>
            readTrackData(doc),
          );
          value = {
            name: data.name,
            points: pointCount(data),
            segments: data.tracks.flatMap((t) =>
              t.segments.map((s) =>
                Array.from(
                  s.longitude,
                  (lon, j) => [lon, s.latitude[j]!] as [number, number],
                ),
              ),
            ),
          };
          if (value.points > LIMITS.points)
            throw new AppError("TOOL", "单条轨迹超过概览点数预算");
          const bytes = encodeObject(row.sha256, value);
          account(bytes.length);
          await atomic(objectPath(root, row.sha256), bytes);
        }
        features = overviewFeatures(row.id, value.segments, crs, entry.kind);
        entry.name = value.name || entry.name;
        entry.points = value.points;
        entry.segments = value.segments.length;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "USER_INPUT")
          throw error;
        entry.error = error.message;
        entries.push(entry);
        progress({ completed: i + 1, total: rows.length, phase: "reading" });
        continue;
      }
      points += entry.points;
      if (points > LIMITS.points)
        throw new AppError(
          "TOOL",
          "轨迹库超过当前概览点数预算，保留上一版概览",
        );
      extent.add(features);
      const line = Buffer.from(JSON.stringify(features) + "\n");
      account(line.length);
      geometryBytes += line.length;
      geometryHash.update(line);
      await output.write(line);
      entries.push(entry);
      progress({ completed: i + 1, total: rows.length, phase: "reading" });
    }
    db.exec("COMMIT");
    await output.sync();
    await output.close();
    progress({
      completed: entries.length,
      total: entries.length,
      phase: "indexing",
    });
    const manifest: Manifest = {
      format: FORMAT,
      version,
      fingerprint: request.fingerprint,
      ...stamp,
      crs,
      createdAt: Date.now(),
      geometryHash: geometryHash.digest("hex"),
      geometryBytes,
      entries,
      bounds: extent.bounds(),
      summary: {
        entries: entries.length,
        valid: entries.filter((e) => !e.error).length,
        invalid: entries.filter((e) => e.error).length,
        points,
      },
    };
    const text = JSON.stringify(manifest);
    account(Buffer.byteLength(text));
    await writeFile(path.join(stage, "manifest.json"), text, { mode: 0o600 });
    await mkdir(path.join(root, "generations"), { recursive: true });
    await rename(stage, generation(root, version));
    return manifest;
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
    await output.close().catch(() => {});
    await rm(stage, { recursive: true, force: true });
  }
}
