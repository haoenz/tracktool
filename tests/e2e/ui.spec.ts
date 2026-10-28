import { expect, test } from "@playwright/test";
import type {} from "../../src/drawing/globals.js";

test("map menu and print bar support keyboard use", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/map");
  await page.locator(".app-icon").focus();
  await page.keyboard.press("Enter");
  const print = page.getByRole("button", { name: "出图", exact: true });
  await expect(print).toBeVisible();
  await print.focus();
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
