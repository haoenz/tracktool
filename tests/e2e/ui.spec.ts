import { expect, test } from "@playwright/test";
import { tool } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";

test("search selection and project dialogs support keyboard use and restore focus", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/map?panel=library");
  await tool(page, "新建出图工程");
  const tracks = page.getByRole("combobox", { name: "出图轨迹", exact: true });
  await tracks.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("combobox", {
    name: "搜索出图轨迹",
    exact: true,
  });
  await expect(search).toBeFocused();
  await search.fill("Train/same.kml");
  await expect(
    page.getByRole("option", { name: "Train/same.kml", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.tracks.length))
    .toBe(1);
  await page.keyboard.press("Escape");
  await expect(tracks).toBeFocused();
  await page
    .getByRole("button", { name: "移除 Train/same.kml", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.tracks.length))
    .toBe(0);
  const saveAs = page.getByRole("button", { name: "另存为", exact: true });
  await saveAs.click();
  const dialog = page.getByRole("dialog", { name: "另存工程", exact: true });
  const name = dialog.getByLabel("另存为名称");
  await expect(name).toBeFocused();
  await name.fill("");
  await expect(
    dialog.getByRole("button", { name: "确定", exact: true }),
  ).toBeDisabled();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(saveAs).toBeFocused();
  expect(errors).toEqual([]);
});
