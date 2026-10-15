// Schema 3: immutable content and history, mutable current pointers.
export const BASE_SCHEMA_3 = `
CREATE TABLE archive_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 storage_revision INTEGER NOT NULL DEFAULT 0 CHECK(storage_revision>=0),
 zip_revision INTEGER, zip_target TEXT, views_revision INTEGER,
 zip_name TEXT NOT NULL DEFAULT 'Archive.zip'
);
CREATE TABLE kml_objects (
 sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(sha256)=64),
 codec TEXT NOT NULL CHECK(codec='zlib'),
 raw_size INTEGER NOT NULL CHECK(raw_size>=0), payload BLOB NOT NULL
);
CREATE TABLE kml_index (
 sha256 TEXT NOT NULL REFERENCES kml_objects(sha256) ON DELETE CASCADE,
 parser_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ok','error')),
 metadata TEXT NOT NULL, geometry BLOB, error TEXT, PRIMARY KEY(sha256,parser_version)
);
CREATE TABLE map_projects (
 name TEXT PRIMARY KEY NOT NULL COLLATE BINARY, state TEXT NOT NULL,
 updated_at TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1)
);
`;
export const VERSION_SCHEMA_3 = `
CREATE TABLE track_operations (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN (
   'import','migration_baseline','split_segment','prune','draw','compose','split_journey',
   'restore','presentation','withdraw','source_link','reindex_manifest','set_tag','fill_altitude','legacy_regroup')),
 params_json TEXT NOT NULL CHECK(json_valid(params_json) AND json_type(params_json)='object'),
 algorithm_version TEXT NOT NULL, created_at TEXT NOT NULL,
 request_key TEXT NOT NULL UNIQUE, request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object')
);
CREATE TABLE archive_entries (
 id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL COLLATE BINARY UNIQUE,
 category TEXT CHECK(category IN ('Default','Train','Flight')), filename_date TEXT,
 current_version_id TEXT NOT NULL, current_presentation_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','superseded','withdrawn','source_only')),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>=1),
 FOREIGN KEY(id,current_version_id) REFERENCES track_versions(entry_id,id)
   DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(current_version_id,current_presentation_id) REFERENCES track_presentations(version_id,id)
   DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE track_versions (
 id TEXT PRIMARY KEY NOT NULL,
 entry_id TEXT NOT NULL REFERENCES archive_entries(id) DEFERRABLE INITIALLY DEFERRED,
 version_no INTEGER NOT NULL CHECK(version_no>=1),
 sha256 TEXT NOT NULL REFERENCES kml_objects(sha256),
 operation_id TEXT NOT NULL REFERENCES track_operations(id), created_at TEXT NOT NULL,
 path TEXT NOT NULL, category TEXT CHECK(category IN ('Default','Train','Flight')), filename_date TEXT,
 origin TEXT NOT NULL CHECK(origin IN ('migration_baseline','imported','legacy_result','derived')),
 manifest_status TEXT NOT NULL CHECK(manifest_status IN ('ready','unavailable')),
 manifest_error TEXT,
 CHECK((manifest_status='ready' AND manifest_error IS NULL)
    OR (manifest_status='unavailable' AND manifest_error IS NOT NULL)),
 UNIQUE(entry_id,version_no), UNIQUE(entry_id,id), UNIQUE(id,sha256)
);
CREATE INDEX versions_content ON track_versions(sha256);
CREATE INDEX versions_operation ON track_versions(operation_id);
CREATE TABLE track_operation_inputs (
 operation_id TEXT NOT NULL REFERENCES track_operations(id),
 version_id TEXT NOT NULL REFERENCES track_versions(id), role TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 PRIMARY KEY(operation_id,ordinal), UNIQUE(operation_id,version_id,role)
);
CREATE TABLE track_segments (
 version_id TEXT NOT NULL REFERENCES track_versions(id), segment_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 locator_json TEXT NOT NULL CHECK(json_valid(locator_json) AND json_type(locator_json)='array'),
 locator_version INTEGER NOT NULL CHECK(locator_version=1),
 geometry_kind TEXT NOT NULL CHECK(geometry_kind IN ('gx:Track','LineString')),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('measured','hand_drawn','unknown')),
 point_count INTEGER NOT NULL CHECK(point_count>=0),
 time_status TEXT NOT NULL CHECK(time_status IN ('present','absent','mismatch')),
 PRIMARY KEY(version_id,segment_id), UNIQUE(version_id,ordinal), UNIQUE(version_id,locator_json)
);
CREATE TABLE track_segment_sources (
 id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL REFERENCES track_operations(id),
 version_id TEXT NOT NULL, segment_id TEXT NOT NULL,
 source_version_id TEXT NOT NULL, source_segment_id TEXT NOT NULL,
 source_start INTEGER, source_end_exclusive INTEGER,
 evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('exact','ordered_subsequence','manual')),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
 CHECK(version_id<>source_version_id),
 CHECK((source_start IS NULL AND source_end_exclusive IS NULL)
   OR (source_start IS NOT NULL AND source_end_exclusive IS NOT NULL
       AND source_start>=0 AND source_end_exclusive>source_start)),
 FOREIGN KEY(version_id,segment_id) REFERENCES track_segments(version_id,segment_id),
 FOREIGN KEY(source_version_id,source_segment_id) REFERENCES track_segments(version_id,segment_id)
);
CREATE INDEX segment_sources_input ON track_segment_sources(source_version_id,source_segment_id);
CREATE TRIGGER lineage_bounds BEFORE INSERT ON track_segment_sources
 WHEN NEW.source_end_exclusive>(SELECT point_count FROM track_segments
   WHERE version_id=NEW.source_version_id AND segment_id=NEW.source_segment_id) BEGIN
 SELECT RAISE(ABORT,'source range exceeds segment');
END;
CREATE TRIGGER lineage_acyclic BEFORE INSERT ON track_segment_sources BEGIN
 SELECT CASE WHEN EXISTS (
   WITH RECURSIVE ancestors(id) AS (
     SELECT NEW.source_version_id UNION
     SELECT s.source_version_id FROM track_segment_sources s JOIN ancestors a ON s.version_id=a.id
   ) SELECT 1 FROM ancestors WHERE id=NEW.version_id
 ) THEN RAISE(ABORT,'cyclic version lineage') END;
END;
CREATE TABLE track_presentations (
 id TEXT PRIMARY KEY NOT NULL, version_id TEXT NOT NULL REFERENCES track_versions(id),
 operation_id TEXT NOT NULL REFERENCES track_operations(id), created_at TEXT NOT NULL,
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json) AND json_type(settings_json)='object'),
 settings_sha256 TEXT NOT NULL CHECK(length(settings_sha256)=64),
 UNIQUE(version_id,id)
);
CREATE TABLE track_source_locations (
 id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL REFERENCES track_operations(id),
 version_id TEXT NOT NULL, source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
 container TEXT NOT NULL, member TEXT, display_name TEXT NOT NULL,
 source_role TEXT NOT NULL CHECK(source_role IN ('imported_file','legacy_result','earlier_candidate','verified_original')),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
 FOREIGN KEY(version_id,source_sha256) REFERENCES track_versions(id,sha256)
);
CREATE TABLE track_operation_effects (
 operation_id TEXT NOT NULL REFERENCES track_operations(id), entry_id TEXT NOT NULL REFERENCES archive_entries(id),
 before_json TEXT CHECK(before_json IS NULL OR (json_valid(before_json) AND json_type(before_json)='object')),
 after_json TEXT NOT NULL CHECK(json_valid(after_json) AND json_type(after_json)='object'),
 PRIMARY KEY(operation_id,entry_id)
);


CREATE TABLE file_operations (
 id TEXT PRIMARY KEY NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('push','pop')),
 entry_id TEXT NOT NULL REFERENCES archive_entries(id), sha256 TEXT NOT NULL REFERENCES kml_objects(sha256),
 source TEXT, target TEXT NOT NULL,
 expected_generation INTEGER NOT NULL CHECK(expected_generation>=1)
);
CREATE INDEX operation_entry ON file_operations(entry_id);
CREATE UNIQUE INDEX operation_source ON file_operations(entry_id,source);
CREATE TABLE export_receipts (
 target TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('kml_zip','collections','full_backup')),
 revision INTEGER NOT NULL, storage_revision INTEGER,
 CHECK(kind<>'full_backup' OR storage_revision IS NOT NULL), PRIMARY KEY(target,kind)
);

CREATE INDEX entries_state_category_date ON archive_entries(state,category,filename_date);
CREATE VIEW active_archive_entries AS
 SELECT e.id,e.path,e.category,e.filename_date,e.generation,
        v.sha256,e.current_version_id AS version_id,
        e.current_presentation_id AS presentation_id,p.settings_sha256
 FROM archive_entries e JOIN track_versions v ON v.id=e.current_version_id AND v.entry_id=e.id
 JOIN track_presentations p ON p.id=e.current_presentation_id AND p.version_id=v.id
 WHERE e.state='active';

CREATE TRIGGER entry_metadata_insert BEFORE INSERT ON archive_entries BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM track_versions v WHERE v.id=NEW.current_version_id AND v.entry_id=NEW.id
     AND v.path=NEW.path AND v.category IS NEW.category AND v.filename_date IS NEW.filename_date
 ) THEN RAISE(ABORT,'entry metadata differs from version') END;
END;
CREATE TRIGGER entry_metadata_update BEFORE UPDATE ON archive_entries BEGIN
 SELECT CASE WHEN NEW.id<>OLD.id THEN RAISE(ABORT,'entry identity is immutable') END;
 SELECT CASE WHEN NEW.generation<>OLD.generation+1 THEN RAISE(ABORT,'entry generation must increment') END;
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM track_versions v WHERE v.id=NEW.current_version_id AND v.entry_id=NEW.id
     AND v.path=NEW.path AND v.category IS NEW.category AND v.filename_date IS NEW.filename_date
 ) THEN RAISE(ABORT,'entry metadata differs from version') END;
END;
CREATE TRIGGER entry_keep BEFORE DELETE ON archive_entries BEGIN
 SELECT RAISE(ABORT,'withdraw entries instead of deleting history');
END;
CREATE TRIGGER entry_insert AFTER INSERT ON archive_entries BEGIN
 UPDATE archive_meta SET revision=revision+1,storage_revision=storage_revision+1 WHERE singleton=1;
END;
CREATE TRIGGER entry_update AFTER UPDATE ON archive_entries BEGIN
 UPDATE archive_meta SET revision=revision+1,storage_revision=storage_revision+1 WHERE singleton=1;
END;
CREATE TRIGGER segment_manifest_frozen BEFORE INSERT ON track_segments
 WHEN EXISTS(SELECT 1 FROM track_presentations WHERE version_id=NEW.version_id) BEGIN
 SELECT RAISE(ABORT,'segment manifest already published');
END;
CREATE TRIGGER project_generation BEFORE UPDATE ON map_projects
 WHEN NEW.generation<>OLD.generation+1 BEGIN
 SELECT RAISE(ABORT,'project generation must increment');
END;

CREATE TRIGGER object_no_update BEFORE UPDATE ON kml_objects BEGIN SELECT RAISE(ABORT,'immutable object'); END;
CREATE TRIGGER version_no_update BEFORE UPDATE ON track_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
CREATE TRIGGER version_no_delete BEFORE DELETE ON track_versions BEGIN SELECT RAISE(ABORT,'retained version'); END;
CREATE TRIGGER segment_no_update BEFORE UPDATE ON track_segments BEGIN SELECT RAISE(ABORT,'immutable segment'); END;
CREATE TRIGGER segment_no_delete BEFORE DELETE ON track_segments BEGIN SELECT RAISE(ABORT,'retained segment'); END;
CREATE TRIGGER presentation_no_update BEFORE UPDATE ON track_presentations BEGIN SELECT RAISE(ABORT,'immutable presentation'); END;
CREATE TRIGGER presentation_no_delete BEFORE DELETE ON track_presentations BEGIN SELECT RAISE(ABORT,'retained presentation'); END;
CREATE TRIGGER operation_no_update BEFORE UPDATE ON track_operations BEGIN SELECT RAISE(ABORT,'immutable operation'); END;
CREATE TRIGGER operation_no_delete BEFORE DELETE ON track_operations BEGIN SELECT RAISE(ABORT,'retained operation'); END;
CREATE TRIGGER input_no_update BEFORE UPDATE ON track_operation_inputs BEGIN SELECT RAISE(ABORT,'immutable input'); END;
CREATE TRIGGER input_no_delete BEFORE DELETE ON track_operation_inputs BEGIN SELECT RAISE(ABORT,'retained input'); END;
CREATE TRIGGER lineage_no_update BEFORE UPDATE ON track_segment_sources BEGIN SELECT RAISE(ABORT,'immutable lineage'); END;
CREATE TRIGGER lineage_no_delete BEFORE DELETE ON track_segment_sources BEGIN SELECT RAISE(ABORT,'retained lineage'); END;
CREATE TRIGGER source_no_update BEFORE UPDATE ON track_source_locations BEGIN SELECT RAISE(ABORT,'immutable source'); END;
CREATE TRIGGER source_no_delete BEFORE DELETE ON track_source_locations BEGIN SELECT RAISE(ABORT,'retained source'); END;
CREATE TRIGGER effect_no_update BEFORE UPDATE ON track_operation_effects BEGIN SELECT RAISE(ABORT,'immutable effect'); END;
CREATE TRIGGER effect_no_delete BEFORE DELETE ON track_operation_effects BEGIN SELECT RAISE(ABORT,'retained effect'); END;
CREATE TRIGGER object_insert AFTER INSERT ON kml_objects BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER object_delete AFTER DELETE ON kml_objects BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER version_insert AFTER INSERT ON track_versions BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER segment_insert AFTER INSERT ON track_segments BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER presentation_insert AFTER INSERT ON track_presentations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER operation_insert AFTER INSERT ON track_operations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER input_insert AFTER INSERT ON track_operation_inputs BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER lineage_insert AFTER INSERT ON track_segment_sources BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER source_insert AFTER INSERT ON track_source_locations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER effect_insert AFTER INSERT ON track_operation_effects BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER project_insert AFTER INSERT ON map_projects BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER project_update AFTER UPDATE ON map_projects BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER project_delete AFTER DELETE ON map_projects BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER file_insert AFTER INSERT ON file_operations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER file_update AFTER UPDATE ON file_operations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
CREATE TRIGGER file_delete AFTER DELETE ON file_operations BEGIN UPDATE archive_meta SET storage_revision=storage_revision+1 WHERE singleton=1; END;
`;
export const SCHEMA_3 =
  BASE_SCHEMA_3 + VERSION_SCHEMA_3 + "PRAGMA user_version=3;";
