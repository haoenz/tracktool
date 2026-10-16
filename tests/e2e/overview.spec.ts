import { filterTracks } from "./map-tools.js";
import { tool } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";
import { test, expect, type Page } from "@playwright/test";

async function loaded(page: Page) {
  await page.goto("/map?panel=library");
  await expect(page.getByRole("complementary", { name: "地图控制面板" })).toBeVisible();
  if (await page.getByRole("button", { name: "轨迹列表", exact: true }).isVisible())
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
  await page.waitForFunction(() => {
    const m = window.renderer?.map;
    return (
      m?.isStyleLoaded() &&
      m
        .getStyle()
        ?.layers.some(
          (l) =>
            l.id.startsWith("overview-") &&
            l.type === "line" &&
            m.getPaintProperty(l.id, "line-opacity") !== 0 &&
            JSON.stringify(m.getFilter(l.id)).startsWith('["=="'),
        )
    );
  });
}
async function overviewSource(page: Page) {
  return page.evaluate(
    () =>
      (
        window
          .renderer!.map.getStyle()
          ?.layers.find(
            (l) =>
              l.id.startsWith("overview-") &&
              l.type === "line" &&
              window.renderer!.map.getPaintProperty(l.id, "line-opacity") !==
                0 &&
              JSON.stringify(window.renderer!.map.getFilter(l.id)).startsWith(
                '["=="',
              ),
          ) as { source: string } | undefined
      )?.source,
  );
}

test("default overview requests viewport tiles, checks visible tracks, and restores camera", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await loaded(page);
  expect(requests.some((u) => u.includes("/api/overview/tiles/"))).toBe(true);
  expect(
    requests.some(
      (u) => u.endsWith("/api/selection") || u.includes("/geometry?"),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => window.renderer!.state.tracks)).toEqual([]);
  await expect(page.locator(".save-state")).toHaveText("浏览地图");
  await expect(
    page.getByRole("button", { name: "隐藏 索引未命中", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const view = page.getByRole("button", {
    name: "查看 Default/2026-10-01 中文.kml",
    exact: true,
  });
  await view.click();
  await expect(page.getByRole("region", { name: "轨迹详情" })).toContainText(
    "个点",
  );
  await expect(page.getByRole("button", { name: "定位轨迹" })).toBeEnabled();
  await page.getByRole("button", { name: "定位轨迹" }).click();
  await expect(page.locator(".save-state")).toHaveText("浏览地图");
  expect(await page.evaluate(() => window.renderer!.state.tracks)).toEqual([]);
  const source = await overviewSource(page);
  const selected = await page.evaluate(
    (source) =>
      window.renderer!.map.getPaintProperty(source + "-line", "line-color"),
    source,
  );
  expect(JSON.stringify(selected)).toContain("#ff5722");
  const width = await page.evaluate(
    (source) =>
      window.renderer!.map.getPaintProperty(source + "-line", "line-width"),
    source,
  );
  expect(JSON.stringify(width)).toContain("trackId");
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await filterTracks(page, "no-such-track");
  await expect(
    page.getByText("没有匹配的轨迹。", { exact: true }),
  ).toBeVisible();
  expect(await overviewSource(page)).toBe(source);
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [117, 40], zoom: 8.2 }),
  );
  const camera = await page.evaluate(() => window.renderer!.state.camera);
  await page.reload();
  await page.waitForFunction(() => !!window.renderer?.map.isStyleLoaded());
  await expect
    .poll(() => page.evaluate(() => window.renderer!.state.camera))
    .toEqual(camera);
  await expect(page.locator(".save-state")).toHaveText("浏览地图");
  expect(errors).toEqual([]);
});
test("new versions keep visible old tiles until the replacement is ready and retry failed tiles", async ({
  page,
}) => {
  await loaded(page);
  const old = await overviewSource(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/overview/tiles/**", async (route) => {
    if (!route.request().url().includes(old!.slice(9, 41))) await gate;
    await route.continue();
  });
  await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="tracktool-token"]',
    )!.content;
    await fetch("/api/overview/retry?crs=wgs84", {
      method: "POST",
      headers: { "X-Tracktool-Token": token },
    });
  });
  await page.waitForFunction(
    (old) =>
      Object.keys(window.renderer!.map.getStyle().sources).some(
        (s) => s.startsWith("overview-") && s !== old,
      ),
    old,
  );
  expect(await overviewSource(page)).toBe(old);
  release();
  await expect.poll(() => overviewSource(page)).not.toBe(old);
  await page.unroute("**/api/overview/tiles/**");
  await page.route("**/api/overview/tiles/**", (route) =>
    route.fulfill({ status: 503, body: "synthetic tile failure" }),
  );
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [120, 30], zoom: 13 }),
  );
  await expect(page.locator(".overview-resource-error")).toBeVisible({
    timeout: 15000,
  });
  await page.unroute("**/api/overview/tiles/**");
  await page.getByRole("button", { name: "重试概览", exact: true }).click();
  await expect(page.locator(".overview-resource-error")).toHaveCount(0);
  await page.waitForFunction(() => window.renderer!.map.areTilesLoaded());
});
test("style reload restores the overview; export preview excludes it; mobile panels keep the map", async ({
  page,
}) => {
  await loaded(page);
  await tool(page, "地图样式");
  await page.getByRole("combobox", { name: "底图", exact: true }).click();
  await page.getByRole("option").getByText("深色矢量", { exact: true }).click();
  await expect.poll(() => overviewSource(page)).toBeTruthy();
  await expect
    .poll(() => page.evaluate(() => window.renderer!.state.style.basemap), {
      timeout: 20000,
    })
    .toBe("dark");
  await page.waitForFunction(() =>
    window
      .renderer!.map.getStyle()
      ?.layers.some(
        (l) =>
          l.id.startsWith("overview-") &&
          l.type === "line" &&
          window.renderer!.map.getPaintProperty(l.id, "line-opacity") !== 0 &&
          JSON.stringify(window.renderer!.map.getFilter(l.id)).startsWith(
            '["=="',
          ),
      ),
  );
  await tool(page, "新建出图工程");
  await expect.poll(() => overviewSource(page)).toBeUndefined();
  await tool(page, "返回浏览");
  await page
    .getByRole("button", { name: "放弃修改并返回", exact: true })
    .click();
  await expect.poll(() => overviewSource(page)).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起项目菜单" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await page.locator(".map-stage").count()).toBe(1);
});
test("cold build, empty library and failures offer usable status and import/retry actions", async ({
  page,
}) => {
  let state = "building";
  await page.route("**/api/overview?crs=*", (route) =>
    route.fulfill({
      json:
        state === "building"
          ? {
              state,
              crs: "wgs84",
              version: null,
              updating: true,
              maxZoom: 18,
              progress: { completed: 3, total: 10, phase: "reading" },
            }
          : state === "error"
            ? {
                state,
                crs: "wgs84",
                version: null,
                updating: false,
                maxZoom: 18,
                error: "测试构建失败",
              }
            : {
                state: "ready",
                crs: "wgs84",
                version: "a".repeat(32),
                updating: false,
                maxZoom: 18,
                bounds: null,
                summary: { entries: 0, valid: 0, invalid: 0, points: 0 },
              },
    }),
  );
  await page.goto("/map?panel=library");
  await expect(page.getByRole("complementary", { name: "地图控制面板" })).toBeVisible();
  if (await page.getByRole("button", { name: "轨迹列表", exact: true }).isVisible())
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("3/10");
  state = "error";
  await expect(
    page.getByRole("button", { name: "重试概览", exact: true }),
  ).toBeVisible();
  state = "empty";
  await expect(page.getByText(/轨迹库为空/)).toBeVisible();
  await page.getByRole("button", { name: "导入 KML", exact: true }).click();
  await expect(
    page.getByText("1 · 选择或拖入 KML", { exact: true }),
  ).toBeVisible();
});

test("clicking overlapping tracks offers all candidates and keeps list selection linked", async ({
  page,
}) => {
  await loaded(page);
  await page.getByRole("button", { name: "收起项目菜单" }).click();
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [101, 27], zoom: 8 }),
  );
  await page.waitForFunction(() => window.renderer!.map.areTilesLoaded());
  const point = await page.evaluate(() => {
    const r = window.renderer!,
      p = r.map.project([101, 27]),
      rect = r.mapElement.getBoundingClientRect();
    return {
      x: rect.left + (p.x * rect.width) / r.mapElement.clientWidth,
      y: rect.top + (p.y * rect.height) / r.mapElement.clientHeight,
    };
  });
  await page.mouse.click(point.x, point.y);
  await expect(
    page.getByRole("region", { name: "重叠轨迹候选", exact: true }),
  ).toContainText("索引未命中");
  await expect(
    page.getByRole("region", { name: "重叠轨迹候选", exact: true }),
  ).toContainText("原始中文");
  await page
    .getByRole("region", { name: "重叠轨迹候选", exact: true })
    .getByRole("button", { name: "索引未命中", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "轨迹详情" })).toContainText(
    "Train/same.kml",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".overview-row.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "隐藏 索引未命中", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "查看 Train/same.kml", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("GCJ02 basemap uses its own overview version and a style reload restores selection", async ({
  page,
}) => {
  await loaded(page);
  const before = await overviewSource(page);
  await page
    .getByRole("button", { name: "查看 Train/same.kml", exact: true })
    .click();
  await tool(page, "地图样式");
  const label = await page.evaluate(() => {
    const b = window.renderer!.config.basemaps.find(
      (b) => b.id === "amap-road",
    )!;
    return `${b.group} · ${b.name}`;
  });
  const select = page.getByRole("combobox", { name: "底图", exact: true });
  await select.click();
  await page
    .getByRole("combobox", { name: "搜索底图", exact: true })
    .fill(label);
  await page.getByRole("option").getByText(label, { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.renderer!.crs), { timeout: 15000 })
    .toBe("gcj02");
  await expect.poll(() => overviewSource(page)).toBeTruthy();
  expect(await overviewSource(page)).not.toBe(before);
  await page.evaluate(() => {
    const r = window.renderer!;
    r.map.setStyle(r.map.getStyle(), { diff: false });
  });
  await page.waitForFunction(() => window.renderer!.map.isStyleLoaded());
  await expect.poll(() => overviewSource(page)).toBeTruthy();
  await tool(page, "轨迹库");
  await expect(page.getByRole("region", { name: "轨迹详情" })).toContainText(
    "Train/same.kml",
  );
});

test("category colors and alpha match original KML while selection preserves category color", async ({
  page,
}, info) => {
  await loaded(page);
  const source = await overviewSource(page);
  const paint = await page.evaluate((source) => {
    const map = window.renderer!.map;
    return {
      color: map.getPaintProperty(source + "-line", "line-color"),
      opacity: map.getPaintProperty(source + "-line", "line-opacity"),
      point: map.getPaintProperty(source + "-point", "circle-color"),
      kinds: [
        ...new Set(
          map
            .querySourceFeatures(source!, { sourceLayer: "tracks" })
            .map((f) => f.properties.kind),
        ),
      ],
    };
  }, source);
  expect(paint.color).toEqual([
    "match",
    ["get", "kind"],
    "Default",
    "#ff5722",
    "Train",
    "#383041",
    "Flight",
    "#00adb5",
    "#69796f",
  ]);
  expect(paint.point).toEqual(paint.color);
  expect(JSON.stringify(paint.opacity)).toContain(String(26 / 255));
  expect(paint.kinds).toEqual(
    expect.arrayContaining(["Default", "Train", "Flight"]),
  );
  await page
    .getByRole("button", { name: "查看 Train/same.kml", exact: true })
    .click();
  expect(
    await page.evaluate(
      (source) =>
        window.renderer!.map.getPaintProperty(source + "-line", "line-color"),
      source,
    ),
  ).toEqual(paint.color);
  await page.getByRole("button", { name: "定位轨迹", exact: true }).click();
  await page.getByRole("button", { name: "收起项目菜单", exact: true }).click();
  await page.waitForFunction(() => window.renderer!.map.areTilesLoaded());
  await expect(page.locator(".map-status")).toHaveCount(0, { timeout: 10000 });
  await page.screenshot({
    path: info.outputPath("category-map-desktop.png"),
    animations: "disabled",
  });
});

test("only pending work shows a translucent loading status and success notifications expire", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/overview/tiles/**", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/map?panel=library");
  await expect(page.getByRole("complementary", { name: "地图控制面板" })).toBeVisible();
  if (await page.getByRole("button", { name: "轨迹列表", exact: true }).isVisible())
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
    await expect(page.locator(".map-status")).toContainText(/正在/, {
      timeout: 15000,
    });
    const background = await page
      .locator(".map-status")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toMatch(/^rgba\(/);
  } finally {
    release();
  }
  await page.waitForFunction(() => window.renderer?.map.areTilesLoaded());
  await expect(page.locator(".map-status")).toHaveCount(0, { timeout: 15000 });
  await expect(
    page.getByText("选择轨迹查看，拖动地图探索。", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "切换当前列表可见性", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^(显示|隐藏) 索引未命中$/, exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "显示 索引未命中", exact: true })
    .click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(
    "已更新地图显示",
  );
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 10000,
  });
  await expect(page.locator(".map-status")).toHaveCount(0);
});

test("browse eye buttons filter map lines and points, survive searches and style reload, and select all again", async ({
  page,
}) => {
  await loaded(page);
  const source = await overviewSource(page);
  await page.getByRole("button", { name: "切换当前列表可见性", exact: true }).click();
  const checkbox = page.getByRole("button", {
    name: /^(隐藏|显示) 索引未命中$/,
    exact: true,
  });
  await expect(checkbox).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(() =>
      page.evaluate((s) => window.renderer!.map.getFilter(s + "-line"), source),
    )
    .toEqual([
      "all",
      ["==", ["get", "role"], "line"],
      ["in", ["get", "trackId"], ["literal", []]],
    ]);
  await expect(checkbox).toBeEnabled();
  await checkbox.click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(
    "已更新地图显示",
  );
  const filters = await page.evaluate(
    (s) =>
      ["line", "point"].map((role) =>
        window.renderer!.map.getFilter(s + "-" + role),
      ),
    source,
  );
  for (const filter of filters)
    expect(JSON.stringify(filter)).toMatch(/"literal",\["[^"]+"\]/);
  await filterTracks(page, "no-such-track");
  await expect(
    page.getByText("没有匹配的轨迹。", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (s) => window.renderer!.map.getFilter(s + "-line"),
      source,
    ),
  ).toEqual(filters[0]);
  await page.evaluate(() => {
    const m = window.renderer!.map;
    m.setStyle(m.getStyle(), { diff: false });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = window.renderer!.map;
        const l = m
          .getStyle()
          ?.layers.find(
            (l) => l.id.startsWith("overview-") && l.type === "line",
          );
        return l && m.getFilter(l.id);
      }),
    )
    .toEqual(filters[0]);
  await filterTracks(page, "");
  await expect(checkbox).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", {
      name: /^(显示|隐藏) 原始中文$/,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "切换当前列表可见性", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: /^(显示|隐藏) 原始中文$/,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => overviewSource(page)).toBeTruthy();
  await checkbox.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = window.renderer!.map;
        const l = m
          .getStyle()
          ?.layers.find(
            (l) => l.id.startsWith("overview-") && l.type === "line",
          );
        return l && JSON.stringify(m.getFilter(l.id));
      }),
    )
    .toContain('["!",["in"');
});
