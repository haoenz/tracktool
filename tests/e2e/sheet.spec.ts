import { test, expect, type Page, type Locator } from "@playwright/test";
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
  await expect(panel).toBeHidden();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(app).toHaveAttribute("data-sheet", "half");
  await handle.tap();
  await expect(app).toHaveAttribute("data-sheet", "full");
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

async function dragSheet(
  page: Page,
  target: Locator,
  distance: number,
  settle = true,
) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + distance, { steps: settle ? 8 : 1 });
  // Holding at the destination distinguishes a deliberate drag from a fling.
  if (settle) await page.waitForTimeout(130);
  await page.mouse.up();
}

test("slow drags snap back or dismiss, and title space also drags", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  const panel = page.locator("#map-panel");
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  const app = page.locator(".map-app");
  await expect(handle).toBeVisible();
  await dragSheet(page, handle, 80);
  await expect(panel).toBeVisible();
  await expect(app).toHaveAttribute("data-sheet", "half");
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(400);
  await dragSheet(
    page,
    panel.getByRole("heading", { name: "设置", exact: true }),
    260,
  );
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(app).toHaveAttribute("data-sheet", "half");
  await handle.press("End");
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(750);
  await dragSheet(page, handle, 680);
  await expect(panel).toBeHidden();
});

test("downward flings advance one stop and reopening starts at half height", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  const panel = page.locator("#map-panel");
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  await handle.press("End");
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(750);
  await dragSheet(page, handle, 100, false);
  await expect(page.locator(".map-app")).toHaveAttribute("data-sheet", "half");
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeLessThan(410);
  await dragSheet(page, handle, 100, false);
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await handle.press("End");
  await handle.press("Home");
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".map-app")).toHaveAttribute("data-sheet", "half");
});

test("header navigation, native content scrolling and cancelled drags do not dismiss", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  const panel = page.locator("#map-panel");
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await page.getByRole("button", { name: "返回设置", exact: true }).click();
  await expect(
    panel.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  const box = (await panel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
  await page.mouse.wheel(0, 300);
  await expect
    .poll(() => panel.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator(".map-app")).toHaveAttribute("data-sheet", "half");
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 22);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 300);
  await handle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(400);
});

test("keyboard closing works with reduced motion and restores toolbar focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/map?panel=settings");
  const panel = page.locator("#map-panel");
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  const settings = page.getByRole("button", { name: "设置", exact: true });
  for (const key of ["Home", "ArrowDown"]) {
    await handle.press(key);
    await expect(panel).toBeHidden();
    await expect(settings).toBeFocused();
    await settings.click();
    await expect(page.locator(".map-app")).toHaveAttribute(
      "data-sheet",
      "half",
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(handle).toBeHidden();
});

test("touch content scrolls while touch title dragging closes the sheet", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  const panel = page.locator("#map-panel");
  await page.getByRole("button", { name: "地图设置", exact: true }).tap();
  const session = await page.context().newCDPSession(page);
  async function swipe(x: number, y: number, distance: number) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 12; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + (distance * step) / 12 }],
      });
    }
    await page.waitForTimeout(130);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  const bounds = (await panel.boundingBox())!;
  await swipe(bounds.x + bounds.width - 5, bounds.y + bounds.height - 45, -180);
  await expect
    .poll(() => panel.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator(".map-app")).toHaveAttribute("data-sheet", "half");
  await panel.evaluate((el) => {
    el.scrollTop = 0;
  });
  const title = (await panel
    .getByRole("heading", { name: "地图设置", exact: true })
    .boundingBox())!;
  await swipe(title.x + title.width / 2, title.y + title.height / 2, 260);
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "设置", exact: true }).tap();
  await expect(page.locator(".map-app")).toHaveAttribute("data-sheet", "half");
  await session.detach();
});
