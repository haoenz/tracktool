import { afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import Database from "better-sqlite3";
import Pbf from "pbf";
import { Downloads } from "../../dist/node/infrastructure/maps/downloads.js";
import { TileCache } from "../../dist/node/infrastructure/maps/tile-cache.js";
import {
  MapResources,
  tileUrl,
  pythonJson,
} from "../../dist/node/infrastructure/maps/resources.js";
import { Transport } from "../../dist/node/infrastructure/maps/transport.js";
import { vectorLabelVersion } from "../../dist/node/infrastructure/maps/vector-labels.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .reverse()
      .map((f) => f()),
  );
});
async function temporary() {
  const p = await mkdtemp(path.join(os.tmpdir(), "tracktool-resources-"));
  cleanup.push(() => rm(p, { recursive: true, force: true }));
  return p;
}
const hash = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const vector = {
  tiles: ["https://offline.example/{z}/{x}/{y}.pbf"],
  vector_layers: [
    { id: "water", fields: {} },
    { id: "transportation", fields: { class: "String" } },
    { id: "landcover", fields: {} },
  ],
};
const tile = Buffer.from([26, 9, 10, 5, 119, 97, 116, 101, 114, 120, 2]);
it("fetches and caches regular and bold glyphs independently and rejects unsupported fonts", async () => {
  const folder = await temporary();
  const fetcher = vi.fn(async (url: string) =>
    Buffer.from([10, url.includes("Bold") ? 1 : 0]),
  );
  const resources = new MapResources(folder, { fetch: fetcher });
  try {
    expect(await resources.glyph("0-255")).toEqual(Buffer.from([10, 0]));
    expect(
      await resources.glyph("0-255", undefined, false, "Noto Sans Bold"),
    ).toEqual(Buffer.from([10, 1]));
    await resources.glyph("0-255", undefined, true, "Noto Sans Bold");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Bold/0-255.pbf",
    );
    await expect(
      resources.glyph("0-255", undefined, false, "../other"),
    ).rejects.toThrow("无效地图字体");
    await expect(
      resources.glyph("1-256", undefined, false, "Noto Sans Bold"),
    ).rejects.toThrow("无效字体范围");
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await resources.close();
  }
});
it("shares cached single-name tiles between browsing and export while retaining upstream bytes", async () => {
  const feature = new Pbf();
  feature.writePackedVarint(2, [0, 0, 1, 1, 2, 2]);
  feature.writeVarintField(3, 1);
  feature.writePackedVarint(4, [9, 20, 40]);
  const layer = new Pbf();
  layer.writeStringField(1, "place");
  layer.writeVarintField(15, 2);
  layer.writeBytesField(2, feature.finish());
  for (const key of ["name", "name:zh", "name:zh-Hans"])
    layer.writeStringField(3, key);
  for (const name of ["London", "伦敦;倫敦", "伦敦"]) {
    const value = new Pbf();
    value.writeStringField(1, name);
    layer.writeBytesField(4, value.finish());
  }
  const writer = new Pbf();
  writer.writeBytesField(3, layer.finish());
  const original = Buffer.from(writer.finish());
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith(".pbf") ? original : Buffer.from(JSON.stringify(vector)),
  );
  const folder = await temporary();
  let r = new MapResources(folder, { fetch: fetcher });
  try {
    await r.prepare();
    expect((await r.tile("vector", 1, 0, 0)).data).toEqual(original);
    const displayed = await r.displayTile("vector", 1, 0, 0);
    expect(displayed.data).not.toEqual(original);
    expect(displayed.mime).toBe("application/x-protobuf");
    expect(displayed.data.includes(Buffer.from("tracktool:name"))).toBe(true);
    const key = hash(pythonJson([vectorLabelVersion, hash(original)]));
    expect(r.tiles.get(key)).toEqual(displayed.data);
    expect(
      (await r.displayTile("vector", 1, 0, 0, undefined, true)).data,
    ).toEqual(displayed.data);
    r.tiles.put(key, Buffer.from("broken derived tile"));
    expect((await r.displayTile("vector", 1, 0, 0)).data).toEqual(
      displayed.data,
    );
    expect((await r.tile("vector", 1, 0, 0)).data).toEqual(original);
    await expect(
      r.displayTile("vector", 1, 0, 0, undefined, false, "gcj02"),
    ).rejects.toThrow("不支持");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await r.close();
    r = new MapResources(folder, { fetch: fetcher });
    await r.prepare();
    expect((await r.displayTile("vector", 1, 0, 0)).data).toEqual(
      displayed.data,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await r.close();
  }
});
it("deduplicates downloads, independently cancels waiters and drops obsolete queued work", async () => {
  const d = new Downloads(1, { custom: 1 });
  let release!: (b: Buffer) => void;
  const run = vi.fn(
    () =>
      new Promise<Buffer>((r) => {
        release = r;
      }),
  );
  const c = new AbortController();
  const a = d.load("a", "custom", run, c.signal);
  const b = d.load("a", "custom", run, undefined, true);
  c.abort();
  await expect(a).rejects.toThrow("取消");
  const queued = new AbortController();
  const never = vi.fn(async () => Buffer.from("never"));
  const n = d.load("n", "custom", never, queued.signal);
  queued.abort();
  await expect(n).rejects.toThrow();
  release(Buffer.from("ok"));
  await expect(b).resolves.toEqual(Buffer.from("ok"));
  expect(run).toHaveBeenCalledTimes(1);
  expect(never).not.toHaveBeenCalled();
  await d.close();
});
it("schedules exports without starving previews and enforces per-provider limits", async () => {
  const d = new Downloads(2, { a: 1, b: 1 }),
    order: string[] = [],
    releases: (() => void)[] = [];
  const run = (id: string) => () =>
    new Promise<Buffer>((resolve) => {
      order.push(id);
      releases.push(() => resolve(Buffer.from(id)));
    });
  const jobs = [
    d.load("a1", "a", run("a1")),
    d.load("a2", "a", run("a2")),
    d.load("a3", "a", run("a3"), undefined, true),
    d.load("b1", "b", run("b1")),
  ];
  expect(order).toEqual(["a1", "b1"]);
  releases.splice(0).forEach((r) => r());
  await new Promise((r) => setTimeout(r, 0));
  expect(order).toContain("a3");
  releases.splice(0).forEach((r) => r());
  await new Promise((r) => setTimeout(r, 0));
  releases.splice(0).forEach((r) => r());
  await Promise.all(jobs);
  expect(order).toHaveLength(4);
  await d.close();
});
it("transactional disk LRU, replacement accounting, legacy import and reopen", async () => {
  const folder = await temporary();
  await writeFile(path.join(folder, `${"a".repeat(64)}.tile`), "old");
  let cache = new TileCache(folder, 7);
  expect(cache.get(`legacy:${"a".repeat(64)}`)?.toString()).toBe("old");
  cache.put("b", Buffer.from("1234"), 1);
  cache.put("c", Buffer.from("5678"), 2);
  expect(cache.get("b")).toBeUndefined();
  cache.put("c", Buffer.from("xy"));
  cache.close();
  cache = new TileCache(folder, 7);
  expect(cache.get("c")?.toString()).toBe("xy");
  cache.close();
});
it("uses Python cache identities, validates tiles, preserves attribution and hides source credentials", async () => {
  const folder = await temporary(),
    secret = "https://offline.example/planet?key=secret-value";
  const fetcher = vi.fn(async (url: string) =>
    url === secret ? Buffer.from(JSON.stringify(vector)) : tile,
  );
  const r = new MapResources(folder, {
    env: {
      TRACKTOOL_MAP_TILEJSON: secret,
      TRACKTOOL_MAP_VECTOR_ATTRIBUTION: "Fixture provider",
    },
    fetch: fetcher,
  });
  try {
    await r.prepare();
    r.tiles.put(
      hash(
        pythonJson([
          "tile-v2",
          "vector",
          "https://offline.example/1/0/0.pbf",
          256,
          vector,
        ]),
      ),
      tile,
    );
    expect((await r.tile("vector", 1, 0, 0)).data).toEqual(tile);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r.publicConfig())).not.toContain("secret-value");
    expect(r.publicConfig().customVectorAttribution).toBe("Fixture provider");
    await expect(
      r.validate("vector", Buffer.from("<html>error</html>")),
    ).rejects.toThrow("无效");
    await expect(r.validate("vector", Buffer.from([26, 255]))).rejects.toThrow(
      "无效",
    );
    const png = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await r.validate("osm-standard", png);
    await expect(
      r.validate("osm-standard", png.subarray(0, 40)),
    ).rejects.toThrow("无效");
    expect(() => r.checkText("路线 🦄")).toThrow("缺少字符");
    expect(() => r.checkText("中文路线")).not.toThrow();
  } finally {
    await r.close();
  }
});
it("matches TMS, quadkey, Galileo and Tencent addressing", () =>
  expect(
    tileUrl(
      {
        url: "https://a/{z}/{x}/{y}/{y_tms}/{quadkey}/{galileo}/{x16}/{y_tms16}",
      },
      3,
      5,
      2,
    ),
  ).toBe("https://a/3/5/2/5/121/G/0/0"));
it("retries transient HTTP failures, rejects redirects and railway rate limits cool down", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValue(new Response(tile));
  const t = new Transport(fetcher);
  expect(await t.fetch("https://test.example/tile")).toEqual(tile);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const redirect = new Transport(
    vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 302 })),
  );
  await expect(redirect.fetch("https://test.example/tile")).rejects.toThrow(
    "重定向",
  );
  const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 429 })),
    rail = new Transport(limited);
  await expect(
    rail.fetch("https://tiles.openrailwaymap.org/x"),
  ).rejects.toThrow("限流");
  await expect(
    rail.fetch("https://tiles.openrailwaymap.org/y"),
  ).rejects.toThrow("冷却");
  expect(limited).toHaveBeenCalledTimes(1);
});
it("fixed asset manifest references are bundled and verified", async () => {
  const assets = JSON.parse(
    await readFile("dist/maps/data/assets.json", "utf8"),
  ) as { files: Record<string, { sha256: string }> };
  for (const [file, value] of Object.entries(assets.files)) {
    expect(
      createHash("sha256")
        .update(await readFile(path.join("dist/maps", file)))
        .digest("hex"),
    ).toBe(value.sha256);
  }
});

it("keeps cached reads independent of recency write locks and retries failed touches", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
  const folder = await temporary(),
    cache = new TileCache(folder, 4096);
  const blocker = new Database(path.join(folder, "tiles.sqlite3"));
  try {
    for (let i = 0; i < 512; i++) cache.put(String(i), Buffer.from("x"), 1);
    blocker.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 512; i++)
      expect(cache.get(String(i))?.toString()).toBe("x");
    // The scheduled batch also fails without losing touches or breaking reads.
    await vi.advanceTimersByTimeAsync(0);
    expect(() => cache.flush()).toThrow(/locked/);
    expect(
      blocker.prepare("SELECT accessed FROM tiles WHERE key='511'").get(),
    ).toEqual({ accessed: 1 });
    blocker.exec("ROLLBACK");
    cache.flush();
    expect(
      blocker.prepare("SELECT count(*) n FROM tiles WHERE accessed=20").get(),
    ).toEqual({ n: 512 });
    cache.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
    vi.useRealTimers();
  }
});
it("closes the tile database and cancels scheduled work even if recency cannot flush", async () => {
  vi.useFakeTimers();
  const folder = await temporary(),
    cache = new TileCache(folder, 32);
  const blocker = new Database(path.join(folder, "tiles.sqlite3"));
  try {
    cache.put("a", Buffer.from("x"), 1);
    cache.get("a");
    blocker.exec("BEGIN IMMEDIATE");
    expect(() => cache.close()).toThrow(/locked/);
    expect(() => cache.get("a")).toThrow(/not open/);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
    vi.useRealTimers();
  }
});
it.each(["legacy", "current"])(
  "discards malformed %s raster cache entries and fetches valid replacements",
  async (kind) => {
    const png = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const fetcher = vi.fn(async () => png),
      r = new MapResources(await temporary(), { env: {}, fetch: fetcher });
    const source = "osm-standard",
      preset = r.presets[source]!,
      url = tileUrl(preset, 1, 0, 0);
    const key = hash(
      pythonJson(["tile-v2", source, url, preset.tile_size, preset]),
    );
    const oldKey = `legacy:${hash(url)}`;
    try {
      r.tiles.put(
        kind === "legacy" ? oldKey : key,
        Buffer.from("<html>upstream error</html>"),
      );
      expect((await r.tile(source, 1, 0, 0)).data).toEqual(png);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(r.tiles.get(oldKey)).toBeUndefined();
      expect((await r.tile(source, 1, 0, 0)).data).toEqual(png);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await r.close();
    }
  },
);
it("fully validates legacy raster pixels even when their headers are readable", async () => {
  const png = await sharp({
    create: { width: 256, height: 256, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  // PNG metadata is intact, but the IDAT stream is truncated.
  const broken = png.subarray(0, png.length - 30);
  expect((await sharp(broken).metadata()).width).toBe(256);
  const fetcher = vi.fn(async () => png),
    r = new MapResources(await temporary(), { env: {}, fetch: fetcher });
  const source = "osm-standard",
    url = tileUrl(r.presets[source]!, 1, 0, 0);
  try {
    r.tiles.put(`legacy:${hash(url)}`, broken);
    expect((await r.tile(source, 1, 0, 0)).data).toEqual(png);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await r.close();
  }
});
