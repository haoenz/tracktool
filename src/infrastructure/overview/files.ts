import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";
import { z } from "zod";
import Database from "better-sqlite3";
import { AppError } from "../../domain/errors.js";
import { OVERVIEW_TILING } from "../../domain/overview.js";
import { PARSER_VERSION } from "../track-index.js";
import type { OverviewCrs } from "../../shared/overview.js";
import { FORMAT, Manifest, type SourceStamp, LIMITS } from "./types.js";

export const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const generation = (root: string, version: string) =>
  path.join(root, "generations", version);
export function openSource(source: string): Database.Database {
  const db = new Database(source, {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  if (
    ![2, 3, 4].includes(db.pragma("user_version", { simple: true }) as number)
  ) {
    db.close();
    throw new AppError("USER_INPUT", "轨迹库版本不支持地图概览");
  }
  return db;
}
export function readStamp(source: string): SourceStamp {
  const db = openSource(source);
  try {
    return stampIn(db);
  } finally {
    db.close();
  }
}
export function stampIn(db: Database.Database): SourceStamp {
  const row = db
    .prepare("SELECT archive_id,revision FROM archive_meta WHERE singleton=1")
    .get() as { archive_id: string; revision: number } | undefined;
  if (!row) throw new AppError("USER_INPUT", "轨迹库缺少版本信息");
  return { archiveId: row.archive_id, revision: row.revision };
}
export function fingerprint(stamp: SourceStamp, crs: OverviewCrs) {
  return digest(
    JSON.stringify({
      ...stamp,
      crs,
      format: FORMAT,
      parser: PARSER_VERSION,
      coordinates: 2,
      tiling: OVERVIEW_TILING,
    }),
  );
}
export async function atomic(file: string, bytes: string | Uint8Array) {
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, file);
}
export async function boundedRead(file: string, limit: number) {
  if ((await stat(file)).size > limit)
    throw new AppError("TOOL", "地图缓存超过读取上限");
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new AppError("TOOL", "地图缓存超过读取上限");
  return bytes;
}
export async function readManifest(root: string, version: string) {
  const manifest = Manifest.parse(
    JSON.parse(
      (
        await boundedRead(
          path.join(generation(root, version), "manifest.json"),
          16 * 1024 ** 2,
        )
      ).toString(),
    ),
  );
  if (manifest.version !== version)
    throw new AppError("TOOL", "地图缓存版本不一致");
  return manifest;
}
const Coordinates = z.object({
  name: z.string(),
  tags: z.string(),
  date: z.string(),
  segments: z.array(
    z.array(z.tuple([z.number().finite(), z.number().finite()])),
  ),
  points: z.number().int().nonnegative(),
});
export type Coordinates = z.infer<typeof Coordinates>;
export function objectPath(root: string, sha: string) {
  return path.join(root, "objects", `${sha}.gz`);
}
export function encodeObject(sha: string, value: Coordinates) {
  const payload = JSON.stringify(value);
  return gzipSync(
    JSON.stringify({
      sha,
      parser: PARSER_VERSION,
      hash: digest(payload),
      payload,
    }),
  );
}
export async function readObject(
  root: string,
  sha: string,
): Promise<Coordinates> {
  const bytes = await boundedRead(objectPath(root, sha), LIMITS.buildBytes);
  const item = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: LIMITS.buildBytes }).toString(),
  ) as { sha: string; parser: number; hash: string; payload: string };
  if (
    item.sha !== sha ||
    item.parser !== PARSER_VERSION ||
    digest(item.payload) !== item.hash
  )
    throw new AppError("TOOL", "地图几何缓存校验失败");
  const data = Coordinates.parse(JSON.parse(item.payload));
  if (data.points !== data.segments.reduce((n, s) => n + s.length, 0))
    throw new AppError("TOOL", "地图几何点数不一致");
  return data;
}
