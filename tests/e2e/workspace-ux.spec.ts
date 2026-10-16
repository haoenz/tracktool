import { pickEditorPoint } from "./map-tools.js";
import { filterTracks, expectTrackFilter } from "./map-tools.js";
import { test, expect, type Page } from "@playwright/test";
import { tool, batchTrack } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";
async function call<T>(page: Page, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tracktool-Token": document.querySelector<HTMLMetaElement>(
            'meta[name="tracktool-token"]',
          )!.content,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { url, body },
  ) as Promise<T>;
}

test("list visibility covers all matching pages and stays independent of batch selection", async ({
  page,
}) => {
  await page.route("**/api/overview/entries?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("ids")) {
      await route.continue();
      return;
    }
    const rows = Array.from({ length: 55 }, (_, i) => ({
      id: `ux-${i}`,
      entry: `Default/2026-10-01 行程${i}.kml`,
      name: `行程${i}`,
      kind: "Default",
      date: "2026-10-01",
      sha256: "0".repeat(64),
      points: 2,
      segments: 1,
      distance_m: 1000,
    }));
    const q = url.searchParams.get("q") ?? "";
    const filtered = rows.filter((r) => r.name.includes(q));
    const offset = Number(url.searchParams.get("offset") ?? 0),
      limit = Number(url.searchParams.get("limit") ?? 50);
    await route.fulfill({
      json: {
        version: url.searchParams.get("version"),
        total: filtered.length,
        entries: filtered.slice(offset, offset + limit),
      },
    });
  });
  await page.goto("/map?panel=library");
  await expect(
    page.getByRole("complementary", { name: "地图控制面板" }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "轨迹列表", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "隐藏 行程0", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".map-track-list").getByRole("checkbox"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await page.getByRole("button", { name: "选择当前页", exact: true }).click();
  await expect(page.getByRole("region", { name: "批量操作" })).toContainText(
    "已选 50 条",
  );
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择 行程50", exact: true })
    .check();
  await expect(page.getByRole("region", { name: "批量操作" })).toContainText(
    "已选 51 条",
  );
  await filterTracks(page, "行程54");
  await expect(
    page.getByRole("checkbox", { name: "选择 行程54", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "批量操作" })).toContainText(
    "已选 51 条",
  );
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByLabel("起始日期", { exact: true }).fill("2026-10-01");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  const mapRequest = page.waitForRequest(
    (r) =>
      r.url().includes("/api/overview/entries?") &&
      new URL(r.url()).searchParams.get("limit") === "500",
  );
  await page
    .getByRole("button", { name: "切换当前列表可见性", exact: true })
    .click();
  expect(new URL((await mapRequest).url()).searchParams.get("from")).toBe(
    "2026-10-01",
  );
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "显示 行程54", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await expect(page.getByRole("region", { name: "批量操作" })).toContainText(
    "已选 51 条",
  );
  await page
    .getByRole("button", { name: "选择全部筛选结果（1）", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "批量操作" })).toContainText(
    "已选 1 条",
  );
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await filterTracks(page, "");
  await expect(
    page.getByRole("button", { name: "隐藏 行程0", exact: true }),
  ).toBeVisible();
  const visibility = page.getByRole("button", {
    name: "切换当前列表可见性",
    exact: true,
  });
  // Mixed visibility selects the whole matching list, including later pages.
  await visibility.click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "隐藏 行程54", exact: true }),
  ).toBeVisible();
  await visibility.click();
  await expect(
    page.getByRole("button", { name: "显示 行程54", exact: true }),
  ).toBeVisible();
  await filterTracks(page, "行程54");
  await expect(
    page.getByRole("button", { name: "显示 行程54", exact: true }),
  ).toBeVisible();
  await visibility.click();
  await expect(
    page.getByRole("button", { name: "隐藏 行程54", exact: true }),
  ).toBeVisible();
  await filterTracks(page, "");
  await expect(
    page.getByRole("button", { name: "显示 行程0", exact: true }),
  ).toBeVisible();
  await filterTracks(page, "行程54");
  await page.reload();
  await expectTrackFilter(page, "行程54");
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await expect(page.getByRole("region", { name: "批量操作" })).toContainText(
    "已选 1 条",
  );
});

test("details preserve list scroll; hover and focus do not repaint map highlights; mobile sheet stays usable", async ({
  page,
}, info) => {
  await page.goto("/map?panel=library");
  await expect(
    page.getByRole("complementary", { name: "地图控制面板" }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "轨迹列表", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看 Train/same.kml", exact: true }),
  ).toBeVisible();
  await page.waitForFunction(() => window.renderer?.map.loaded());
  const before = await page.evaluate(() => window.renderer!.state.camera);
  const highlights = () =>
    page.evaluate(() => {
      const map = window.renderer!.map;
      return map
        .getStyle()
        .layers.filter((layer) => layer.id.startsWith("overview-"))
        .map((layer) => ({ id: layer.id, paint: layer.paint }));
    });
  await expect.poll(async () => (await highlights()).length).toBeGreaterThan(0);
  const beforeHighlights = await highlights();
  const track = page.getByRole("button", {
    name: "查看 Train/same.kml",
    exact: true,
  });
  await track.hover();
  await expect
    .poll(() => track.evaluate((el) => el.matches(":hover")))
    .toBe(true);
  expect(await highlights()).toEqual(beforeHighlights);
  await track.focus();
  await expect(track).toBeFocused();
  expect(await highlights()).toEqual(beforeHighlights);
  expect(await page.evaluate(() => window.renderer!.state.camera)).toEqual(
    before,
  );
  const controls = page.getByRole("complementary", { name: "地图控制面板" });
  await controls.evaluate((e) => (e.scrollTop = 180));
  const scroll = await controls.evaluate((e) => e.scrollTop);
  await page
    .getByRole("button", { name: "查看 Train/same.kml", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "轨迹详情" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  expect(await controls.evaluate((e) => e.scrollTop)).toBe(scroll);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起", exact: true }).click();
  expect((await controls.boundingBox())!.height).toBeLessThan(60);
  await page.getByRole("button", { name: "展开", exact: true }).click();
  expect((await controls.boundingBox())!.height).toBeGreaterThan(600);
  await page.getByRole("button", { name: "半屏", exact: true }).click();
  expect((await controls.boundingBox())!.height).toBeLessThan(500);
  expect(await controls.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("library-mobile.png") });
  await page.getByRole("button", { name: "展开", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 Train/same.kml", exact: true })
    .click();
  await page.getByRole("button", { name: "定位轨迹", exact: true }).click();
  await expect(page.locator(".map-app")).toHaveAttribute("data-sheet", "half");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = window.renderer!;
        const p = r.map.project([101, 27]);
        const box = r.mapElement.getBoundingClientRect();
        return (
          box.top + (p.y * box.height) / r.mapElement.clientHeight <
          document.querySelector(".map-controls")!.getBoundingClientRect().top
        );
      }),
    )
    .toBe(true);
});

test("map picks real points, marks a range and preserves draft when switching panels", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await page.goto("/map?panel=library");
  await expect(
    page.getByRole("complementary", { name: "地图控制面板" }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "轨迹列表", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/edit-fixture",
    {},
  );
  try {
    await filterTracks(page, fixture.path);
    await page
      .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
      .click();
    await page.getByRole("button", { name: "编辑轨迹", exact: true }).click();
    await page.getByRole("button", { name: "删除轨迹点", exact: true }).click();
    await page.getByRole("button", { name: "定位轨迹", exact: true }).click();
    const clickPoint = async (lon: number) => {
      const point = await page.evaluate((lon) => {
        const r = window.renderer!,
          p = r.map.project([lon, 30]),
          box = r.mapElement.getBoundingClientRect();
        return {
          x: box.left + (p.x * box.width) / r.mapElement.clientWidth,
          y: box.top + (p.y * box.height) / r.mapElement.clientHeight,
        };
      }, lon);
      await page.mouse.click(point.x, point.y);
    };
    await clickPoint(120.01);
    await clickPoint(120.02);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.renderer!.data?.features.find(
              (f) => f.properties?.segment_id === "ux-delete",
            )?.geometry,
        ),
      )
      .toEqual({
        type: "MultiLineString",
        coordinates: [
          [
            [120.01, 30],
            [120.02, 30],
          ],
        ],
      });
    await tool(page, "设置");
    await tool(page, "轨迹库");
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("region", { name: "轨迹详情" })).toContainText(
      "编辑已保存",
      { timeout: 20000 },
    );
    await expect(page.locator(".map-stage")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("map-edit-range.png") });
    const detail = await call<{ segments: { point_count: number }[] }>(
      page,
      `/api/tracks/${fixture.id}`,
    );
    expect(detail.segments.reduce((n, s) => n + s.point_count, 0)).toBe(4);
  } finally {
    await call(page, "/api/test/edit-cleanup", { id: fixture.id });
  }
});

test("selected tracks enter a new project explicitly and hiding the library never removes project content", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await expect(
    page.getByRole("complementary", { name: "地图控制面板" }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "轨迹列表", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
  await batchTrack(page, "Train/same.kml");
  await page.getByRole("button", { name: "加入新建工程", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.renderer!.state.tracks.length))
    .toBe(1);
  await page.getByRole("button", { name: "从轨迹库添加", exact: true }).click();
  await page
    .getByRole("button", { name: "切换当前列表可见性", exact: true })
    .click();
  await page.getByRole("button", { name: "回到工程", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.renderer!.state.tracks.length))
    .toBe(1);
});

test("map draft pins its geometry version and refuses a concurrent library change", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/map?panel=library");
  await expect(
    page.getByRole("complementary", { name: "地图控制面板" }),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "轨迹列表", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/edit-fixture",
    {},
  );
  try {
    const before = await call<{
      entry: {
        version_id: string;
        presentation_id: string;
        generation: number;
      };
    }>(page, `/api/tracks/${fixture.id}`);
    await filterTracks(page, fixture.path);
    const geometryRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes(`/api/tracks/${fixture.id}/geometry?`))
        geometryRequests.push(r.url());
    });
    await page
      .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
      .click();
    const editEntry = page.getByRole("button", {
      name: "编辑轨迹",
      exact: true,
    });
    if (await editEntry.isVisible()) await editEntry.click();
    await expect.poll(() => geometryRequests.length).toBeGreaterThan(0);
    const params = new URL(geometryRequests[0]!).searchParams;
    expect(params.get("version_id")).toBe(before.entry.version_id);
    expect(params.get("presentation_id")).toBe(before.entry.presentation_id);
    await page.getByRole("button", { name: "断开轨迹", exact: true }).click();
    await pickEditorPoint(page, 1);
    await call(page, "/api/test/edit-presentation", { id: fixture.id });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const request = page.waitForRequest((r) =>
      r.url().endsWith("/api/tracks/edit-previews"),
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await request).postDataJSON().target.generation).toBe(
      before.entry.generation,
    );
    await expect(
      page.getByRole("button", { name: "重新载入轨迹", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "确认应用编辑", exact: true }),
    ).toHaveCount(0);
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "重新载入轨迹", exact: true })
      .click();

    await pickEditorPoint(page, 1);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByText("编辑已保存，旧版本保留在历史中。", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
  } finally {
    await call(page, "/api/test/edit-cleanup", { id: fixture.id });
  }
});

for (const width of [1280, 390]) {
  test(`list toolbar orders visibility, filter, search and sort at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map?panel=library");
    await expect(
      page.getByRole("complementary", { name: "地图控制面板" }),
    ).toBeVisible();
    if (
      await page
        .getByRole("button", { name: "轨迹列表", exact: true })
        .isVisible()
    )
      await page.getByRole("button", { name: "轨迹列表", exact: true }).click();
    const toolbar = page.locator(".list-visibility-toolbar");
    const visibility = toolbar.getByRole("button", {
      name: "切换当前列表可见性",
      exact: true,
    });
    const filter = toolbar.getByRole("button", { name: "筛选", exact: true });
    const search = toolbar.getByRole("textbox", {
      name: "筛选轨迹",
      exact: true,
    });
    const sort = toolbar.getByRole("button", { name: "排序", exact: true });
    await expect(search).toBeVisible();
    const boxes = await Promise.all(
      [visibility, filter, search, sort].map((el) => el.boundingBox()),
    );
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.x).toBeGreaterThanOrEqual(
        boxes[i - 1]!.x + boxes[i - 1]!.width,
      );
      expect(
        Math.abs(
          boxes[i]!.y +
            boxes[i]!.height / 2 -
            boxes[0]!.y -
            boxes[0]!.height / 2,
        ),
      ).toBeLessThan(2);
    }
    await expect(filter).toHaveText("");
    await expect(sort).toHaveText("");
    await search.fill("same");
    await filter.click();
    const dialog = page.getByRole("dialog", { name: "筛选", exact: true });
    await dialog.getByLabel("起始日期", { exact: true }).fill("2026-10-10");
    await dialog.getByLabel("截止日期", { exact: true }).fill("2026-10-01");
    await expect(
      dialog.getByRole("button", { name: "应用", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(filter).toBeFocused();
    await filter.click();
    await expect(dialog.getByLabel("起始日期", { exact: true })).toHaveValue(
      "",
    );
    await dialog.getByLabel("起始日期", { exact: true }).fill("2099-01-01");
    await dialog.getByRole("button", { name: "应用", exact: true }).click();
    await expect(
      page.getByText("没有匹配的轨迹。", { exact: true }),
    ).toBeVisible();
    await expect(filter).toHaveAttribute("title", "筛选：已设置");
    await filter.click();
    await dialog.getByRole("button", { name: "重置", exact: true }).click();
    await dialog.getByRole("button", { name: "应用", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "查看 Train/same.kml", exact: true }),
    ).toBeVisible();
    await expect(search).toHaveValue("same");
    await sort.click();
    await page.getByRole("radio", { name: "名称", exact: true }).click();
    await sort.click();
    await expect(
      page.getByRole("radio", { name: "名称", exact: true }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(sort).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
