import { expect, test } from "@playwright/test";
test("loads configuration, refreshes and survives direct navigation on a narrow viewport", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const responsePromise = page.waitForResponse("**/api/config");
  await page.goto("/settings");
  const body = await (await responsePromise).text();
  expect(body).not.toContain("synthetic-e2e-private-key");
  expect(body).not.toContain("synthetic-private-extra");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("/示例/轨迹归档", { exact: true })).toBeVisible();
  await expect(page.getByText("已配置", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "刷新" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByText("/示例/轨迹归档", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("reports a failure and lets the user retry", async ({ page }) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "USER_INPUT",
          message: "配置文件不是有效 JSON",
          exitCode: 1,
        },
      }),
    }),
  );
  await page.goto("/settings");
  await expect(page.getByText("配置文件不是有效 JSON")).toBeVisible();
  await page.unroute("**/api/config");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("/示例/轨迹归档", { exact: true })).toBeVisible();
});
