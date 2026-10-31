import { expect, test, type Page } from "@playwright/test";
import type {} from "../../src/drawing/globals.js";
import { displayCoordinate } from "../../src/shared/coordinates.js";
import { resetDisplay } from "./display-reset.js";
import { pickBasemap, tool } from "./map-tools.js";

async function expectLocation(page: Page, position: [number, number]) {
  const marker = page.getByRole("img", { name: "定位位置" });
  await expect(marker).toBeVisible();
  const crs = await page.evaluate(() => window.renderer!.crs);
  const coordinate = displayCoordinate(position, crs);
  await expect
    .poll(() =>
      page.evaluate((coordinate) => {
        const renderer = window.renderer!;
        coordinate[0] +=
          360 *
          Math.round((renderer.map.getCenter().lng - coordinate[0]) / 360);
        const point = renderer.map.project(coordinate);
        const canvas = renderer.mapElement.getBoundingClientRect();
        const scale = canvas.width / renderer.mapElement.clientWidth;
        const marker = document
          .querySelector(".map-location-marker")!
          .getBoundingClientRect();
        return Math.hypot(
          marker.left + marker.width / 2 - canvas.left - point.x * scale,
          marker.top + marker.height / 2 - canvas.top - point.y * scale,
        );
      }, coordinate),
    )
    .toBeLessThan(1);
  expect((await marker.boundingBox())!.width).toBeCloseTo(16, 0);
}

test.beforeEach(async ({ request }) => {
  await resetDisplay(request);
});

for (const [basemap, longitude, latitude] of [
  ["vector", 116.404, 39.915],
  ["amap-satellite", 116.404, 39.915],
  ["vector", -179.999, -16.5],
] as const) {
  test(`GPS location centers ${basemap} at ${longitude}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ longitude, latitude });
    await page.goto("/map");
    await page.waitForFunction(() => !!window.renderer);
    await expect(page.getByRole("img", { name: "定位位置" })).toBeHidden();
    if (basemap !== "vector") {
      await tool(page, "地图样式");
      await pickBasemap(page, basemap);
      await expect
        .poll(() => page.evaluate(() => window.renderer?.state.style.basemap), {
          timeout: 20_000,
        })
        .toBe(basemap);
      await page.getByRole("button", { name: "设置", exact: true }).click();
    }
    await page.getByRole("button", { name: "GPS 定位", exact: true }).click();
    const crs = basemap === "amap-satellite" ? "gcj02" : "wgs84";
    const position = displayCoordinate([longitude, latitude], crs);
    await expect
      .poll(() =>
        page.evaluate((position) => {
          const renderer = window.renderer!;
          const point = renderer.map.project(position);
          const canvas = renderer.mapElement.getBoundingClientRect();
          const stage = document
            .querySelector(".map-stage")!
            .getBoundingClientRect();
          const scale = canvas.width / renderer.mapElement.clientWidth;
          return Math.hypot(
            canvas.left + point.x * scale - (stage.left + stage.width / 2),
            canvas.top + point.y * scale - (stage.top + stage.height / 2),
          );
        }, position),
      )
      .toBeLessThan(2);
    await expect(page.getByRole("button", { name: "GPS 定位" })).toBeEnabled();
    await expectLocation(page, [longitude, latitude]);
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLDivElement>(".map-stage")!;
      stage.scrollTo(100, 30);
    });
    await expectLocation(page, [longitude, latitude]);
    await page.evaluate(() => {
      const map = window.renderer!.map;
      map.panBy([120, 80], { duration: 0 });
      map.zoomTo(map.getZoom() - 1, { duration: 0 });
    });
    await expectLocation(page, [longitude, latitude]);
    if (longitude < -179) {
      await page.evaluate(() =>
        window.renderer!.map.jumpTo({ center: [179.999, -16.5], zoom: 14 }),
      );
      await expectLocation(page, [longitude, latitude]);
    }
  });
}

for (const [code, message] of [
  [1, "定位权限被拒绝"],
  [2, "暂时无法获取当前位置"],
  [3, "定位超时"],
] as const) {
  test(`GPS failure ${code} shows a message and allows retry`, async ({
    page,
  }) => {
    await page.addInitScript((code) => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition: (
            _success: PositionCallback,
            error: PositionErrorCallback,
          ) => {
            setTimeout(() => error({ code } as GeolocationPositionError), 250);
          },
        },
      });
    }, code);
    await page.goto("/map");
    const button = page.getByRole("button", { name: "GPS 定位", exact: true });
    await button.click();
    await expect(page.getByRole("button", { name: "正在定位" })).toBeDisabled();
    await expect(page.getByText(message, { exact: false })).toBeVisible();
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toBeEnabled();
    await expect(page.getByRole("img", { name: "定位位置" })).toBeHidden();
  });
}

test("GPS marker survives basemap changes, resizing and print mode, and updates on the next fix", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ longitude: 116.404, latitude: 39.915 });
  await page.goto("/map");
  const button = page.getByRole("button", { name: "GPS 定位", exact: true });
  await button.click();
  await expectLocation(page, [116.404, 39.915]);
  await tool(page, "地图样式");
  await pickBasemap(page, "amap-satellite");
  await expect
    .poll(() => page.evaluate(() => window.renderer?.crs), { timeout: 20_000 })
    .toBe("gcj02");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expectLocation(page, [116.404, 39.915]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectLocation(page, [116.404, 39.915]);
  await context.setGeolocation({ longitude: 116.405, latitude: 39.916 });
  await button.click();
  await expectLocation(page, [116.405, 39.916]);
  await expect(page.getByRole("img", { name: "定位位置" })).toHaveCount(1);
  await tool(page, "出图");
  await expect(page.getByRole("img", { name: "定位位置" })).toHaveCount(0);
  await tool(page, "返回浏览");
  await expectLocation(page, [116.405, 39.916]);
  await page.reload();
  await expect(button).toBeVisible();
  await expect(page.getByRole("img", { name: "定位位置" })).toBeHidden();
});

test("GPS button stays above the mobile sheet and hides in print mode", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map");
  const button = page.getByRole("button", { name: "GPS 定位", exact: true });
  await expect(button).toBeVisible();
  let bounds = (await button.boundingBox())!;
  expect(bounds.x).toBeGreaterThan(300);
  expect(bounds.y).toBeGreaterThan(700);
  await tool(page, "轨迹库");
  const panel = page.getByLabel("地图控制面板", { exact: true });
  await expect
    .poll(async () => {
      bounds = (await button.boundingBox())!;
      return bounds.y + bounds.height <= (await panel.boundingBox())!.y - 4;
    })
    .toBe(true);
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  await handle.press("End");
  await expect(button).toBeHidden();
  await handle.press("Home");
  await expect(button).toBeVisible();
  await tool(page, "出图");
  await expect(button).toHaveCount(0);
});
