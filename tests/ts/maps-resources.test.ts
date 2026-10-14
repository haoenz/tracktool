import { afterEach, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Downloads } from "../../dist/node/infrastructure/maps/downloads.js";
import { TileCache } from "../../dist/node/infrastructure/maps/tile-cache.js";
import {
  MapResources,
  tileUrl,
  pythonJson,
} from "../../dist/node/infrastructure/maps/resources.js";
import { Transport } from "../../dist/node/infrastructure/maps/transport.js";
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
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const vector = {
  tiles: ["https://offline.example/{z}/{x}/{y}.pbf"],
  vector_layers: [
    { id: "water", fields: {} },
    { id: "transportation", fields: { class: "String" } },
    { id: "landcover", fields: {} },
  ],
};
const tile = Buffer.from([26, 9, 10, 5, 119, 97, 116, 101, 114, 120, 2]);
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
    await r.validate("satellite", png);
    await expect(r.validate("satellite", png.subarray(0, 40))).rejects.toThrow(
      "无效",
    );
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
