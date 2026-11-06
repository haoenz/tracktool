import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
import { MapResources } from "../../dist/node/infrastructure/maps/resources.js";
import { createApp } from "../../dist/node/server/app.js";

it("validates, persists and applies cache settings without downloading map resources", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tracktool-cache-settings-"),
  );
  const store = new FileConfigStore({ path: path.join(dir, "config.json") });
  const fetcher = vi.fn(async () => {
    throw new Error("unexpected network request");
  });
  let resources: MapResources | undefined;
  const start = async () => {
    const app = await createApp({
      configStore: store,
      token: "test",
      maps: {
        cache: dir,
        resources: () =>
          (resources = new MapResources(dir, { env: {}, fetch: fetcher })),
      },
      work: { stateDir: path.join(dir, "work"), roots: [dir] },
    });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    return {
      app,
      call: (body?: unknown, token = "test") =>
        fetch(`${base}/api/settings/tile-cache`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "X-Tracktool-Token": token,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
    };
  };
  vi.stubEnv("TRACKTOOL_MAP_CACHE_MIB", undefined);
  let server = await start();
  try {
    expect(await (await server.call()).json()).toEqual({
      capacityMiB: 1024,
      readOnly: false,
    });
    for (const capacityMiB of [0, -1, 1.5, 16385, "512", null])
      expect((await server.call({ capacityMiB })).status).toBe(400);
    expect((await server.call({ capacityMiB: 1 }, "wrong")).status).toBe(403);
    expect(
      (await server.call({ capacityMiB: 2, archive_path: dir })).status,
    ).toBe(400);
    expect((await server.call({ capacityMiB: 2 })).status).toBe(200);
    resources!.tiles.put("a", Buffer.alloc(700_000), 1);
    resources!.tiles.put("b", Buffer.alloc(700_000), 2);
    const set = vi
      .spyOn(store, "set")
      .mockRejectedValueOnce(new Error("write failed"));
    expect((await server.call({ capacityMiB: 1 })).status).toBe(500);
    expect(resources!.tiles.get("a")).toBeDefined();
    set.mockRestore();
    expect((await server.call({ capacityMiB: 1 })).status).toBe(200);
    expect(resources!.tiles.get("a")).toBeDefined();
    expect(resources!.tiles.get("b")).toBeUndefined();
    expect((await store.load()).map_cache_mib).toBe(1);
    const resize = vi
      .spyOn(resources!.tiles, "setCapacity")
      .mockImplementationOnce(() => {
        throw new Error("cache write failed");
      });
    expect((await server.call({ capacityMiB: 2 })).status).toBe(500);
    expect((await store.load()).map_cache_mib).toBe(1);
    resize.mockRestore();

    await server.app.close();
    server = await start();
    expect(await (await server.call()).json()).toEqual({
      capacityMiB: 1,
      readOnly: false,
    });
    vi.stubEnv("TRACKTOOL_MAP_CACHE_MIB", "64");
    expect(await (await server.call()).json()).toEqual({
      capacityMiB: 64,
      readOnly: true,
    });
    expect((await server.call({ capacityMiB: 2 })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await server.app.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
