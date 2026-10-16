import type Database from "better-sqlite3";
import path from "node:path";
import { AppError } from "../../domain/errors.js";
import type { Category } from "../../domain/archive.js";
import {
  readTransaction,
  rawObject,
  schemaVersion,
  activeEntries,
} from "./database.js";
import { exclusive, present } from "../durable-files.js";

export type EntrySelector = {
  name?: string;
  entry_id?: string;
  category?: Category;
};
export function selectEntry(
  db: Database.Database,
  selector: EntrySelector,
): { id: string; path: string; sha256: string } {
  const versioned = schemaVersion(db) >= 3;
  if (selector.entry_id) {
    const row = db
      .prepare(
        versioned
          ? `SELECT e.id,e.path,v.sha256 FROM archive_entries e JOIN track_versions v ON v.id=e.current_version_id WHERE e.id=?`
          : "SELECT id,path,sha256 FROM archive_entries WHERE id=?",
      )
      .get(selector.entry_id) as
      { id: string; path: string; sha256: string } | undefined;
    if (!row) throw new AppError("USER_INPUT", "Entry not found");
    return row;
  }
  if (!selector.name)
    throw new AppError("USER_INPUT", "Select a track by entry ID or name");
  const rows = (
    db
      .prepare(
        `SELECT id,path,sha256,category FROM ${activeEntries(db)} ORDER BY path`,
      )
      .all() as {
      id: string;
      path: string;
      sha256: string;
      category: Category | null;
    }[]
  ).filter(
    (row) =>
      (!selector.category || row.category === selector.category) &&
      (row.path === selector.name ||
        (!/[\\/]/.test(selector.name!) &&
          [
            path.basename(row.path),
            path.basename(row.path, path.extname(row.path)),
          ].includes(selector.name!))),
  );
  if (rows.length !== 1)
    throw new AppError(
      "USER_INPUT",
      rows.length
        ? "Ambiguous name; use the full member path or entry ID"
        : "Entry not found",
    );
  return rows[0]!;
}
export type DownloadSelector = EntrySelector & {
  version_id?: string;
  expected_sha256?: string;
};
/** Resolve ownership/version without loading or decompressing original KML. */
export function downloadReference(
  db: Database.Database,
  selector: DownloadSelector,
): { name: string; sha256: string } {
  const entry = selectEntry(db, selector);
  let sha256 = entry.sha256,
    name = entry.path;
  if (selector.version_id) {
    if (schemaVersion(db) < 3)
      throw new AppError(
        "USER_INPUT",
        "Historical download requires a versioned archive",
      );
    const row = db
      .prepare(
        "SELECT sha256,path FROM track_versions WHERE id=? AND entry_id=?",
      )
      .get(selector.version_id, entry.id) as
      { sha256: string; path: string } | undefined;
    if (!row)
      throw new AppError(
        "USER_INPUT",
        "Version does not belong to the selected entry",
      );
    sha256 = row.sha256;
    name = row.path;
  }
  if (selector.expected_sha256 && sha256 !== selector.expected_sha256) {
    const historical =
      schemaVersion(db) >= 3 && !selector.version_id
        ? (db
            .prepare(
              "SELECT sha256,path FROM track_versions WHERE entry_id=? AND sha256=? ORDER BY version_no DESC LIMIT 1",
            )
            .get(entry.id, selector.expected_sha256) as
            { sha256: string; path: string } | undefined)
        : undefined;
    if (!historical)
      throw new AppError(
        "USER_INPUT",
        "当前展示的轨迹版本已不可用，请刷新详情后重试",
      );
    sha256 = historical.sha256;
    name = historical.path;
  }
  return { name: path.basename(name), sha256 };
}
export function downloadBytes(
  file: string,
  selector: DownloadSelector,
): { name: string; bytes: Uint8Array; sha256: string } {
  return readTransaction(file, (db) => {
    const reference = downloadReference(db, selector);
    return { ...reference, bytes: rawObject(db, reference.sha256) };
  });
}
export function downloadFile(
  file: string,
  selector: EntrySelector & { version_id?: string },
  output: string,
  preview = false,
) {
  const result = downloadBytes(file, selector),
    target = path.join(output, result.name);
  if (present(target))
    throw new AppError(
      "USER_INPUT",
      `Refusing to overwrite existing target: ${target}`,
    );
  if (!preview) exclusive(target, result.bytes);
  return {
    message: preview
      ? "Would download track; archive unchanged"
      : "Track downloaded; archive unchanged",
    paths: [target],
  };
}
