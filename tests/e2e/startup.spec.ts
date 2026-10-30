import { expect, test } from "@playwright/test";
import { resetDisplay } from "./display-reset.js";
import type {} from "../../src/drawing/globals.js";

declare global {
  interface Window {
    startupProbe: { release: () => void; blocked: () => number };
  }
}

test.beforeEach(async ({ request }) => {
  await resetDisplay(request);
});

for (const [width, colorScheme] of [
  [1280, "light"],
  [390, "dark"],
] as const) {
  test(`startup covers the viewport until the first paint at ${width}px without waiting for tiles`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(() => {
      const nativeFrame = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map<number, FrameRequestCallback>();
      let hold = true;
      // Hold renderer frames after its canvas mounts, while the browser can
      // still paint DOM and the test can inspect the otherwise fleeting gap.
      window.requestAnimationFrame = (callback) => {
        const id = nativeFrame((time) => {
          if (hold && document.querySelector(".maplibregl-canvas"))
            pending.set(id, callback);
          else callback(time);
        });
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        pending.delete(id);
        nativeCancel(id);
      };
      window.startupProbe = {
        blocked: () => pending.size,
        release: () => {
          hold = false;
          for (const callback of pending.values()) nativeFrame(callback);
          pending.clear();
        },
      };
    });
    let releaseBootstrap!: () => void;
    const bootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    let releaseTiles!: () => void;
    const tiles = new Promise<void>((resolve) => {
      releaseTiles = resolve;
    });
    await page.route("**/api/bootstrap", async (route) => {
      await bootstrap;
      await route.continue();
    });
    await page.route("**/tiles/**", async (route) => {
      await tiles;
      await route.continue();
    });
    try {
      await page.goto("/map");
      const startup = page.locator(".startup-screen");
      await expect(startup).toBeVisible();
      expect(await startup.boundingBox()).toEqual({
        x: 0,
        y: 0,
        width,
        height: 800,
      });
      await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
      releaseBootstrap();
      await expect
        .poll(() => page.evaluate(() => window.startupProbe.blocked()))
        .toBeGreaterThan(0);
      await expect(startup).toBeVisible();
      expect(await startup.boundingBox()).toEqual({
        x: 0,
        y: 0,
        width,
        height: 800,
      });
      expect(
        await page.evaluate(() =>
          document.elementFromPoint(1, 1)?.matches(".startup-screen"),
        ),
      ).toBe(true);
      await expect(page.locator(".map-app")).toHaveAttribute("inert", "");
      await page.screenshot({
        path: info.outputPath("before-first-paint.png"),
      });
      await page.evaluate(() => window.startupProbe.release());
      await expect(startup).toHaveCount(0);
      await expect(page.locator(".map-app")).not.toHaveAttribute("inert");
      expect(
        await page.evaluate(() => window.renderer!.map.areTilesLoaded()),
      ).toBe(false);
      // Slow resources must not prevent opening settings or changing a source.
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await expect(page.locator("#map-panel")).toBeVisible();
      releaseTiles();
      await expect(page.locator(".map-stage")).toHaveAttribute(
        "data-status",
        "ready",
      );
    } finally {
      releaseBootstrap();
      releaseTiles();
    }
  });
}

test("a failed initial basemap exposes retry instead of trapping the startup screen", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/tiles/vector/**", async (route) => {
    if (fail) await route.fulfill({ status: 503, body: "Unavailable" });
    else await route.continue();
  });
  await page.goto("/map");
  await expect(page.locator(".startup-screen")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重试地图", exact: true }),
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "重试地图", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重试地图", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".map-stage")).toHaveAttribute(
    "data-status",
    "ready",
  );
});
