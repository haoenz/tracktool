import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtemp, copyFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { inflateSync, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { ArchiveClient } from "../../dist/node/infrastructure/archive/client.js";
import { withDocument } from "../../dist/node/infrastructure/xml/document.js";
import { readTrackData } from "../../dist/node/infrastructure/xml/trackdata.js";
import {
  serialize,
  deserialize,
  PARSER_VERSION,
} from "../../dist/node/infrastructure/track-index.js";
import { timestamp } from "../../dist/node/domain/trackdata.js";
import { MapService } from "../../dist/node/services/map-service.js";
import { defaultProject } from "../../dist/node/shared/project.js";
import { ArchiveStore } from "../../dist/node/infrastructure/archive/store.js";
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
  const reading = store.selection(archive, ["Train/same.kml"]);
  await begun;
  const writer = new Database(archive);
  writer.pragma("foreign_keys=ON");
  const { sha256 } = writer
    .prepare("SELECT sha256 FROM archive_entries WHERE path=?")
    .get("Train/same.kml") as { sha256: string };
  writer
    .transaction(() => {
      writer
        .prepare("DELETE FROM archive_entries WHERE path=?")
        .run("Train/same.kml");
      writer.prepare("DELETE FROM kml_objects WHERE sha256=?").run(sha256);
    })
    .immediate();
  writer.close();
  const tracks = deserialize(
    await readFile("tests/ts/fixtures/maps/python-index.zlib"),
  );
  finish({ name: tracks.name, placemarks: 1, coordinateNodes: 6, tracks });
  expect((await reading).tracks).toHaveLength(1);
  const check = new Database(archive);
  expect(
    check.prepare("SELECT 1 FROM kml_index WHERE sha256=?").get(sha256),
  ).toBeUndefined();
  expect(
    check.prepare("SELECT 1 FROM kml_objects WHERE sha256=?").get(sha256),
  ).toBeUndefined();
  check.close();
});
it("enforces 200-member and raw 128 MiB limits even on index hits", async () => {
  await expect(
    client.selection(
      archive,
      Array.from({ length: 201 }, (_, i) => String(i)),
    ),
  ).rejects.toThrow("200");
  const db = new Database(archive);
  db.prepare(
    "UPDATE kml_objects SET raw_size=? WHERE sha256=(SELECT sha256 FROM archive_entries WHERE path=?)",
  ).run(128 * 1024 * 1024 + 1, first);
  db.close();
  expect((await client.selection(archive, [first])).errors[0]!.error).toContain(
    "128 MiB",
  );
  expect((await client.stats()).indexHits).toBe(0);
});
it("coordinate comments, zero altitude, time mismatches and invalid aligned times retain Python semantics", () => {
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
it("reads Python binary64/int64 index exactly and writes Python-compatible payloads", async () => {
  const python = await readFile("tests/ts/fixtures/maps/python-index.zlib"),
    raw = await readFile("tests/ts/fixtures/xml/complex.kml");
  const parsed = withDocument(raw, (d) => readTrackData(d));
  expect(deserialize(python)).toEqual(parsed);
  expect(JSON.parse(inflateSync(serialize(parsed)).toString())).toEqual(
    JSON.parse(inflateSync(python).toString()),
  );
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
it("reads the exact complete paths, uses persisted/memory indices and rejects partial names", async () => {
  expect((await client.catalog(directory)).entries).toHaveLength(5);
  const selected = await client.selection(archive, [
    first,
    "Train/same.kml",
    "same.kml",
  ]);
  expect(selected.tracks).toHaveLength(2);
  expect(selected.errors).toHaveLength(1);
  expect(await client.stats()).toMatchObject({ xml: 2, indexHits: 0 });
  await client.selection(archive, [first]);
  expect(await client.stats()).toMatchObject({ xml: 2, memoryHits: 1 });
  await client.close();
  client = new ArchiveClient();
  await client.selection(archive, ["Train/same.kml"]);
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
it("rebuilds corrupt disposable indices without altering originals, rejects bad/polar members and preserves segments/dateline", async () => {
  const db = new Database(archive);
  const original = db
    .prepare("SELECT sha256,payload FROM kml_objects ORDER BY sha256")
    .all();
  db.prepare("UPDATE kml_index SET geometry=X'00',parser_version=?").run(
    PARSER_VERSION,
  );
  db.close();
  const result = await client.selection(archive, [
    first,
    "Default/invalid.kml",
    "Default/polar.kml",
    "Flight/dateline.kml",
  ]);
  expect(result.tracks).toHaveLength(2);
  expect(result.errors).toHaveLength(2);
  expect(
    result.tracks[1]!.geojson.features.map((f) => f.geometry.coordinates),
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
it("saves/reopens projects, blocks changed content, and rechecks inside the write transaction", async () => {
  const service = new MapService(client),
    selected = await client.selection(archive, [first]),
    state = defaultProject();
  state.archive = archive;
  state.schema = 2;
  state.tracks = selected.tracks.map((t) => ({
    entry: t.entry,
    sha256: t.sha256,
  }));
  await service.save("中文项目", state);
  expect(await service.projects(archive)).toEqual(["中文项目"]);
  expect((await service.load(archive, "中文项目")).state).toEqual(state);
  const db = new Database(archive);
  db.prepare(
    "UPDATE archive_entries SET sha256=(SELECT sha256 FROM archive_entries WHERE path=?) WHERE path=?",
  ).run("Train/same.kml", first);
  db.close();
  expect((await service.project(state)).errors[0]!.error).toContain("变化");
  await expect(service.save("changed", state)).rejects.toThrow("变化");
  await expect(client.save(archive, "raced", state)).rejects.toThrow("变化");
  expect(await client.projects(archive)).toEqual(["中文项目"]);
});
it("rejects unknown schemas without upgrading or creating missing files", async () => {
  const db = new Database(archive);
  db.pragma("user_version=99");
  db.close();
  await expect(client.catalog(archive)).rejects.toThrow("schema 99");
  await expect(
    client.catalog(path.join(directory, "missing.sqlite3")),
  ).rejects.toThrow("not found");
  const check = new Database(archive);
  expect(check.pragma("user_version", { simple: true })).toBe(99);
  check.close();
});
it("cancellation releases the worker and queued requests resume", async () => {
  const controller = new AbortController();
  const cancelled = client.selection(
    archive,
    [first],
    undefined,
    controller.signal,
  );
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
  db.prepare("INSERT INTO kml_objects VALUES (?,?,?,?)").run(
    digest,
    "zlib",
    raw.length,
    payload,
  );
  db.prepare(
    "INSERT INTO archive_entries(id,path,sha256,category) VALUES (?,?,?,?)",
  ).run("partial-time", entry, digest, "Default");
  db.prepare("INSERT INTO kml_index VALUES (?,?, 'error', '{}', NULL, ?)").run(
    digest,
    2,
    'Invalid timestamp ""',
  );
  db.close();
  const selected = await client.selection(archive, [entry]);
  expect(selected.errors).toEqual([]);
  expect(selected.tracks[0]!.points).toBe(2);
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
it("tracks larger than the RAM cache remain selectable and reopen from the persistent index", async () => {
  const raw = Buffer.from(
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>' +
      "104,30,0 ".repeat(500_001) +
      "</coordinates></LineString></Placemark></kml>",
  );
  const digest = createHash("sha256").update(raw).digest("hex"),
    db = new Database(archive),
    entry = "Default/large.kml";
  db.prepare("INSERT INTO kml_objects VALUES (?,?,?,?)").run(
    digest,
    "zlib",
    raw.length,
    deflateSync(raw),
  );
  db.prepare(
    "INSERT INTO archive_entries(id,path,sha256,category) VALUES (?,?,?,?)",
  ).run("large-cache-test", entry, digest, "Default");
  db.close();
  for (let i = 0; i < 2; i++) {
    const selected = await client.selection(archive, [entry]);
    expect(selected.errors).toEqual([]);
    expect(selected.tracks[0]!.points).toBe(500_001);
  }
  expect(await client.stats()).toMatchObject({
    xml: 1,
    indexHits: 1,
    memoryHits: 0,
  });
}, 30_000);
