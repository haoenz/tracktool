import { test, expect } from "@playwright/test";
import sharp from "sharp";
import type {} from "../../src/drawing/globals.js";
import { resetDisplay } from "./display-reset.js";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe("high-density mobile map", () => {
  test.use({ deviceScaleFactor: 4, isMobile: true, colorScheme: "dark" });

  for (const bounds of [
    [100, 5, 110, 65],
    [179, -20, 181, 60],
  ] as const) {
    test(`first visit fits overview ${bounds.join(",")} into the visible screen and reload keeps the camera`, async ({
      page,
      request,
    }) => {
      await resetDisplay(request);
      await page.setViewportSize({ width: 360, height: 626 });
      await page.route("**/api/overview?crs=wgs84", async (route) => {
        const response = await route.fetch();
        const status = await response.json();
        await route.fulfill({ response, json: { ...status, bounds } });
      });
      await page.goto("/map?panel=none");
      await expect(
        page.locator('.map-stage[data-status="ready"]'),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(([west, south, east, north]) => {
            const renderer = window.renderer!;
            const canvas = renderer.mapElement.getBoundingClientRect();
            const scale = canvas.width / renderer.mapElement.clientWidth;
            const stage = document
              .querySelector(".map-stage")!
              .getBoundingClientRect();
            return [
              [west, north],
              [east, south],
            ].every(([lon, lat]) => {
              const center = renderer.map.getCenter().lng;
              const longitude = lon! + 360 * Math.round((center - lon!) / 360);
              const point = renderer.map.project([longitude, lat!]);
              const x = canvas.left + point.x * scale;
              const y = canvas.top + point.y * scale;
              return (
                x >= stage.left + 14 &&
                x <= stage.right - 14 &&
                y >= stage.top + 14 &&
                y <= stage.bottom - 14
              );
            });
          }, bounds),
        )
        .toBe(true);
      await page.evaluate(() => {
        window.renderer!.map.jumpTo({ center: [107, 25], zoom: 9 });
      });
      const camera = await page.evaluate(() => window.renderer!.state.camera);
      await page.reload();
      await expect(
        page.locator('.map-stage[data-status="ready"]'),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.renderer!.state.camera))
        .toEqual(camera);
    });
  }

  test("paints the lower viewport after rotation and panning", async ({
    page,
    request,
  }) => {
    await resetDisplay(request);
    await page.setViewportSize({ width: 360, height: 626 });
    await page.goto("/map?panel=none");
    await expect(page.locator('.map-stage[data-status="ready"]')).toBeVisible();

    for (const viewport of [
      { width: 360, height: 626 },
      { width: 626, height: 360 },
      { width: 360, height: 626 },
    ]) {
      await page.setViewportSize(viewport);
      const canvas = page.locator(".maplibregl-canvas");
      await expect
        .poll(async () => {
          const bounds = (await canvas.boundingBox())!;
          return (
            bounds.x <= 0 &&
            bounds.y <= 0 &&
            bounds.x + bounds.width >= viewport.width &&
            bounds.y + bounds.height >= viewport.height
          );
        })
        .toBe(true);
      const before = await page.evaluate(() => window.renderer!.state.camera);
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.down();
      await page.mouse.move(viewport.width / 2 + 50, viewport.height / 2 + 20, {
        steps: 5,
      });
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => window.renderer!.state.camera))
        .not.toEqual(before);
      await page.evaluate(() => window.renderer!.ready());

      // Layout bounds alone cannot detect a canvas clipped by the compositor.
      // Local vector fixtures are empty, so exposed pixels must show the map's
      // dark ground color all the way down, rather than the workspace beneath.
      const { data, info } = await sharp(
        await page.screenshot({ scale: "css" }),
      )
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (const fraction of [0.25, 0.5, 0.75, 0.9]) {
        const offset =
          (Math.floor(viewport.height * fraction) * info.width + 4) *
          info.channels;
        expect([...data.subarray(offset, offset + 3)]).toEqual([32, 44, 51]);
      }
    }
  });
});

test("mobile handle drags, snaps, cycles and keeps icon closing", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  const panel = page.getByRole("complementary", { name: "地图控制面板" });
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  const app = page.locator(".map-app");
  await expect(handle).toBeVisible();
  await expect(
    page.getByRole("button", { name: "半屏", exact: true }),
  ).toHaveCount(0);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 22);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 380, { steps: 12 });
  await page.mouse.up();
  await expect(app).toHaveAttribute("data-sheet", "collapsed");
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeLessThan(60);
  await handle.tap();
  await expect(app).toHaveAttribute("data-sheet", "half");
  await handle.press("End");
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(600);
  await panel.evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect(handle).toBeInViewport();
  await handle.press("ArrowDown");
  await expect(app).toHaveAttribute("data-sheet", "half");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(handle).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(handle).toBeHidden();
  await expect(panel).toBeVisible();
});
