import { expect, test } from "@playwright/test";
import { tool } from "./map-tools.js";

test("settings contain map controls only and server configuration writes require CLI", async ({
  page,
}, info) => {
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
  for (const name of [
    "日志级别",
    "备份目录名",
    "Google API 密钥",
    "修改设置",
    "配置项",
    "保存设置",
  ])
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  expect(requests.some((u) => u.endsWith("/api/config"))).toBe(false);
  const results = await page.evaluate(async () => {
    const headers = {
      "X-Tracktool-Token": document.querySelector<HTMLMetaElement>(
        'meta[name="tracktool-token"]',
      )!.content,
      "Content-Type": "application/json",
    };
    const before = await (await fetch("/api/config", { headers })).json();
    const statuses = [];
    for (const key of [
      "log_level",
      "kml_backup_dir_name",
      "google_api_key",
      "track_tag.Default",
      "archive_path",
    ])
      statuses.push(
        (
          await fetch("/api/work/settings", {
            method: "POST",
            headers,
            body: JSON.stringify({ key, value: "changed" }),
          })
        ).status,
      );
    return {
      statuses,
      before,
      after: await (await fetch("/api/config", { headers })).json(),
    };
  });
  expect(results.statuses).toEqual([403, 403, 403, 403, 403]);
  expect(results.after).toEqual(results.before);
  expect(JSON.stringify(results.before)).not.toContain(
    "synthetic-e2e-private-key",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "地图工具", exact: true });
  await expect(nav.getByRole("button")).toHaveText(["轨迹", "设置"]);
  await expect(page.locator(".workspace-tools")).toHaveCount(0);
  await tool(page, "轨迹库");
  await expect(page.getByRole("tab")).toHaveText([
    "轨迹库",
    "轨迹处理",
    "轨迹导出",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("two-tools-mobile.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});

test("bootstrap errors remain actionable without exposing server settings", async ({
  page,
}) => {
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: {
          code: "USER_INPUT",
          message: "配置文件不是有效 JSON",
          exitCode: 1,
        },
      },
    }),
  );
  await page.goto("/settings");
  await expect(
    page.getByText("配置文件不是有效 JSON", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("配置项", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/bootstrap");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
});
