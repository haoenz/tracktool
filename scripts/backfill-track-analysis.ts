import path from "node:path";
import { writeFileSync } from "node:fs";
import { XmlWorkers } from "../dist/node/infrastructure/xml/client.js";
import {
  readTransaction,
  rawObject,
  transaction,
  schemaVersion,
} from "../dist/node/infrastructure/archive/database.js";
import {
  CURRENT_ANALYSIS_KEY,
  writeAnalysis,
} from "../dist/node/infrastructure/archive/analysis-cache.js";
import { hashJson } from "../dist/node/infrastructure/archive/identity.js";

const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: node scripts/backfill-track-analysis.ts <archive.sqlite3> [report.json]",
  );
const reportFile = process.argv[3];
const key = CURRENT_ANALYSIS_KEY;
const objects = readTransaction(file, (db) => {
  if (schemaVersion(db) < 5)
    throw new Error("Statistics backfill requires schema 5 or newer");
  return db
    .prepare(
      `SELECT o.sha256, c.sha256 IS NOT NULL AS cached FROM kml_objects o
    LEFT JOIN track_analysis_cache c ON c.sha256=o.sha256 AND c.parser_version=?
      AND c.analysis_version=? AND c.params_hash=? ORDER BY o.sha256`,
    )
    .all(key.parser_version, key.analysis_version, hashJson(key.params)) as {
    sha256: string;
    cached: number;
  }[];
});
const workers = new XmlWorkers(2, 2);
let next = 0,
  completed = 0,
  computed = 0,
  reused = 0;
const failures: { sha256: string; error: string }[] = [];
const progress = () =>
  console.log(
    JSON.stringify({
      total: objects.length,
      completed,
      computed,
      reused,
      failed: failures.length,
    }),
  );
progress();
try {
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < objects.length) {
        const entry = objects[next++]!;
        try {
          if (entry.cached) reused++;
          else {
            const raw = readTransaction(file, (db) =>
              rawObject(db, entry.sha256),
            );
            const response = await workers.run(raw, {
              kind: "analysis",
              params: key.params,
            });
            if (!response.analysis) throw new Error("Missing analysis result");
            transaction(file, true, (db) =>
              writeAnalysis(db, entry.sha256, response.analysis!, key),
            );
            computed++;
          }
        } catch (error) {
          failures.push({
            sha256: entry.sha256,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        completed++;
        if (completed % 25 === 0) progress();
      }
    }),
  );
} finally {
  await workers.close();
}
progress();
const report = {
  database: path.resolve(file),
  analysis_version: key.analysis_version,
  total: objects.length,
  computed,
  reused,
  failures,
};
if (reportFile)
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
if (failures.length) {
  console.error(JSON.stringify({ failures }));
  process.exitCode = 1;
}
