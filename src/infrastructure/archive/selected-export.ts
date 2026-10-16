import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from "@zip.js/zip.js";
import { AppError } from "../../domain/errors.js";
import { readTransaction, rawObject, activeEntries } from "./database.js";

/** One snapshot and one download, preserving every original byte and archive path. */
export async function exportSelectedOriginals(file: string, ids: string[]) {
  const entries = readTransaction(file, (db) => {
    let bytes = 0;
    return [...new Set(ids)].map((id) => {
      const entry = db
        .prepare(`SELECT path,sha256 FROM ${activeEntries(db)} WHERE id=?`)
        .get(id) as { path: string; sha256: string } | undefined;
      if (!entry)
        throw new AppError(
          "USER_INPUT",
          "所选轨迹已成为历史来源，请刷新后重新选择",
        );
      const raw = rawObject(db, entry.sha256);
      bytes += raw.length;
      if (bytes > 128 * 1024 * 1024)
        throw new AppError(
          "USER_INPUT",
          "本次原件下载超过 128 MiB，请分批选择；未截断导出",
        );
      return { path: entry.path, raw };
    });
  });
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const entry of entries)
    await writer.add(entry.path, new Uint8ArrayReader(entry.raw));
  return Buffer.from(await writer.close());
}
