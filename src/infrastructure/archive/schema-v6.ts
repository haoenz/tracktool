import { SCHEMA_5 } from "./schema-v5.js";

export const MIGRATE_5 = `
CREATE TABLE track_endpoint_locations (
 presentation_id TEXT NOT NULL REFERENCES track_presentations(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL CHECK(endpoint IN ('start','end')),
 latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 provider TEXT NOT NULL CHECK(provider='google'),
 language TEXT NOT NULL,
 resolver_version INTEGER NOT NULL CHECK(resolver_version>=1),
 status TEXT NOT NULL CHECK(status IN ('complete','partial','zero_results')),
 location_json TEXT NOT NULL CHECK(json_valid(location_json) AND json_type(location_json)='object'),
 queried_at TEXT NOT NULL,
 PRIMARY KEY(presentation_id,endpoint,provider,language,resolver_version)
);
CREATE INDEX endpoint_location_coordinates ON track_endpoint_locations(latitude,longitude,provider,language,resolver_version);
${["INSERT", "UPDATE", "DELETE"].map((action) => `CREATE TRIGGER endpoint_location_${action.toLowerCase()} AFTER ${action} ON track_endpoint_locations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;`).join("\n")}
PRAGMA user_version=6;
`;
export const SCHEMA_6 = SCHEMA_5 + MIGRATE_5;
