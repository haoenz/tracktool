import { SegmentEditSchema } from "../../dist/node/shared/track-edit.js";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {
  withDocument,
  namespaces,
} from "../../dist/node/infrastructure/xml/document.js";
import { readManifest } from "../../dist/node/infrastructure/xml/manifest.js";
import { readTrackData } from "../../dist/node/infrastructure/xml/trackdata.js";
import { editSegments } from "../../dist/node/infrastructure/xml/segment-edit.js";
import {
  bindSegments,
  evaluatePresentation,
  resolvedEdges,
  detectSegmentGaps,
  detectSegmentDrift,
} from "../../dist/node/domain/presentation.js";
import { kmlRoot } from "../../dist/node/domain/kml-edit.js";
import {
  VersionStore,
  currentEntry,
  archiveId,
} from "../../dist/node/infrastructure/archive/versions.js";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import { prepareSegmentEdit } from "../../dist/node/infrastructure/archive/segment-editor.js";
import {
  readTransaction,
  transaction,
} from "../../dist/node/infrastructure/archive/database.js";
import type { SegmentInput } from "../../dist/node/domain/segment-edit.js";
import type { Presentation } from "../../dist/node/domain/track-version.js";

const encode = (text: string) => new TextEncoder().encode(text);
const line = (coordinates: string, id = "g") =>
  `<LineString id="${id}"><tessellate>1</tessellate><coordinates>${coordinates}</coordinates></LineString>`;
const times = [
  "2026-01-01T00:00:00.000001+08:00",
  "2026-01-01T00:00:01.000002+08:00",
  "2026-01-01T00:00:02.000003+08:00",
  "2026-01-01T00:00:03.000004+08:00",
];
const coords = [
  "120.00000 30.0 0",
  "120.00001 30.0",
  "120.00002 30.0 12.000",
  "120.00003 30.0 15",
];
const track = `<gx:Track id="g"><altitudeMode>absolute</altitudeMode><gx:altitudeMode>relativeToSeaFloor</gx:altitudeMode>${times.map((t) => `<when>${t}</when>`).join("")}${coords.map((c, i) => `<gx:coord custom="p${i}">${c}</gx:coord>`).join("")}${coords.map((_, i) => `<gx:angles>${i} 0 0</gx:angles>`).join("")}<Model id="model"><Location><longitude>120</longitude><latitude>30</latitude></Location></Model><ExtendedData><SchemaData schemaUrl="#schema"><gx:SimpleArrayData name="speed">${["1.000", "", "3.00", "4"].map((v) => `<gx:value>${v}</gx:value>`).join("")}</gx:SimpleArrayData></SchemaData><custom:note xmlns:custom="urn:custom">保留 &amp; 元数据</custom:note></ExtendedData><!-- track note --></gx:Track>`;
const mixed = encode(
  kmlRoot(
    `<Document><name>原行程</name><description><![CDATA[a < b & c]]></description><Style id="style"><LineStyle><color>ff0000ff</color></LineStyle></Style><Schema id="schema"><gx:SimpleArrayField name="speed" type="double"/></Schema><ExtendedData><Data name="TrackTags"><value>徒步</value></Data></ExtendedData><Folder><name>层级</name><Placemark id="p"><name>混合</name><styleUrl>#style</styleUrl><MultiGeometry>${line("119,30 120,30", "same")}<gx:MultiTrack><gx:interpolate>1</gx:interpolate>${track}</gx:MultiTrack></MultiGeometry></Placemark></Folder><Placemark><description>untouched</description>${line("120.1,30 120.2,30", "same")}</Placemark></Document>`,
  ),
);
function source(raw: Uint8Array = mixed, version = "v1"): SegmentInput {
  const manifest = readManifest(raw, (i) => `${version}-s${i}`);
  expect(manifest.status, manifest.error ?? "").toBe("ready");
  return {
    version_id: version,
    raw,
    segments: manifest.segments,
    settings: {
      schema: 1,
      default_connect: true,
      order: manifest.segments.map((s) => s.segment_id),
      ignored: [],
      connections: [],
    },
  };
}
function view(input: SegmentInput) {
  return evaluatePresentation(
    withDocument(input.raw, (doc) =>
      bindSegments(readTrackData(doc), input.segments),
    ),
    input.settings,
  );
}
function next(result: ReturnType<typeof editSegments>): SegmentInput {
  return { ...result, version_id: "next" };
}
function values(raw: Uint8Array, xpath: string) {
  return withDocument(raw, (doc) =>
    doc.find(xpath, namespaces).map((n) => n.content),
  );
}
function unchanged(raw: Uint8Array) {
  return withDocument(raw, (doc) =>
    doc
      .get('//kml:Placemark[kml:description="untouched"]', namespaces)!
      .canonicalizeToString({ withComments: true }),
  );
}

it("internally splits a nested Track into one KML, preserves aligned attributes, and keeps other segment identities", () => {
  const input = source(),
    s = input.segments[1]!,
    before = Buffer.from(input.raw),
    other = unchanged(input.raw);
  input.segments[1]!.source_kind = "measured";
  const result = editSegments(
    input,
    {
      kind: "split_segment",
      segment_id: s.segment_id,
      after_point_indices: [2, 0],
    },
    "split",
  );
  expect(result.segments.map((s) => s.point_count)).toEqual([2, 1, 2, 1, 2]);
  expect(result.segments[0]!.segment_id).toBe(input.segments[0]!.segment_id);
  expect(result.segments.at(-1)!.segment_id).toBe(
    input.segments[2]!.segment_id,
  );
  expect(
    result.segments.slice(1, 4).every((s) => s.source_kind === "measured"),
  ).toBe(true);
  expect(values(result.raw, "//kml:when")).toEqual(times);
  expect(values(result.raw, "//gx:coord")).toEqual(coords);
  expect(values(result.raw, "//gx:coord/@custom")).toEqual([
    "p0",
    "p1",
    "p2",
    "p3",
  ]);
  expect(values(result.raw, "//gx:angles")).toEqual([
    "0 0 0",
    "1 0 0",
    "2 0 0",
    "3 0 0",
  ]);
  expect(values(result.raw, "//gx:value")).toEqual(["1.000", "", "3.00", "4"]);
  expect(values(result.raw, "//gx:interpolate")).toEqual(["0"]);
  expect(unchanged(result.raw)).toBe(other);
  expect(Buffer.from(input.raw)).toEqual(before);
  expect(result.settings.connections).toHaveLength(2);
  expect(result.settings.connections.every((e) => !e.connect)).toBe(true);
  expect(view(next(result)).edges).toHaveLength(2);
  expect(
    result.sources
      .filter((s) => s.source_segment_id === input.segments[1]!.segment_id)
      .map((s) => [s.start, s.end_exclusive]),
  ).toEqual([
    [0, 1],
    [1, 3],
    [3, 4],
  ]);
  expect(
    Buffer.from(
      editSegments(
        input,
        {
          kind: "split_segment",
          segment_id: s.segment_id,
          after_point_indices: [2, 0],
        },
        "split",
      ).raw,
    ),
  ).toEqual(Buffer.from(result.raw));
});
it("splits a direct Placemark LineString, keeps precise tokens and wraps its geometry", () => {
  const input = source(
      encode(
        kmlRoot(
          `<Placemark><name>one</name>${line("120.000,30 120.1,30,0 120.2,30,3.450")}</Placemark>`,
        ),
      ),
    ),
    result = editSegments(
      input,
      {
        kind: "split_segment",
        segment_id: input.segments[0]!.segment_id,
        after_point_indices: [0],
      },
      "line",
    );
  expect(values(result.raw, "//kml:coordinates")).toEqual([
    "120.000,30",
    "120.1,30,0 120.2,30,3.450",
  ]);
  expect(
    values(result.raw, "//kml:Placemark/kml:MultiGeometry/kml:LineString"),
  ).toHaveLength(2);
  expect(view(next(result)).connections).toEqual([]);
});
it("prunes non-overlapping ranges preserving aligned series without inventing time or altitude", () => {
  const input = source(),
    id = input.segments[1]!.segment_id;
  const result = editSegments(
    input,
    {
      kind: "prune",
      segment_id: id,
      ranges: [
        { start: 2, end: 3 },
        { start: 0, end: 1 },
      ],
    },
    "prune",
  );
  expect(result.segments[1]!.segment_id).toBe(id);
  expect(values(result.raw, "//gx:coord")).toEqual([coords[1], coords[3]]);
  expect(values(result.raw, "//kml:when")).toEqual([times[1], times[3]]);
  expect(values(result.raw, "//gx:value")).toEqual(["", "4"]);
  expect(result.changes.removed_points).toBe(2);
  expect(
    result.sources
      .filter((s) => s.source_segment_id === id)
      .map((s) => [s.start, s.end_exclusive]),
  ).toEqual([
    [1, 2],
    [3, 4],
  ]);
});
it.each([
  {
    kind: "prune",
    ranges: [
      { start: 0, end: 3 },
      { start: 2, end: 4 },
    ],
  },
  { kind: "prune", ranges: [{ start: 0, end: 4 }] },
  { kind: "prune", ranges: [{ start: 3, end: 5 }] },
  { kind: "split_segment", after_point_indices: [3] },
  { kind: "split_segment", after_point_indices: [1, 1] },
])("rejects invalid edit ranges: %j", (op) => {
  const input = source();
  expect(() =>
    editSegments(
      input,
      { ...op, segment_id: input.segments[1]!.segment_id },
      "invalid",
    ),
  ).toThrow();
});
it.each(["when", "angles", "array", "extension"])(
  "rejects ambiguous %s sample alignment without losing untouched nodes",
  (type) => {
    let text = Buffer.from(mixed).toString();
    if (type === "when") text = text.replace(`<when>${times[0]}</when>`, "");
    if (type === "angles")
      text = text.replace("<gx:angles>0 0 0</gx:angles>", "");
    if (type === "array") text = text.replace("<gx:value>1.000</gx:value>", "");
    if (type === "extension")
      text = text.replace(
        "</gx:Track>",
        '<custom:r xmlns:custom="urn:custom">0</custom:r><custom:r xmlns:custom="urn:custom">1</custom:r></gx:Track>',
      );
    const input = source(encode(text));
    expect(() =>
      editSegments(
        input,
        {
          kind: "prune",
          segment_id: input.segments[1]!.segment_id,
          ranges: [{ start: 0, end: 1 }],
        },
        "bad",
      ),
    ).toThrow(/alignment|array/);
  },
);
it("keeps missing timestamps as aligned empty slots and never passes them as measured time", () => {
  const input = source(
    encode(
      Buffer.from(mixed)
        .toString()
        .replace(`<when>${times[1]}</when>`, "<when/>"),
    ),
  );
  expect(input.segments[1]!.time_status).toBe("mismatch");
  const result = editSegments(
    input,
    {
      kind: "split_segment",
      segment_id: input.segments[1]!.segment_id,
      after_point_indices: [1],
    },
    "partial",
  );
  expect(values(result.raw, "//kml:when")).toEqual([
    times[0],
    "",
    times[2],
    times[3],
  ]);
  expect(view(next(result)).segments[1]!.time_us).toBeNull();
  expect(view(next(result)).segments[2]!.time_us).not.toBeNull();
  expect(() =>
    withDocument(
      encode(Buffer.from(input.raw).toString().replace(times[0]!, "bad")),
      (doc) => readTrackData(doc),
    ),
  ).toThrow("Invalid timestamp");
});
it("inserts a hand-drawn LineString with explicit snapping, removes bypass overrides, and preserves a single root feature", () => {
  const input = source(
    encode(
      kmlRoot(
        `<Placemark><MultiGeometry>${line("120,30,9 120.01,30,10", "a")}${line("120.02,30 120.03,30", "b")}</MultiGeometry></Placemark>`,
      ),
    ),
  );
  const [a, b] = input.settings.order as [string, string];
  input.settings.connections = [{ from: a, to: b, connect: false }];
  const result = editSegments(
    input,
    {
      kind: "draw",
      after_segment_id: a,
      coordinates: [
        [0, 0],
        [120.015, 30],
        [0, 0, 100],
      ],
      snap_start: { segment_id: a, endpoint: "end" },
      snap_end: { segment_id: b, endpoint: "start" },
    },
    "draw",
  );
  const drawn = result.segments[2]!;
  expect(drawn).toMatchObject({
    source_kind: "hand_drawn",
    geometry_kind: "LineString",
    time_status: "absent",
  });
  expect(result.settings.order).toEqual([a, drawn.segment_id, b]);
  expect(result.changes.removed_connections).toEqual([
    { from: a, to: b, connect: false },
  ]);
  expect(values(result.raw, "//kml:coordinates").at(-1)).toBe(
    "120.01,30,10 120.015,30 120.02,30",
  );
  expect(values(result.raw, "/kml:kml/kml:Document")).toHaveLength(1);
  expect(view(next(result)).edges).toEqual([
    { from: a, to: drawn.segment_id },
    { from: drawn.segment_id, to: b },
  ]);
  expect(view(next(result)).connections).toEqual([]); // snapped endpoints need no zero-length lines
  expect(values(result.raw, "//kml:when")).toEqual([]);
});
it("composes mixed source segments in explicit order with styles and schemas, without inferring untimed sources as hand drawn", () => {
  const input = source(),
    other = source(
      encode(
        kmlRoot(
          `<Document><Style id="style"><LineStyle><color>ff00ff00</color></LineStyle></Style><Placemark><styleUrl>#style</styleUrl>${line("121,30 122,31")}</Placemark></Document>`,
        ),
      ),
      "v2",
    );
  other.segments[0]!.source_kind = "hand_drawn";
  const result = editSegments(
    input,
    {
      kind: "compose",
      segments: [
        {
          version_id: "v2",
          segment_id: other.segments[0]!.segment_id,
        },
        { version_id: "v1", segment_id: input.segments[1]!.segment_id },
      ],
      default_connect: false,
    },
    "compose",
    [other],
  );
  expect(result.segments.map((s) => [s.geometry_kind, s.source_kind])).toEqual([
    ["LineString", "hand_drawn"],
    ["gx:Track", "unknown"],
  ]);
  expect(values(result.raw, "//kml:coordinates")).toEqual(["121,30 122,31"]);
  expect(values(result.raw, "//kml:when")).toEqual(times);
  const ids = values(result.raw, "//*[@id]/@id");
  expect(new Set(ids).size).toBe(ids.length);
  for (const ref of [
    ...values(result.raw, "//kml:styleUrl"),
    ...values(result.raw, "//kml:SchemaData/@schemaUrl"),
  ])
    expect(ids).toContain(ref.slice(1));
  expect(values(result.raw, "/kml:kml/kml:Document/kml:Schema")).toHaveLength(
    1,
  );
  expect(view(next(result)).connections).toEqual([]);
  expect(result.changes.removed_points).toBe(4);
});
it("uses locators instead of duplicate XML geometry IDs, validates source manifests and keeps edits deterministic", () => {
  const input = source(),
    bad = structuredClone(input);
  bad.segments[0]!.locator = [99];
  expect(() =>
    editSegments(
      bad,
      {
        kind: "prune",
        segment_id: bad.segments[0]!.segment_id,
        ranges: [{ start: 0, end: 1 }],
      },
      "bad",
    ),
  ).toThrow("manifest");
  const result = editSegments(
    input,
    {
      kind: "prune",
      segment_id: input.segments[2]!.segment_id,
      ranges: [{ start: 0, end: 1 }],
    },
    "last",
  );
  expect(result.segments[0]!.point_count).toBe(2);
  expect(result.segments[2]!.point_count).toBe(1);
});
it("does not bridge an ignored middle segment, supports explicit cross-links and separates measured, drawn and connection distances", () => {
  const input = source(
    encode(
      kmlRoot(
        `<Document><Placemark><MultiGeometry>${line("120,30 120.001,30", "a")}${line("120.002,30 120.003,30", "b")}${line("120.004,30 120.005,30", "c")}</MultiGeometry></Placemark></Document>`,
      ),
    ),
  );
  const [a, b, c] = input.settings.order as [string, string, string];
  input.segments[0]!.source_kind = "measured";
  input.segments[1]!.source_kind = "hand_drawn";
  const defaultView = view(input);
  expect(defaultView.connections).toHaveLength(2);
  expect(defaultView.totals.measured_m).toBeGreaterThan(0);
  expect(defaultView.totals.hand_drawn_m).toBeGreaterThan(0);
  expect(defaultView.totals.unknown_m).toBeGreaterThan(0);
  expect(defaultView.totals.measured_speed_mps).toBeNull();
  input.settings.ignored = [b];
  expect(view(input).edges).toEqual([]);
  expect(view(input).segments.map((s) => s.segment_id)).toEqual([a, c]);
  input.settings.connections = [{ from: a, to: c, connect: true }];
  expect(view(input).connections).toHaveLength(1);
  input.settings.default_connect = false;
  expect(view(input).connections).toHaveLength(1);
  expect(() =>
    resolvedEdges(
      { ...input.settings, order: [c, b, a] },
      input.settings.order,
    ),
  ).toThrow("follow segment order");
});
it("binds same-content geometry independently to presentation snapshots and excludes drawn segments from timed speed", () => {
  const input = source();
  input.segments[1]!.source_kind = "measured";
  const segments = withDocument(input.raw, (doc) =>
    bindSegments(readTrackData(doc), input.segments),
  );
  const other: Presentation = {
    ...input.settings,
    default_connect: false,
    ignored: [input.settings.order[0]!],
  };
  const first = evaluatePresentation(segments, input.settings),
    second = evaluatePresentation(segments, other);
  expect(first.connections.length).toBeGreaterThan(second.connections.length);
  expect(second.totals.measured_speed_mps).toBeGreaterThan(0);
  expect(segments).toHaveLength(3);
  const drawn = segments.map((s) => ({
    ...s,
    source_kind: "hand_drawn" as const,
  }));
  expect(
    evaluatePresentation(drawn, input.settings).totals.measured_speed_mps,
  ).toBeNull();
  expect(input.settings.ignored).toEqual([]);
});
it("detects gaps and returning drift only within a fully timed segment and returns explicit edit indices", () => {
  const input = source(),
    s = withDocument(input.raw, (doc) =>
      bindSegments(readTrackData(doc), input.segments),
    )[1]!;
  const modified = {
    ...s,
    longitude: Float64Array.from([120, 121, 120.00001, 120.00002]),
  };
  expect(
    detectSegmentDrift(modified, {
      speedMps: 100,
      jumpMeters: 1000,
      returnMeters: 50,
      maxSeconds: 10,
    }),
  ).toEqual([{ start: 1, end: 2 }]);
  expect(
    detectSegmentGaps(modified, { gapSeconds: 0.5, gapMeters: 1000 }),
  ).toEqual([0, 1]);
  expect(() =>
    detectSegmentGaps({ ...s, time_us: null }, { gapSeconds: 1, gapMeters: 1 }),
  ).toThrow("complete timestamps");
  expect(() =>
    detectSegmentGaps(
      { ...s, time_us: BigInt64Array.from([...s.time_us!].reverse()) },
      { gapSeconds: 1, gapMeters: 1 },
    ),
  ).toThrow("increasing");
});

const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
function snapshot(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => {
        const name = (row as { name: string }).name;
        return [
          name,
          db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ];
      });
  } finally {
    db.close();
  }
}
it("prepares without writes, publishes identities/settings/lineage atomically, replays, rejects stale input and preserves all originals", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-p2-"));
  dirs.push(dir);
  await new ArchiveWriter().init(dir);
  const file = path.join(dir, "archive.sqlite3");
  const ref = transaction(file, true, (db) =>
      currentEntry(
        db,
        addEntry(db, "2026-01-01 trip.kml", mixed, "Default").id,
      ),
    ),
    archive = readTransaction(file, archiveId),
    store = new VersionStore(file);
  const manifest = readTransaction(file, (db) =>
    db
      .prepare(
        "SELECT segment_id FROM track_segments WHERE version_id=? ORDER BY ordinal",
      )
      .all(ref.version_id),
  ) as { segment_id: string }[];
  const expected = {
    entry_id: ref.entry_id,
    version_id: ref.version_id,
    presentation_id: ref.presentation_id,
    generation: ref.generation,
    sha256: ref.sha256,
  };
  const request = {
    archive_id: archive,
    request_key: "split",
    target: expected,
    operation: {
      kind: "split_segment" as const,
      segment_id: manifest[1]!.segment_id,
      after_point_indices: [1],
    },
  };
  const before = snapshot(file),
    prepared = await prepareSegmentEdit(file, request);
  expect(snapshot(file)).toEqual(before);
  const output = store.publish(prepared.publish);
  expect(store.publish(prepared.publish)).toEqual(output);
  expect(output.entries[0]!.entry_id).toBe(ref.entry_id);
  expect(store.history(ref.entry_id)).toHaveLength(2);
  expect(Buffer.from(store.read(ref.version_id))).toEqual(Buffer.from(mixed));
  expect(
    readTransaction(file, (db) =>
      db
        .prepare(
          "SELECT segment_id FROM track_segments WHERE version_id=? ORDER BY ordinal",
        )
        .all(output.entries[0]!.version_id),
    ),
  ).toEqual(
    prepared.result.segments.map((s) => ({ segment_id: s.segment_id })),
  );
  await expect(
    prepareSegmentEdit(file, { ...request, request_key: "stale" }),
  ).rejects.toThrow("changed since preview");
  const updated = output.entries[0]!;
  const target = {
    entry_id: updated.entry_id,
    version_id: updated.version_id,
    presentation_id: updated.presentation_id,
    generation: updated.generation,
    sha256: updated.sha256,
  };
  const settings = { ...prepared.result.settings, default_connect: false };
  const presentation = await prepareSegmentEdit(file, {
    archive_id: archive,
    request_key: "settings",
    target,
    operation: { kind: "presentation", settings },
  });
  expect(Buffer.from(presentation.result.raw)).toEqual(
    Buffer.from(prepared.result.raw),
  );
  const shown = store.publish(presentation.publish).entries[0]!;
  expect(shown.version_id).toBe(updated.version_id);
  expect(shown.sha256).toBe(updated.sha256);
  expect(shown.presentation_id).not.toBe(updated.presentation_id);
  const count = store.history(ref.entry_id).length;
  expect(count).toBe(2);
  const bad = {
    ...prepared.publish,
    request_key: "bad-ids",
    inputs: [shown],
    outputs: prepared.publish.outputs.map((o) =>
      o.kind === "version" ? { ...o, segment_ids: ["duplicate"] } : o,
    ),
  };
  const state = snapshot(file);
  expect(() => store.publish(bad)).toThrow("identities");
  expect(snapshot(file)).toEqual(state);
});

it("remaps incoming/outgoing overrides and ignored segments when splitting, without bypassing a cut", () => {
  const input = source(),
    [a, b, c] = input.settings.order as [string, string, string];
  input.settings.ignored = [b];
  input.settings.connections = [
    { from: a, to: b, connect: false },
    { from: b, to: c, connect: true },
  ];
  const result = editSegments(
    input,
    { kind: "split_segment", segment_id: b, after_point_indices: [1] },
    "ignored-split",
  );
  const left = result.segments[1]!.segment_id,
    right = result.segments[2]!.segment_id;
  expect(result.settings.ignored).toEqual([left, right]);
  expect(result.settings.connections).toEqual([
    { from: a, to: left, connect: false },
    { from: right, to: c, connect: true },
    { from: left, to: right, connect: false },
  ]);
  expect(result.changes.before_edges).toEqual([]);
  expect(result.changes.after_edges).toEqual([]);
  expect(
    evaluatePresentation(view(next(result)).segments, {
      schema: 1,
      default_connect: false,
      order: [a, c],
      ignored: [],
      connections: [],
    }).connections,
  ).toEqual([]);
  const modelIds = values(result.raw, "//kml:Model/@id");
  expect(modelIds).toHaveLength(2);
  expect(new Set(modelIds).size).toBe(2);
});
it("supports prefixed KML/gx names and preserves unedited opaque metadata and local Model references", () => {
  const raw = encode(
    `<k:kml xmlns:k="${namespaces.kml}" xmlns:t="${namespaces.gx}" xmlns:x="urn:custom"><k:Document><k:ExtendedData><x:data>keep</x:data></k:ExtendedData><k:Placemark><t:Track id="track"><k:when>${times[0]}</k:when><k:when>${times[1]}</k:when><t:coord>120 30</t:coord><t:coord>121 31</t:coord><k:Model id="model"><k:Link><k:href>#model</k:href></k:Link></k:Model></t:Track></k:Placemark></k:Document></k:kml>`,
  );
  const input = source(raw),
    result = editSegments(
      input,
      {
        kind: "split_segment",
        segment_id: input.segments[0]!.segment_id,
        after_point_indices: [0],
      },
      "prefix",
    );
  expect(values(result.raw, "//gx:coord")).toEqual(["120 30", "121 31"]);
  expect(Buffer.from(result.raw).toString()).toContain("<x:data>keep</x:data>");
  const ids = values(result.raw, "//kml:Model/@id");
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const href of values(result.raw, "//kml:href"))
    expect(ids).toContain(href.slice(1));
});
it("composes the same logical segment from two fixed versions with distinct output identities", () => {
  const input = source(
      encode(
        kmlRoot(
          `<Document><Placemark>${line("120,30 121,31")}</Placemark></Document>`,
        ),
      ),
    ),
    other = source(input.raw, "v2");
  other.segments[0]!.segment_id = input.segments[0]!.segment_id;
  other.settings.order = [input.segments[0]!.segment_id];
  const op = {
    kind: "compose",
    segments: [
      {
        version_id: input.version_id,
        segment_id: input.segments[0]!.segment_id,
      },
      {
        version_id: other.version_id,
        segment_id: other.segments[0]!.segment_id,
      },
    ],
    default_connect: true,
  };
  const result = editSegments(input, op, "two-versions", [other]);
  expect(new Set(result.segments.map((s) => s.segment_id)).size).toBe(2);
  expect(result.sources.map((s) => s.source_version_id)).toEqual(["v1", "v2"]);
  expect(() =>
    editSegments(
      input,
      { ...op, segments: [op.segments[0], op.segments[0]] },
      "duplicate",
      [other],
    ),
  ).toThrow("Duplicate composition");
});
it("drops explicit bypasses around an insertion and requires deliberate fixes for backward overrides after reordering", () => {
  const input = source(),
    [a, , c] = input.settings.order as [string, string, string];
  input.settings.connections = [{ from: a, to: c, connect: true }];
  const drawn = editSegments(
    input,
    {
      kind: "draw",
      after_segment_id: a,
      coordinates: [
        [120, 30],
        [121, 31],
      ],
    },
    "bypass",
  );
  expect(drawn.changes.removed_connections).toEqual(input.settings.connections);
  expect(drawn.settings.connections).toEqual([]);
  const order = [...input.settings.order].reverse();
  expect(() =>
    editSegments(
      input,
      { kind: "presentation", settings: { ...input.settings, order } },
      "reorder",
    ),
  ).toThrow("follow segment order");
  const changed = editSegments(
    input,
    {
      kind: "presentation",
      settings: { ...input.settings, order, connections: [] },
    },
    "reorder-fixed",
  );
  expect(Buffer.from(changed.raw)).toEqual(Buffer.from(input.raw));
  expect(changed.changes.removed_connections).toEqual(
    input.settings.connections,
  );
});
it("omits zero-length dateline connections and never auto-connects independent evaluator calls", () => {
  const input = source(
    encode(
      kmlRoot(
        `<Document><Placemark><MultiGeometry>${line("179,30 180,30", "a")}${line("-180,30 -179,30", "b")}</MultiGeometry></Placemark></Document>`,
      ),
    ),
  );
  expect(view(input).edges).toHaveLength(1);
  expect(view(input).connections).toHaveLength(0);
  const segments = withDocument(input.raw, (doc) =>
    bindSegments(readTrackData(doc), input.segments),
  );
  for (const s of segments)
    expect(
      evaluatePresentation([s], {
        schema: 1,
        default_connect: true,
        order: [s.segment_id],
        ignored: [],
        connections: [],
      }).connections,
    ).toEqual([]);
});
it("prepares a composition from fixed historical/source-only versions and publishes source dependencies", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-p2-compose-"));
  dirs.push(dir);
  await new ArchiveWriter().init(dir);
  const file = path.join(dir, "archive.sqlite3"),
    store = new VersionStore(file);
  const target = transaction(file, true, (db) =>
      currentEntry(db, addEntry(db, "target.kml", mixed, "Default").id),
    ),
    archive = readTransaction(file, archiveId);
  const sourceRaw = encode(
    kmlRoot(
      `<Document><Placemark>${line("120,30 121,31")}</Placemark></Document>`,
    ),
  );
  const imported = store.publish({
    archive_id: archive,
    request_key: "source",
    kind: "import",
    algorithm_version: "test",
    params: {},
    inputs: [],
    outputs: [
      {
        kind: "version",
        path: "source.kml",
        category: null,
        raw: sourceRaw,
        state: "source_only",
        source_kinds: { 0: "hand_drawn" },
      },
    ],
  }).entries[0]!;
  const targetId = readTransaction(
      file,
      (db) =>
        (
          db
            .prepare(
              "SELECT segment_id FROM track_segments WHERE version_id=? AND ordinal=1",
            )
            .get(target.version_id) as { segment_id: string }
        ).segment_id,
    ),
    sourceId = readTransaction(
      file,
      (db) =>
        (
          db
            .prepare("SELECT segment_id FROM track_segments WHERE version_id=?")
            .get(imported.version_id) as { segment_id: string }
        ).segment_id,
    );
  const ref = {
    entry_id: target.entry_id,
    version_id: target.version_id,
    presentation_id: target.presentation_id,
    generation: target.generation,
    sha256: target.sha256,
  };
  const prepared = await prepareSegmentEdit(file, {
    archive_id: archive,
    request_key: "compose",
    target: ref,
    sources: [
      {
        entry_id: imported.entry_id,
        version_id: imported.version_id,
        presentation_id: imported.presentation_id,
        sha256: imported.sha256,
      },
    ],
    operation: {
      kind: "compose",
      segments: [
        { version_id: target.version_id, segment_id: targetId },
        { version_id: imported.version_id, segment_id: sourceId },
      ],
      default_connect: false,
    },
  });
  expect(prepared.publish.historical_inputs).toEqual([
    { version_id: imported.version_id, sha256: imported.sha256 },
  ]);
  const result = store.publish(prepared.publish);
  expect(result.entries[0]!.entry_id).toBe(target.entry_id);
  expect(result.entries).toHaveLength(1);
  expect(
    readTransaction(file, (db) => currentEntry(db, imported.entry_id).state),
  ).toBe("source_only");
  expect(Buffer.from(store.read(imported.version_id))).toEqual(
    Buffer.from(sourceRaw),
  );
  expect(prepared.result.segments.map((s) => s.source_kind)).toEqual([
    "unknown",
    "hand_drawn",
  ]);
});

it("rejects retired reversal operations and composition flags", () => {
  expect(
    SegmentEditSchema.safeParse({ kind: "reverse", segment_id: "segment" })
      .success,
  ).toBe(false);
  for (const reverse of [true, false])
    expect(
      SegmentEditSchema.safeParse({
        kind: "compose",
        segments: [{ version_id: "version", segment_id: "segment", reverse }],
        default_connect: false,
      }).success,
    ).toBe(false);
});
