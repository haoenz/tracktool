import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { FileConfigStore } from "../dist/node/infrastructure/config-store.js";
import { resolveApiKey } from "../dist/node/domain/config.js";
import { databasePath } from "../dist/node/infrastructure/archive/database.js";
import type { AdministrativeLocation } from "../dist/node/shared/endpoint-location.js";

const config = await new FileConfigStore().load();
const key = resolveApiKey(config, process.env.TRACKTOOL_GOOGLE_API_KEY);
if (!key) throw new Error("Google API key is required");
const db = new Database(databasePath(String(config.archive_path)), {
  readonly: true,
  fileMustExist: true,
});
type Row = {
  entry_id: string;
  path: string;
  endpoint: string;
  latitude: number;
  longitude: number;
  location_json: string;
};
const rows = db
  .prepare(
    `SELECT e.id AS entry_id,e.path,l.endpoint,l.latitude,l.longitude,l.location_json FROM track_endpoint_locations l JOIN track_presentations p ON p.id=l.presentation_id JOIN archive_entries e ON e.current_presentation_id=p.id WHERE e.state='active' AND l.status='partial' AND l.language='zh-CN' ORDER BY e.path,l.endpoint`,
  )
  .all() as Row[];
db.close();
const selected: (Omit<Row, "location_json"> & {
  stored: AdministrativeLocation;
})[] = [];
const seen = new Set<string>();
for (const { location_json, ...row } of rows) {
  const stored = JSON.parse(location_json) as AdministrativeLocation;
  const group = JSON.stringify([
    stored.country_code,
    stored.country_code === "CN" ? stored.city : null,
  ]);
  if (seen.has(group)) continue;
  seen.add(group);
  selected.push({ ...row, stored });
  if (selected.length === 12) break;
}
const report: Record<string, unknown>[] = [];
for (const sample of selected) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.search = new URLSearchParams({
    latlng: `${sample.latitude},${sample.longitude}`,
    key,
    language: "zh-CN",
  }).toString();
  let payload;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("HTTP failure");
    payload = (await response.json()) as {
      status: string;
      results?: {
        types?: string[];
        address_components?: { types: string[]; long_name: string }[];
      }[];
    };
  } catch {
    console.error(
      JSON.stringify({
        entry_id: sample.entry_id,
        error: "Google transport failure",
      }),
    );
    process.exitCode = 1;
    continue;
  }
  if (payload.status !== "OK") {
    console.error(
      JSON.stringify({
        entry_id: sample.entry_id,
        error: ["ZERO_RESULTS", "REQUEST_DENIED", "OVER_QUERY_LIMIT"].includes(
          payload.status,
        )
          ? payload.status
          : "Google API failure",
      }),
    );
    process.exitCode = 1;
    continue;
  }
  // Successful response only: keep the full JSON, never the request URL or API key.
  report.push({
    ...sample,
    fetched_at: new Date().toISOString(),
    response: payload,
  });
  const unique = new Map<string, { name: string; types: string[] }>();
  for (const result of payload.results ?? [])
    for (const c of result.address_components ?? []) {
      if (c.types.includes("political"))
        unique.set(JSON.stringify([c.long_name, c.types]), {
          name: c.long_name,
          types: c.types,
        });
    }
  console.log(
    JSON.stringify({
      country_code: sample.stored.country_code,
      city: sample.stored.city,
      results: payload.results?.length,
      political_components: [...unique.values()],
    }),
  );
}
writeFileSync(
  "data/endpoint-location-audit-20261016.json",
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
