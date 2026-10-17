import { filterTracks } from "./map-tools.js";
import { tool } from "./map-tools.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
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
async function confirm(page: Page) {
  await expect(
    page
      .locator(".task-detail")
      .getByRole("button", { name: "下载", exact: true })
      .first(),
  ).toBeVisible({ timeout: 20000 });
}
test("media links return to the map with no web media tools", async ({
  page,
}) => {
  await page.goto("/media");
  await expect(page).toHaveURL(/\/map$/);
  await expect(
    page.getByRole("button", { name: "展开项目菜单" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "媒体", exact: true }),
  ).toHaveCount(0);
});
test("archive upload, backup, read-only download and real deletion use separate controls", async ({
  page,
}) => {
  await page.goto("/archive");
  await expect(page.getByText("轨迹分类图例")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "管理轨迹库" })).toHaveCount(0);
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  await expect(page.getByLabel("操作", { exact: true })).toHaveCount(0);
  await upload(
    page,
    "2026-10-01 网页归档.kml",
    await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
  );
  await expect(
    page.getByText("已导入 1 条轨迹。", { exact: true }),
  ).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "导出轨迹", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
  await page.getByRole("option", { name: "ZIP", exact: true }).click();
  const automaticDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await automaticDownload).suggestedFilename()).toBe("Archive.zip");
  await confirm(page);
  const event = page.waitForEvent("download");
  await page
    .locator(".task-detail")
    .getByRole("button", { name: "下载", exact: true })
    .first()
    .click();
  expect((await event).suggestedFilename()).toBe("Archive.zip");
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
  const kmlDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await kmlDownload).suggestedFilename()).toMatch(/\.kml$/i);
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeEnabled();
  await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
  await page.getByRole("option", { name: "PNG图像", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "新建出图工程", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toHaveCount(0);
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
      page.getByText("已导入 1 条轨迹。 1 个文件待处理。", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(list).toContainText("需要处理");
    await expect(page.locator(".task-detail")).toHaveCount(0);
    await page
      .getByRole("button", {
        name: "2026-10-02 损坏.kml 更多操作",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "移除 2026-10-02 损坏.kml", exact: true })
      .click();
    await expect(list.getByRole("article")).toHaveCount(1);
    expect(uploads.filter((value) => value === name)).toHaveLength(1);
    await expect(
      page.getByText("已导入 1 条轨迹。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("轨迹库已刷新；当前地图选择和构图已保留。", {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`upload-${width}.png`) });
    await upload(page, name, buffer);
    await expect(
      page.getByText("已导入 1 条轨迹，跳过 1 条重复轨迹。", { exact: true }),
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
    await page
      .getByRole("button", { name: `${name} 更多操作`, exact: true })
      .click();
    await page
      .getByLabel(`${name} 导入名称`, { exact: true })
      .fill(name.replace(".kml", "-修正.kml"));
    await page.getByRole("button", { name: "保存并重试", exact: true }).click();
    await expect(
      page.getByText("已导入 2 条轨迹，跳过 1 条重复轨迹。", { exact: true }),
    ).toBeVisible();
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

test("failed upload retries only the failed file and preserves successful imports", async ({
  page,
}) => {
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
    page.getByText("已导入 1 条轨迹。 1 个文件待处理。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试失败文件", exact: true }).click();
  await expect(
    page.getByText("已导入 2 条轨迹。", { exact: true }),
  ).toBeVisible();
  expect(uploads.filter((name) => name === names[0])).toHaveLength(1);
  expect(uploads.filter((name) => name === names[1])).toHaveLength(2);
  await upload(page, `2026-10-01 新增-${Date.now()}.kml`, buffer);
  await expect(
    page.getByText("已导入 3 条轨迹。", { exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("button", { name: "查询导入结果", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查询导入结果", exact: true }).click();
  await expect(
    page.getByText("已导入 1 条轨迹。", { exact: true }),
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
  await expect(
    page.getByText("已导入 1 条轨迹。", { exact: true }),
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
    page.getByRole("button", { name: "重试失败文件", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
