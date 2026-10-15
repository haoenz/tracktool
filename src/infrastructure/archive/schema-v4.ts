import { SCHEMA_3 } from "./schema-v3.js";

// Schema 3 is a frozen migration input. Explicitly version the controlled deletion contract.
const guards = [
  ["entry_keep", "archive_entries"],
  ["version_no_delete", "track_versions"],
  ["segment_no_delete", "track_segments"],
  ["presentation_no_delete", "track_presentations"],
  ["input_no_delete", "track_operation_inputs"],
  ["lineage_no_delete", "track_segment_sources"],
  ["source_no_delete", "track_source_locations"],
  ["effect_no_delete", "track_operation_effects"],
] as const;
export const MIGRATE_3 = `
CREATE TABLE track_deletions (
 request_key TEXT PRIMARY KEY NOT NULL, request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 entry_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object')
);
CREATE TABLE track_operation_deletions (
 operation_id TEXT NOT NULL REFERENCES track_operations(id), entry_id TEXT NOT NULL,
 deletion_key TEXT NOT NULL REFERENCES track_deletions(request_key), PRIMARY KEY(operation_id,entry_id)
);
CREATE TRIGGER deletion_key_unique BEFORE INSERT ON track_deletions
 WHEN EXISTS(SELECT 1 FROM track_operations WHERE request_key=NEW.request_key) BEGIN
 SELECT RAISE(ABORT,'request key already used'); END;
CREATE TRIGGER operation_key_unique BEFORE INSERT ON track_operations
 WHEN EXISTS(SELECT 1 FROM track_deletions WHERE request_key=NEW.request_key) BEGIN
 SELECT RAISE(ABORT,'request key already used'); END;
${guards
  .map(
    ([trigger, table]) => `DROP TRIGGER ${trigger};
CREATE TRIGGER ${trigger} BEFORE DELETE ON ${table}
 WHEN tracktool_can_delete('${table}',OLD.rowid)<>1 BEGIN
 SELECT RAISE(ABORT,'history requires controlled deletion'); END;`,
  )
  .join("\n")}
CREATE TRIGGER object_delete_guard BEFORE DELETE ON kml_objects
 WHEN tracktool_can_delete('kml_objects',OLD.rowid)<>1 BEGIN
 SELECT RAISE(ABORT,'object requires controlled deletion'); END;
CREATE TRIGGER entry_delete AFTER DELETE ON archive_entries BEGIN
 UPDATE archive_meta SET revision=revision+1,storage_revision=storage_revision+1 WHERE singleton=1; END;
${["track_deletions", "track_operation_deletions"]
  .map(
    (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable deletion receipt'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'retained deletion receipt'); END;
CREATE TRIGGER ${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;`,
  )
  .join("\n")}
DROP TRIGGER file_insert;
DROP TRIGGER file_update;
DROP TRIGGER file_delete;
DROP TABLE file_operations;
CREATE TABLE file_operations (
 id TEXT PRIMARY KEY NOT NULL, operation TEXT NOT NULL CHECK(operation='push'),
 entry_id TEXT NOT NULL REFERENCES archive_entries(id), sha256 TEXT NOT NULL REFERENCES kml_objects(sha256),
 source TEXT, target TEXT NOT NULL, expected_generation INTEGER NOT NULL CHECK(expected_generation>=1)
);
CREATE INDEX operation_entry ON file_operations(entry_id);
CREATE UNIQUE INDEX operation_source ON file_operations(entry_id,source);
${["INSERT", "UPDATE", "DELETE"].map((action) => `CREATE TRIGGER file_${action.toLowerCase()} AFTER ${action} ON file_operations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;`).join("\n")}
PRAGMA user_version=4;
`;
export const SCHEMA_4 = SCHEMA_3 + MIGRATE_3;
