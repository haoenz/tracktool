import type Database from "better-sqlite3";
import type { TrackReference } from "../../shared/track-reference.js";
import { displayKml } from "../xml/display.js";
import { rawObject } from "./database.js";
import { readPresentation, resolveTrack } from "./presentation.js";
export function exportDisplay(
  db: Database.Database,
  entry: string,
  ref?: TrackReference,
): Uint8Array {
  const reference = resolveTrack(db, ref ?? { entry });
  const { segments, settings } = readPresentation(db, reference);
  return displayKml({
    version_id: reference.version_id!,
    raw: rawObject(db, reference.sha256),
    segments,
    settings,
  });
}
