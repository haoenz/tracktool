import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
async function call<T>(page: Page, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-tracktool-token": document.querySelector<HTMLMetaElement>(
            'meta[name="tracktool-token"]',
          )!.content,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    { url, body },
  ) as Promise<T>;
}
async function preview(page: Page) {
  await page.getByRole("button", { name: "生成编辑预览", exact: true }).click();
  await expect(page.getByText("待确认的编辑预览", { exact: true })).toBeVisible(
    { timeout: 20000 },
  );
}
async function apply(page: Page) {
  await page.getByRole("button", { name: "确认应用编辑", exact: true }).click();
  await expect(
    page.getByText("编辑已保存，旧版本保留在历史中。", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("待确认的编辑预览", { exact: true })).toHaveCount(
    0,
  );
}
for (const width of [1280, 390])
  test(`version editing, drawing, visibility and restoration at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tracks");
    const fixture = await call<{ id: string; path: string }>(
      page,
      "/api/test/edit-fixture",
      {},
    );
    try {
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await page.getByLabel("编辑行程", { exact: true }).click();
      await page
        .getByRole("option", { name: fixture.path, exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "段 1", exact: true }),
      ).toBeVisible();
      await page.getByLabel("断点索引", { exact: true }).fill("1");
      await preview(page);
      await expect(page.getByText(/3 段 · 6 点/)).toBeVisible();
      await expect(
        page.getByRole("region", { name: "段编辑地图" }).locator(".map-stage"),
      ).toHaveAttribute("data-status", "ready", { timeout: 20000 });
      await page.reload();
      await expect(
        page.getByRole("button", { name: "确认应用编辑", exact: true }),
      ).toBeVisible();
      await apply(page);
      await expect(
        page.getByRole("button", { name: "段 3", exact: true }),
      ).toBeVisible();
      await page.getByLabel("段编辑操作", { exact: true }).click();
      await page.getByRole("option", { name: "插入手绘", exact: true }).click();
      const map = page.getByRole("region", { name: "段编辑地图" });
      await expect(map).toHaveAttribute("data-status", "ready", {
        timeout: 20000,
      });
      await map.scrollIntoViewIfNeeded();
      const canvas = map.locator(".maplibregl-canvas");
      await canvas.click({ position: { x: 100, y: 100 }, force: true });
      await canvas.click({ position: { x: 150, y: 110 }, force: true });
      await expect(page.getByText(/已画 2 点/)).toBeVisible();
      await map.screenshot({ path: test.info().outputPath("drawing.png") });
      await preview(page);
      await expect(page.getByText(/4 段 · 8 点/)).toBeVisible();
      await apply(page);
      await page
        .getByRole("checkbox", { name: "忽略段 4", exact: true })
        .check();
      await page
        .getByRole("button", { name: "预览展示设置", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "确认应用编辑", exact: true }),
      ).toBeVisible();
      await apply(page);
      await expect(
        page.getByRole("checkbox", { name: "忽略段 4", exact: true }),
      ).toBeChecked();
      await expect(
        page.getByRole("button", { name: "下载版本 3", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "下载版本 4", exact: true }),
      ).toHaveCount(0);
      for (const ordinal of [1, 2, 3])
        await page
          .getByRole("checkbox", { name: `忽略段 ${ordinal}`, exact: true })
          .check();
      await page
        .getByRole("button", { name: "预览展示设置", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "缩放到编辑轨迹", exact: true }),
      ).toBeDisabled();
      await apply(page);
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "下载版本 1", exact: true })
        .click();
      const file = await download;
      expect(await readFile((await file.path())!, "utf8")).toContain(
        "120,30 120.01,30 120.02,30 120.03,30",
      );
      await page
        .getByRole("button", { name: "预览恢复版本 1", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "确认应用编辑", exact: true }),
      ).toBeVisible();
      await apply(page);
      await expect(
        page.getByRole("button", { name: "段 3", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "下载版本 4", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await call(page, "/api/test/edit-cleanup", { id: fixture.id });
    }
  });
