import { SCHEMA_7 } from "./schema-v7.js";

// Version lineage lookups (delete, restore, acyclic trigger) filter by
// version_id, which previously forced a full scan of these tables.
export const MIGRATE_7 = `
CREATE INDEX IF NOT EXISTS segment_sources_version ON track_segment_sources(version_id);
CREATE INDEX IF NOT EXISTS source_locations_version ON track_source_locations(version_id);
CREATE INDEX IF NOT EXISTS operation_inputs_version ON track_operation_inputs(version_id);
PRAGMA user_version=8;
`;
export const SCHEMA_8 = SCHEMA_7 + MIGRATE_7;
