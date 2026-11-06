import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type {} from "../../src/drawing/globals.js";
import { tool } from "./map-tools.js";
import { resetDisplay } from "./display-reset.js";

test.beforeEach(async ({ request }) => resetDisplay(request));

async function ready(page: Page, panel = "none") {
  await page.goto(`/map?panel=${panel}`);
  await page.waitForFunction(() => {
    const map = window.renderer?.map;
    return (
      map?.loaded() &&
      map
        .getStyle()
        .layers.some(
          (layer) =>
            layer.id.startsWith("overview-") &&
            layer.id.endsWith("-line") &&
            JSON.stringify(map.getFilter(layer.id)).includes('"gapReason"'),
        )
    );
  });
  await expect(page.locator(".map-status")).toHaveCount(0);
}

test("short map reads stay quiet and adjacent phases share one delayed indicator", async ({
  page,
}) => {
  await ready(page);
  const source = await page.evaluate(() => {
    const map = window.renderer!.map;
    const layer = map
      .getStyle()
      .layers.find(
        (layer) =>
          layer.id.startsWith("overview-") &&
          layer.id.endsWith("-line") &&
          JSON.stringify(map.getFilter(layer.id)).includes('"gapReason"'),
      );
    return layer && "source" in layer ? layer.source : undefined;
  });
  expect(typeof source).toBe("string");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const loading = (active: boolean) =>
    page.evaluate(
      ({ active, source }) => {
        window.renderer!.map.fire(active ? "dataloading" : "sourcedata", {
          dataType: "source",
          sourceId: source,
          isSourceLoaded: !active,
        });
      },
      { active, source },
    );
  await loading(true);
  await page.clock.runFor(100);
  await expect(page.locator(".map-status")).toHaveCount(0);
  await loading(false);
  await page.clock.runFor(400);
  await expect(page.locator(".map-status")).toHaveCount(0);
  await loading(true);
  await page.clock.runFor(200);
  const status = page.locator(".map-status");
  await expect(status).toContainText("正在加载地图轨迹");
  await status.evaluate((element) =>
    element.setAttribute("data-continuous", "true"),
  );
  await loading(false);
  await page.clock.runFor(100);
  await loading(true);
  await page.clock.runFor(200);
  await expect(status).toHaveAttribute("data-continuous", "true");
  await page.clock.runFor(8100);
  await expect(status).toContainText("请检查网络连接");
  await loading(false);
  await page.clock.runFor(500);
  await expect(status).toHaveCount(0);
});

test("list refresh keeps rows, failure retries locally, and new filters do not reuse old rows", async ({
  page,
}) => {
  await ready(page, "library");
  const row = page.getByRole("button", {
    name: "查看 Train/same.kml",
    exact: true,
  });
  await expect(row).toBeVisible();
  let mode: "wait" | "error" | "ok" = "wait";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/overview/entries?*", async (route) => {
    if (mode === "wait") await gate;
    if (mode === "error")
      await route.fulfill({
        status: 503,
        json: { error: { message: "测试列表不可用" } },
      });
    else await route.continue();
  });
  try {
    await page.clock.install();
    await page.clock.fastForward(31_000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });
    await expect(
      page.getByText("正在更新列表…", { exact: true }),
    ).toBeVisible();
    await expect(row).toBeVisible();
    await expect(
      page.locator(".map-track-list .loading-placeholder"),
    ).toHaveCount(0);
    await expect(page.locator(".map-status")).toHaveCount(0);
    mode = "error";
    release();
    const retry = page.getByRole("button", { name: "重试列表", exact: true });
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await expect(row).toBeVisible();
    mode = "ok";
    await retry.click();
    await expect(retry).toHaveCount(0);
    await page.unroute("**/api/overview/entries?*");
    let finish!: () => void;
    const filtered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await page.route("**/api/overview/entries?*", async (route) => {
      await filtered;
      await route.continue();
    });
    try {
      await page.getByLabel("筛选轨迹", { exact: true }).fill("不会匹配的轨迹");
      await expect(
        page.locator(".map-track-list .loading-placeholder"),
      ).toBeVisible();
      await expect(row).toHaveCount(0);
      await expect(page.locator(".map-status")).toHaveCount(0);
    } finally {
      finish();
    }
    await expect(page.getByText("无匹配", { exact: true })).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("PNG export reports real phases without invented percentages and fails in its panel", async ({
  page,
}) => {
  await ready(page);
  await tool(page, "出图");
  let phase = "resources";
  await page.route("**/api/print", (route) =>
    route.fulfill({ json: { job: "loading-test", warnings: [] } }),
  );
  await page.route("**/api/jobs/loading-test", (route) =>
    route.fulfill({
      json: {
        status: phase === "failed" ? "failed" : "rendering",
        phase,
        error: phase === "failed" ? "测试图片生成失败" : undefined,
      },
    }),
  );
  await page.getByRole("button", { name: "导出 PNG", exact: true }).click();
  const status = page.locator(".map-status");
  await expect(status).toContainText("正在加载出图资源");
  phase = "rendering";
  await expect(status).toContainText("正在生成 PNG 图片");
  await expect(status).not.toContainText("%");
  phase = "failed";
  const panel = page.getByRole("region", { name: "出图设置" });
  await expect(panel.getByRole("alert")).toContainText("测试图片生成失败");
  await expect(
    panel.getByRole("button", { name: "导出 PNG", exact: true }),
  ).toBeEnabled();
  await expect(status).toHaveCount(0);
});

test("import checks show backend counts and explain a long wait in the import panel", async ({
  page,
}) => {
  await page.clock.install();
  await ready(page);
  await tool(page, "上传轨迹");
  let hold = true;
  await page.route("**/api/work/tasks/*", async (route) => {
    const response = await route.fetch();
    const task = await response.json();
    await route.fulfill({
      response,
      json: hold
        ? {
            ...task,
            status: "running",
            progress: { ...task.progress, completed: 1, total: 3 },
          }
        : task,
    });
  });
  try {
    await page.getByLabel("上传输入文件").setInputFiles({
      name: `2026-10-01 加载进度-${Date.now()}.kml`,
      mimeType: "application/octet-stream",
      buffer: await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
    });
    const summary = page.locator(".import-summary");
    await expect(summary).toContainText("正在检查轨迹 · 1/3");
    await expect(page.locator(".map-status")).toHaveCount(0);
    await page.clock.fastForward(8500);
    await expect(summary).toContainText("文件处理仍在进行中");
    await expect(
      page.getByRole("button", { name: "取消检查", exact: true }),
    ).toBeEnabled();
    hold = false;
    await expect(summary).toContainText("待导入1个");
    await expect(summary).not.toContainText("文件处理仍在进行中");
  } finally {
    hold = false;
    await page.unrouteAll({ behavior: "wait" });
  }
});
