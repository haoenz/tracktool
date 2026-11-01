import { pickBasemap, tool } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";
import { test, expect } from "@playwright/test";
import { resetDisplay } from "./display-reset.js";
import sharp from "sharp";
import type { MapState } from "../../src/shared/map-state.js";
import { printDocument } from "../../src/shared/print.js";
import type { Page } from "@playwright/test";
import type { MapConfig } from "../../src/shared/map.js";
async function call<T>(
  page: Page,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ url, body }) => {
      const token = document.querySelector<HTMLMetaElement>(
        'meta[name="tracktool-token"]',
      )!.content;
      const r = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "X-Tracktool-Token": token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as T };
    },
    { url, body },
  );
}

test.beforeEach(async ({ request }) => {
  await resetDisplay(request);
});

test("map labels and tracks retain readable screen sizes across resizing and print mode", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      config: MapConfig;
      state: MapState;
    };
    body.config.vectorLayers!.place = { name: "String", class: "String" };
    body.state.style.features.places = "all";
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map");
  await page.waitForFunction(() =>
    window.renderer?.map.getLayer("place-country"),
  );
  const sizes = () =>
    page.evaluate(() => {
      const r = window.renderer!;
      const scale =
        r.mapElement.getBoundingClientRect().width / r.mapElement.clientWidth;
      const width = Number(r.map.getPaintProperty("track-lines", "line-width"));
      const text = Number(
        r.map.getLayoutProperty("place-country", "text-size"),
      );
      const styleLayers = r.map.getStyle().layers;
      const countryMaxZoom = styleLayers.find(
        (layer) => layer.id === "place-country",
      )!.maxzoom!;
      const stateMinZoom = styleLayers.find(
        (layer) => layer.id === "place-state",
      )!.minzoom!;
      const overview = r.map
        .getStyle()
        .layers.find(
          (layer) =>
            layer.id.startsWith("overview-") && layer.id.endsWith("-line"),
        );
      const overviewWidth = overview
        ? r.map.getPaintProperty(overview.id, "line-width")
        : undefined;
      return {
        width,
        text,
        screenWidth: width * scale,
        screenText: text * scale,
        countryMaxZoom,
        stateMinZoom,
        screenCountryMaxZoom: countryMaxZoom + Math.log2(scale),
        screenStateMinZoom: stateMinZoom + Math.log2(scale),
        overviewWidth:
          overviewWidth === undefined
            ? undefined
            : Number(
                Array.isArray(overviewWidth)
                  ? overviewWidth.at(-1)
                  : overviewWidth,
              ) * scale,
        displayScale: r.displayScale,
      };
    });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 390, height: 600 },
    { width: 844, height: 390 },
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const multiplier = viewport.width <= 700 ? 1.2 : 1;
    await expect
      .poll(async () => (await sizes()).screenWidth)
      .toBeCloseTo(3 * multiplier, 1);
    expect((await sizes()).screenText).toBeCloseTo(22 * multiplier, 1);
    expect((await sizes()).screenCountryMaxZoom).toBeCloseTo(4.5, 2);
    expect((await sizes()).screenStateMinZoom).toBeCloseTo(4, 2);
  }
  await expect
    .poll(async () => (await sizes()).overviewWidth)
    .toBeCloseTo(3, 1);
  await page.evaluate(() => window.renderer!.retryResources());
  await page.waitForFunction(
    () =>
      window.renderer?.map.getLayer("track-lines") &&
      window.renderer.map.getLayer("place-country"),
  );
  await expect
    .poll(async () => (await sizes()).screenText)
    .toBeCloseTo(26.4, 1);
  expect((await sizes()).screenCountryMaxZoom).toBeCloseTo(4.5, 2);
  await tool(page, "出图");
  await expect.poll(async () => (await sizes()).displayScale).toBe(1);
  expect((await sizes()).width).toBe(3);
  expect((await sizes()).text).toBe(22);
  expect((await sizes()).countryMaxZoom).toBe(4.5);
  expect((await sizes()).stateMinZoom).toBe(4);
  await tool(page, "返回浏览");
  await expect
    .poll(async () => (await sizes()).screenWidth)
    .toBeCloseTo(3.6, 1);
  expect((await sizes()).screenText).toBeCloseTo(26.4, 1);
  expect((await sizes()).screenCountryMaxZoom).toBeCloseTo(4.5, 2);
});

test("missing tiles, missing fonts and unsupported title glyphs block print export", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/map");
  await tool(page, "地图样式");
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
  const bootstrap = await call<{ state: MapState; initialArchive: string }>(
    page,
    "/api/bootstrap",
  );
  const document = printDocument(
    bootstrap.body.state,
    bootstrap.body.initialArchive,
    [],
  );
  for (const mode of ["tiles", "font"]) {
    await call(page, "/api/test/fault", { mode });
    try {
      const submitted = await call<{ job: string }>(page, "/api/print", {
        document,
      });
      expect(submitted.status).toBe(200);
      await expect
        .poll(
          async () =>
            (
              await call<{ status: string }>(
                page,
                `/api/jobs/${submitted.body.job}`,
              )
            ).body.status,
          { timeout: 90_000 },
        )
        .toBe("failed");
      expect(
        (await call(page, `/api/jobs/${submitted.body.job}/png`)).status,
      ).toBe(400);
    } finally {
      await call(page, "/api/test/fault", { mode: "" });
    }
  }
  expect(
    (
      await call(page, "/api/print", {
        document: { ...document, title: "无法出图 🦄" },
      })
    ).status,
  ).toBe(400);
});
test("rapid source changes only commit the latest choice", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/map");
  await tool(page, "地图样式");
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
  let release!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => {
    started = r;
  });
  await page.route("**/api/basemap-check", async (route) => {
    started();
    await waiting;
    await route.fulfill({ json: { ok: true } });
  });
  const { body: bootstrap } = await call<{
    config: { basemaps: { id: string; name: string; group: string }[] };
  }>(page, "/api/bootstrap");
  const bing = bootstrap.config.basemaps.find((b) => b.id.startsWith("bing-"))!;
  const later = bootstrap.config.basemaps.find((b) => b.id === "amap-road")!;
  await pickBasemap(page, bing.id);
  await startedPromise;
  expect(await page.evaluate(() => window.renderer?.state.style.basemap)).toBe(
    "vector",
  );
  await pickBasemap(page, later.id);
  // Both switches are still waiting for their source check: nothing commits
  // until the checks settle, then only the latest choice applies.
  expect(await page.evaluate(() => window.renderer?.state.style.basemap)).toBe(
    "vector",
  );
  const completed = page.waitForResponse("**/api/basemap-check");
  release();
  await completed;
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.style.basemap), {
      timeout: 20000,
    })
    .toBe("amap-road");
});
test("reselecting the applied basemap cancels a pending switch", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/map");
  await tool(page, "地图样式");
  let release!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => {
    started = r;
  });
  await page.route("**/api/basemap-check", async (route) => {
    started();
    await waiting;
    await route.fulfill({ json: { ok: true } });
  });
  const { body: bootstrap } = await call<{
    config: { basemaps: { id: string; name: string; group: string }[] };
  }>(page, "/api/bootstrap");
  const bing = bootstrap.config.basemaps.find((b) => b.id.startsWith("bing-"))!;
  await pickBasemap(page, bing.id);
  await startedPromise;
  await pickBasemap(page, "vector");
  expect(await page.evaluate(() => window.renderer?.state.style.basemap)).toBe(
    "vector",
  );
  const completed = page.waitForResponse("**/api/basemap-check");
  release();
  await completed;
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.style.basemap))
    .toBe("vector");
});
test("browse display style survives a reload", async ({ page }) => {
  await page.goto("/map");
  await tool(page, "地图样式");
  const roads = page
    .getByRole("radiogroup", { name: "道路", exact: true })
    .first();
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/api/display") && response.ok(),
  );
  await roads.getByRole("radio", { name: "主干道路", exact: true }).check();
  await expect
    .poll(() =>
      page.evaluate(() => window.renderer?.state.style.features.roads),
    )
    .toBe("major");
  await saved;
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => window.renderer?.state.style.features.roads),
    )
    .toBe("major");
});
test("failed source retains the current map; a later source wins and camera/style changes avoid loading detailed geometry", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let geometryRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/geometry")) geometryRequests++;
  });
  await page.goto("/map");
  await tool(page, "地图样式");
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
  const config = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="tracktool-token"]',
    )!.content;
    return (
      await (
        await fetch("/api/bootstrap", {
          headers: { "X-Tracktool-Token": token },
        })
      ).json()
    ).config as { basemaps: { id: string; name: string; group: string }[] };
  });
  const google = config.basemaps.find((b) => b.id.startsWith("google-"))!;
  const esri = config.basemaps.find((b) => b.id === "esri-satellite")!;
  await pickBasemap(page, google.id);
  await expect(page.locator(".settings-panel [role=alert]")).toContainText(
    "失败：",
  );
  expect(await page.evaluate(() => window.renderer?.state.style.basemap)).toBe(
    "vector",
  );
  await pickBasemap(page, esri.id);
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.style.basemap), {
      timeout: 20000,
    })
    .toBe("esri-satellite");
  await expect(page.getByLabel("标题", { exact: true })).not.toBeVisible();
  expect(geometryRequests).toBe(0);
});
test("map icons directly toggle panels on desktop and mobile", async ({
  page,
}) => {
  await page.goto("/map");
  const tracks = page.locator(".app-icon");
  const settings = page.getByRole("button", { name: "设置", exact: true });
  const panel = page.getByLabel("地图控制面板", { exact: true });
  const nav = page.getByRole("navigation", { name: "地图工具", exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(panel).toBeHidden();
    await expect(nav).toBeHidden();
    await tracks.click();
    await expect(panel).toBeHidden();
    await expect(nav.getByRole("button")).toHaveCount(4);
    await expect(page.locator(".map-header")).not.toContainText(
      /轨迹|设置|浏览地图/,
    );
    await nav
      .getByRole("button", { name: "打开轨迹列表", exact: true })
      .click();
    await expect(page.getByLabel("筛选轨迹", { exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "上传轨迹", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "轨迹库操作", exact: true }),
    ).toBeVisible();
    await nav.getByRole("button", { name: "导出轨迹", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "导出类型", exact: true }),
    ).toBeVisible();
    await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    const bounds = await settings.boundingBox();
    expect(bounds!.x + bounds!.width).toBeGreaterThan(width - 24);
    await settings.click();
    await expect(panel).toBeHidden();
    await tracks.click();
    await expect(nav).toBeHidden();
  }
});

for (const [basemap, overlay] of [
  ["amap-satellite", "amap-labels"],
  ["esri-satellite", "amap-labels"],
] as const) {
  test(`${basemap} + ${overlay} keeps its canvas CRS and exports PNG`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.goto("/map");
    await tool(page, "地图样式");
    const names = await page.evaluate(
      ({ basemap, overlay }) => {
        const config = window.renderer!.config;
        const base = config.basemaps.find((b) => b.id === basemap)!;
        return {
          vendor: ["OSM", "memomaps", "OpenTopoMap", "OpenFreeMap"].includes(
            base.group,
          )
            ? "开放地图"
            : base.group,
          base: base.name,
          overlay: config.overlays.find((o) => o.id === overlay)!.name,
        };
      },
      { basemap, overlay },
    );
    // The badge describes the CRS relative to the current canvas, so check it
    // before switching the basemap (which derives a new canvas).
    await page.getByRole("button", { name: names.vendor, exact: true }).click();
    const baseButton = page.getByRole("button", {
      name: names.base,
      exact: true,
    });
    const baseHint = baseButton.getByText("GCJ-02", { exact: true });
    if (basemap === "amap-satellite") await expect(baseHint).toBeVisible();
    else await expect(baseHint).toHaveCount(0);
    await baseButton.click();
    await expect
      .poll(() => page.evaluate(() => window.renderer!.state.style.basemap), {
        timeout: 20000,
      })
      .toBe(basemap);
    const gcjCanvas = basemap === "amap-satellite";
    if (gcjCanvas) {
      await expect(
        page.getByRole("radiogroup", { name: "道路", exact: true }),
      ).toHaveCount(0);
    } else
      await expect(
        page.getByRole("radio", { name: "主干道路", exact: true }),
      ).toBeEnabled();
    const overlaySelect = page.getByRole("combobox", {
      name: "路网",
      exact: true,
    });
    await overlaySelect.click();
    const option = page.getByRole("option").filter({
      has: page.getByText(names.overlay, { exact: true }),
    });
    await expect(option).toBeEnabled();
    await option.click();
    await expect
      .poll(() =>
        page.evaluate((id) => !!window.renderer!.map.getSource(id), overlay),
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (
            await call<{ state: MapState }>(page, "/api/bootstrap")
          ).body.state.style.overlays.find((o) => o.id === overlay)?.enabled,
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.reload();
    await page.waitForFunction(
      (id) => !!window.renderer?.map.getSource(id),
      overlay,
    );
    const state = await page.evaluate(() =>
      structuredClone(window.renderer!.state),
    );
    state.camera = { center: [116.404, 39.915], zoom: 12 };
    state.output = { width: 960, height: 720 };
    const initialArchive = (
      await call<{ initialArchive: string }>(page, "/api/bootstrap")
    ).body.initialArchive;
    const submitted = await call<{ job: string }>(page, "/api/print", {
      document: printDocument(state, initialArchive, []),
    });
    expect(submitted.status).toBe(200);
    let result: { status: string; error?: string } | undefined;
    await expect
      .poll(
        async () => {
          result = (
            await call<{ status: string; error?: string }>(
              page,
              `/api/jobs/${submitted.body.job}`,
            )
          ).body;
          return ["done", "failed"].includes(result.status);
        },
        { timeout: 90000 },
      )
      .toBe(true);
    expect(result?.status, result?.error).toBe("done");
    const token = await page
      .locator('meta[name="tracktool-token"]')
      .getAttribute("content");
    const png = await page.request.get(`/api/jobs/${submitted.body.job}/png`, {
      headers: { "X-Tracktool-Token": token! },
    });
    expect(png.ok()).toBe(true);
    const data = await png.body();
    expect(await sharp(data).metadata()).toMatchObject({
      width: 960,
      height: 720,
    });
    await sharp(data).toFile(info.outputPath("mixed-coordinates.png"));
  });
}
