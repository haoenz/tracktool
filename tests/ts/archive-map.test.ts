import { readTransaction } from "../../dist/node/infrastructure/archive/database.js";
import {
  resolveTrack,
  readPresentation,
  displayed,
} from "../../dist/node/infrastructure/archive/presentation.js";
import { geojson } from "../../dist/node/domain/geometry.js";
import { pointCount } from "../../dist/node/domain/trackdata.js";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { timestamp } from "../../dist/node/domain/trackdata.js";
import { ArchiveClient } from "../../dist/node/infrastructure/archive/client.js";
import {
  deleteEntry,
  previewDeletion,
} from "../../dist/node/infrastructure/archive/deletion.js";
import { ArchiveStore } from "../../dist/node/infrastructure/archive/store.js";
import { addEntry } from "../../dist/node/infrastructure/archive/writer.js";
import {
  deserialize,
  PARSER_VERSION,
  serialize,
} from "../../dist/node/infrastructure/track-index.js";
import { withDocument } from "../../dist/node/infrastructure/xml/document.js";
import { readTrackData } from "../../dist/node/infrastructure/xml/trackdata.js";
import type { XmlResult } from "../../dist/node/services/ports.js";
const first = "Default/2026-10-01 中文.kml";
let directory: string, archive: string, client: ArchiveClient;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tracktool-map-"));
  archive = path.join(directory, "archive.sqlite3");
  await copyFile("tests/ts/fixtures/maps/archive.sqlite3", archive);
  client = new ArchiveClient();
});
afterEach(async () => {
  await client.close();
  await rm(directory, { recursive: true, force: true });
});
it("snapshot survives concurrent deletion and index creation cannot resurrect the removed object", async () => {
  let entered!: () => void, finish!: (result: XmlResult) => void;
  const begun = new Promise<void>((r) => {
    entered = r;
  });
  const pending = new Promise<XmlResult>((r) => {
    finish = r;
  });
  const store = new ArchiveStore({
    run: async () => {
      entered();
      return pending;
    },
  });
  const reading = store.readTrackData(archive, "Train/same.kml");
  await begun;
  const writer = new Database(archive);
  writer.pragma("foreign_keys=ON");
  const { sha256 } = writer
    .prepare("SELECT sha256 FROM active_archive_entries WHERE path=?")
    .get("Train/same.kml") as { sha256: string };
  const plan = previewDeletion(archive, { name: "Train/same.kml" });
  writer.close();
  deleteEntry(archive, {
    archive_id: plan.archive_id,
    expected: plan.expected,
    request_key: "delete",
  });
  const tracks = withDocument(
    await readFile("tests/ts/fixtures/xml/complex.kml"),
    readTrackData,
  );
  finish({ name: tracks.name, placemarks: 1, coordinateNodes: 6, tracks });
  expect((await reading).data).toEqual(tracks);
  const check = new Database(archive);
  expect(
    check.prepare("SELECT 1 FROM kml_index WHERE sha256=?").get(sha256),
  ).toBeUndefined();
  expect(
    check.prepare("SELECT 1 FROM kml_objects WHERE sha256=?").get(sha256),
  ).toBeUndefined();
  check.close();
});
it("coordinate comments, zero altitude, time mismatches and invalid aligned times preserve coordinate and timestamp semantics", () => {
  const xml = (geometry: string) =>
    Buffer.from(
      `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark>${geometry}</Placemark></Document></kml>`,
    );
  const read = (s: string) => withDocument(xml(s), (d) => readTrackData(d));
  const result = read(
    "<gx:Track><when>bad</when><gx:coord>12<!--ignored-->0 30 0</gx:coord><gx:coord>121 31</gx:coord></gx:Track>",
  );
  expect(result.tracks[0]!.segments[0]!.time_us).toBeNull();
  expect([...result.tracks[0]!.segments[0]!.longitude]).toEqual([120, 121]);
  expect([...result.tracks[0]!.segments[0]!.altitude!]).toEqual([0, NaN]);
  expect(() =>
    read("<gx:Track><when>bad</when><gx:coord>120 30</gx:coord></gx:Track>"),
  ).toThrow("point 1: Invalid timestamp");
  expect(() =>
    read("<LineString><coordinates>120,30 181,30</coordinates></LineString>"),
  ).toThrow("point 2: Invalid longitude");
});
it("roundtrips binary64 coordinates and int64 timestamps exactly", async () => {
  const raw = await readFile("tests/ts/fixtures/xml/complex.kml");
  const parsed = withDocument(raw, readTrackData);
  expect(deserialize(serialize(parsed))).toEqual(parsed);
  expect(parsed.tracks[0]!.segments[0]!.altitude![0]).toBeNaN();
  expect(parsed.tracks[0]!.segments[0]!.altitude![1]).toBe(0);
  expect(parsed.tracks[0]!.segments[1]!.time_us![0]).toBe(1790812800123456n);
});
it.each([
  ["0001-01-01T00:00:00Z", -62135596800000000n],
  ["9999-12-31T23:59:59.9999999Z", 253402300799999999n],
  ["1969-12-31T23:59:59.999999Z", -1n],
  ["1970-01-01T08:00:00.123456789+08:00", 123456n],
])("preserves integer UTC microseconds %s", (value, expected) =>
  expect(timestamp(value)).toBe(expected),
);
it.each([
  "2025-02-29T00:00:00Z",
  "2026-01-01T24:00:00Z",
  "2026-01-01T00:00:00",
  "2026-01-01T00:00:00+24:00",
])("rejects invalid timestamps %s", (value) =>
  expect(() => timestamp(value)).toThrow(),
);
it("reads exact complete paths, reuses persisted indices and rejects partial names", async () => {
  expect((await client.catalog(directory)).entries).toHaveLength(5);
  await client.readTrackData(archive, first);
  await client.readTrackData(archive, "Train/same.kml");
  await expect(client.readTrackData(archive, "same.kml")).rejects.toThrow(
    "not found",
  );
  expect(await client.stats()).toMatchObject({ xml: 2, indexHits: 0 });
  await client.readTrackData(archive, first);
  expect(await client.stats()).toMatchObject({ xml: 2, indexHits: 1 });
  await client.close();
  client = new ArchiveClient();
  await client.readTrackData(archive, "Train/same.kml");
  expect(await client.stats()).toMatchObject({ xml: 0, indexHits: 1 });
  const db = new Database(archive);
  expect(
    db
      .prepare("SELECT metadata FROM kml_index WHERE status='ok'")
      .all()
      .every((r) =>
        Object.hasOwn(
          JSON.parse((r as { metadata: string }).metadata),
          "time_min_us",
        ),
      ),
  ).toBe(true);
  db.close();
});
it("reuses one database connection across archive reads", async () => {
  // Cold index writes use independent connections so a concurrent writer
  // cannot force an old read snapshot to upgrade. Warm reads still reuse one.
  await client.readTrackData(archive, first);
  await client.readTrackData(archive, "Train/same.kml");
  await client.close();
  client = new ArchiveClient();
  const before = (await client.stats()).opens;
  await client.catalog(directory);
  await client.readTrackData(archive, first);
  await client.readTrackData(archive, "Train/same.kml");
  expect((await client.stats()).opens - before).toBe(1);
});
it("rebuilds corrupt disposable indices without altering originals, rejects bad/polar members and preserves segments/dateline", async () => {
  const db = new Database(archive);
  const original = db
    .prepare("SELECT sha256,payload FROM kml_objects ORDER BY sha256")
    .all();
  db.prepare("UPDATE kml_index SET geometry=X'00',parser_version=?").run(
    PARSER_VERSION,
  );
  db.close();
  await client.readTrackData(archive, first);
  await expect(
    client.readTrackData(archive, "Default/invalid.kml"),
  ).rejects.toThrow();
  const polar = await client.readTrackData(archive, "Default/polar.kml");
  expect(() => geojson(polar.data)).toThrow();
  const result = await client.readTrackData(archive, "Flight/dateline.kml");
  expect(
    readTransaction(archive, (db) => {
      const view = readPresentation(
        db,
        resolveTrack(db, { entry: "Flight/dateline.kml" }),
      );
      return displayed(result.data, view.segments, view.settings)
        .geojson()
        .features.map((f) => f.geometry.coordinates);
    }),
  ).toEqual([
    [
      [
        [179, 30],
        [181, 31],
      ],
    ],
    [[120, 40]],
  ]);
  const after = new Database(archive);
  expect(
    after
      .prepare("SELECT sha256,payload FROM kml_objects ORDER BY sha256")
      .all(),
  ).toEqual(original);
  after.close();
});
it("rejects unknown schemas without upgrading or creating missing files", async () => {
  const db = new Database(archive);
  db.pragma("user_version=99");
  db.close();
  await expect(client.catalog(archive)).rejects.toThrow("99");
  await expect(
    client.catalog(path.join(directory, "missing.sqlite3")),
  ).rejects.toThrow("找不到");
  const check = new Database(archive);
  expect(check.pragma("user_version", { simple: true })).toBe(99);
  check.close();
});
it("cancellation releases the worker and queued requests resume", async () => {
  const controller = new AbortController();
  const cancelled = client.readTrackData(archive, first, controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toThrow("取消");
  expect((await client.catalog(archive)).entries).toHaveLength(5);
});
it("rebuilds old parser errors for empty time slots and preserves raw data and schema", async () => {
  const raw = Buffer.from(
    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark><gx:Track><when>2026-01-01T00:00:00Z</when><when/><gx:coord>120 30</gx:coord><gx:coord>121 31</gx:coord></gx:Track></Placemark></kml>',
  );
  const digest = createHash("sha256").update(raw).digest("hex"),
    entry = "Default/partial.kml",
    db = new Database(archive),
    payload = deflateSync(raw);
  const schema = db.pragma("user_version", { simple: true });
  db.transaction(() => addEntry(db, entry, raw, "Default"))();
  db.prepare("INSERT INTO kml_index VALUES (?,?, 'error', '{}', NULL, ?)").run(
    digest,
    2,
    'Invalid timestamp ""',
  );
  db.close();
  const selected = await client.readTrackData(archive, entry);
  expect(pointCount(selected.data)).toBe(2);
  const after = new Database(archive);
  try {
    const rows = after
      .prepare(
        "SELECT parser_version,status,geometry FROM kml_index WHERE sha256=?",
      )
      .all(digest) as {
      parser_version: number;
      status: string;
      geometry: Buffer;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parser_version: PARSER_VERSION,
      status: "ok",
    });
    expect(
      deserialize(rows[0]!.geometry).tracks[0]!.segments[0]!.time_us,
    ).toBeNull();
    expect(
      after
        .prepare("SELECT payload FROM kml_objects WHERE sha256=?")
        .get(digest),
    ).toEqual({ payload });
    expect(after.pragma("user_version", { simple: true })).toBe(schema);
  } finally {
    after.close();
  }
});
it("large tracks reopen from the persistent index without reparsing", async () => {
  const raw = Buffer.from(
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>' +
      "104,30,0 ".repeat(500_001) +
      "</coordinates></LineString></Placemark></kml>",
  );
  const db = new Database(archive),
    entry = "Default/large.kml";
  db.transaction(() => addEntry(db, entry, raw, "Default"))();
  db.close();
  for (let i = 0; i < 2; i++) {
    const selected = await client.readTrackData(archive, entry);
    expect(pointCount(selected.data)).toBe(500_001);
  }
  expect(await client.stats()).toMatchObject({
    xml: 1,
    indexHits: 1,
    memoryHits: 0,
  });
}, 30_000);

it("bounds raw object reads before parsing", async () => {
  const db = new Database(archive);
  db.exec("DROP TRIGGER object_no_update");
  db.prepare(
    "UPDATE kml_objects SET raw_size=? WHERE sha256=(SELECT sha256 FROM active_archive_entries WHERE path=?)",
  ).run(128 * 1024 * 1024 + 1, first);
  db.close();
  await expect(client.readBytes(archive, first)).rejects.toThrow("128 MiB");
  expect((await client.stats()).xml).toBe(0);
});
