import { afterEach, expect, it, vi } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
import { withDocument } from "../../dist/node/infrastructure/xml/document.js";
import { KmlService } from "../../dist/node/services/kml-service.js";
import { LocalKmlFiles } from "../../dist/node/infrastructure/kml-files.js";
import { GoogleElevation } from "../../dist/node/infrastructure/elevation.js";
import { DEFAULTS } from "../../dist/node/domain/config.js";
import { createContext } from "../../dist/node/services/context.js";
import expected from "./fixtures/m4/python.json";
const raw = readFileSync(
  new URL("./fixtures/m4/2026-10-01 轨迹.kml", import.meta.url),
);
const pools: XmlWorkers[] = [];
const dirs: string[] = [];
function pool() {
  const p = new XmlWorkers();
  pools.push(p);
  return p;
}
function tmp() {
  const d = mkdtempSync(path.join(os.tmpdir(), "tracktool-m4-edit-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(pools.map((p) => p.close()));
  pools.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
export function summary(bytes: Uint8Array) {
  return withDocument(bytes, (doc) =>
    Object.fromEntries(
      Object.entries({
        names: "//kml:name/text()",
        coords: "//gx:coord/text()",
        whens: "//kml:when/text()",
        lines: "//kml:LineString/kml:coordinates/text()",
        opaque: "//custom:opaque/text()",
        tags: '//kml:Data[@name="TrackTags"]/kml:value/text()',
        descriptions: "//kml:description/text()",
        ids: "//kml:LineString/@id | //kml:MultiGeometry/@id",
      }).map(([key, xpath]) => [
        key,
        doc
          .find(xpath, {
            kml: "http://www.opengis.net/kml/2.2",
            gx: "http://www.google.com/kml/ext/2.2",
            custom: "urn:custom",
          })
          .map((n) => n.content),
      ]),
    ),
  );
}
it("matches Python content, nearest microsecond split and WGS84 drift removal", async () => {
  const p = pool();
  expect((await p.run(raw, { kind: "content" })).content).toEqual(
    expected.content,
  );
  const split = (
    await p.run(raw, {
      kind: "edit",
      operation: {
        kind: "split",
        stem: "2026-10-01 轨迹",
        points: ["2026-10-01T00:00:01.400000Z"],
        auto: false,
        gapSeconds: 300,
        gapMeters: 500,
      },
    })
  ).edit!;
  expect(split.outputs.map((o) => summary(Buffer.from(o.xml)))).toEqual(
    expected.split,
  );
  const prune = (
    await p.run(raw, {
      kind: "edit",
      operation: {
        kind: "prune",
        stem: "2026-10-01 轨迹",
        points: [],
        auto: true,
        speedMps: 30,
        jumpMeters: 100,
        returnMeters: 30,
        maxSeconds: 120,
      },
    })
  ).edit!;
  expect(prune.count).toBe(1);
  expect(summary(Buffer.from(prune.outputs[0]!.xml))).toEqual(expected.prune);
});
it("auto split retains each original point exactly once, last-point split fails", async () => {
  const p = pool();
  const op = {
    kind: "split" as const,
    stem: "test",
    points: [],
    auto: true,
    gapSeconds: 300,
    gapMeters: 500,
  };
  const result = (await p.run(raw, { kind: "edit", operation: op })).edit!;
  expect(
    result.outputs.map((o) => summary(Buffer.from(o.xml)).coords!.length),
  ).toEqual([3, 2]);
  await expect(
    p.run(raw, {
      kind: "edit",
      operation: {
        ...op,
        auto: false,
        points: ["2026-10-01T00:10:04.000001Z"],
      },
    }),
  ).rejects.toThrow("last point");
});
it("set-tag preserves custom namespaces, CDATA, and creates a missing tag only explicitly", async () => {
  const p = pool();
  const result = (
    await p.run(raw, {
      kind: "edit",
      operation: { kind: "set-tag", tag: "徒步", create: false },
    })
  ).edit!.outputs[0]!.xml;
  expect(result).toContain("<![CDATA[a<b & c]]>");
  expect(summary(Buffer.from(result)).tags).toEqual(["徒步"]);
  expect(summary(Buffer.from(result)).opaque).toEqual(["untouched"]);
  const empty = Buffer.from(
    '<k:kml xmlns:k="http://www.opengis.net/kml/2.2"><k:Document><k:name>N</k:name></k:Document></k:kml>',
  );
  await expect(
    p.run(empty, {
      kind: "edit",
      operation: { kind: "set-tag", tag: "火车", create: false },
    }),
  ).rejects.toThrow("create-tag");
  const created = (
    await p.run(empty, {
      kind: "edit",
      operation: { kind: "set-tag", tag: "火车", create: true },
    })
  ).edit!.outputs[0]!.xml;
  expect(summary(Buffer.from(created)).tags).toEqual(["火车"]);
});
it("altitude excludes a whole Placemark if any segment has elevation; multigeom preserves styles", async () => {
  const input = Buffer.from(
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>D</name><Style id="s"><LineStyle><width>4</width></LineStyle></Style><Placemark><name>A</name><MultiGeometry><LineString><coordinates>100,26,0</coordinates></LineString><LineString><coordinates>101,27,2</coordinates></LineString></MultiGeometry></Placemark><Placemark><name>B</name><LineString><coordinates>102,28 103,29,-0</coordinates></LineString></Placemark></Document></kml>',
  );
  const p = pool();
  expect(
    (
      await p.run(input, {
        kind: "edit",
        operation: { kind: "altitude-targets" },
      })
    ).edit!.locations,
  ).toEqual([
    [28, 102],
    [29, 103],
  ]);
  const result = (
    await p.run(input, {
      kind: "edit",
      operation: { kind: "altitude-apply", values: [12.34, null] },
    })
  ).edit!;
  expect(summary(Buffer.from(result.outputs[0]!.xml)).lines).toEqual([
    "100,26,0",
    "101,27,2",
    "102,28,12.34 103,29,0",
  ]);
  const converted = (
    await p.run(input, { kind: "edit", operation: { kind: "to-multigeom" } })
  ).edit!.outputs[0]!.xml;
  expect(converted).toContain('id="s"');
  expect(summary(Buffer.from(converted)).ids).toEqual(["B"]);
});
it("plan mode never writes, moves or calls Google; edits reject changed originals", async () => {
  const dir = tmp(),
    file = path.join(dir, "2026-10-01 轨迹.kml");
  writeFileSync(file, raw);
  const api = { get: vi.fn() },
    archive = { execute: vi.fn() },
    files = new LocalKmlFiles(),
    p = pool();
  const s = new KmlService(files, p, archive, api),
    ctx = createContext({ config: DEFAULTS, mode: "plan" });
  await s.edit(ctx, file, { kind: "set-tag", tag: "徒步", create: false });
  await s.archiveOperation(ctx, { kind: "recover", database: "missing" });
  await s.merge(
    ctx,
    [file],
    path.join(dir, "merged.kml"),
    "missing",
    "missing",
    false,
    false,
    [],
  );
  expect(readFileSync(file)).toEqual(raw);
  expect(existsSync(path.join(dir, "merged.kml"))).toBe(false);
  expect(archive.execute).not.toHaveBeenCalled();
  writeFileSync(
    file,
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>1,2,0</coordinates></LineString></Placemark></kml>',
  );
  await s.fillAltitude(ctx, file, "");
  expect(api.get).not.toHaveBeenCalled();
  const source = await files.read(file);
  writeFileSync(file, "changed");
  await expect(
    files.write(file, "replacement", { expected: source.sha256 }),
  ).rejects.toThrow("changed");
  expect(readFileSync(file, "utf8")).toBe("changed");
});
it("Google batches at 512, aligns missing results and retries transport only without exposing secrets", async () => {
  const calls: string[] = [];
  const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({ status: "OK", results: [{ elevation: 12.345 }] }),
    );
  });
  const api = new GoogleElevation(request),
    signal = new AbortController().signal;
  const values = await api.get(
    Array.from({ length: 513 }, () => [1, 2]),
    "secret",
    signal,
  );
  expect(calls).toHaveLength(2);
  expect(values).toHaveLength(513);
  expect(values[0]).toBe(12.35);
  expect(values[1]).toBeNull();
  const fail = vi.fn(async () => {
    throw new Error("secret url");
  });
  await expect(
    new GoogleElevation(fail, async () => {}).get([[1, 2]], "secret", signal),
  ).rejects.toThrow("3 attempts");
  expect(fail).toHaveBeenCalledTimes(3);
  const denied = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ status: "REQUEST_DENIED", error_message: "secret" }),
      ),
  );
  await expect(
    new GoogleElevation(denied).get([[1, 2]], "secret", signal),
  ).rejects.toThrow("REQUEST_DENIED");
  expect(denied).toHaveBeenCalledTimes(1);
  const abort = new AbortController();
  abort.abort();
  await expect(api.get([[1, 2]], "secret", abort.signal)).rejects.toMatchObject(
    { code: "CANCELLED" },
  );
});
it("Google elevation rounding matches Python ties-to-even and binary64 decimals", async () => {
  const elevations = [0.125, 0.375, -0.125, -0.375, 2.675, 12.345];
  const api = new GoogleElevation(
    async () =>
      new Response(
        JSON.stringify({
          status: "OK",
          results: elevations.map((elevation) => ({ elevation })),
        }),
      ),
  );
  expect(
    await api.get(
      elevations.map(() => [1, 2]),
      "key",
      new AbortController().signal,
    ),
  ).toEqual([0.12, 0.38, -0.12, -0.38, 2.67, 12.35]);
});
