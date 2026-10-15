import { parentPort } from "node:worker_threads";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import geojsonvt from "geojson-vt";
import { AppError, errorInfo } from "../../domain/errors.js";
import {
  OVERVIEW_TILING,
  splitOverviewLine,
  type DisplayFeature,
} from "../../domain/overview.js";
import { generation, readManifest, readObject } from "./files.js";
import { buildOverview, encodedTile } from "./build.js";
import { LIMITS, type OverviewCommand, type Manifest } from "./types.js";

let active:
  | { key: string; index: ReturnType<typeof geojsonvt>; manifest: Manifest }
  | undefined;
async function run(command: OverviewCommand) {
  if (command.op === "reset") {
    active = undefined;
    return { ok: true };
  }
  if (command.op === "build")
    return buildOverview(command.request, (progress) =>
      parentPort!.postMessage({ progress }),
    );
  const key = `${command.root}/${command.version}`;
  const manifest =
    active?.key === key
      ? active.manifest
      : await readManifest(command.root, command.version);
  if (command.op === "detail") {
    const entry = manifest.entries.find((e) => e.id === command.id);
    if (!entry) throw new AppError("USER_INPUT", "概览中没有该轨迹");
    if (entry.error) throw new AppError("USER_INPUT", entry.error);
    if (entry.points > LIMITS.detailPoints)
      throw new AppError(
        "USER_INPUT",
        "轨迹超过详情点数上限，请使用分级地图或 CLI 查看",
      );
    const object = await readObject(
      command.root,
      entry.display_key ?? entry.sha256,
    );
    return {
      version: command.version,
      crs: "wgs84",
      entry,
      geometry: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { trackId: entry.id },
            geometry: {
              type: "MultiLineString",
              coordinates: object.segments
                .filter((s) => s.length > 1)
                .flatMap(splitOverviewLine),
            },
          },
          {
            type: "Feature",
            properties: { trackId: entry.id },
            geometry: {
              type: "MultiPoint",
              coordinates: object.segments
                .filter((s) => s.length === 1)
                .map((s) => s[0]),
            },
          },
        ],
      },
    };
  }
  if (active?.key !== key) {
    active = undefined;
    const hash = createHash("sha256"),
      features: DisplayFeature[] = [];
    const stream = createReadStream(
      path.join(generation(command.root, command.version), "geometry.ndjson"),
    );
    let bytes = 0;
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes > LIMITS.buildBytes)
        stream.destroy(new AppError("TOOL", "概览几何超过读取上限"));
    });
    for await (const line of createInterface({
      input: stream,
      crlfDelay: Infinity,
    }))
      for (const feature of JSON.parse(line) as DisplayFeature[])
        features.push(feature);
    if (
      bytes !== manifest.geometryBytes ||
      hash.digest("hex") !== manifest.geometryHash
    )
      throw new AppError("TOOL", "概览几何缓存损坏，请重建");
    active = {
      key,
      manifest,
      index: geojsonvt(
        { type: "FeatureCollection", features },
        OVERVIEW_TILING,
      ),
    };
  }
  const bytes = encodedTile(active.index, command.z, command.x, command.y);
  const recycle =
    active.index.tileCoords.length >= command.indexTiles ||
    process.memoryUsage().heapUsed >= LIMITS.indexHeapBytes;
  const tiles = active.index.tileCoords.length;
  if (recycle) active = undefined;
  return { bytes, recycle, tiles };
}
// The parent sends only one command at a time; this worker never owns HTTP state.
parentPort!.on(
  "message",
  (message: { id: number; command: OverviewCommand }) => {
    void run(message.command).then(
      (result) => parentPort!.postMessage({ id: message.id, result }),
      (error) =>
        parentPort!.postMessage({
          id: message.id,
          error: errorInfo(
            error instanceof AppError
              ? error
              : new AppError("TOOL", "地图缓存处理失败，请重试或重建", {
                  cause: error,
                }),
          ),
        }),
    );
  },
);
