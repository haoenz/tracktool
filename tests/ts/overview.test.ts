import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deflateSync, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import {
  SCHEMA,
  MIGRATE_1,
} from "../../dist/node/infrastructure/archive/schema.js";
import { OverviewService } from "../../dist/node/infrastructure/overview/service.js";
import { buildOverview } from "../../dist/node/infrastructure/overview/build.js";
import {
  fingerprint,
  generation,
  readStamp,
} from "../../dist/node/infrastructure/overview/files.js";
import { LIMITS } from "../../dist/node/infrastructure/overview/types.js";
import {
  OverviewExtent,
  overviewFeatures,
  splitOverviewLine,
} from "../../dist/node/domain/overview.js";
import type {
  OverviewStatus,
  OverviewCrs,
} from "../../dist/node/shared/overview.js";
import { createApp } from "../../dist/node/server/app.js";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";

const require = createRequire(import.meta.url);
const decoderRequire = createRequire(require.resolve("vt-pbf"));
const Pbf = decoderRequire("pbf") as new (bytes: Uint8Array) => unknown;
const { VectorTile } = decoderRequire("@mapbox/vector-tile") as {
  VectorTile: new (pbf: unknown) => {
    layers: Record<
      string,
      {
        length: number;
        feature(i: number): {
          properties: Record<string, string | number>;
          loadGeometry(): { x: number; y: number }[][];
        };
      }
    >;
  };
};
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const kml = (lines: string[], name = "test") =>
  `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name><Placemark>${lines.map((line) => `<LineString><coordinates>${line}</coordinates></LineString>`).join("")}</Placemark></Document></kml>`;
function insert(db: Database.Database, id: string, xml: string) {
  const raw = Buffer.from(xml),
    sha = createHash("sha256").update(raw).digest("hex");
  db.prepare("INSERT OR IGNORE INTO kml_objects VALUES (?,?,?,?)").run(
    sha,
    "zlib",
    raw.length,
    deflateSync(raw),
  );
  db.prepare("INSERT INTO archive_entries VALUES (?,?,?,?,?)").run(
    id,
    `Default/${id}.kml`,
    sha,
    "Default",
    "2026-10-14",
  );
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-overview-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "archive.sqlite3"),
    cache = path.join(dir, "cache");
  const db = new Database(source);
  db.exec(SCHEMA);
  db.exec(MIGRATE_1);
  db.pragma("journal_mode=WAL");
  db.prepare(
    "INSERT INTO archive_meta(singleton,archive_id) VALUES (1,'fixture')",
  ).run();
  insert(db, "normal", kml(["116,39 116.1,39.1 116.2,39.05"]));
  insert(db, "tiny", kml(["116,39 116.0000001,39.0000001"]));
  insert(db, "seam", kml(["179.8,20 -179.7,21"]));
  insert(db, "single", kml(["116.03,39.03"]));
  insert(db, "broken", "<kml>");
  db.close();
  return { dir, source, cache };
}
function service(
  source: string,
  cache: string,
  options: ConstructorParameters<typeof OverviewService>[2] = {},
) {
  const s = new OverviewService(source, cache, { pollMs: 30, ...options });
  cleanup.push(() => s.close());
  return s;
}
async function until<T>(get: () => Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 400; i++) {
    const value = await get();
    if (done(value)) return value;
    await delay(20);
  }
  throw Error("overview timeout");
}
async function ready(
  s: OverviewService,
  crs: OverviewCrs = "wgs84",
  previous?: string | null,
) {
  return until(
    () => s.status(crs),
    (v) => {
      if (v.state === "error") throw Error(v.error);
      return !!v.version && !v.updating && v.version !== previous;
    },
  );
}
function decoded(bytes: Uint8Array) {
  const layer = new VectorTile(new Pbf(gunzipSync(bytes))).layers.tracks!;
  if (!layer) return [];
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i));
}
it("preserves segments, small-track identity, world wrapping and display-coordinate conversion", () => {
  const raw: [[number, number], [number, number]] = [
    [179.8, 20],
    [-179.7, 21],
  ];
  const parts = splitOverviewLine(raw);
  expect(parts).toHaveLength(2);
  expect(
    splitOverviewLine([
      [180, 0],
      [0, 0],
    ]),
  ).toEqual([
    [
      [180, 0],
      [0, 0],
    ],
  ]);
  expect(
    parts.every((line) =>
      line.every((p, i) => i === 0 || Math.abs(p[0] - line[i - 1]![0]) < 1),
    ),
  ).toBe(true);
  const features = overviewFeatures(
    "id",
    [
      raw,
      [[116, 39]],
      [
        [116, 39],
        [116.0000001, 39],
      ],
    ],
    "wgs84",
    "Flight",
  );
  expect(features.every((f) => f.properties.kind === "Flight")).toBe(true);
  expect(new Set(features.map((f) => f.properties.segmentId))).toEqual(
    new Set(["id:0", "id:1", "id:2"]),
  );
  expect(
    features
      .filter((f) => f.properties.segmentId === "id:2")
      .map((f) => f.properties.role),
  ).toEqual(["line", "point"]);
  const bounds = new OverviewExtent();
  bounds.add(overviewFeatures("seam", [raw], "wgs84"));
  expect(bounds.bounds()![2] - bounds.bounds()![0]).toBeCloseTo(0.5);
  expect(() => overviewFeatures("invalid", [[[120, 89]]], "wgs84")).toThrow(
    "纬度",
  );
  expect(() => overviewFeatures("empty", [], "wgs84")).toThrow("几何");
  expect(
    overviewFeatures("gcj", [[[116, 39]]], "gcj02")[0]!.geometry.coordinates,
  ).not.toEqual([116, 39]);
});
it("builds a complete decodable overview, reports bad entries, and never writes source indexes", async () => {
  const { source, cache } = await fixture(),
    before = await readFile(source),
    s = service(source, cache);
  const status = await ready(s);
  expect(status.summary).toEqual({
    entries: 5,
    valid: 4,
    invalid: 1,
    points: 8,
  });
  const manifest = await s.manifest(status.version!);
  expect(manifest.entries.find((e) => e.id === "broken")?.error).toBeTruthy();
  const tile = decoded(await s.tile(status.version!, 0, 0, 0));
  expect(
    tile.every(
      (f) =>
        f.properties.kind ===
        manifest.entries.find((e) => e.id === f.properties.trackId)?.kind,
    ),
  ).toBe(true);
  expect(new Set(tile.map((f) => f.properties.trackId))).toEqual(
    new Set(["normal", "tiny", "seam", "single"]),
  );
  expect(
    tile.some(
      (f) => f.properties.trackId === "tiny" && f.properties.role === "point",
    ),
  ).toBe(true);
  const detail = (await s.detail(status.version!, "seam")) as {
    geometry: { features: { geometry: { coordinates: number[][][] } }[] };
  };
  expect(detail.geometry.features[0]!.geometry.coordinates).toHaveLength(2);
  expect(await readFile(source)).toEqual(before);
  const db = new Database(source, { readonly: true });
  expect(db.prepare("SELECT count(*) AS n FROM kml_index").get()).toEqual({
    n: 0,
  });
  db.close();
});
it("pins a read snapshot across concurrent archive writes", async () => {
  const { source, cache } = await fixture(),
    stamp = readStamp(source);
  let wrote = false;
  const manifest = await buildOverview(
    {
      source,
      root: cache,
      stamp,
      crs: "wgs84",
      fingerprint: fingerprint(stamp, "wgs84"),
      budget: LIMITS.buildBytes,
    },
    () => {
      if (wrote) return;
      wrote = true;
      const db = new Database(source);
      insert(db, "later", kml(["120,30 121,31"]));
      db.close();
    },
  );
  expect(manifest.revision).toBe(stamp.revision);
  expect(manifest.entries.some((e) => e.id === "later")).toBe(false);
  expect(readStamp(source).revision).toBe(stamp.revision + 1);
});
it("detects CLI-style writes, retains old snapshot tiles and entries, and separates CRS versions", async () => {
  const { source, cache } = await fixture(),
    s = service(source, cache),
    a = await ready(s);
  const old = await s.tile(a.version!, 0, 0, 0);
  const db = new Database(source);
  insert(db, "later", kml(["120,30 121,31"]));
  db.close();
  const updating = await s.status("wgs84");
  expect(updating.version).toBe(a.version);
  expect(updating.updating).toBe(true);
  expect(await s.tile(a.version!, 0, 0, 0)).toEqual(old);
  const b = await ready(s, "wgs84", a.version);
  expect(b.summary?.entries).toBe(6);
  expect(
    (await s.manifest(a.version!)).entries.some((e) => e.id === "later"),
  ).toBe(false);
  expect(
    decoded(await s.tile(b.version!, 0, 0, 0)).some(
      (f) => f.properties.trackId === "later",
    ),
  ).toBe(true);
  const gcj = await ready(s, "gcj02");
  expect(gcj.version).not.toBe(b.version);
  expect(gcj.revision).toBe(b.revision);
  expect((await s.manifest(gcj.version!)).crs).toBe("gcj02");
});
it("restarts from a published manifest and ignores interrupted staging work", async () => {
  const { source, cache } = await fixture(),
    s = service(source, cache),
    a = await ready(s);
  await s.close();
  await mkdir(path.join(cache, "staging-orphan"));
  await writeFile(
    path.join(cache, "staging-orphan", "geometry.ndjson"),
    "partial",
  );
  const next = service(source, cache),
    b = await ready(next);
  expect(b.version).toBe(a.version);
  expect((await readdir(cache)).some((n) => n.startsWith("staging-"))).toBe(
    false,
  );
  expect(decoded(await next.tile(b.version!, 0, 0, 0)).length).toBeGreaterThan(
    0,
  );
});
it("rebuilds older tile formats to include categories without modifying the source library", async () => {
  const { source, cache } = await fixture();
  const before = await readFile(source);
  const old = service(source, cache);
  const a = await ready(old);
  await old.close();
  const file = path.join(generation(cache, a.version!), "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...manifest, format: 1 }));
  const next = service(source, cache);
  const b = await ready(next);
  expect(b.version).not.toBe(a.version);
  expect(
    decoded(await next.tile(b.version!, 0, 0, 0)).every(
      (f) => typeof f.properties.kind === "string",
    ),
  ).toBe(true);
  expect(await readFile(source)).toEqual(before);
});
it("keeps a published generation after a failed update and can explicitly retry", async () => {
  const { source, cache } = await fixture(),
    options = { pollMs: 30, buildBytes: LIMITS.buildBytes };
  const s = new OverviewService(source, cache, options);
  cleanup.push(() => s.close());
  const a = await ready(s);
  options.buildBytes = 1;
  const db = new Database(source);
  insert(db, "later", kml(["120,30 121,31"]));
  db.close();
  const failed = await until(
    () => s.status("wgs84"),
    (v) => v.state === "error",
  );
  expect(failed.version).toBe(a.version);
  expect(decoded(await s.tile(a.version!, 0, 0, 0)).length).toBeGreaterThan(0);
  options.buildBytes = LIMITS.buildBytes;
  await s.retry("wgs84");
  const b = await ready(s, "wgs84", a.version);
  expect(b.summary?.entries).toBe(6);
});
it("detects corrupt persisted geometry and repairs it without editing the archive", async () => {
  const { source, cache } = await fixture(),
    s = service(source, cache),
    a = await ready(s);
  await s.close();
  await writeFile(
    path.join(generation(cache, a.version!), "geometry.ndjson"),
    "[]\n",
  );
  const next = service(source, cache);
  await ready(next);
  await expect(next.tile(a.version!, 5, 26, 12)).rejects.toThrow("损坏");
  expect((await next.status("wgs84")).error).toContain("损坏");
  await next.retry("wgs84");
  const b = await ready(next, "wgs84", a.version);
  expect(decoded(await next.tile(b.version!, 0, 0, 0)).length).toBeGreaterThan(
    0,
  );
});
it("regenerates corrupt encoded tiles and rejects versions from a replaced library", async () => {
  const { source, cache } = await fixture(),
    s = service(source, cache),
    a = await ready(s);
  const expected = await s.tile(a.version!, 0, 0, 0);
  await s.close();
  await writeFile(
    path.join(generation(cache, a.version!), "tiles", "0-0-0.pbf.gz"),
    "bad tile",
  );
  const next = service(source, cache);
  expect(await next.tile(a.version!, 0, 0, 0)).toEqual(expected);
  await next.close();
  const db = new Database(source);
  db.exec("UPDATE archive_meta SET archive_id='replacement'");
  db.close();
  const replaced = service(source, cache);
  await expect(replaced.tile(a.version!, 0, 0, 0)).rejects.toThrow("过期");
  expect((await ready(replaced)).version).not.toBe(a.version);
});
it("reclaims retired generations under disk pressure and retains at most two revisions", async () => {
  const { source, cache } = await fixture(),
    s = service(source, cache);
  const a = await ready(s);
  const add = (id: string) => {
    const db = new Database(source);
    insert(db, id, kml(["120,30 121,31"]));
    db.close();
  };
  add("second");
  const b = await ready(s, "wgs84", a.version);
  const retiredBytes = (
    await stat(path.join(generation(cache, a.version!), "geometry.ndjson"))
  ).size;
  async function size(dir: string): Promise<number> {
    let bytes = 0;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      bytes += e.isDirectory() ? await size(f) : (await stat(f)).size;
    }
    return bytes;
  }
  const before = await size(cache);
  await s.cache.exclusive(() =>
    s.cache.room(s.cache.diskBytes - before + retiredBytes),
  );
  await expect(s.manifest(a.version!)).rejects.toThrow("过期");
  expect((await s.manifest(b.version!)).version).toBe(b.version);
  add("third");
  const c = await ready(s, "wgs84", b.version);
  add("fourth");
  await ready(s, "wgs84", c.version);
  expect(
    new Set([...s.cache.manifests.values()].map((m) => m.revision)).size,
  ).toBeLessThanOrEqual(2);
  await expect(s.manifest(b.version!)).rejects.toThrow("过期");
});
it("rejects concurrent cache ownership, releases locks on cancellation, and recovers stale locks", async () => {
  const { source, cache } = await fixture(),
    a = service(source, cache);
  await ready(a);
  const b = service(source, cache);
  expect((await b.status("wgs84")).error).toContain("另一个服务");
  await b.close();
  await a.retry("wgs84");
  await a.close();
  expect(
    (await readdir(cache)).some(
      (n) => n.startsWith("staging-") || n === "owner.json",
    ),
  ).toBe(false);
  await writeFile(
    path.join(cache, "owner.json"),
    JSON.stringify({ pid: 2147483647, owner: "dead" }),
  );
  const c = service(source, cache);
  expect((await ready(c)).version).toBeTruthy();
});
it("deduplicated tile requests survive one viewer aborting and recycle tiny index budgets", async () => {
  const { source, cache } = await fixture(),
    s = service(source, cache, { indexTiles: 1 }),
    a = await ready(s);
  const abort = new AbortController();
  const first = s.tile(a.version!, 10, 842, 390, abort.signal);
  const second = s.tile(a.version!, 10, 842, 390);
  abort.abort();
  await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
  const bytes = await second;
  expect(decoded(bytes)).toBeDefined();
  expect(await s.tile(a.version!, 10, 842, 390)).toEqual(bytes);
});
it("handles an empty archive and refuses insufficient disk reservation", async () => {
  const { source, cache } = await fixture(),
    db = new Database(source);
  db.exec("DELETE FROM archive_entries");
  db.close();
  const s = service(source, cache),
    status = await ready(s);
  expect(status.bounds).toBeNull();
  expect(status.summary?.entries).toBe(0);
  expect(decoded(await s.tile(status.version!, 0, 0, 0))).toEqual([]);
  const limited = service(source, path.join(cache, "limited"), {
    diskBytes: 1024,
  });
  expect(
    (
      await until(
        () => limited.status("wgs84"),
        (v) => v.state === "error",
      )
    ).error,
  ).toContain("空间");
});
it("authenticates overview routes and binds data to backend configuration", async () => {
  const { source, dir } = await fixture(),
    config = path.join(dir, "config.json");
  await writeFile(config, JSON.stringify({ archive_path: source }));
  const app = await createApp({
    configStore: new FileConfigStore({ path: config }),
    token: "overview-test",
    maps: { cache: path.join(dir, "http-cache") },
  });
  cleanup.push(() => app.close());
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const headers = { "X-Tracktool-Token": "overview-test" };
  expect((await fetch(base + "/api/overview")).status).toBe(403);
  expect(
    (
      await fetch(base + "/api/overview", {
        headers: { ...headers, Origin: "https://wrong.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(base + "/api/overview?path=/tmp/other.sqlite3", { headers }))
      .status,
  ).toBe(400);
  const status = await until(
    async () =>
      (await (
        await fetch(base + "/api/overview", { headers })
      ).json()) as OverviewStatus,
    (s) => s.state === "ready" && !s.updating,
  );
  const tileUrl =
    base +
    status.tiles!.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");
  expect((await fetch(tileUrl)).status).toBe(403);
  const tile = await fetch(tileUrl, { headers });
  expect(tile.status).toBe(200);
  expect(tile.headers.get("cache-control")).toBe("no-store");
  expect(tile.headers.get("content-type")).toContain("vector-tile");
  const raw = new VectorTile(new Pbf(new Uint8Array(await tile.arrayBuffer())));
  expect(raw.layers.tracks!.length).toBeGreaterThan(0);
  expect(
    (
      await fetch(base + `/api/overview/tiles/${status.version}/19/0/0.pbf`, {
        headers,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(base + `/api/overview/tiles/${status.version}/0/1/0.pbf`, {
        headers,
      })
    ).status,
  ).toBe(400);
  const list = (await (
    await fetch(
      base + `/api/overview/entries?version=${status.version}&limit=2`,
      { headers },
    )
  ).json()) as { total: number; entries: unknown[] };
  expect(list.total).toBe(5);
  expect(list.entries).toHaveLength(2);
  const filtered = (await (
    await fetch(
      base +
        `/api/overview/entries?version=${status.version}&ids=normal,tiny&kind=Default&q=tiny`,
      { headers },
    )
  ).json()) as { total: number; entries: { id: string }[] };
  expect(filtered.total).toBe(1);
  expect(filtered.entries[0]?.id).toBe("tiny");
  expect(
    (
      await fetch(
        base +
          `/api/overview/entries?version=${status.version}&ids=${Array(101).fill("normal").join(",")}`,
        { headers },
      )
    ).status,
  ).toBe(400);

  expect(
    (
      await fetch(
        base +
          `/api/overview/entries/normal/geometry?version=${status.version}`,
        { headers },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(base + `/api/overview/entries?version=${"0".repeat(32)}`, {
        headers,
      })
    ).status,
  ).toBe(400);
});
