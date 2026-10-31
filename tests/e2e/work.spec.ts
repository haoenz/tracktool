import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  COMPRESSION_OPTIONS,
  EXPORT_FORMAT_OPTIONS,
  exportEncoding,
} from "../../src/shared/export-format.js";
import type { WorkTask } from "../../src/shared/work.js";
import { filterTracks, tool } from "./map-tools.js";

for (const format of EXPORT_FORMAT_OPTIONS) {
  test(`exports all compression profiles for ${format.label}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/map?panel=export");
    await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
    await page.getByRole("option", { name: "压缩包", exact: true }).click();
    await expect(
      page.getByRole("radio", { name: "极致压缩", exact: true }),
    ).toBeChecked();
    await page
      .getByRole("combobox", { name: "压缩包格式", exact: true })
      .click();
    await page.getByRole("option", { name: format.label, exact: true }).click();
    for (const compression of COMPRESSION_OPTIONS) {
      await page
        .getByRole("radio", { name: compression.label, exact: true })
        .click();
      const options = { format: format.value, compression: compression.value };
      const encoding = exportEncoding(options);
      await expect(
        page.getByText(`输出文件：${encoding.filename}`, { exact: true }),
      ).toBeVisible();
      const request = page.waitForRequest("**/api/work/preview");
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出", exact: true }).click();
      expect((await request).postDataJSON().options).toMatchObject(options);
      const download = await downloading;
      expect(download.suggestedFilename()).toBe(encoding.filename);
      const bytes = await readFile((await download.path())!);
      expect(bytes.length).toBeGreaterThan(0);
      // Extreme xz compression can outrun the default assertion timeout.
      await expect(page.getByRole("heading", { name: "下载完成" })).toBeVisible(
        { timeout: 20_000 },
      );
      await expect(
        page.getByRole("button", { name: "导出", exact: true }),
      ).toBeEnabled();
    }
  });
}
async function upload(page: Page, name: string, buffer: Buffer) {
  const source = page.getByText("从当前设备上传", { exact: true });
  if (await source.isVisible()) await source.click();
  await page
    .getByLabel("上传输入文件")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await expect(
    page.getByRole("article", { name, exact: true }).last(),
  ).toBeVisible();
}
async function confirmImport(page: Page, count = 1) {
  const button = page.getByRole("button", {
    name: "导入",
    exact: true,
  });
  await expect(button).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('.import-file[data-stage="ready"]')).toHaveCount(
    count,
  );
  await button.click();
}
test("archive upload, backup, read-only download and real deletion use separate controls", async ({
  page,
}, info) => {
  await page.goto("/map?panel=library");
  await expect(page.getByText("轨迹分类图例")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "管理轨迹库" })).toHaveCount(0);
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  await expect(page.getByLabel("操作", { exact: true })).toHaveCount(0);
  await upload(
    page,
    "2026-10-01 网页归档.kml",
    await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
  );
  await confirmImport(page);
  await expect(
    page.getByText("共1个文件，已导入1个。", { exact: true }),
  ).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "导出轨迹", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
  await page.getByRole("option", { name: "压缩包", exact: true }).click();
  await expect(page.getByRole("heading", { name: "导出轨迹" })).toBeVisible();
  await expect(page.getByText("轨迹库中的全部轨迹")).toBeVisible();
  await expect(page.getByLabel("服务端输出文件（可选）")).toHaveCount(0);
  await expect(page.getByText("高级选项", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("export-zip-desktop.png") });
  const automaticDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await automaticDownload).suggestedFilename()).toBe("Archive.zip");
  const result = page.getByRole("region", { name: "导出结果" });
  await expect(result.getByRole("heading", { name: "下载完成" })).toBeVisible();
  await expect(result.getByText("Archive.zip", { exact: true })).toBeVisible();
  await expect(
    result.getByText("服务端输出位置", { exact: true }),
  ).toBeHidden();
  await expect(result.getByRole("button", { name: "刷新轨迹库" })).toHaveCount(
    0,
  );
  await expect(result.getByText("已下载", { exact: true })).toBeVisible();
  await expect(
    result.getByRole("button", { name: "下载", exact: true }),
  ).toHaveCount(0);
  await expect(result).toContainText("临时文件已清理");
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await event).suggestedFilename()).toBe("Archive.zip");
  await expect(result.getByRole("heading", { name: "下载完成" })).toBeVisible();
  await tool(page, "轨迹库");
  if (!(await page.getByLabel("筛选轨迹", { exact: true }).isVisible()))
    await tool(page, "轨迹库");
  await filterTracks(page, "网页归档");
  await page
    .getByRole("button", {
      name: "查看 Train/2026-10/2026-10-01 网页归档.kml",
      exact: true,
    })
    .click();
  const downloading = page.waitForEvent("download");
  const taskRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/work/"))
      taskRequests.push(request.url());
  });
  await page.getByRole("button", { name: "下载轨迹", exact: true }).click();
  await expect(page.getByLabel("历史版本 ID（留空下载当前版本）")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "轨迹详情" }).locator(".task-detail"),
  ).toHaveCount(0);
  const downloaded = await downloading;
  expect(taskRequests).toEqual([]);
  expect(downloaded.suggestedFilename()).toBe("2026-10-01 网页归档.kml");
  expect(await readFile((await downloaded.path())!)).toEqual(
    await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
  );
  await page.getByRole("button", { name: "更多轨迹操作", exact: true }).click();
  await page.getByRole("button", { name: "删除轨迹", exact: true }).click();

  await expect(page.getByRole("dialog")).toContainText(
    "将永久删除这条轨迹及其 1 个历史版本。",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.getByText("轨迹已删除", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "查看 Train/2026-10/2026-10-01 网页归档.kml",
      exact: true,
    }),
  ).toHaveCount(0);
});
test("library offers no standalone editor or independent file tools", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await expect(
    page.getByRole("button", { name: "筛选", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "库内行程编辑", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("当前行程与刷新", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("tab", { name: "独立文件工具" })).toHaveCount(0);
  await expect(page.getByLabel("上传输入文件")).toHaveCount(0);
  await expect(page.getByLabel("操作", { exact: true })).toHaveCount(0);
});

test("export apply failure leaves a retryable result instead of a pending state", async ({
  page,
}) => {
  await page.goto("/map?panel=export");
  await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
  await page.getByRole("option", { name: "压缩包", exact: true }).click();
  await page.route("**/api/work/tasks/*/apply", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请求失败（503）");
  await expect(page.getByRole("heading", { name: "导出失败" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/api/work/tasks/*/apply");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("Archive.zip");
  await expect(page.getByRole("heading", { name: "下载完成" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("interrupted export downloads remain retryable and are removed after receipt", async ({
  page,
}) => {
  await page.goto("/map?panel=export");
  await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
  await page.getByRole("option", { name: "压缩包", exact: true }).click();
  const acknowledgements: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/download-complete"))
      acknowledgements.push(request.url());
  });
  await page.route("**/api/work/tasks/*/download?*", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  const applied = page.waitForResponse(
    (response) =>
      response.url().endsWith("/apply") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const task = (await (await applied).json()) as WorkTask;
  await expect(page.getByRole("alert")).toContainText("请求失败（503）");
  expect(acknowledgements).toEqual([]);
  const readTask = async () =>
    (
      await page.request.get(`/api/work/tasks/${task.id}`, {
        headers: { "X-Tracktool-Token": "e2e" },
      })
    ).json() as Promise<WorkTask>;
  const result = await readTask();
  const file = result.output!.paths[0]!;
  expect(existsSync(file)).toBe(true);
  const bytes = await readFile(file);
  await page.unroute("**/api/work/tasks/*/download?*");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("region", { name: "导出结果" })
    .getByRole("button", { name: "下载", exact: true })
    .click();
  expect(await readFile((await (await downloaded).path())!)).toEqual(bytes);
  await expect(page.getByRole("heading", { name: "下载完成" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => existsSync(file)).toBe(false);
  await expect.poll(async () => (await readTask()).exportsCleaned).toBe(true);
  expect(acknowledgements).toHaveLength(1);
});

test("library entry points and favicon work on mobile", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map");
  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(icon).toBeTruthy();
  const response = await page.request.get(icon!);
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain("<svg");
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("button", { name: "归档状态", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "升级数据库", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "查看 Train/same.kml", exact: true })
    .click();
  await page.getByRole("button", { name: "下载轨迹", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "下载轨迹", exact: true }).last(),
  ).toBeVisible();
  expect(
    await page
      .getByRole("region", { name: "轨迹详情" })
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("track-detail-mobile.png") });
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await page.getByRole("button", { name: "导出轨迹", exact: true }).click();
  await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
  await page.getByRole("option", { name: "聚合KML", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "轨迹导出类型" }),
  ).toContainText("聚合导出");
  await expect(page.getByLabel("服务端输出目录（可选）")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("export-kml-mobile.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass("dark");
  await page.screenshot({
    path: info.outputPath("export-kml-mobile-dark.png"),
  });
  const kmlDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await kmlDownload).suggestedFilename()).toMatch(/\.kml$/i);
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeEnabled();
  const result = page.getByRole("region", { name: "导出结果" });
  await expect(result.getByRole("heading", { name: "下载完成" })).toBeVisible();
  expect(
    await result.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await result.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("export-result-mobile-dark.png"),
  });
  await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
  await page.getByRole("option", { name: "PNG图像", exact: true }).click();
  await expect(page.getByRole("region", { name: "出图设置" })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "导出类型", exact: true }),
  ).toBeHidden();
  await expect(page.getByLabel("操作", { exact: true })).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`upload imports valid files, skips duplicates and repairs conflicts at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map?panel=library");
    await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "选择文件", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("支持格式：.kml", { exact: true }),
    ).toBeVisible();
    const name = `2026-10-01 上传交互-${width}-${Date.now()}.kml`;
    const buffer = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/work/uploads?"))
        uploads.push(new URL(request.url()).searchParams.get("name")!);
    });
    await page.getByLabel("上传输入文件").setInputFiles([
      { name, mimeType: "application/octet-stream", buffer },
      {
        name: "2026-10-02 损坏.kml",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("<kml>"),
      },
    ]);
    const list = page.getByRole("region", { name: "上传文件列表" });
    await expect(list.getByRole("article")).toHaveCount(2);
    await expect(
      page.getByText("共2个文件，待导入1个，待处理1个。", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 20000 });
    const summary = page.locator(".import-actions > .import-summary");
    await expect(summary).toHaveCount(1);
    await expect(summary.getByRole("status")).toHaveText(
      "共2个文件，待导入1个，待处理1个。",
    );
    await expect(
      page.getByRole("button", {
        name: "全部重试",
        exact: true,
      }),
    ).toHaveCount(0);
    const summaryBox = (await summary.boundingBox())!;
    const listBox = (await list.boundingBox())!;
    expect(summaryBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
    const invalid = list.getByRole("article", { name: "2026-10-02 损坏.kml" });
    await expect(invalid.locator(".import-file-meta")).toContainText(
      "KML 格式或编码无效",
    );
    await expect(invalid.locator(".import-file-error")).toHaveCount(0);
    await expect(page.locator(".task-detail")).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "2026-10-02 损坏.kml 更多操作",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("group", { name: "活动标签", exact: true }),
    ).toContainText("活动标签 缺失");
    await expect(
      page.locator(".import-options-actions").getByRole("button"),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".import-options-dialog")
        .getByRole("button", { name: /^移除 |^重试 / }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    const remove = invalid.getByRole("button", {
      name: "移除 2026-10-02 损坏.kml",
      exact: true,
    });
    await expect(remove).toHaveText("");
    await expect(
      invalid.getByRole("button", {
        name: "重试 2026-10-02 损坏.kml",
        exact: true,
      }),
    ).toHaveText("");
    await expect(
      page.getByRole("button", { name: "导入", exact: true }),
    ).toBeDisabled();
    await remove.click();
    await expect(list.getByRole("article")).toHaveCount(1);
    await confirmImport(page);
    expect(uploads.filter((value) => value === name)).toHaveLength(1);
    await expect(
      page.getByText("共1个文件，已导入1个。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("轨迹库已刷新；当前地图选择和构图已保留。", {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`upload-${width}.png`) });
    await upload(page, name, buffer);
    await expect(
      page.getByText("共2个文件，已导入1个，跳过重复1个。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^导入 \d+ 条轨迹$/ }),
    ).toHaveCount(0);
    expect(
      await page
        .locator(".import-panel")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    const changed = Buffer.from(
      buffer.toString().replace("</kml>", "<!-- changed --> </kml>"),
    );
    await upload(page, name, changed);
    await expect(list).toContainText("名称冲突");
    await expect(list.locator(".import-file-error")).toHaveCount(0);
    await page
      .getByRole("button", { name: `${name} 更多操作`, exact: true })
      .click();
    const picker = page.getByRole("group", { name: "活动标签", exact: true });
    await expect(picker.getByRole("tab", { name: "轨道" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      picker.getByRole("button", { name: "火车", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    await expect(
      picker.getByRole("button", { name: "保留原标签" }),
    ).toHaveCount(0);
    await picker.getByRole("tab", { name: "轨道" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(picker.getByRole("tab", { name: "飞行" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(picker.locator('button[aria-pressed="true"]')).toHaveCount(0);
    await expect(
      picker.getByRole("button", { name: "火车", exact: true }),
    ).toHaveCount(0);
    await picker.getByRole("button", { name: "飞机", exact: true }).click();
    await expect(
      picker.getByRole("button", { name: "飞机", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: `${name} 更多操作`, exact: true })
      .click();
    await expect(picker.getByRole("tab", { name: "轨道" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await picker.getByRole("tab", { name: "飞行" }).click();
    await picker.getByRole("button", { name: "飞机", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const pending = list.getByRole("article", { name, exact: true }).last();
    await expect(pending).toHaveAttribute("data-stage", "ready");
    await expect(pending.locator(".import-category")).toHaveText("飞机");
    await page
      .getByRole("button", { name: `${name} 更多操作`, exact: true })
      .click();
    await expect(picker.getByRole("tab", { name: "飞行" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await picker.getByRole("tab", { name: "轨道" }).click();
    await expect(
      picker.getByRole("button", { name: "火车", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await picker.getByRole("button", { name: "火车", exact: true }).click();
    await expect(
      picker.getByRole("button", { name: "火车", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await picker.getByRole("tab", { name: "普通", exact: true }).click();
    const hiking = picker.getByRole("button", { name: "徒步", exact: true });
    await hiking.focus();
    await page.keyboard.press("Enter");
    await expect(hiking).toHaveAttribute("aria-pressed", "true");
    const bounds = await page.locator(".import-options-dialog").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const dialog = page.getByRole("dialog", { name: "编辑轨迹信息" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toBeVisible();
    if (width >= 640) {
      expect(Math.abs(bounds!.x + bounds!.width / 2 - width / 2)).toBeLessThan(
        2,
      );
      expect(Math.abs(bounds!.y + bounds!.height / 2 - 450)).toBeLessThan(2);
    } else {
      expect(Math.abs(bounds!.y + bounds!.height - 900)).toBeLessThan(2);
      expect(bounds!.width).toBe(width);
    }

    const actionsBox = (await page
      .locator(".import-options-actions")
      .boundingBox())!;
    const saveBox = (await page
      .getByRole("button", { name: "保存", exact: true })
      .boundingBox())!;
    expect(
      Math.abs(
        actionsBox.x +
          actionsBox.width -
          saveBox.x -
          saveBox.width -
          (width >= 640 ? 24 : 20),
      ),
    ).toBeLessThan(2);
    await page.screenshot({
      path: info.outputPath(`upload-tags-${width}.png`),
    });
    await page
      .getByLabel(`${name} 导入名称`, { exact: true })
      .fill(name.replace(".kml", "-修正.kml"));
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".import-options-dialog")).toHaveCount(0);
    await expect(pending).toHaveAttribute("data-stage", "ready");
    await expect(pending.locator("strong")).toHaveText(
      name.replace(".kml", "-修正.kml"),
    );
    await confirmImport(page);
    await expect(
      page.getByText("共3个文件，已导入2个，跳过重复1个。", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 20000 });
    await page
      .getByRole("button", { name: "查看已导入轨迹", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /^查看 .*上传交互.*-修正.kml$/ }),
    ).toHaveCount(1);
    await expect(page.locator(".track-row-name")).toHaveCount(2);
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(
      page.getByRole("group", { name: "导入范围", exact: true }),
    ).toContainText("本次导入：2条");
    await page
      .getByRole("button", { name: "清除导入筛选", exact: true })
      .click();
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await expect
      .poll(() => page.locator(".track-row-name").count())
      .toBeGreaterThan(2);
  });
}

test("upload summarizes input errors and shows unexpected error details in the file menu", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const detail = "临时存储空间不足，无法写入上传文件";
  await page.route("**/api/work/uploads?**", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("name") === "存储失败.kml"
    )
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: detail } }),
      });
    else await route.continue();
  });
  const buffer = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  const files = [
    { name: "格式错误.txt", buffer },
    { name: "缺少日期.kml", buffer },
    {
      name: "2026-10-01 空轨迹.kml",
      buffer: Buffer.from(
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>',
      ),
    },
    { name: "存储失败.kml", buffer },
  ];
  await page
    .getByLabel("上传输入文件")
    .setInputFiles(
      files.map((file) => ({ ...file, mimeType: "application/octet-stream" })),
    );
  await expect(page.getByText("共4个文件，待处理4个。")).toBeVisible({
    timeout: 20000,
  });
  for (const [name, label] of [
    ["格式错误.txt", "不支持的文件格式（仅支持 KML）"],
    ["缺少日期.kml", "文件名缺少日期（YYYY-MM-DD）"],
    ["2026-10-01 空轨迹.kml", "没有有效轨迹点"],
  ] as const) {
    const row = page.getByRole("article", { name, exact: true });
    await expect(row.locator(".import-file-meta")).toContainText(label);
    await expect(row.locator(".import-file-error")).toHaveCount(0);
  }
  const failed = page.getByRole("article", {
    name: "存储失败.kml",
    exact: true,
  });
  await expect(failed.locator(".import-file-meta")).toContainText("导入失败");
  await expect(failed.locator("details")).toHaveCount(0);
  await expect(page.getByText("查看错误详情", { exact: true })).toHaveCount(0);
  await expect(page.getByText(detail, { exact: true })).not.toBeVisible();
  await failed.getByRole("button", { name: "存储失败.kml 更多操作" }).click();
  const explanation = page
    .locator(".import-options-dialog")
    .getByRole("note", { name: "错误说明" });
  await expect(explanation).toContainText(detail);
  await expect(explanation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(detail, { exact: true })).not.toBeVisible();
});

test("upload requires a registered tag when the source tag is unregistered", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const name = `2026-10-01 未登记标签-${Date.now()}.kml`;
  const buffer = Buffer.from(
    (
      await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml", "utf8")
    ).replace("<value>火车</value>", "<value>未登记活动</value>"),
  );
  await upload(page, name, buffer);
  const row = page.getByRole("article", { name, exact: true });
  await expect(row.locator(".import-file-meta")).toContainText(
    "未登记的活动标签",
    { timeout: 20000 },
  );
  await expect(row).not.toContainText("需要处理");
  await expect(row).not.toContainText("无法识别活动标签");
  await expect(row.locator(".import-file-error")).toHaveCount(0);
  await expect(page.locator(".import-actions").getByRole("status")).toHaveText(
    "共1个文件，待处理1个。",
  );
  await page
    .getByRole("button", { name: `${name} 更多操作`, exact: true })
    .click();
  const picker = page.getByRole("group", { name: "活动标签", exact: true });
  const save = page.getByRole("button", { name: "保存", exact: true });
  await expect(picker).toContainText("活动标签 未登记活动（未登记）");
  await expect(picker.getByRole("button", { name: "保留原标签" })).toHaveCount(
    0,
  );
  await expect(picker.locator('button[aria-pressed="true"]')).toHaveCount(0);
  await expect(save).toBeDisabled();
  await picker.getByRole("tab", { name: "轨道" }).click();
  await expect(save).toBeDisabled();
  await picker.getByRole("button", { name: "火车", exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(row).toHaveAttribute("data-stage", "ready");
  await confirmImport(page);
  await expect(row).toContainText("已导入", { timeout: 20000 });
  await expect(row.locator(".import-category")).toHaveText("火车");
});

test("failed upload blocks the batch and retry rechecks before confirmation", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const names = [
    `2026-10-01 上传成功-${Date.now()}.kml`,
    `2026-10-01 上传失败-${Date.now()}.kml`,
  ];
  const uploads: string[] = [];
  await page.route("**/api/work/uploads?**", async (route) => {
    const name = new URL(route.request().url()).searchParams.get("name")!;
    uploads.push(name);
    if (
      name === names[1] &&
      uploads.filter((value) => value === name).length === 1
    )
      await route.abort();
    else await route.continue();
  });
  const buffer = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  await page.getByLabel("上传输入文件").setInputFiles(
    names.map((name) => ({
      name,
      mimeType: "application/octet-stream",
      buffer,
    })),
  );
  await expect(
    page.getByText("共2个文件，待导入1个，待处理1个。", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 20000 });
  const failed = page.getByRole("article", { name: names[1]!, exact: true });
  await expect(failed.locator(".import-file-meta")).toContainText(
    "上传连接中断",
  );
  await expect(failed.locator(".import-file-error")).toHaveCount(0);
  await failed
    .getByRole("button", { name: `重试 ${names[1]!}`, exact: true })
    .click();
  await confirmImport(page, 2);
  await expect(
    page.getByText("共2个文件，已导入2个。", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  expect(uploads.filter((name) => name === names[0])).toHaveLength(1);
  expect(uploads.filter((name) => name === names[1])).toHaveLength(2);
  await upload(page, `2026-10-01 新增-${Date.now()}.kml`, buffer);
  await confirmImport(page);
  await expect(
    page.getByText("共3个文件，已导入3个。", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  expect(uploads).toHaveLength(4);
});

for (const width of [1280, 390]) {
  test(`panel back arrows stay beside titles and return through detail at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map");
    await tool(page, "轨迹库");
    await page
      .getByRole("button", { name: "查看 Train/same.kml", exact: true })
      .click();
    const header = page
      .getByRole("complementary", { name: "地图控制面板" })
      .locator(":scope > .panel-header");
    const back = header.getByRole("button", { name: "返回列表", exact: true });
    await expect(back).toBeVisible();
    await expect(back).toHaveText("");
    await expect(back.locator("svg")).toHaveCount(1);
    const buttonBox = (await back.boundingBox())!;
    const titleBox = (await header.getByRole("heading").boundingBox())!;
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(titleBox.x);
    expect(
      Math.abs(
        buttonBox.y + buttonBox.height / 2 - titleBox.y - titleBox.height / 2,
      ),
    ).toBeLessThan(2);
    await page.getByRole("button", { name: "编辑轨迹", exact: true }).click();
    await header.getByRole("button", { name: "返回详情", exact: true }).click();
    await expect(
      header.getByRole("button", { name: "返回列表", exact: true }),
    ).toBeVisible();
    await header.getByRole("button", { name: "返回列表", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "筛选", exact: true }),
    ).toBeVisible();
    for (const name of ["上传轨迹", "导出轨迹", "设置"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(header).toHaveCount(0);
    }
    await tool(page, "轨迹库");
    await expect(
      page.getByRole("button", { name: "筛选", exact: true }),
    ).toBeVisible();
  });
}

test("lost import response can recover the same committed result", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  let committedTask = "";
  let recoveredTask = "";
  await page.route("**/api/work/tasks/*/apply", async (route) => {
    const response = await route.fetch();
    const task = (await response.json()) as { id: string };
    if (!committedTask) {
      committedTask = task.id;
      await route.abort();
    } else {
      recoveredTask = task.id;
      await route.fulfill({ response });
    }
  });
  await upload(
    page,
    `2026-10-01 断网响应-${Date.now()}.kml`,
    await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
  );
  await confirmImport(page);
  await expect(
    page.getByRole("button", { name: "查询导入结果", exact: true }),
  ).toBeVisible();
  const uncertain = page.locator('.import-file[data-stage="uncertain"]');
  await expect(uncertain.locator(".import-file-meta")).toContainText(
    "导入结果待确认",
  );
  await expect(uncertain.locator(".import-file-error")).toHaveCount(0);
  await expect(page.locator(".import-actions").getByRole("status")).toHaveText(
    "共1个文件，待确认1个。",
  );
  await expect(
    page.getByRole("button", { name: "全部重试", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "查询导入结果", exact: true }).click();
  await expect(
    page.getByText("共1个文件，已导入1个。", { exact: true }),
  ).toBeVisible();
  expect(recoveredTask).toBe(committedTask);
});

test("upload works without secure-context randomUUID and explains name conflicts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const name = `2026-10-01 HTTP上传-${Date.now()}.kml`;
  const buffer = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  await upload(page, name, buffer);
  await confirmImport(page);
  await expect(
    page.getByText("共1个文件，已导入1个。", { exact: true }),
  ).toBeVisible();
  await upload(
    page,
    name,
    Buffer.from(buffer.toString().replace("</kml>", "<!-- changed --> </kml>")),
  );
  await expect(
    page.getByRole("region", { name: "上传文件列表" }),
  ).toContainText("名称冲突");
  await expect(
    page.getByRole("button", { name: "全部重试", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `重试 ${name}`, exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test("import editor presents missing and empty tags inline without repeating the filename", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const xml = await readFile(
    "tests/ts/fixtures/m4/2026-10-01 轨迹.kml",
    "utf8",
  );
  const contents = [
    xml.replace('<Data name="TrackTags"><value>火车</value></Data>', ""),
    xml.replace("<value>火车</value>", "<value></value>"),
    xml.replace("<value>火车</value>", "<value>  </value>"),
  ];
  const names = contents.map((_, index) => `2026-10-01 缺失标签${index}.kml`);
  await page.getByLabel("上传输入文件").setInputFiles(
    contents.map((content, index) => ({
      name: names[index]!,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(content),
    })),
  );
  await expect(
    page.getByText("共3个文件，待处理3个。", { exact: true }),
  ).toBeVisible();
  for (const name of names) {
    await page
      .getByRole("button", { name: `${name} 更多操作`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "编辑轨迹信息",
      exact: true,
    });
    await expect(dialog.getByText(name, { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByLabel(`${name} 导入名称`, { exact: true }),
    ).toHaveValue(name);
    const legend = dialog.locator("legend");
    await expect(legend).toHaveText("活动标签 缺失");
    const missing = legend.getByText("缺失", { exact: true });
    await expect(missing).toHaveCSS("color", "oklch(0.577 0.245 27.325)");
    await expect(
      dialog.getByText("请选择已登记的活动标签后保存。", { exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "保存", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

test("desktop import footer aligns right, fits content and scrolls with the panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const files = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      name: `不支持的文件${index}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("fixture"),
    }));
  await page.getByLabel("上传输入文件").setInputFiles(files(2));
  await expect(
    page.getByText("共2个文件，待处理2个。", { exact: true }),
  ).toBeVisible();
  const panel = page.locator(".map-controls");
  const footer = page.locator(".import-actions");
  const button = footer.getByRole("button", { name: "导入", exact: true });
  await expect(button).toBeDisabled();
  await expect(page.locator(".import-summary")).toHaveCSS(
    "text-align",
    "right",
  );
  await expect(footer).toHaveCSS("position", "static");
  const panelBox = (await panel.boundingBox())!;
  const footerBox = (await footer.boundingBox())!;
  const buttonBox = (await button.boundingBox())!;
  expect(
    panelBox.y + panelBox.height - footerBox.y - footerBox.height,
  ).toBeLessThanOrEqual(16);
  expect(
    Math.abs(buttonBox.x + buttonBox.width - footerBox.x - footerBox.width),
  ).toBeLessThan(2);
  await page.getByLabel("上传输入文件").setInputFiles(files(16));
  await expect(
    page.getByText("共18个文件，待处理18个。", { exact: true }),
  ).toBeAttached();
  await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(button).toBeInViewport();
  const bottom = (await footer.boundingBox())!;
  await panel.evaluate((element) => {
    element.scrollTop -= 80;
  });
  await expect
    .poll(async () => (await footer.boundingBox())!.y - bottom.y)
    .toBeCloseTo(80, 0);
});
