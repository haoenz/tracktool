import Database from "better-sqlite3";
import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";
import {
  ANALYSIS_PARAMS,
  ANALYSIS_VERSION,
  type AnalysisParams,
} from "../../domain/track-analysis.js";
import { AppError, checkCancelled } from "../../domain/errors.js";
import type { TrackAnalysis } from "../../shared/track-analysis.js";
import type { XmlPort } from "../../services/ports.js";
import { PARSER_VERSION } from "../track-index.js";
import { readTransaction, schemaVersion } from "./database.js";
import { downloadBytes, downloadReference } from "./download.js";
import { canonical, hashJson } from "./identity.js";

const MAX_PROFILE_BYTES = 8 * 1024 * 1024;
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const count = nonnegative.int().max(2_000_000);
const ratio = finite.min(0).max(1);
const sampleSchema = z
  .object({
    segment: count,
    longitude: finite.min(-180).max(180),
    latitude: finite.min(-90).max(90),
    distance_m: nonnegative,
    time_ms: finite.nullable(),
    altitude: finite.nullable(),
    speed: nonnegative.nullable(),
    speed_spike: z.boolean().optional(),
  })
  .strict();
const summarySchema = z
  .object({
    distance_m: nonnegative,
    points: count,
    segments: count,
    start_ms: finite.nullable(),
    end_ms: finite.nullable(),
    elapsed_s: nonnegative.nullable(),
    moving_s: nonnegative.nullable(),
    average_kmh: nonnegative.nullable(),
    moving_average_kmh: nonnegative.nullable(),
    max_kmh: nonnegative.nullable(),
    min_altitude: finite.nullable(),
    max_altitude: finite.nullable(),
    ascent_m: nonnegative.nullable(),
    descent_m: nonnegative.nullable(),
    terrain: z
      .object({ ascent: ratio, descent: ratio, flat: ratio })
      .strict()
      .nullable(),
    elevation_coverage: ratio,
    time_complete: z.boolean(),
    time_issues: z
      .object({
        missing: z.boolean(),
        duplicate: z.boolean(),
        reversed: z.boolean(),
      })
      .strict(),
    excluded_speed_intervals: count,
    sampled: z.boolean(),
  })
  .strict();
const profileSchema = z.array(sampleSchema).max(10001);
const resultSchema = summarySchema.extend({ samples: profileSchema });

export type AnalysisCacheKey = {
  parser_version: number;
  analysis_version: number;
  params: AnalysisParams;
};
export const CURRENT_ANALYSIS_KEY: AnalysisCacheKey = Object.freeze({
  parser_version: PARSER_VERSION,
  analysis_version: ANALYSIS_VERSION,
  params: ANALYSIS_PARAMS,
});
/** Persist inside the caller's transaction; ingestion must not silently lose its statistics. */
export function writeAnalysis(
  db: Database.Database,
  sha256: string,
  analysis: TrackAnalysis,
  key: AnalysisCacheKey = CURRENT_ANALYSIS_KEY,
): void {
  if (schemaVersion(db) < 5) return;
  const { samples, ...summary } = resultSchema.parse(analysis);
  const raw = Buffer.from(JSON.stringify(samples));
  if (raw.length > MAX_PROFILE_BYTES)
    throw new AppError("USER_INPUT", "统计曲线超过缓存大小限制");
  db.prepare(
    `INSERT INTO track_analysis_cache
    (sha256,parser_version,analysis_version,params_hash,params_json,summary_json,profile_blob,profile_codec,profile_raw_size,created_at)
    VALUES (?,?,?,?,?,?,?,'zlib',?,?)
    ON CONFLICT(sha256,parser_version,analysis_version,params_hash) DO UPDATE SET
      params_json=excluded.params_json,summary_json=excluded.summary_json,
      profile_blob=excluded.profile_blob,profile_codec=excluded.profile_codec,
      profile_raw_size=excluded.profile_raw_size,created_at=excluded.created_at`,
  ).run(
    sha256,
    key.parser_version,
    key.analysis_version,
    hashJson(key.params),
    canonical(key.params),
    JSON.stringify(summary),
    deflateSync(raw),
    raw.length,
    new Date().toISOString(),
  );
}

type Row = {
  params_json: string;
  summary_json: string;
  profile_blob: Buffer;
  profile_codec: string;
  profile_raw_size: number;
};
type Pending = {
  promise: Promise<TrackAnalysis>;
  controller: AbortController;
  users: number;
};

/** Persistent, rebuildable analysis. The worker pool owns CPU limits; reads never upgrade a database. */
export class TrackAnalysisCache {
  private pending = new Map<string, Pending>();
  constructor(
    private workers: XmlPort,
    private key: AnalysisCacheKey = CURRENT_ANALYSIS_KEY,
  ) {}

  async get(
    file: string,
    entryId: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<TrackAnalysis> {
    checkCancelled(signal);
    const paramsJson = canonical(this.key.params),
      paramsHash = hashJson(this.key.params);
    const args = [
      sha256,
      this.key.parser_version,
      this.key.analysis_version,
      paramsHash,
    ];
    // Ownership must be checked even on a hit or when another entry shares this content.
    const cached = readTransaction(file, (db) => {
      downloadReference(db, { entry_id: entryId, expected_sha256: sha256 });
      if (schemaVersion(db) < 5) return undefined;
      try {
        const row = db
          .prepare(
            `SELECT params_json,summary_json,profile_blob,profile_codec,profile_raw_size
          FROM track_analysis_cache WHERE sha256=? AND parser_version=? AND analysis_version=? AND params_hash=? AND length(summary_json)<=32768 AND length(profile_blob)<=8388608`,
          )
          .get(...args) as Row | undefined;
        if (
          !row ||
          row.params_json !== paramsJson ||
          row.summary_json.length > 32768 ||
          row.profile_codec !== "zlib" ||
          !Number.isInteger(row.profile_raw_size) ||
          row.profile_raw_size < 0 ||
          row.profile_raw_size > MAX_PROFILE_BYTES ||
          row.profile_blob.length > MAX_PROFILE_BYTES
        )
          return undefined;
        const raw = inflateSync(row.profile_blob, {
          maxOutputLength: MAX_PROFILE_BYTES,
        });
        if (raw.length !== row.profile_raw_size) return undefined;
        const summary = summarySchema.parse(JSON.parse(row.summary_json));
        const samples = profileSchema.parse(JSON.parse(raw.toString("utf8")));
        return { ...summary, samples };
      } catch {
        // Corrupt/incompatible cache is a miss; immutable source data remains authoritative.
        return undefined;
      }
    });
    if (cached) return cached;
    const identity = JSON.stringify([file, ...args]);
    let job = this.pending.get(identity);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const fresh: Pending = {
        controller,
        users: 0,
        promise: this.compute(file, entryId, sha256, controller.signal),
      };
      this.pending.set(identity, fresh);
      // Install both handlers so a fully cancelled request cannot leave an unhandled rejection.
      const remove = () => {
        if (this.pending.get(identity) === fresh) this.pending.delete(identity);
      };
      void fresh.promise.then(remove, remove);
      job = fresh;
    }
    return this.subscribe(job, signal);
  }

  private subscribe(
    job: Pending,
    signal?: AbortSignal,
  ): Promise<TrackAnalysis> {
    job.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, result?: TrackAnalysis) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        if (--job.users === 0) job.controller.abort();
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => finish(new AppError("CANCELLED", "操作已取消"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void job.promise.then(
        (result) => finish(undefined, result),
        (error) => finish(error),
      );
    });
  }

  private async compute(
    file: string,
    entryId: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<TrackAnalysis> {
    const original = downloadBytes(file, {
      entry_id: entryId,
      expected_sha256: sha256,
    });
    const response = await this.workers.run(
      original.bytes,
      { kind: "analysis", params: this.key.params },
      signal,
    );
    checkCancelled(signal);
    const result = resultSchema.parse(response.analysis);
    // Reads remain best effort; explicit ingestion/backfill uses writeAnalysis directly.
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { fileMustExist: true, timeout: 250 });
      db.pragma("foreign_keys=ON");
      db.exec("BEGIN IMMEDIATE");
      writeAnalysis(db, sha256, result, this.key);
      db.exec("COMMIT");
    } catch {
      // Read-only, locked or deleted archives still return the computed result.
    } finally {
      if (db?.inTransaction) db.exec("ROLLBACK");
      db?.close();
    }
    return result;
  }
}
