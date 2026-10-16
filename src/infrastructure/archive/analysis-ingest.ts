import type Database from "better-sqlite3";
import { analyzeTrack } from "../../domain/track-analysis.js";
import { withDocument } from "../xml/document.js";
import { readTrackData } from "../xml/trackdata.js";
import { CURRENT_ANALYSIS_KEY, writeAnalysis } from "./analysis-cache.js";
import { schemaVersion } from "./database.js";
import { hashJson } from "./identity.js";

/** Called by the common version publisher, within the same atomic write transaction. */
export function analyzeOnIngest(
  db: Database.Database,
  sha256: string,
  raw: Uint8Array,
): void {
  if (schemaVersion(db) < 5) return;
  const key = CURRENT_ANALYSIS_KEY;
  if (
    db
      .prepare(
        `SELECT 1 FROM track_analysis_cache
    WHERE sha256=? AND parser_version=? AND analysis_version=? AND params_hash=?`,
      )
      .get(
        sha256,
        key.parser_version,
        key.analysis_version,
        hashJson(key.params),
      )
  )
    return;
  const analysis = withDocument(raw, (doc) =>
    analyzeTrack(readTrackData(doc), key.params),
  );
  writeAnalysis(db, sha256, analysis, key);
}
