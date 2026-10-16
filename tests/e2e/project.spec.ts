import { filterTracks, expectTrackFilter } from "./map-tools.js";
import { tool, selectProjectTrack, saveProject } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";
import { test, expect, type Page } from "@playwright/test";
import type { Project } from "../../src/shared/project.js";
const track = "Train/same.kml";
const state = (page: Page) => page.evaluate(() => window.renderer!.state);
async function browse(page: Page) {
  await page.goto("/map?panel=library");
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("button", { name: `查看 ${track}`, exact: true }),
  ).toBeVisible();
  await page.waitForFunction(() => window.renderer?.map.loaded());
}
async function title(page: Page, value: string) {
  await tool(page, "工程样式");
  await page.getByLabel("标题", { exact: true }).fill(value);
}

test("project candidate browsing preserves composition, filters, visibility and list position; exit protects changes", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await browse(page);
  await expect(page.locator(".map-stage")).not.toHaveClass(/export-preview/);
  await expect(
    page.getByRole("button", { name: "导出 PNG", exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "隐藏 索引未命中", exact: true })
    .click();
  await filterTracks(page, "Train");
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [111, 32], zoom: 6.2 }),
  );
  const before = await state(page);
  await tool(page, "新建出图工程");
  await expect(page.locator(".map-stage")).toHaveClass(/export-preview/);
  expect((await state(page)).camera).toEqual(before.camera);
  expect((await state(page)).tracks).toEqual([]);
  await expect(page.locator(".save-state")).toHaveText("未保存");
  await selectProjectTrack(page, track);
  await title(page, "保留的工程修改");
  await tool(page, "设置");
  await page.getByRole("combobox", { name: "底图", exact: true }).click();
  await page
    .getByRole("combobox", { name: "搜索底图", exact: true })
    .fill("深色矢量");
  await page.getByText("深色矢量", { exact: true }).click();
  await expect.poll(async () => (await state(page)).style.basemap).toBe("dark");
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [120, 40], zoom: 9 }),
  );
  const composition = await state(page);
  await tool(page, "出图");
  await page.getByRole("button", { name: "从轨迹库添加", exact: true }).click();
  await filterTracks(page, "same");
  await page
    .getByRole("button", { name: `查看 ${track}`, exact: true })
    .click();
  await page.getByRole("button", { name: "定位轨迹", exact: true }).click();
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [101, 27], zoom: 7 }),
  );
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await page.getByRole("button", { name: "切换当前列表可见性", exact: true }).click();
  await page.getByRole("button", { name: "回到工程", exact: true }).click();
  await expect.poll(() => state(page)).toEqual(composition);
  await tool(page, "返回浏览");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  expect((await state(page)).title).toBe("保留的工程修改");
  await tool(page, "返回浏览");
  await page
    .getByRole("button", { name: "放弃修改并返回", exact: true })
    .click();
  await expect(page.locator(".save-state")).toHaveText("浏览地图");
  expect((await state(page)).camera).toEqual(before.camera);
  expect((await state(page)).style).toEqual(before.style);
  expect((await state(page)).tracks).toEqual(before.tracks);
  await expectTrackFilter(page, "Train");
  await expect(
    page.getByRole("button", { name: "显示 索引未命中", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: info.outputPath("browse-restored.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await tool(page, "新建出图工程");
  await page.getByRole("button", { name: "收起项目菜单", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "当前出图工程" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("project-mobile.png") });
});

test("ordinary save, save-as, pending open and failed save never write the wrong target", async ({
  page,
}) => {
  test.setTimeout(90000);
  await browse(page);
  const before = (await state(page)).camera;
  const names = [`工程A-${Date.now()}`, `工程B-${Date.now()}`];
  await tool(page, "新建出图工程");
  await title(page, "保存后返回");
  await saveProject(page, names[0]!);
  await page
    .getByRole("region", { name: "当前出图工程" })
    .getByRole("button", { name: "另存为", exact: true })
    .click();
  const saveAs = page.getByRole("dialog", { name: "另存工程" });
  await saveAs.getByLabel("另存为名称").fill(names[1]!);
  await saveAs.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.locator(".save-state")).toHaveText("已保存");
  await tool(page, "项目");
  await page.getByLabel("已保存项目", { exact: true }).click();
  await page.getByRole("option", { name: names[0]!, exact: true }).click();
  await title(page, "B 的新修改");
  const saved: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/projects/save"))
      saved.push((r.postDataJSON() as { name: string }).name);
  });
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs++;
    await d.dismiss();
  });
  await page
    .getByRole("region", { name: "当前出图工程" })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.locator(".save-state")).toHaveText("已保存");
  expect(saved).toEqual([names[1]]);
  expect(dialogs).toBe(0);
  await page
    .getByRole("region", { name: "当前出图工程" })
    .getByRole("button", { name: "另存为", exact: true })
    .click();
  await saveAs.getByLabel("另存为名称").fill(names[0]!);
  await saveAs.getByRole("button", { name: "确定", exact: true }).click();
  expect(dialogs).toBe(1);
  expect(saved).toEqual([names[1]]);
  await saveAs.getByRole("button", { name: "取消", exact: true }).click();
  await title(page, "失败后保留");
  await tool(page, "返回浏览");
  const exit = page.getByRole("dialog");
  await page.route("**/api/projects/save", (r) =>
    r.fulfill({
      status: 500,
      json: {
        error: { code: "INTERNAL", message: "模拟保存失败", exitCode: 1 },
      },
    }),
  );
  await exit.getByRole("button", { name: "保存并返回", exact: true }).click();
  await expect(exit.getByRole("alert")).toContainText("模拟保存失败");
  expect((await state(page)).title).toBe("失败后保留");
  await page.unroute("**/api/projects/save");
  await exit.getByRole("button", { name: "保存并返回", exact: true }).click();
  await expect(page.locator(".save-state")).toHaveText("浏览地图");
  expect((await state(page)).camera).toEqual(before);
  await tool(page, "打开已有工程");
  await page.getByLabel("已保存项目", { exact: true }).click();
  await page.getByRole("option", { name: names[0]!, exact: true }).click();
  await page.getByRole("button", { name: "载入项目", exact: true }).click();
  await expect(page.locator(".save-state")).toHaveText("已保存");
  expect((await state(page)).title).toBe("保存后返回");
});

test("explicit project selection uses full precision; legacy JSON binds the fixed library and missing sources block export", async ({
  page,
}) => {
  test.setTimeout(90000);
  await browse(page);
  await tool(page, "新建出图工程");
  await selectProjectTrack(page, track);
  const project = await state(page);
  expect(project.tracks).toHaveLength(1);
  expect(project.tracks[0]!.entry).toBe(track);
  expect(
    await page.evaluate(() =>
      window.renderer!.data!.features.map((f) => f.geometry),
    ),
  ).toEqual([
    {
      type: "MultiLineString",
      coordinates: [
        [
          [100, 26],
          [101, 27],
          [102, 28],
        ],
        [
          [103, 29],
          [104, 30],
        ],
      ],
    },
    { type: "MultiPoint", coordinates: [[105, 31]] },
  ]);
  await tool(page, "返回浏览");
  await page
    .getByRole("button", { name: "放弃修改并返回", exact: true })
    .click();
  await tool(page, "打开已有工程");
  await page.locator("input[type=file]").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(page.locator(".map-errors [role=alert]")).toBeVisible();
  const legacy: Record<string, unknown> = structuredClone(project);
  legacy.schema = 1;
  legacy.archive = "/foreign/archive.sqlite3";
  legacy.title = "旧版工程";
  const style = legacy.style as Record<string, unknown>;
  delete style.features;
  delete style.overlays;
  delete style.power;
  await page.locator("input[type=file]").setInputFiles({
    name: "legacy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await expect(page.locator("[data-sonner-toaster]")).toContainText(
    "项目已载入",
  );
  const upgraded = await state(page);
  expect(upgraded.schema).toBe(3);
  expect(upgraded.archive).toBe(project.archive);
  expect(upgraded.tracks).toEqual(project.tracks);
  await tool(page, "项目");
  const missing: Project = {
    ...upgraded,
    schema: 2,
    tracks: [{ entry: "Default/missing.kml", sha256: "0".repeat(64) }],
  };
  page.once("dialog", (d) => d.accept());
  await page.locator("input[type=file]").setInputFiles({
    name: "missing.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(missing)),
  });
  await expect(page.locator(".map-errors [role=alert]")).toContainText(
    "missing.kml",
  );
  await tool(page, "出图");
  await expect(
    page.getByRole("button", { name: "导出 PNG", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("region", { name: "当前出图工程" })
      .getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
});
