import { test, expect } from "@playwright/test";
import type {} from "../../src/drawing/globals.js";
import { tool } from "./map-tools.js";

test("a transient tile failure is logged, retried and does not prevent readiness", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  let failed = false;
  await page.route("**/tiles/vector/**", async (route) => {
    if (!failed) {
      failed = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto("/map");
  await page.waitForFunction(() => window.renderer?.map.loaded());
  await expect.poll(() => failed).toBe(true);
  await page.evaluate(() => window.renderer!.ready());
  expect(warnings.some((w) => w.includes("[地图资源]"))).toBe(true);
  await expect(page.locator(".map-errors")).toBeHidden();
  await expect(page.locator(".map-resource-error")).toHaveCount(0);
  expect(await page.evaluate(() => window.renderer!.errors)).toEqual([]);
});

test("persistent tile failure blocks export; reconnect reloads and clears only the resource alert", async ({
  page,
}) => {
  test.setTimeout(45000);
  await page.route("**/tiles/vector/**", (route) =>
    route.fulfill({ status: 503, body: "synthetic offline" }),
  );
  await page.goto("/map");
  await expect(page.locator(".map-resource-error")).toContainText(
    "底图加载失败",
    { timeout: 15000 },
  );
  await expect(page.locator(".map-errors")).toBeHidden();
  const error = await page.evaluate(async () => {
    try {
      await window.renderer!.ready();
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(error).toContain("地图资源不完整");
  await page.unroute("**/tiles/vector/**");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.evaluate(() => window.renderer!.ready());
  await expect(page.locator(".map-resource-error")).toHaveCount(0);
  expect(await page.evaluate(() => window.renderer!.errors)).toEqual([]);
  await tool(page, "新建出图工程");
  await page
    .getByRole("region", { name: "当前出图工程" })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const save = page.getByRole("dialog", { name: "另存工程" });
  await save.getByLabel("另存为名称").fill("保存失败不能被地图恢复清除");
  await page.route("**/api/projects/save", (route) =>
    route.fulfill({
      status: 500,
      json: {
        error: { code: "INTERNAL", message: "模拟保存失败", exitCode: 1 },
      },
    }),
  );
  await save.getByRole("button", { name: "确定", exact: true }).click();
  await expect(save.getByRole("alert")).toContainText("模拟保存失败");
  await save.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => window.renderer!.map.refreshTiles("base"));
  await page.evaluate(() => window.renderer!.ready());
  await expect(page.locator(".map-errors")).toContainText("模拟保存失败");
});

test("overview failures recover without leaving a sticky overview error", async ({
  page,
}) => {
  await page.route("**/api/overview/tiles/**", (route) =>
    route.fulfill({ status: 503, body: "synthetic overview failure" }),
  );
  await page.goto("/map");
  await expect(page.locator(".overview-resource-error")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator(".map-errors")).toBeHidden();
  await page.unroute("**/api/overview/tiles/**");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".overview-resource-error")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window
          .renderer!.map.getStyle()
          .layers.some(
            (l) =>
              l.id.startsWith("overview-") &&
              l.type === "line" &&
              JSON.stringify(window.renderer!.map.getFilter(l.id)).startsWith(
                '["=="',
              ),
          ),
      ),
    )
    .toBe(true);
});
