import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { Page } from "@playwright/test";
async function choose(page: Page, name: string) {
  await page.getByLabel("操作", { exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}
async function upload(page: Page, name: string, buffer: Buffer) {
  await page.getByText("从当前设备上传", { exact: true }).click();
  await page
    .getByLabel("上传输入文件")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await expect(page.getByLabel("已选输入（每行一个完整路径）")).toHaveValue(
    new RegExp(name.replaceAll(".", "\\.")),
  );
}
async function confirm(page: Page) {
  await page.getByRole("button", { name: "确认执行此预览" }).click();
  await expect(
    page.getByRole("button", { name: "下载", exact: true }).first(),
  ).toBeVisible({ timeout: 20000 });
}
test("media upload → review → write → reload → download works on mobile without exposing secrets", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/media");
  await choose(page, "设置元数据");
  await page.getByLabel("自定义标签（每行 NAME=VALUE）").fill("IPTC:City=杭州");
  const jpg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  await upload(page, "手机照片.jpg", jpg);
  await page.getByRole("button", { name: "生成操作预览" }).click();
  await expect(
    page.getByRole("button", { name: "确认执行此预览" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "确认执行此预览" }),
  ).toBeVisible();
  await confirm(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).first().click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toBe("手机照片.jpg");
  expect((await readFile((await downloaded.path())!)).length).toBeGreaterThan(
    jpg.length,
  );
  await page.reload();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await page.content()).not.toContain("synthetic-e2e-private-key");
  expect(errors).toEqual([]);
});
test("archive upload and tagging preview feed real push, filtering and backup downloads", async ({
  page,
}) => {
  await page.goto("/archive");
  await choose(page, "轨迹入库");
  await page.getByLabel("轨迹分类", { exact: true }).first().click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await page.getByText("保留入库的源文件", { exact: true }).click();
  await upload(
    page,
    "2026-10-01 网页归档.kml",
    await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
  );
  await page.getByRole("button", { name: "生成操作预览" }).click();
  await page.getByRole("button", { name: "确认执行此预览" }).click();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "刷新归档" }).click();
  await page.getByLabel("筛选归档轨迹").fill("网页归档");
  await expect(
    page.getByText("2026-10-01 网页归档.kml", { exact: true }),
  ).toBeVisible();
  await choose(page, "ZIP 备份");
  await page.getByRole("button", { name: "生成操作预览" }).click();
  await confirm(page);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).first().click();
  expect((await event).suggestedFilename()).toBe("Archive.zip");
});
test("track editing reports malformed input as partial and allows a fresh retry", async ({
  page,
}) => {
  await page.goto("/tracks");
  await choose(page, "检查分类");
  await upload(page, "bad.kml", Buffer.from("<kml>"));
  await page.getByRole("button", { name: "开始检查" }).click();
  await expect(page.getByText("部分失败", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByRole("button", { name: "确认执行此预览" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "重新预览 / 重试" }).click();
  await expect(page.getByText("部分失败", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "在任务页查看" }).click();
  await expect(
    page.getByRole("heading", { name: "任务", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "重新预览 / 重试" }),
  ).toBeVisible();
});
test("shared settings save a config value and refresh the existing public summary", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByLabel("配置项", { exact: true }).click();
  await page.getByRole("option", { name: "日志级别", exact: true }).click();
  await page.getByLabel("新值", { exact: true }).fill("VERBOSE");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
  await expect(page.getByText("VERBOSE", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("VERBOSE", { exact: true })).toBeVisible();
});
test("edited KML can be inspected on a map and its upload batch remains manageable after refresh", async ({
  page,
}) => {
  await page.goto("/tracks");
  await choose(page, "设置活动标签");
  await page.getByLabel("活动标签", { exact: true }).click();
  await page.getByRole("option", { name: "徒步", exact: true }).click();
  await page.getByText("缺少活动标签时创建", { exact: true }).click();
  await upload(
    page,
    "2026-10-01 地图检查.kml",
    await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
  );
  await page.getByRole("button", { name: "生成操作预览" }).click();
  await confirm(page);
  await page.getByRole("button", { name: "地图检查处理结果" }).click();
  await expect(
    page.getByRole("region", { name: "轨迹结果地图" }),
  ).toBeVisible();
  await expect(
    page.locator('[aria-label="轨迹结果地图"] .map-stage'),
  ).toHaveAttribute("data-status", "ready", { timeout: 20000 });
  await page.screenshot({
    path: path.join(os.tmpdir(), "tracktool-m6-tracks.png"),
    fullPage: true,
  });
  await page.goto("/tasks");
  await page.reload();
  await expect(page.getByText("暂存文件", { exact: true })).toBeVisible();
  await expect(page.getByText(/2026-10-01 地图检查.kml ·/)).toBeVisible();
});
