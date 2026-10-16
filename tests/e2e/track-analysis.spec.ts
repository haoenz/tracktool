import { test, expect, type Page } from "@playwright/test";
import { filterTracks, tool } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";
import type { GeoJSONSource } from "maplibre-gl";

async function call<T>(page: Page, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-tracktool-token": document.querySelector<HTMLMetaElement>(
            'meta[name="tracktool-token"]',
          )!.content,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { url, body },
  );
}
for (const width of [1280, 390])
  test(`track analysis and temporary map coloring at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map");
    const fixture = await call<{ id: string; path: string; sha256: string }>(
      page,
      "/api/test/analysis-fixture",
      {},
    );
    try {
      await tool(page, "轨迹库");
      await filterTracks(page, fixture.path.split("/").at(-1)!);
      await page
        .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
        .click();
      const panel = page.getByRole("region", { name: "轨迹详情", exact: true });
      await expect(panel.locator(".track-route")).toHaveText("未知→未知");
      await expect(panel.locator(".track-stats > div")).toHaveCount(2);
      await expect(panel).not.toContainText(fixture.path);
      await expect(panel.locator(".track-stats")).not.toContainText(
        "计算中...",
      );
      await expect(panel.locator(".track-stats")).not.toContainText("无数据");
      await page.screenshot({ path: info.outputPath(`summary-${width}.png`) });
      const analysis = panel.getByRole("region", { name: "轨迹分析" });
      await expect(analysis).toBeVisible();
      await panel
        .getByRole("button", { name: "定位轨迹", exact: true })
        .click();
      await panel.locator("summary", { hasText: "更多统计" }).click();
      await expect(panel.locator(".analysis-more")).toContainText(
        "运动平均速度",
      );
      await expect(panel.locator(".analysis-more")).toContainText("平路占比");
      await panel.locator("summary", { hasText: "更多统计" }).click();
      await analysis
        .getByRole("group", { name: "图表指标" })
        .getByRole("button", { name: "速度", exact: true })
        .click();
      const chart = analysis.getByRole("img", { name: /速度变化图/ });
      await expect(chart).toBeVisible();
      await chart.focus();
      await page.keyboard.press("End");
      await expect(analysis.locator(".analysis-hover")).toContainText("km/h");
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const source = window.renderer!.map.getSource(
              "analysis-cursor",
            ) as GeoJSONSource;
            const data = await source?.getData();
            return data?.type === "FeatureCollection"
              ? data.features.length
              : 0;
          }),
        )
        .toBe(1);
      const coloring = analysis.getByRole("group", { name: "地图着色" });
      await coloring.getByRole("button", { name: "速度", exact: true }).click();
      const overlayCount = () =>
        page.evaluate(async () => {
          const data = await (
            window.renderer!.map.getSource("analysis-profile") as GeoJSONSource
          )?.getData();
          return data?.type === "FeatureCollection" ? data.features.length : 0;
        });
      await expect.poll(overlayCount).toBe(78);
      // Restoring the style must reinstall the temporary coloring, without changing project tracks.
      await page.evaluate(() => {
        const map = window.renderer!.map;
        map.setStyle(map.getStyle(), { diff: false });
      });
      await expect.poll(overlayCount).toBe(78);
      expect(await page.evaluate(() => window.renderer!.state.tracks)).toEqual(
        [],
      );
      await coloring.getByRole("button", { name: "海拔", exact: true }).click();
      await expect(analysis.getByLabel("地图着色色标")).toContainText("m");
      await analysis
        .getByRole("group", { name: "图表横轴" })
        .getByRole("button", { name: "时间", exact: true })
        .click();
      await expect(chart).toHaveAttribute("aria-label", /经过时间/);
      await analysis.scrollIntoViewIfNeeded();
      expect(
        await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`analysis-${width}.png`) });
      await coloring.getByRole("button", { name: "原始", exact: true }).click();
      await expect.poll(overlayCount).toBe(0);
      await coloring.getByRole("button", { name: "海拔", exact: true }).click();
      await page.getByRole("button", { name: "返回列表", exact: true }).click();
      await expect.poll(overlayCount).toBe(0);
      await page.screenshot({ path: info.outputPath(`list-${width}.png`) });
      expect(errors).toEqual([]);
    } finally {
      await call(page, "/api/test/edit-cleanup", { id: fixture.id });
    }
  });

test("tracks without time and elevation retain explicit missing-data states", async ({
  page,
}) => {
  await page.goto("/map");
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/edit-fixture",
    {},
  );
  try {
    await tool(page, "轨迹库");
    await filterTracks(page, fixture.path.split("/").at(-1)!);
    await page
      .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
      .click();
    const panel = page.getByRole("region", { name: "轨迹详情", exact: true });
    await expect(panel.locator(".analysis-empty")).toHaveText(
      "没有可用的海拔数据",
    );
    await expect(panel.locator(".track-stats")).toContainText("无数据");
    const coloring = panel.getByRole("group", { name: "地图着色" });
    await expect(
      coloring.getByRole("button", { name: "速度", exact: true }),
    ).toBeDisabled();
    await expect(
      coloring.getByRole("button", { name: "海拔", exact: true }),
    ).toBeDisabled();
    await expect(
      panel
        .getByRole("group", { name: "图表横轴" })
        .getByRole("button", { name: "时间", exact: true }),
    ).toBeDisabled();
  } finally {
    await call(page, "/api/test/edit-cleanup", { id: fixture.id });
  }
});

for (const complete of [true, false])
  test(`pending analysis never reports missing data (${complete ? "timed" : "untimed"})`, async ({
    page,
  }) => {
    await page.goto("/map");
    const fixture = await call<{ id: string; path: string }>(
      page,
      complete ? "/api/test/analysis-fixture" : "/api/test/edit-fixture",
      {},
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/api/tracks/${fixture.id}/analysis?*`,
      async (route) => {
        await gate;
        await route.continue();
      },
    );
    try {
      await tool(page, "轨迹库");
      await filterTracks(page, fixture.path.split("/").at(-1)!);
      await page
        .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
        .click();
      const panel = page.getByRole("region", { name: "轨迹详情", exact: true });
      const elapsed = panel
        .locator(".track-stats > div")
        .filter({ hasText: "耗时" });
      await expect(elapsed).toContainText("计算中...");
      await expect(panel.locator(".analysis-stat-list").first()).toContainText(
        "计算中...",
      );
      await expect(panel).not.toContainText("无数据");
      await expect(
        panel.getByRole("region", { name: "轨迹分析" }).getByRole("status"),
      ).toHaveText("计算中...");
      release();
      await expect(elapsed).not.toContainText("计算中...");
      if (complete) await expect(elapsed).not.toContainText("无数据");
      else await expect(elapsed).toContainText("无数据");
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await call(page, "/api/test/edit-cleanup", { id: fixture.id });
    }
  });

test("analysis failure is distinct from missing data and retry computes successfully", async ({
  page,
}) => {
  await page.goto("/map");
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/analysis-fixture",
    {},
  );
  await page.route(`**/api/tracks/${fixture.id}/analysis?*`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "测试计算失败" } }),
    }),
  );
  try {
    await tool(page, "轨迹库");
    await filterTracks(page, fixture.path.split("/").at(-1)!);
    await page
      .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
      .click();
    const panel = page.getByRole("region", { name: "轨迹详情", exact: true });
    const elapsed = panel
      .locator(".track-stats > div")
      .filter({ hasText: "耗时" });
    await expect(elapsed).toContainText("计算失败");
    await expect(panel).not.toContainText("无数据");
    await page.unrouteAll();
    await panel.getByRole("button", { name: "重试统计" }).click();
    await expect(elapsed).not.toContainText("计算失败");
    await expect(elapsed).not.toContainText("计算中...");
    await expect(elapsed).not.toContainText("无数据");
  } finally {
    await page.unrouteAll();
    await call(page, "/api/test/edit-cleanup", { id: fixture.id });
  }
});

test("interior duplicate timestamps do not hide elapsed time", async ({
  page,
}) => {
  await page.goto("/map");
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/analysis-fixture",
    { duplicateTime: true },
  );
  try {
    await tool(page, "轨迹库");
    await filterTracks(page, fixture.path.split("/").at(-1)!);
    await page
      .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
      .click();
    const panel = page.getByRole("region", { name: "轨迹详情", exact: true });
    await expect(
      panel.locator(".track-stats > div").filter({ hasText: "耗时" }),
    ).toContainText("1小时19分");
    await expect(
      panel.locator(".analysis-stat-list").first(),
    ).not.toContainText("无数据");
    await expect(
      panel
        .getByRole("group", { name: "图表横轴" })
        .getByRole("button", { name: "时间", exact: true }),
    ).toBeDisabled();
  } finally {
    await call(page, "/api/test/edit-cleanup", { id: fixture.id });
  }
});
