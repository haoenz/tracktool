import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("upload checks the whole batch and applies only after confirmation", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  let releaseUpload!: () => void;
  let releasePreview!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const previews: number[] = [];
  const applies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/work/preview"))
      previews.push(request.postDataJSON().inputs.length);
    if (request.url().endsWith("/apply")) applies.push(request.url());
  });
  for (const [url, gate] of [
    ["**/api/work/uploads?**", uploadGate],
    ["**/api/work/preview", previewGate],
  ] as const) {
    await page.route(
      url,
      async (route) => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
  }
  const name = `2026-10-01 进度-${Date.now()}.kml`;
  const buffer = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  try {
    await page.getByLabel("上传输入文件").setInputFiles(
      [name, name.replace("进度", "后续")].map((name) => ({
        name,
        mimeType: "application/octet-stream",
        buffer,
      })),
    );
    const row = page.getByRole("article", { name, exact: true });
    await expect(row.getByRole("progressbar")).toBeVisible();
    await expect(
      page.locator(".import-actions").getByRole("status"),
    ).toHaveText("共2个文件，正在检查…");
    await expect(row).toContainText(/上传中 \d+%/);
    await expect(
      page.getByRole("button", { name: "导入", exact: true }),
    ).toHaveCount(0);
    releaseUpload();
    await expect(row).toContainText("正在检查轨迹");
    releasePreview();
    const confirm = page.getByRole("button", {
      name: "导入",
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    await expect(
      page.locator(".import-actions").getByRole("status"),
    ).toHaveText("共2个文件，待导入2个。");
    expect(previews).toEqual([2]);
    expect(applies).toEqual([]);
    await confirm.click();
    await expect(
      page.locator(".import-actions").getByRole("status"),
    ).toHaveText("共2个文件，已导入2个。", { timeout: 20000 });
    expect(applies).toHaveLength(1);

    const input = page.getByLabel("上传输入文件");
    const summary = page.locator(".import-actions").getByRole("status");
    const viewImported = page.getByRole("button", {
      name: "查看已导入轨迹",
      exact: true,
    });
    await input.setInputFiles([]);
    await expect(summary).toHaveText("共2个文件，已导入2个。");
    await expect(viewImported).toBeVisible();

    await input.setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer,
    });
    await expect(summary).toHaveText("共1个文件，跳过重复1个。");
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(viewImported).toHaveCount(0);

    await input.setInputFiles({
      name: name.replace("进度", "下一批"),
      mimeType: "application/octet-stream",
      buffer,
    });
    await expect(row).toHaveCount(0);
    await expect(summary).toHaveText("共1个文件，待导入1个。");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(summary).toHaveText("共1个文件，已导入1个。");
    expect(applies).toHaveLength(2);
  } finally {
    releaseUpload();
    releasePreview();
  }
});

test("stopping precheck never imports and retry still requires confirmation", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/work/preview",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  const applies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/apply")) applies.push(request.url());
  });
  const name = `2026-10-01 取消检查-${Date.now()}.kml`;
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  try {
    await page.getByLabel("上传输入文件").setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
    });
    await expect(page.getByRole("article")).toContainText("正在检查轨迹");
    const cancel = page.getByRole("button", { name: "取消检查", exact: true });
    const action = page.locator(".import-actions").getByRole("button");
    await expect(action).toHaveCount(1);
    await expect(action).toHaveText("检查中…");
    await expect(action).toBeDisabled();
    await expect(cancel).toHaveCount(0);
    await page.clock.runFor(999);
    await expect(cancel).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(action).toHaveCount(1);
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(action).toHaveText("正在取消…");
    await expect(action).toBeDisabled();
    await page.clock.resume();
    release();
    await expect(page.getByRole("article")).toContainText("已取消");
    expect(applies).toHaveLength(0);
    await page
      .getByRole("button", { name: `重试 ${name}`, exact: true })
      .click();
    const confirm = page.getByRole("button", {
      name: "导入",
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    expect(applies).toHaveLength(0);
    await confirm.click();
    await expect(page.getByRole("article")).toContainText("已导入");
  } finally {
    release();
  }
});

test("drag and drop checks a file before confirmation", async ({ page }) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const buffer = await readFile(
    "tests/ts/fixtures/m4/2026-10-01 轨迹.kml",
    "utf8",
  );
  const dataTransfer = await page.evaluateHandle((contents) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([contents], `2026-10-01 拖放-${Date.now()}.kml`, {
        type: "application/vnd.google-earth.kml+xml",
      }),
    );
    return transfer;
  }, buffer);
  const zone = page.locator(".import-dropzone");
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await expect(zone).toHaveClass(/dragging/);
  await zone.dispatchEvent("drop", { dataTransfer });
  await expect(zone).not.toHaveClass(/dragging/);
  const confirm = page.getByRole("button", {
    name: "导入",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(
    page.getByText("共1个文件，已导入1个。", { exact: true }),
  ).toBeVisible();
  await dataTransfer.dispose();
});

test("batch conflicts block every file and removing the new copy rechecks the remaining duplicate", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const name = `2026-10-01 批内重名-${Date.now()}.kml`;
  const buffer = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  const applies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/apply")) applies.push(request.url());
  });
  await page.getByLabel("上传输入文件").setInputFiles([
    { name, mimeType: "application/octet-stream", buffer },
    {
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(
        buffer.toString().replace("</kml>", "<!-- changed --></kml>"),
      ),
    },
  ]);
  const rows = page.getByRole("article", { name, exact: true });
  await expect(rows.filter({ hasText: "名称冲突" })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "导入", exact: true }),
  ).toBeDisabled();
  expect(applies).toHaveLength(0);
  await rows
    .last()
    .getByRole("button", { name: `移除 ${name}`, exact: true })
    .click();
  const confirm = page.getByRole("button", {
    name: "导入",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  const badName = "2026-10-01 新增坏文件.kml";
  await page.getByLabel("上传输入文件").setInputFiles({
    name: badName,
    mimeType: "application/octet-stream",
    buffer: Buffer.from("<kml>"),
  });
  const bad = page.getByRole("article", { name: badName, exact: true });
  await expect(bad).toHaveAttribute("data-stage", "error");
  await expect(confirm).toBeDisabled();
  expect(applies).toHaveLength(0);
  await bad
    .getByRole("button", { name: `移除 ${badName}`, exact: true })
    .click();
  await expect(confirm).toBeEnabled();
  await page
    .getByLabel("上传输入文件")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await expect(rows.filter({ hasText: "重复轨迹" })).toHaveCount(1);
  await expect(page.locator(".import-actions").getByRole("status")).toHaveText(
    "共2个文件，待导入1个，重复1个。",
  );
  await expect(confirm).toBeEnabled();
  expect(applies).toHaveLength(0);
  await rows
    .filter({ hasText: "检查通过" })
    .getByRole("button", { name: `移除 ${name}`, exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("检查通过");
  await expect(confirm).toBeEnabled();
  expect(applies).toHaveLength(0);
  await confirm.click();
  await expect(rows).toContainText("已导入");
  expect(applies).toHaveLength(1);
});

test("a rejected confirmation requires a fresh check and another explicit confirmation", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const plans: string[] = [];
  await page.route("**/api/work/tasks/*/apply", async (route) => {
    plans.push(route.request().url());
    if (plans.length === 1)
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "预览已过期，请重新检查。" },
        }),
      });
    else await route.continue();
  });
  const name = `2026-10-01 过期预览-${Date.now()}.kml`;
  await page.getByLabel("上传输入文件").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml"),
  });
  const confirm = page.getByRole("button", {
    name: "导入",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const row = page.getByRole("article", { name, exact: true });
  await expect(row).toHaveAttribute("data-stage", "error");
  await expect(
    page.getByRole("button", { name: "导入", exact: true }),
  ).toBeDisabled();
  await row.getByRole("button", { name: `重试 ${name}`, exact: true }).click();
  await expect(confirm).toBeEnabled();
  expect(plans).toHaveLength(1);
  await confirm.click();
  await expect(row).toContainText("已导入");
  expect(plans).toHaveLength(2);
  expect(plans[1]).not.toBe(plans[0]);
});

test("editing reuses uploads and keeps untouched rows still while batch conflicts are rechecked", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  const stamp = Date.now();
  const names = [
    `2026-10-01 复用甲-${stamp}.kml`,
    `2026-10-01 复用乙-${stamp}.kml`,
  ];
  const bytes = await readFile(
    "tests/ts/fixtures/m4/2026-10-01 轨迹.kml",
    "utf8",
  );
  const uploads: string[] = [];
  const applies: string[] = [];
  const inputs: string[][] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/work/uploads?"))
      uploads.push(request.url());
    if (request.url().endsWith("/apply")) applies.push(request.url());
    if (request.url().endsWith("/api/work/preview"))
      inputs.push(request.postDataJSON().inputs);
  });
  await page.getByLabel("上传输入文件").setInputFiles(
    names.map((name, index) => ({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(
        index ? bytes.replace("</kml>", "<!-- changed --></kml>") : bytes,
      ),
    })),
  );
  await expect(
    page.getByRole("button", { name: "导入", exact: true }),
  ).toBeEnabled();
  const unchanged = page.getByRole("article", { name: names[0], exact: true });
  const changed = page.getByRole("article", { name: names[1], exact: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/work/preview",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await changed
      .getByRole("button", { name: `${names[1]} 更多操作`, exact: true })
      .click();
    await page
      .getByLabel(`${names[1]} 导入名称`, { exact: true })
      .fill(names[0]!);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(changed).toHaveAttribute("data-stage", "reading");
    await expect(unchanged).toHaveAttribute("data-stage", "ready");
    await expect(unchanged.locator(".animate-spin")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "导入", exact: true }),
    ).toHaveCount(0);
    expect(uploads).toHaveLength(2);
    release();
    await expect(
      page.getByRole("article").filter({ hasText: "名称冲突" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "导入", exact: true }),
    ).toBeDisabled();
    expect(applies).toHaveLength(0);
    await changed
      .getByRole("button", { name: `${names[1]} 更多操作`, exact: true })
      .click();
    await page
      .getByLabel(`${names[1]} 导入名称`, { exact: true })
      .fill(names[1]!);
    await page.getByRole("tab", { name: "普通", exact: true }).click();
    await page.getByRole("button", { name: "徒步", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const confirm = page.getByRole("button", {
      name: "导入",
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    expect(uploads).toHaveLength(2);
    expect(inputs).toHaveLength(3);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
    await expect(changed.locator(".import-category")).toHaveText("徒步");
    expect(applies).toHaveLength(0);
    await confirm.click();
    await expect(
      page.locator(".import-actions").getByRole("status"),
    ).toHaveText("共2个文件，已导入2个。", { timeout: 20000 });
  } finally {
    release();
  }
});
