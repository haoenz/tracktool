import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("mobile handle drags, snaps, cycles and keeps icon closing", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  const panel = page.getByRole("complementary", { name: "地图控制面板" });
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  const app = page.locator(".map-app");
  await expect(handle).toBeVisible();
  await expect(
    page.getByRole("button", { name: "半屏", exact: true }),
  ).toHaveCount(0);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 22);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 380, { steps: 12 });
  await page.mouse.up();
  await expect(app).toHaveAttribute("data-sheet", "collapsed");
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeLessThan(60);
  await handle.tap();
  await expect(app).toHaveAttribute("data-sheet", "half");
  await handle.press("End");
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(600);
  await panel.evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect(handle).toBeInViewport();
  await handle.press("ArrowDown");
  await expect(app).toHaveAttribute("data-sheet", "half");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(handle).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(handle).toBeHidden();
  await expect(panel).toBeVisible();
});
