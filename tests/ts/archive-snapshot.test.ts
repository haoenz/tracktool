import {
  previewDeletion,
  deleteEntryInTransaction,
} from "../../dist/node/infrastructure/archive/deletion.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { ArchiveStore } from "../../dist/node/infrastructure/archive/store.js";
import {
  enableSharedConnections,
  resetSharedConnections,
} from "../../dist/node/infrastructure/archive/database.js";
import { withDocument } from "../../dist/node/infrastructure/xml/document.js";
import { readTrackData } from "../../dist/node/infrastructure/xml/trackdata.js";

let directory: string, archive: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tracktool-snapshot-"));
  archive = path.join(directory, "archive.sqlite3");
  await copyFile("tests/ts/fixtures/maps/archive.sqlite3", archive);
  enableSharedConnections();
});
afterEach(async () => {
  resetSharedConnections();
  await rm(directory, { recursive: true, force: true });
});
it.each(["update", "delete"] as const)(
  "keeps a cold shared snapshot readable across a concurrent %s",
  async (change) => {
    const member = "Train/same.kml";
    const writer = new Database(archive);
    writer.pragma("foreign_keys=ON");
    const { sha256 } = writer
      .prepare("SELECT sha256 FROM active_archive_entries WHERE path=?")
      .get(member) as { sha256: string };
    writer.prepare("DELETE FROM kml_index WHERE sha256=?").run(sha256);
    let parses = 0;
    const store = new ArchiveStore({
      run: async (bytes) => {
        parses++;
        // Commit while the reader's snapshot is open and its XML job is pending.
        writer
          .transaction(() => {
            if (change === "delete") {
              const plan = previewDeletion(archive, { name: member });
              deleteEntryInTransaction(writer, {
                archive_id: plan.archive_id,
                expected: plan.expected,
                request_key: "remove",
              });
            } else writer.exec("UPDATE archive_meta SET revision=revision+1");
          })
          .immediate();
        const tracks = withDocument(bytes, readTrackData);
        return { name: tracks.name, placemarks: 1, coordinateNodes: 1, tracks };
      },
    });
    try {
      const result = await store.readTrackData(archive, member);
      expect(result.data.tracks.length).toBeGreaterThan(0);
      expect(parses).toBe(1);
      const index = writer
        .prepare("SELECT status FROM kml_index WHERE sha256=?")
        .get(sha256);
      if (change === "delete") {
        expect(index).toBeUndefined();
        expect(
          writer
            .prepare("SELECT 1 FROM kml_objects WHERE sha256=?")
            .get(sha256),
        ).toBeUndefined();
      } else {
        expect(index).toMatchObject({ status: "ok" });
        await store.readTrackData(archive, member);
        expect(parses).toBe(1);
      }
    } finally {
      writer.close();
    }
  },
);
