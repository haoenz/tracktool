// Schema and ordered migration intentionally match the Python archive format.
export const SCHEMA = `
CREATE TABLE archive_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, zip_revision INTEGER, zip_target TEXT,
 views_revision INTEGER, zip_name TEXT NOT NULL DEFAULT 'Archive.zip');
CREATE TABLE kml_objects (
 sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64), codec TEXT NOT NULL CHECK(codec='zlib'),
 raw_size INTEGER NOT NULL CHECK(raw_size>=0), payload BLOB NOT NULL);
CREATE TABLE archive_entries (
 id TEXT PRIMARY KEY, path TEXT NOT NULL COLLATE BINARY UNIQUE,
 sha256 TEXT NOT NULL REFERENCES kml_objects(sha256),
 category TEXT CHECK(category IN ('Default','Train','Flight')), filename_date TEXT);
CREATE INDEX entries_content ON archive_entries(sha256);
CREATE INDEX entries_category_date ON archive_entries(category,filename_date);
CREATE TABLE kml_index (
 sha256 TEXT NOT NULL REFERENCES kml_objects(sha256) ON DELETE CASCADE,
 parser_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ok','error')),
 metadata TEXT NOT NULL, geometry BLOB, error TEXT,
 PRIMARY KEY(sha256,parser_version));
CREATE TABLE map_projects (
 name TEXT PRIMARY KEY COLLATE BINARY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE file_operations (
 id TEXT PRIMARY KEY, operation TEXT NOT NULL CHECK(operation IN ('push','pop')),
 entry_id TEXT NOT NULL REFERENCES archive_entries(id), sha256 TEXT NOT NULL REFERENCES kml_objects(sha256),
 source TEXT, target TEXT NOT NULL);
CREATE UNIQUE INDEX operation_entry ON file_operations(entry_id);
CREATE TRIGGER entry_insert AFTER INSERT ON archive_entries BEGIN
 UPDATE archive_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER entry_delete AFTER DELETE ON archive_entries BEGIN
 UPDATE archive_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER entry_update AFTER UPDATE OF path,sha256,category ON archive_entries
 WHEN OLD.path!=NEW.path OR OLD.sha256!=NEW.sha256 OR OLD.category IS NOT NEW.category BEGIN
 UPDATE archive_meta SET revision=revision+1 WHERE singleton=1; END;
`;
export const MIGRATE_1 = `
DROP INDEX operation_entry;
CREATE INDEX operation_entry ON file_operations(entry_id);
CREATE UNIQUE INDEX operation_source ON file_operations(entry_id,source);
CREATE TABLE export_receipts (target TEXT PRIMARY KEY, revision INTEGER NOT NULL);
INSERT INTO export_receipts SELECT zip_target,zip_revision FROM archive_meta WHERE zip_target IS NOT NULL AND zip_revision IS NOT NULL;
PRAGMA user_version=2;
`;
