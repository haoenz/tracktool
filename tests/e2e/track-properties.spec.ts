import { test, expect } from "@playwright/test";
import { tool, pickEditorPoint } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";

test("visibility has no processing or project-selection side effects", async ({
  page,
}) => {
  const selectionRequests: string[] = [];
  page.on("request", (r) => {
    if (
      r.url().includes("/api/selection") ||
      r.url().includes("selection-copy")
    )
      selectionRequests.push(r.url());
  });
  await page.goto("/map");
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("tab", { name: "轨迹处理", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "批量操作", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "切换当前列表可见性", exact: true })
    .click();
  await page
    .getByRole("button", { name: "显示 索引未命中", exact: true })
    .click();
  await page
    .getByRole("button", { name: "切换当前列表可见性", exact: true })
    .click();
  expect(selectionRequests).toEqual([]);
  await expect(page.getByRole("button", { name: /处理已选轨迹/ })).toHaveCount(
    0,
  );
  await tool(page, "新建出图工程");
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.tracks.length))
    .toBe(0);
  await page.getByRole("combobox", { name: "出图轨迹", exact: true }).click();
  await page
    .getByRole("combobox", { name: "搜索出图轨迹", exact: true })
    .fill("Train/same.kml");
  await page
    .getByRole("option", { name: "Train/same.kml", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.tracks.length))
    .toBe(1);
  const count = selectionRequests.length;
  await tool(page, "轨迹库");
  await page
    .getByRole("button", { name: "切换当前列表可见性", exact: true })
    .click();
  await tool(page, "出图");
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.tracks.length))
    .toBe(1);
  expect(selectionRequests).toHaveLength(count);
});

test("single-track panel previews and saves tag, split and cleanup with history", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/map");
  await tool(page, "轨迹库");
  await page
    .getByRole("button", { name: "查看 Train/same.kml", exact: true })
    .click();
  const dialog = page.getByRole("region", { name: "轨迹详情", exact: true });
  await expect(
    dialog.getByRole("button", { name: "编辑轨迹", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole("button", { name: "历史记录", exact: true }),
  ).toBeHidden();
  await dialog.getByRole("button", { name: "编辑轨迹", exact: true }).click();
  const choose = async (name: string) => {
    const back = page.getByRole("button", {
      name: "返回编辑操作",
      exact: true,
    });
    if (await back.isVisible()) await back.click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.locator("#map-panel > .panel-header").getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(back).toHaveCount(1);
  };
  await choose("补高程");
  await expect(dialog).toContainText("缺失高程的轨迹片段查询海拔");
  await choose("修改标签");
  await dialog.getByRole("combobox", { name: "活动标签", exact: true }).click();
  await page.getByRole("option", { name: "徒步", exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toContainText("编辑已保存，旧版本保留在历史中。", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "返回编辑操作", exact: true }).click();
  await page.getByRole("button", { name: "返回详情", exact: true }).click();
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  // Use a longer independent fixture for split/prune.
  await page
    .getByRole("button", {
      name: "查看 Default/2026-10-01 中文.kml",
      exact: true,
    })
    .click();
  await dialog.getByRole("button", { name: "编辑轨迹", exact: true }).click();
  await choose("断开轨迹");
  await pickEditorPoint(page, 1);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toContainText("编辑已保存，旧版本保留在历史中。", {
    timeout: 20000,
  });
  await choose("删除轨迹点");
  await pickEditorPoint(page, 0);
  await pickEditorPoint(page, 0);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toContainText("编辑已保存，旧版本保留在历史中。", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "返回编辑操作", exact: true }).click();
  await page.getByRole("button", { name: "返回详情", exact: true }).click();
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await page
    .getByRole("button", {
      name: "查看 Default/2026-10-01 中文.kml",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("button", { name: "历史记录", exact: true })
    .click();
  await dialog
    .getByRole("list", { name: "操作时间线" })
    .getByRole("button")
    .last()
    .click();
  await expect(
    dialog.getByRole("button", { name: "下载此时的 KML", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
