import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("upload shows each stage and stopping preserves the saving file", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/map?panel=library");
  await page.getByRole("button", { name: "上传轨迹", exact: true }).click();
  let releaseUpload!: () => void;
  let releasePreview!: () => void;
  let releaseApply!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const applyGate = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/work/uploads?"))
      uploads.push(new URL(request.url()).searchParams.get("name")!);
  });
  for (const [url, gate] of [
    ["**/api/work/uploads?**", uploadGate],
    ["**/api/work/preview", previewGate],
    ["**/api/work/tasks/*/apply", applyGate],
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
  const next = name.replace("进度", "后续");
  const buffer = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  try {
    await page.getByLabel("上传输入文件").setInputFiles(
      [name, next].map((name) => ({
        name,
        mimeType: "application/octet-stream",
        buffer,
      })),
    );
    const row = page.getByRole("article", { name, exact: true });
    await expect(row.getByRole("progressbar")).toBeVisible();
    await expect(row).toContainText(/上传中 \d+%/);
    releaseUpload();
    await expect(row).toContainText("正在读取轨迹");
    releasePreview();
    await expect(row).toContainText("正在保存");
    await page
      .getByRole("button", { name: "停止剩余上传", exact: true })
      .click();
    await expect(
      page.getByText("正在保存的轨迹完成后停止，已导入的轨迹会保留。", {
        exact: true,
      }),
    ).toBeVisible();
    releaseApply();
    await expect(row).toContainText("已导入");
    await expect(
      page.getByRole("article", { name: next, exact: true }),
    ).toContainText("已取消");
    expect(uploads).toEqual([name]);
    await page
      .getByRole("button", { name: "重试失败文件", exact: true })
      .click();
    await expect(
      page.getByText("已导入 2 条轨迹。", { exact: true }),
    ).toBeVisible();
    expect(uploads).toEqual([name, next]);
  } finally {
    releaseUpload();
    releasePreview();
    releaseApply();
  }
});

test("drag and drop highlights the target and automatically imports a file", async ({
  page,
}) => {
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
  await expect(
    page.getByText("已导入 1 条轨迹。", { exact: true }),
  ).toBeVisible();
  await dataTransfer.dispose();
});
