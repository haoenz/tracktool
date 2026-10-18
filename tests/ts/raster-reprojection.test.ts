import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { reprojectGcjTile } from "../../src/infrastructure/maps/raster-reprojection.js";
import { MapResources } from "../../src/infrastructure/maps/resources.js";
import { defaultProject, ProjectSchema } from "../../src/shared/project.js";
import {
  effectiveFeatures,
  overlayReason,
  reconcileOverlays,
} from "../../src/drawing/layers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const pixel = (lon: number, lat: number, world: number) => [
  ((lon + 180) / 360) * world - 0.5,
  ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) /
    2) *
    world -
    0.5,
];
const solid = (size: number) =>
  sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 240, g: 30, b: 10, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();

it.each([256, 512])(
  "aligns a known Beijing control point at %i pixels without dark alpha fringes",
  async (size) => {
    const z = 18,
      world = 2 ** z * size;
    // Fixed control pair, independent of the resampling implementation.
    const [wx, wy] = pixel(116.404, 39.915, world) as [number, number];
    const [gx, gy] = pixel(116.41024449916938, 39.91640428150164, world) as [
      number,
      number,
    ];
    const x = Math.floor(wx / size),
      y = Math.floor(wy / size);
    const load = vi.fn(async (tx: number, ty: number) => {
      const data = Buffer.alloc(size * size * 4);
      for (let row = 0; row < size; row++)
        for (let col = 0; col < size; col++) {
          const alpha = Math.round(
            200 *
              Math.exp(
                -((tx * size + col - gx) ** 2 + (ty * size + row - gy) ** 2) /
                  18,
              ),
          );
          if (alpha) {
            data[(row * size + col) * 4] = 255;
            data[(row * size + col) * 4 + 3] = alpha;
          }
        }
      return sharp(data, { raw: { width: size, height: size, channels: 4 } })
        .png()
        .toBuffer();
    });
    // The control point is on a target tile edge; measure both tiles to include
    // the entire marker and exercise seamless sampling across that boundary.
    const image = Buffer.concat(
      await Promise.all(
        [y - 1, y].map(async (ty) =>
          sharp(await reprojectGcjTile(z, x, ty, size, load))
            .raw()
            .toBuffer(),
        ),
      ),
    );
    let mass = 0,
      cx = 0,
      cy = 0;
    for (let row = 0; row < size * 2; row++)
      for (let col = 0; col < size; col++) {
        const i = (row * size + col) * 4,
          a = image[i + 3]!;
        if (!a) continue;
        expect(image[i]).toBe(255);
        expect(image[i + 1]).toBe(0);
        mass += a;
        cx += col * a;
        cy += row * a;
      }
    expect(mass).toBeGreaterThan(1000);
    expect(Math.abs(cx / mass - (wx - x * size))).toBeLessThan(0.5);
    expect(Math.abs(cy / mass - (wy - (y - 1) * size))).toBeLessThan(0.5);
    expect(load.mock.calls.some(([tx, ty]) => tx !== x || ty !== y)).toBe(true);
  },
);

it.each([
  [2, 0, 0],
  [2, 3, 3],
])(
  "preserves pixels outside China, including world edges (%i/%i/%i)",
  async (z, x, y) => {
    const input = await solid(256),
      load = vi.fn(async () => input);
    const output = await reprojectGcjTile(z!, x!, y!, 256, load);
    expect(await sharp(output).raw().toBuffer()).toEqual(
      await sharp(input).raw().toBuffer(),
    );
    expect(load.mock.calls).toHaveLength(1);
  },
);

async function resources(fetcher: (url: string) => Promise<Buffer>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-reproject-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const r = new MapResources(dir, {
    root: path.resolve("dist/maps"),
    env: { TRACKTOOL_MAP_DOWNLOADS: "1" },
    fetch: fetcher,
  });
  cleanup.push(() => r.close());
  return r;
}

it("shares reprojection, isolates cancelled previews, caches separately and bypasses WGS84 sources", async () => {
  const input = await solid(256),
    fetcher = vi.fn(async () => input);
  const r = await resources(fetcher),
    cancel = new AbortController();
  const preview = r.displayTile(
    "amap-satellite",
    12,
    3372,
    1552,
    cancel.signal,
  );
  const exported = r.displayTile(
    "amap-satellite",
    12,
    3372,
    1552,
    undefined,
    true,
  );
  cancel.abort();
  await expect(preview).rejects.toThrow("取消");
  const result = await exported;
  expect(result.mime).toBe("image/png");
  expect(await sharp(result.data).raw().toBuffer()).toEqual(
    await sharp(input).raw().toBuffer(),
  );
  const calls = fetcher.mock.calls.length;
  expect(calls).toBeGreaterThan(1);
  expect((await r.displayTile("amap-satellite", 12, 3372, 1552)).data).toEqual(
    result.data,
  );
  expect(fetcher).toHaveBeenCalledTimes(calls);
  expect((await r.tile("amap-satellite", 12, 3372, 1552)).data).toEqual(input);
  expect((await r.displayTile("esri-satellite", 2, 0, 0)).data).toEqual(input);
  await expect(r.displayTile("amap-satellite", 19, 0, 0)).rejects.toThrow(
    "无效",
  );
  await expect(r.displayTile("amap-satellite", 2, 4, 0)).rejects.toThrow(
    "无效",
  );
  await expect(
    r.displayTile("amap-satellite", 2, 0, 0, cancel.signal),
  ).rejects.toThrow("取消");
});

it("rejects incomplete source mosaics and retries without caching a partial result", async () => {
  const input = await solid(256);
  let fail = true;
  const fetcher = vi.fn(async () => {
    if (fail) throw new Error("fixture unavailable");
    return input;
  });
  const r = await resources(fetcher);
  await expect(r.displayTile("amap-labels", 12, 3372, 1552)).rejects.toThrow(
    "fixture unavailable",
  );
  fail = false;
  expect((await r.displayTile("amap-labels", 12, 3372, 1552)).mime).toBe(
    "image/png",
  );
});

it("accepts mixed coordinate sources and OSM features while retaining content conflict checks", async () => {
  const r = await resources(async () => Buffer.alloc(0));
  const config = r.publicConfig();
  config.vectorLayers = { transportation: { class: "String" }, building: {} };
  const project = defaultProject();
  project.style.basemap = "amap-satellite";
  project.style.overlays = [
    "openrailwaymap-standard",
    "openinframap-power",
  ].map((id) => ({ id, enabled: true, opacity: 1 }));
  expect(ProjectSchema.safeParse(project).success).toBe(true);
  expect(reconcileOverlays(project, config)).toEqual([]);
  expect(effectiveFeatures(project, config).roads).toBe("all");
  expect(effectiveFeatures(project, config).buildings).toBe("all");
  project.style.basemap = "esri-satellite";
  project.style.overlays = [{ id: "amap-labels", enabled: true, opacity: 1 }];
  expect(ProjectSchema.safeParse(project).success).toBe(true);
  expect(reconcileOverlays(project, config)).toEqual([]);
  project.style.basemap = "osm-standard";
  expect(ProjectSchema.safeParse(project).success).toBe(false);
  expect(
    overlayReason(
      project,
      config,
      config.overlays.find((o) => o.id === "amap-labels")!,
    ),
  ).toContain("同类内容");
});
