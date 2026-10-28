import { SCHEMA_6 } from "./schema-v6.js";

// Projects are no longer stored in the archive; their table only ever held
// browser-side print drafts, which now live in the browser.
export const MIGRATE_6 = `
DROP TRIGGER IF EXISTS project_insert;
DROP TRIGGER IF EXISTS project_update;
DROP TRIGGER IF EXISTS project_delete;
DROP TRIGGER IF EXISTS project_generation;
DROP TABLE IF EXISTS map_projects;
PRAGMA user_version=7;
`;
export const SCHEMA_7 = SCHEMA_6 + MIGRATE_6;
