import { tool } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";
import { test, expect, type Page } from "@playwright/test";
import type { Project } from "../../src/shared/project.js";

const track = "Train/same.kml";

async function browse(page: Page) {
  await page.goto("/map");
  await expect(
    page.getByRole("checkbox", { name: track, exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => window.renderer?.map.loaded());
}
async function state(page: Page) {
  return page.evaluate(() => window.renderer!.state);
}
async function title(page: Page, value: string) {
  await tool(page, "工程样式");
  await page.getByLabel("标题", { exact: true }).fill(value);
}
async function overviewVisible(page: Page) {
  return page.evaluate(() =>
    window
      .renderer!.map.getStyle()
      .layers.some(
        (l) =>
          l.id.startsWith("overview-") &&
          l.type === "line" &&
          window.renderer!.map.getPaintProperty(l.id, "line-opacity") !== 0,
      ),
  );
}
test("explicit project entry preserves browse camera, selection and filter; only real edits prompt", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await browse(page);
  await expect(page.locator(".map-stage")).not.toHaveClass(/export-preview/);
  await expect(
    page.getByRole("button", { name: "导出 PNG", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("checkbox", { name: track, exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: track, exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: `查看 ${track}`, exact: true })
    .click();
  await page.getByLabel("筛选轨迹", { exact: true }).fill("Train");
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [111, 32], zoom: 6.2 }),
  );
  const before = await state(page);
  await expect(page.locator(".save-state")).toHaveText("浏览地图", {
    timeout: 20000,
  });
  await tool(page, "新建出图工程");
  await expect(page.locator(".map-stage")).toHaveClass(/export-preview/);
  expect((await state(page)).camera).toEqual(before.camera);
  expect((await state(page)).tracks).toEqual(before.tracks);
  await expect(page.locator(".save-state")).toHaveText("出图工程");
  await tool(page, "返回浏览");
  await expect(page.locator(".save-state")).toHaveText("浏览地图", {
    timeout: 20000,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tool(page, "新建出图工程");
  await title(page, "测试修改");
  await expect(page.locator(".save-state")).toHaveText("未保存");
  await page.getByLabel("标题", { exact: true }).fill("");
  await expect(page.locator(".save-state")).toHaveText("出图工程");
  await page.getByLabel("标题", { exact: true }).fill("保留的工程修改");
  await tool(page, "设置");
  await page.getByLabel("底图", { exact: true }).click();
  await page
    .locator(".ant-select-item-option-content")
    .getByText("深色矢量", { exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).style.basemap, { timeout: 20000 })
    .toBe("dark");
  await page.evaluate(() =>
    window.renderer!.map.jumpTo({ center: [120, 40], zoom: 9 }),
  );
  await tool(page, "轨迹库");
  await page.getByLabel("筛选轨迹", { exact: true }).fill("Train");
  await page.getByLabel("筛选轨迹", { exact: true }).fill("same");
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: track, exact: true }),
  ).not.toBeChecked();
  await tool(page, "出图");
  await page.getByRole("switch", { name: "出图预览", exact: true }).click();
  await expect.poll(() => overviewVisible(page)).toBe(false);
  await tool(page, "返回浏览");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(page.locator(".save-state")).toHaveText("未保存");
  expect((await state(page)).title).toBe("保留的工程修改");
  await tool(page, "返回浏览");
  await page
    .getByRole("button", { name: "放弃修改并返回", exact: true })
    .click();
  await expect(page.locator(".save-state")).toHaveText("浏览地图", {
    timeout: 20000,
  });
  expect((await state(page)).camera).toEqual(before.camera);
  expect((await state(page)).tracks).toEqual(before.tracks);
  expect((await state(page)).style).toEqual(before.style);
  await expect(page.getByLabel("筛选轨迹", { exact: true })).toHaveValue(
    "Train",
  );
  await expect(
    page.getByRole("checkbox", { name: track, exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: `查看 ${track}`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => overviewVisible(page)).toBe(true);
  await expect(page.locator(".ant-modal-mask")).not.toBeVisible();
  await page.screenshot({
    path: info.outputPath("browse-restored.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await tool(page, "新建出图工程");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "返回浏览", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "收起控制面板", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "地图控制面板" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("project-mobile.png"),
    animations: "disabled",
  });
});

test("failed save and cancelled overwrite retain edits; save and return restores browse; reopen is clean", async ({
  page,
}) => {
  test.setTimeout(90000);
  await browse(page);
  const before = (await state(page)).camera;
  await tool(page, "新建出图工程");
  await title(page, "保存后返回");
  await tool(page, "返回浏览");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("项目名称", { exact: true }).fill("P4保存往返");
  await page.route("**/api/projects/save", (route) =>
    route.fulfill({
      status: 500,
      json: {
        error: { code: "INTERNAL", message: "模拟保存失败", exitCode: 1 },
      },
    }),
  );
  await dialog.getByRole("button", { name: "保存并返回", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("模拟保存失败");
  await expect(page.locator(".save-state")).toHaveText("未保存");
  expect((await state(page)).title).toBe("保存后返回");
  await page.unroute("**/api/projects/save");
  await dialog.getByRole("button", { name: "保存并返回", exact: true }).click();
  await expect(page.locator(".save-state")).toHaveText("浏览地图", {
    timeout: 20000,
  });
  expect((await state(page)).camera).toEqual(before);
  await tool(page, "打开已有工程");
  await page.getByLabel("已保存项目", { exact: true }).click();
  await page
    .locator(".ant-select-item-option-content")
    .getByText("P4保存往返", { exact: true })
    .click();
  await page.getByRole("button", { name: "载入项目", exact: true }).click();
  await expect(page.locator(".ant-message")).toContainText("项目已载入", {
    timeout: 20000,
  });
  await expect(page.locator(".save-state")).toHaveText("出图工程");
  expect((await state(page)).title).toBe("保存后返回");
  await title(page, "覆盖取消后仍保留");
  await tool(page, "返回浏览");
  page.once("dialog", (d) => d.dismiss());
  await dialog.getByRole("button", { name: "保存并返回", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".save-state")).toHaveText("未保存");
  expect((await state(page)).title).toBe("覆盖取消后仍保留");
  await dialog
    .getByRole("button", { name: "放弃修改并返回", exact: true })
    .click();
  await expect(page.locator(".save-state")).toHaveText("浏览地图", {
    timeout: 20000,
  });
});

test("highlight initializes full precision project; old JSON binds current library and missing sources block export", async ({
  page,
}) => {
  test.setTimeout(90000);
  await browse(page);
  await page
    .getByRole("button", { name: `查看 ${track}`, exact: true })
    .click();
  await expect(page.getByRole("region", { name: "轨迹详情" })).toContainText(
    track,
  );
  await tool(page, "新建出图工程");
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("checkbox", { name: track, exact: true }),
  ).toBeChecked();
  const project = await state(page);
  expect(project.tracks).toHaveLength(1);
  expect(project.tracks[0]!.entry).toBe(track);
  const exact = await page.evaluate(() => window.renderer!.data);
  expect(exact!.features.map((f) => f.geometry)).toEqual([
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
  await expect(page.locator(".save-state")).toHaveText("浏览地图", {
    timeout: 20000,
  });
  await tool(page, "打开已有工程");
  await page.locator("input[type=file]").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(page.locator(".map-errors [role=alert]")).toBeVisible();
  await expect(page.locator(".save-state")).toHaveText("浏览地图", {
    timeout: 20000,
  });
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
  await expect(page.locator(".ant-message")).toContainText("项目已载入", {
    timeout: 20000,
  });
  const upgraded = await state(page);
  expect(upgraded.schema).toBe(2);
  expect(upgraded.archive).toBe(project.archive);
  expect(upgraded.tracks).toEqual(project.tracks);
  await expect(page.locator(".save-state")).toHaveText("出图工程");
  const missing: Project = {
    ...upgraded,
    tracks: [{ entry: "Default/missing.kml", sha256: "0".repeat(64) }],
  };
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
  await tool(page, "项目");
  await page.getByLabel("项目名称", { exact: true }).fill("缺失源不可保存");
  await expect(
    page.getByRole("button", { name: "保存项目", exact: true }),
  ).toBeDisabled();
});
