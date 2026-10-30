import type Database from "better-sqlite3";
import type { XmlDocument } from "libxml2-wasm";
import { analyzeTrack } from "../../domain/track-analysis.js";
import type { TrackAnalysis } from "../../shared/track-analysis.js";
import type { TrackData } from "../../domain/trackdata.js";
import { withDocument } from "../xml/document.js";
import { readTrackData } from "../xml/trackdata.js";
import {
  CURRENT_ANALYSIS_KEY,
  writeAnalysis,
  type AnalysisCacheKey,
} from "./analysis-cache.js";
import { schemaVersion } from "./database.js";
import { hashJson } from "./identity.js";

/** True when this content has no reusable statistics yet. */
export function needsAnalysis(
  db: Database.Database,
  sha256: string,
  key: AnalysisCacheKey = CURRENT_ANALYSIS_KEY,
): boolean {
  if (schemaVersion(db) < 5) return false;
  return !db
    .prepare(
      `SELECT 1 FROM track_analysis_cache
      WHERE sha256=? AND parser_version=? AND analysis_version=? AND params_hash=?`,
    )
    .get(
      sha256,
      key.parser_version,
      key.analysis_version,
      hashJson(key.params),
    );
}

export function analyzeDocument(
  doc: XmlDocument,
  data?: TrackData,
  key: AnalysisCacheKey = CURRENT_ANALYSIS_KEY,
): TrackAnalysis {
  return analyzeTrack(data ?? readTrackData(doc), key.params);
}

/** Called by the common version publisher, within the same atomic write transaction. */
export function analyzeOnIngest(
  db: Database.Database,
  sha256: string,
  raw: Uint8Array,
): void {
  const key = CURRENT_ANALYSIS_KEY;
  if (!needsAnalysis(db, sha256, key)) return;
  const analysis = withDocument(raw, (doc) =>
    analyzeDocument(doc, undefined, key),
  );
  writeAnalysis(db, sha256, analysis, key);
}
