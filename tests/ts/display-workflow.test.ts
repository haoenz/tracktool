import { it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import { ArchiveClient } from "../../dist/node/infrastructure/archive/client.js";
import { ArchiveStore } from "../../dist/node/infrastructure/archive/store.js";
import {
  readTransaction,
  transaction,
} from "../../dist/node/infrastructure/archive/database.js";
import {
  VersionStore,
  archiveId,
} from "../../dist/node/infrastructure/archive/versions.js";
import { trackDetail } from "../../dist/node/infrastructure/archive/track-reader.js";
import { resolveTrack } from "../../dist/node/infrastructure/archive/presentation.js";
import { presentationDigest } from "../../dist/node/infrastructure/archive/identity.js";
import { exportDisplay } from "../../dist/node/infrastructure/archive/display-export.js";
import { readZip } from "../../dist/node/infrastructure/archive/zip.js";
import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
import { MapService } from "../../dist/node/services/map-service.js";
import { defaultProject } from "../../dist/node/shared/project.js";
import { EditPreviews } from "../../dist/node/infrastructure/archive/edit-previews.js";
import { buildOverview } from "../../dist/node/infrastructure/overview/build.js";
import {
  fingerprint,
  readStamp,
  readObject,
  objectPath,
} from "../../dist/node/infrastructure/overview/files.js";
import { parseMediaTime } from "../../dist/node/domain/media-time.js";
import type {
  Presentation,
  VersionRef,
} from "../../dist/node/shared/track-edit.js";
import { createApp } from "../../dist/node/server/app.js";
import { DEFAULTS } from "../../dist/node/domain/config.js";

const raw = Buffer.from(
  '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>mixed</name><Style id="line"><LineStyle><color>ff00ff00</color></LineStyle></Style><Placemark><styleUrl>#line</styleUrl><gx:Track><when>2026-10-14T00:00:00.000001Z</when><when>2026-10-14T00:01:00Z</when><gx:coord>120 30 8</gx:coord><gx:coord>120.01 30 9</gx:coord><gx:ExtendedData><gx:SimpleArrayData name="speed"><gx:value>1</gx:value><gx:value>2</gx:value></gx:SimpleArrayData></gx:ExtendedData></gx:Track></Placemark><Placemark><LineString><coordinates>120.02,30 120.03,30</coordinates></LineString></Placemark><Placemark><LineString><coordinates>120.04,30 120.05,30</coordinates></LineString></Placemark></Document></kml>',
);
const reference = (e: VersionRef) => ({
  entry_id: e.entry_id,
  version_id: e.version_id,
  presentation_id: e.presentation_id,
  generation: e.generation,
  sha256: e.sha256,
});
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-p4-"));
  clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const writer = new ArchiveWriter();
  await writer.init(dir);
  const file = path.join(dir, "archive.sqlite3"),
    name = "Default/2026-10-14 mixed.kml";
  const id = transaction(
    file,
    true,
    (db) => addEntry(db, name, raw, "Default").id,
  );
  const client = new ArchiveClient();
  clean.push(() => client.close());
  const xml = new XmlWorkers(1, 0);
  clean.push(() => xml.close());
  const store = new ArchiveStore(xml),
    service = new MapService(client),
    versions = new VersionStore(file);
  const ref = () =>
    readTransaction(file, (db) => resolveTrack(db, { entry: name }));
  const set = (settings: Presentation) =>
    versions.publish({
      archive_id: readTransaction(file, archiveId),
      request_key: randomUUID(),
      kind: "presentation",
      algorithm_version: "test",
      params: {},
      inputs: [versions.current(id)],
      outputs: [{ kind: "presentation", entry_id: id, settings }],
    });
  return {
    dir,
    file,
    name,
    id,
    writer,
    client,
    xml,
    store,
    service,
    versions,
    ref,
    set,
  };
}
const lines = (track: {
  geojson: { features: { geometry: { type: string; coordinates: unknown } }[] };
}) =>
  track.geojson.features
    .filter((f) => f.geometry.type === "MultiLineString")
    .flatMap((f) => f.geometry.coordinates as number[][][]);
const meta = (file: string) =>
  readTransaction(
    file,
    (db) =>
      db
        .prepare("SELECT revision,storage_revision FROM archive_meta")
        .get() as { revision: number; storage_revision: number },
  );

it("uses presentation snapshots with a warm raw cache and never bypasses ignored middle segments", async () => {
  const f = await fixture();
  expect(
    lines((await f.store.selection(f.file, [f.name])).tracks[0]!),
  ).toHaveLength(5);
  const xmlCount = f.store.stats.xml,
    sha = f.ref().sha256;
  const d = trackDetail(f.file, f.id),
    settings = { ...d.settings, ignored: [d.settings.order[1]!] };
  f.set(settings);
  expect(
    lines((await f.store.selection(f.file, [f.name])).tracks[0]!),
  ).toHaveLength(2);
  settings.connections = [
    { from: settings.order[0]!, to: settings.order[2]!, connect: true },
  ];
  f.set(settings);
  expect(
    lines((await f.store.selection(f.file, [f.name])).tracks[0]!),
  ).toHaveLength(3);
  expect(f.store.stats.xml).toBe(xmlCount);
  expect(f.ref().sha256).toBe(sha);
  expect(Buffer.from(f.store.readBytes(f.file, f.name))).toEqual(raw);
});
it("pins project history, isolates overrides and advances only storage revision when saving", async () => {
  const f = await fixture(),
    selected = await f.client.selection(f.file, [f.name]),
    state = defaultProject();
  state.archive = f.file;
  state.tracks = [selected.tracks[0]!.reference!];
  const original = await f.service.project(state),
    before = meta(f.file);
  await f.service.save("old", state);
  expect(meta(f.file).revision).toBe(before.revision);
  expect(meta(f.file).storage_revision).toBeGreaterThan(
    before.storage_revision,
  );
  const settings = {
    ...selected.tracks[0]!.presentation!.settings,
    default_connect: false,
  };
  f.set(settings);
  expect(lines((await f.service.load(f.file, "old")).tracks[0]!)).toEqual(
    lines(original.tracks[0]!),
  );
  state.tracks[0]!.override = {
    settings,
    sha256: presentationDigest(settings),
  };
  expect(lines((await f.service.project(state)).tracks[0]!)).toHaveLength(3);
  const shaBefore = f.ref().sha256;
  const edits = new EditPreviews(path.join(f.dir, "tasks.sqlite3"));
  clean.push(() => edits.close());
  const d = trackDetail(f.file, f.id),
    p = await edits.create(f.file, randomUUID(), {
      schema: 1,
      archive_id: d.archive_id,
      target: reference(d.entry),
      sources: [],
      operation: {
        kind: "draw",
        after_segment_id: d.settings.order[0]!,
        coordinates: [
          [120.01, 30],
          [120.02, 30],
        ],
      },
    });
  edits.apply(f.file, {
    schema: 1,
    archive_id: d.archive_id,
    preview_id: p.preview_id,
    preview_sha256: p.preview_sha256,
    request_key: randomUUID(),
  });
  expect(f.ref().sha256).not.toBe(shaBefore);
  const drawn = readTransaction(f.file, (db) => exportDisplay(db, f.name));
  const importedId = transaction(
    f.file,
    true,
    (db) => addEntry(db, "Default/2026-10-15 drawn.kml", drawn, "Default").id,
  );
  const imported = trackDetail(f.file, importedId);
  expect(
    imported.segments.filter((s) => s.source_kind === "hand_drawn"),
  ).toHaveLength(1);
  expect(
    imported.segments.find((s) => s.source_kind === "hand_drawn")!.time_status,
  ).toBe("absent");
  expect(lines((await f.service.load(f.file, "old")).tracks[0]!)).toEqual(
    lines(original.tracks[0]!),
  );
  expect(
    (await f.service.project(state)).tracks[0]!.presentation!.current,
  ).toBe(false);
  await f.service.save("historical", state);
  state.tracks[0]!.override!.sha256 = "0".repeat(64);
  expect((await f.service.project(state)).errors[0]!.error).toContain("校验");
});
it("reopens a fixed project after its journey has been replaced and does not cross archive identities", async () => {
  const f = await fixture(),
    state = defaultProject(),
    d = trackDetail(f.file, f.id);
  state.archive = f.file;
  state.tracks = [f.ref()];
  const before = await f.service.project(state);
  await f.service.save("superseded", state);
  const edits = new EditPreviews(path.join(f.dir, "tasks.sqlite3"));
  clean.push(() => edits.close());
  const p = await edits.create(f.file, randomUUID(), {
    schema: 1,
    archive_id: d.archive_id,
    target: reference(d.entry),
    sources: [],
    operation: {
      kind: "split_journey",
      outputs: [
        {
          path: "Default/2026-10-14 first.kml",
          category: "Default",
          segment_ids: [d.settings.order[0]!],
        },
        {
          path: "Train/2026-10-14 rest.kml",
          category: "Train",
          segment_ids: d.settings.order.slice(1),
        },
      ],
    },
  });
  edits.apply(f.file, {
    schema: 1,
    archive_id: d.archive_id,
    preview_id: p.preview_id,
    preview_sha256: p.preview_sha256,
    request_key: randomUUID(),
  });
  const loaded = await f.service.load(f.file, "superseded");
  expect(loaded.errors).toEqual([]);
  expect(lines(loaded.tracks[0]!)).toEqual(lines(before.tracks[0]!));
  expect(loaded.tracks[0]!.presentation!.current).toBe(false);
  expect(() => f.store.currentReference(f.file, f.id)).toThrow("替代");
  state.tracks[0]!.archive_id = randomUUID();
  expect((await f.service.project(state)).errors[0]!.error).toContain(
    "身份不同",
  );
});
it("resolves legacy path/hash to the original baseline with disconnected compatibility and refuses missing matches", async () => {
  const f = await fixture(),
    state = defaultProject();
  state.schema = 2;
  state.archive = f.file;
  state.tracks = [{ entry: f.name, sha256: f.ref().sha256 }];
  const upgraded = await f.service.project(state);
  expect(upgraded.state.schema).toBe(3);
  expect(lines(upgraded.tracks[0]!)).toHaveLength(3);
  expect(upgraded.state.tracks[0]!.override!.settings.default_connect).toBe(
    false,
  );
  state.tracks[0]!.sha256 = "0".repeat(64);
  expect((await f.service.project(state)).errors[0]!.error).toContain(
    "重新关联",
  );
});
it("exports mixed geometry losslessly and reimports generated edges without inventing sample segments", async () => {
  const f = await fixture(),
    d = trackDetail(f.file, f.id);
  const settings = {
    ...d.settings,
    ignored: [d.settings.order[1]!],
    connections: [
      { from: d.settings.order[0]!, to: d.settings.order[2]!, connect: true },
    ],
  };
  f.set(settings);
  const exported = readTransaction(f.file, (db) => exportDisplay(db, f.name)),
    text = Buffer.from(exported).toString();
  expect(text).toContain("2026-10-14T00:00:00.000001Z");
  expect(text).toContain("SimpleArrayData");
  expect(text).toContain("ff00ff00");
  expect(text).not.toContain("120.02,30 120.03,30");
  expect(text).toContain("connection");
  expect(
    Buffer.from(readTransaction(f.file, (db) => exportDisplay(db, f.name))),
  ).toEqual(Buffer.from(exported));
  const name = "Default/2026-10-15 reimport.kml",
    id = transaction(
      f.file,
      true,
      (db) => addEntry(db, name, exported, "Default").id,
    );
  expect(trackDetail(f.file, id).segments).toHaveLength(2);
  const first = (await f.client.selection(f.file, [f.name])).tracks[0]!,
    second = (await f.client.selection(f.file, [name])).tracks[0]!;
  expect(lines(second)).toEqual(lines(first));
  const again = readTransaction(f.file, (db) => exportDisplay(db, name));
  const imported = (
    await f.xml.run(again, { kind: "tracks", source: "roundtrip" })
  ).tracks!;
  expect(imported.tracks.flatMap((t) => t.segments)).toHaveLength(2);
  const edits = new EditPreviews(path.join(f.dir, "tasks.sqlite3"));
  clean.push(() => edits.close());
  const current = trackDetail(f.file, id),
    preview = await edits.create(f.file, randomUUID(), {
      schema: 1,
      archive_id: current.archive_id,
      target: reference(current.entry),
      sources: [],
      operation: {
        kind: "draw",
        after_segment_id: current.settings.order[0]!,
        coordinates: [
          [120.01, 30],
          [120.04, 30],
        ],
      },
    });
  expect(preview.outputs[0]!.segments).toHaveLength(3);
});
it("roundtrips all-ignored empty presentation and rejects dangling export metadata", async () => {
  const f = await fixture(),
    d = trackDetail(f.file, f.id);
  f.set({ ...d.settings, ignored: d.settings.order });
  const out = readTransaction(f.file, (db) => exportDisplay(db, f.name));
  expect(
    (await f.xml.run(out, { kind: "tracks", source: "empty" })).tracks!.tracks,
  ).toHaveLength(0);
  const id = transaction(
    f.file,
    true,
    (db) => addEntry(db, "Default/empty.kml", out, "Default").id,
  );
  expect(trackDetail(f.file, id).segments).toHaveLength(0);
  f.set(d.settings);
  const populated = readTransaction(f.file, (db) => exportDisplay(db, f.name));
  const invalid = Buffer.from(
    Buffer.from(populated)
      .toString()
      .replace(
        /&quot;xml_id&quot;:&quot;[^&]+/,
        "&quot;xml_id&quot;:&quot;missing",
      ),
  );
  // XML text uses plain JSON quotes; mutate its metadata only.
  const broken = Buffer.from(
    invalid.toString().replace(/"xml_id":"[^"]+"/, '"xml_id":"missing"'),
  );
  await expect(
    f.xml.run(broken, { kind: "tracks", source: "broken" }),
  ).rejects.toThrow(/缺失/);
});
it("ZIP and desktop/mobile collections use current display and preserve timed geometry", async () => {
  const f = await fixture(),
    d = trackDetail(f.file, f.id);
  f.set({ ...d.settings, ignored: [d.settings.order[1]!] });
  const zip = path.join(f.dir, "display.zip");
  await f.writer.backup(f.file, zip);
  const files: Uint8Array[] = [];
  await readZip(zip, (_name, bytes) => {
    files.push(bytes);
  });
  expect(files).toHaveLength(1);
  expect(Buffer.from(files[0]!).toString()).toContain("gx:Track");
  await f.writer.execute({
    kind: "rebuild",
    database: f.file,
    output: path.join(f.dir, "out"),
  });
  for (const name of ["Default.kml", "Default.Mobile.kml"]) {
    const text = readFileSync(path.join(f.dir, "out", name));
    expect(text.toString()).toContain("2026-10-14T00:00:00.000001Z");
    expect(
      (
        await f.xml.run(text, { kind: "tracks", source: name })
      ).tracks!.tracks.flatMap((t) => t.segments),
    ).toHaveLength(2);
  }
});
it("overview display caches include settings identity while raw coordinate caches and old generations remain reusable", async () => {
  const f = await fixture(),
    root = path.join(f.dir, "overview");
  const build = () => {
    const stamp = readStamp(f.file);
    return buildOverview(
      {
        source: f.file,
        root,
        crs: "wgs84",
        stamp,
        fingerprint: fingerprint(stamp, "wgs84"),
        budget: 128 * 1024 ** 2,
      },
      () => {},
    );
  };
  const first = await build(),
    key = first.entries[0]!.display_key!,
    mtime = statSync(objectPath(root, f.ref().sha256)).mtimeMs;
  expect((await readObject(root, key)).segments).toHaveLength(5);
  const d = trackDetail(f.file, f.id);
  f.set({ ...d.settings, ignored: [d.settings.order[1]!] });
  const second = await build();
  expect(second.fingerprint).not.toBe(first.fingerprint);
  expect(second.entries[0]!.display_key).not.toBe(key);
  expect(
    (await readObject(root, second.entries[0]!.display_key!)).segments,
  ).toHaveLength(2);
  expect((await readObject(root, key)).segments).toHaveLength(5);
  expect(statSync(objectPath(root, f.ref().sha256)).mtimeMs).toBe(mtime);
});
it("media matching reads timed original samples even when their segment is hidden", async () => {
  const f = await fixture(),
    d = trackDetail(f.file, f.id);
  f.set({ ...d.settings, ignored: d.settings.order });
  const time = parseMediaTime({
    "ExifIFD:DateTimeOriginal": "2026:10:14 00:01:00",
    "ExifIFD:OffsetTimeOriginal": "+00:00",
  })!;
  expect(await f.store.nearest(f.file, time, false, 60)).toBeDefined();
  expect((await f.client.selection(f.file, [f.name])).tracks[0]!.points).toBe(
    0,
  );
});
it("CLI display export has a read-only dry run and refuses to overwrite targets", async () => {
  const f = await fixture(),
    out = path.join(f.dir, "display.kml"),
    before = meta(f.file);
  const args = [
    "dist/node/cli/main.js",
    "track",
    "export",
    f.id,
    "--archive",
    f.file,
    "--output",
    out,
  ];
  const dry = spawnSync(process.execPath, [...args, "--dry-run"], {
    encoding: "utf8",
  });
  expect(dry.status, dry.stderr).toBe(0);
  expect(existsSync(out)).toBe(false);
  const written = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(written.status, written.stderr).toBe(0);
  expect(readFileSync(out, "utf8")).toContain("tracktool:display:1");
  expect(spawnSync(process.execPath, args).status).not.toBe(0);
  expect(meta(f.file)).toEqual(before);
});
it("HTTP project overrides and managed KML downloads do not mutate archive defaults", async () => {
  const f = await fixture(),
    state = defaultProject();
  state.archive = f.file;
  state.tracks = [f.ref()];
  const app = await createApp({
    token: "test",
    configStore: {
      async load() {
        return { ...DEFAULTS, archive_path: f.dir };
      },
    },
    work: {
      stateDir: path.join(f.dir, "work"),
      roots: [f.dir],
      archive: f.dir,
    },
  });
  clean.push(() => app.close());
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const call = async (url: string, payload?: unknown) => {
    const r = await fetch(base + url, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        "x-tracktool-token": "test",
        "content-type": "application/json",
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await r.text();
    return { statusCode: r.status, body, json: () => JSON.parse(body) };
  };
  const before = meta(f.file),
    settings = {
      ...trackDetail(f.file, f.id).settings,
      default_connect: false,
    };
  const result = await call("/api/project/presentation", {
    state,
    entry_id: f.id,
    settings,
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(lines(result.json().tracks[0])).toHaveLength(3);
  expect(meta(f.file)).toEqual(before);
  const exported = await call("/api/export-kml", result.json().state);
  expect(exported.statusCode, exported.body).toBe(200);
  const response = await call(`/api/jobs/${exported.json().job}/kml`);
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("tracktool:display:1");
  expect(meta(f.file)).toEqual(before);
});
