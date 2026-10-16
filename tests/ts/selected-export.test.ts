import { it, expect } from "vitest";
import { mkdtemp, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportSelectedOriginals } from "../../dist/node/infrastructure/archive/selected-export.js";
import {
  readTransaction,
  rawObject,
  activeEntries,
} from "../../dist/node/infrastructure/archive/database.js";
import { readZip } from "../../dist/node/infrastructure/archive/zip.js";
it("batch download is one ZIP of exact original bytes, with no archive writes or silent missing entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-selected-"));
  try {
    const file = path.join(dir, "archive.sqlite3");
    await copyFile("tests/ts/fixtures/maps/archive.sqlite3", file);
    const before = await readFile(file);
    const entries = readTransaction(file, (db) =>
      (
        db
          .prepare(`SELECT id,path,sha256 FROM ${activeEntries(db)} LIMIT 2`)
          .all() as { id: string; path: string; sha256: string }[]
      ).map((e) => ({ ...e, raw: rawObject(db, e.sha256) })),
    );
    const zip = path.join(dir, "originals.zip");
    await writeFile(
      zip,
      await exportSelectedOriginals(
        file,
        entries.map((e) => e.id),
      ),
    );
    const unpacked = new Map<string, Uint8Array>();
    await readZip(zip, (name, raw) => {
      unpacked.set(name, raw);
    });
    expect([...unpacked.keys()]).toEqual(entries.map((e) => e.path));
    for (const e of entries)
      expect(Buffer.from(unpacked.get(e.path)!)).toEqual(Buffer.from(e.raw));
    expect(await readFile(file)).toEqual(before);
    await expect(
      exportSelectedOriginals(file, [entries[0]!.id, "missing"]),
    ).rejects.toThrow("重新选择");
    expect(await readFile(file)).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
