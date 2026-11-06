import { expect, test } from "@playwright/test";
import type {} from "../../src/drawing/globals.js";

test("map menu and print bar support keyboard use", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/map");
  await page.locator(".app-icon").focus();
  await page.keyboard.press("Enter");
  const exportButton = page.getByRole("button", {
    name: "导出轨迹",
    exact: true,
  });
  await expect(exportButton).toBeVisible();
  await exportButton.focus();
  await page.keyboard.press("Tab");
  const settings = page.getByRole("button", { name: "设置", exact: true });
  await expect(settings).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await exportButton.focus();
  await page.keyboard.press("Enter");
  const exportKind = page.getByRole("combobox", {
    name: "导出类型",
    exact: true,
  });
  await exportKind.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", { name: "压缩包", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: "PNG图像", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const bar = page.getByRole("region", { name: "出图设置" });
  await expect(bar).toBeVisible();
  const ratio = bar.getByRole("combobox", { name: "画框比例", exact: true });
  await ratio.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  expect(errors).toEqual([]);
});
