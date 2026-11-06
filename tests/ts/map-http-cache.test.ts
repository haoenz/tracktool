import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
import { MapResources } from "../../dist/node/infrastructure/maps/resources.js";
import { createApp } from "../../dist/node/server/app.js";

it("caches versioned map resources, revalidates bytes and rejects stale versions and failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-http-cache-"));
  let template = "https://fixture.test/{z}/{x}/{y}.pbf";
  const resources = new MapResources(path.join(dir, "cache"), {
    env: {},
    fetch: async (url) => {
      if (url.includes("/planet"))
        return Buffer.from(
          JSON.stringify({
            tiles: [template],
            vector_layers: ["water", "transportation", "landcover"].map(
              (id) => ({ id }),
            ),
          }),
        );
      if (url.includes("/fonts/")) return Buffer.from([10, 0]);
      if (url.includes("/2/0/0")) throw new Error("瓦片加载失败");
      return Buffer.from([26, 9, 10, 5, 119, 97, 116, 101, 114, 120, 2]);
    },
  });
  const app = await createApp({
    token: "test",
    configStore: new FileConfigStore({ path: path.join(dir, "config.json") }),
    maps: { resources: () => resources, cache: path.join(dir, "cache") },
    work: { stateDir: path.join(dir, "work"), roots: [dir] },
  });
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    await resources.prepare();
    const version = resources.resourceVersion;
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    expect(resources.publicConfig().versions.map_resources).toBe(version);
    await resources.prepare(true);
    expect(resources.resourceVersion).toBe(version);
    for (const resource of [
      "/tiles/vector/0/0/0.pbf",
      "/glyphs/Noto%20Sans%20Regular/0-255.pbf",
    ]) {
      const url = `${base}${resource}?v=${version}`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "private, max-age=86400",
      );
      const etag = response.headers.get("etag")!;
      expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
      await response.arrayBuffer();
      const unchanged = await fetch(url, {
        headers: { "If-None-Match": `"other", ${etag}` },
      });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      expect(unchanged.headers.get("cache-control")).toBe(
        "private, max-age=86400",
      );
      const changed = await fetch(url, {
        headers: { "If-None-Match": '"other"' },
      });
      expect(changed.status).toBe(200);
      await changed.arrayBuffer();
      const unversioned = await fetch(base + resource);
      expect(unversioned.headers.get("cache-control")).toBe("no-store");
      await unversioned.arrayBuffer();
    }
    for (const resource of [
      `/tiles/vector/2/0/0.pbf?v=${version}`,
      `/tiles/vector/0/0/0.pbf?v=${"0".repeat(64)}`,
      `/tiles/vector/0/0/0.pbf?crs=gcj02&v=${version}`,
      `/glyphs/unsupported/0-255.pbf?v=${version}`,
    ]) {
      const response = await fetch(base + resource, {
        headers: { "If-None-Match": "*" },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("etag")).toBeNull();
      await response.text();
    }
    template = "https://other.test/{z}/{x}/{y}.pbf";
    await resources.prepare(true);
    expect(resources.resourceVersion).not.toBe(version);
    const old = await fetch(`${base}/tiles/vector/0/0/0.pbf?v=${version}`);
    expect(old.status).toBe(400);
    expect(old.headers.get("cache-control")).toBe("no-store");
    const next = resources.resourceVersion;
    resources.presets[Object.keys(resources.presets)[0]!]!.url += "?changed=1";
    await resources.prepare(true);
    expect(resources.resourceVersion).not.toBe(next);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
