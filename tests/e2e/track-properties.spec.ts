import { test, expect } from "@playwright/test";
import { tool } from "./map-tools.js";
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
    page.getByRole("button", { name: "轨迹导出", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "隐藏全部", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Train/same.kml", exact: true })
    .check();
  await page.getByRole("button", { name: "显示全部", exact: true }).click();
  expect(selectionRequests).toEqual([]);
  await expect(page.getByRole("button", { name: /处理已选轨迹/ })).toHaveCount(
    0,
  );
  await tool(page, "新建出图工程");
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.tracks.length))
    .toBe(0);
  await page
    .getByRole("combobox", { name: "出图轨迹", exact: true })
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
  await page.getByRole("button", { name: "隐藏全部", exact: true }).click();
  await tool(page, "出图");
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.tracks.length))
    .toBe(1);
  expect(selectionRequests).toHaveLength(count);
});

test("single-track modal previews and saves tag, split and cleanup with history", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/map");
  await tool(page, "轨迹库");
  await page
    .getByRole("button", { name: "查看 Train/same.kml", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "轨迹详情", exact: true });
  for (const name of ["拆分", "清理", "补高程", "修改标签"])
    await expect(
      dialog.getByRole("button", { name, exact: true }),
    ).toBeEnabled();
  await dialog.getByRole("button", { name: "补高程", exact: true }).click();
  await expect(dialog).toContainText("生成预览会使用后台配置的高程服务");
  await dialog.getByRole("button", { name: "修改标签", exact: true }).click();
  await dialog.getByRole("combobox", { name: "活动标签", exact: true }).click();
  await page.getByRole("option", { name: "徒步", exact: true }).click();
  await dialog
    .getByRole("button", { name: "生成编辑预览", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "确认保存到轨迹", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await dialog
    .getByRole("button", { name: "确认保存到轨迹", exact: true })
    .click();
  await expect(dialog).toContainText("已保存到当前轨迹，旧版本保留", {
    timeout: 20000,
  });
  await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
  // Use a longer independent fixture for split/prune.
  await page
    .getByRole("button", {
      name: "查看 Default/2026-10-01 中文.kml",
      exact: true,
    })
    .click();
  await dialog.getByRole("button", { name: "拆分", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "断点序号", exact: true })
    .fill("1");
  await dialog
    .getByRole("button", { name: "生成编辑预览", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "确认保存到轨迹", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await dialog
    .getByRole("button", { name: "确认保存到轨迹", exact: true })
    .click();
  await expect(dialog).toContainText("已保存到当前轨迹，旧版本保留", {
    timeout: 20000,
  });
  await dialog.getByRole("button", { name: "清理", exact: true }).click();
  await dialog
    .getByRole("button", { name: "生成编辑预览", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "确认保存到轨迹", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await dialog
    .getByRole("button", { name: "确认保存到轨迹", exact: true })
    .click();
  await expect(dialog).toContainText("已保存到当前轨迹，旧版本保留", {
    timeout: 20000,
  });
  await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page
    .getByRole("button", {
      name: "查看 Default/2026-10-01 中文.kml",
      exact: true,
    })
    .click();
  await dialog.getByText("该轨迹的处理记录", { exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: /^保存 · 已完成/ }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
