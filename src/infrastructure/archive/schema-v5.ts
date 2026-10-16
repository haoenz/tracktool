import { SCHEMA_4 } from "./schema-v4.js";

// Rebuildable derived data deliberately has no business/storage revision triggers.
export const MIGRATE_4 = `
CREATE TABLE track_analysis_cache (
 sha256 TEXT NOT NULL REFERENCES kml_objects(sha256) ON DELETE CASCADE,
 parser_version INTEGER NOT NULL CHECK(parser_version>=1),
 analysis_version INTEGER NOT NULL CHECK(analysis_version>=1),
 params_hash TEXT NOT NULL CHECK(length(params_hash)=64),
 params_json TEXT NOT NULL CHECK(json_valid(params_json) AND json_type(params_json)='object'),
 summary_json TEXT NOT NULL CHECK(json_valid(summary_json) AND json_type(summary_json)='object'),
 profile_blob BLOB NOT NULL,
 profile_codec TEXT NOT NULL CHECK(profile_codec='zlib'),
 profile_raw_size INTEGER NOT NULL CHECK(profile_raw_size>=0 AND profile_raw_size<=8388608),
 created_at TEXT NOT NULL,
 PRIMARY KEY(sha256,parser_version,analysis_version,params_hash)
);
PRAGMA user_version=5;
`;
export const SCHEMA_5 = SCHEMA_4 + MIGRATE_4;
