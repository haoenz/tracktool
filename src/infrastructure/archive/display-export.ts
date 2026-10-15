import type Database from "better-sqlite3";
import { rawObject, schemaVersion } from "./database.js";
import { resolveTrack, readPresentation } from "./presentation.js";
import { displayKml } from "../xml/display.js";
import type { ProjectTrack } from "../../shared/project-track.js";
export function exportDisplay(
  db: Database.Database,
  entry: string,
  ref?: ProjectTrack,
): Uint8Array {
  if (schemaVersion(db) < 3) {
    const row = db
      .prepare("SELECT sha256 FROM archive_entries WHERE path=?")
      .get(entry) as { sha256: string };
    return rawObject(db, row.sha256);
  }
  const reference = resolveTrack(db, ref ?? { entry });
  const { segments, settings } = readPresentation(db, reference);
  return displayKml({
    version_id: reference.version_id!,
    raw: rawObject(db, reference.sha256),
    segments,
    settings,
  });
}
