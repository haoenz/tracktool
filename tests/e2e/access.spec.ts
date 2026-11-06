import { expect, test } from "@playwright/test";

test("shows an Access logout link only when enabled by the server", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
  await page.route(/\/map(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        "</head>",
        '<meta name="tracktool-logout" content="/cdn-cgi/access/logout" /></head>',
      ),
    });
  });
  await page.reload();
  const logout = page.getByRole("button", { name: "退出登录" });
  await expect(logout).toBeVisible();
  await logout.focus();
  await expect(logout).toBeFocused();
  await page.route("**/cdn-cgi/access/logout", (route) =>
    route.fulfill({ contentType: "text/plain", body: "已退出" }),
  );
  await logout.press("Enter");
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
});

test("explains an expired Access session without an automatic navigation or replay", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/bootstrap", async (route) => {
    requests++;
    expect(route.request().headers()["x-requested-with"]).toBe(
      "XMLHttpRequest",
    );
    await route.fulfill({
      status: 401,
      contentType: "text/html",
      body: "login required",
    });
  });
  await page.goto("/map");
  await expect(page.getByText(/登录已过期或访问被拒绝/)).toBeVisible();
  expect(requests).toBe(1);
  await expect(page).toHaveURL(/\/map$/);
});
