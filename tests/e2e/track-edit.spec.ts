import { filterTracks, tool, pickEditorPoint } from "./map-tools.js";
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
async function save(page: Page, label = "保存") {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(
    page.getByText("编辑已保存，旧版本保留在历史中。", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
}
for (const width of [1280, 390])
  test(`version editing, drawing, visibility and restoration at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map?panel=library");
    const fixture = await call<{ id: string; path: string }>(
      page,
      "/api/test/edit-fixture",
      {},
    );
    try {
      const openEditor = async () => {
        await tool(page, "轨迹库");
        await filterTracks(page, fixture.path.split("/").at(-1)!);
        await page
          .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
          .click();
        await page
          .getByRole("button", { name: "编辑轨迹", exact: true })
          .click();
      };
      await openEditor();
      await page.getByRole("button", { name: "断开轨迹", exact: true }).click();
      await pickEditorPoint(page, 1);
      await save(page);
      await page.reload();
      await openEditor();
      await page.getByRole("button", { name: "补绘轨迹", exact: true }).click();
      const map = page.getByRole("region", { name: "段编辑地图" });
      await expect(map).toHaveAttribute("data-status", "ready", {
        timeout: 20000,
      });
      await map.scrollIntoViewIfNeeded();
      const canvas = page.locator(".maplibregl-canvas");
      await canvas.click({
        position: { x: width > 700 ? 700 : 120, y: 220 },
        force: true,
      });
      await canvas.click({
        position: { x: width > 700 ? 750 : 160, y: 240 },
        force: true,
      });
      await expect(page.getByText(/已画 2 点/)).toBeVisible();
      await canvas.screenshot({ path: test.info().outputPath("drawing.png") });
      await save(page);
      await page.getByRole("button", { name: "返回详情", exact: true }).click();
      await page.getByRole("button", { name: "分段管理", exact: true }).click();
      const display = page.getByRole("region", {
        name: "分段管理",
        exact: true,
      });
      const displaySave = display.getByRole("button", {
        name: "保存",
        exact: true,
      });
      await expect(displaySave).toBeDisabled();
      await display
        .getByRole("button", { name: "全部连接", exact: true })
        .click();
      await expect(
        display.getByRole("button", {
          name: "片段 1与片段 4已连接",
          exact: true,
        }),
      ).toBeVisible();
      await display
        .getByRole("button", { name: "下移片段 1", exact: true })
        .click();
      await expect(
        display
          .getByRole("listitem")
          .first()
          .getByRole("button", { name: "拖动片段 4", exact: true }),
      ).toBeVisible();
      await display
        .getByRole("button", { name: "放弃修改", exact: true })
        .click();
      await expect(displaySave).toBeDisabled();
      await expect(
        display
          .getByRole("listitem")
          .first()
          .getByRole("button", { name: "拖动片段 1", exact: true }),
      ).toBeVisible();
      const handle = display.getByRole("button", {
        name: "拖动片段 1",
        exact: true,
      });
      const destination = display.getByRole("listitem").nth(1);
      if (width <= 700)
        await page.getByRole("button", { name: /调整面板高度/ }).press("End");
      await handle.scrollIntoViewIfNeeded();
      const sourceBox = await handle.boundingBox(),
        targetBox = await destination.boundingBox();
      await page.mouse.move(
        sourceBox!.x + sourceBox!.width / 2,
        sourceBox!.y + sourceBox!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(targetBox!.x + 20, targetBox!.y + 20, { steps: 5 });
      await page.mouse.up();
      await expect(
        display
          .getByRole("listitem")
          .first()
          .getByRole("button", { name: "拖动片段 4", exact: true }),
      ).toBeVisible();
      await display
        .getByRole("button", { name: "放弃修改", exact: true })
        .click();

      await page
        .getByRole("button", { name: "隐藏片段 4", exact: true })
        .click();
      await save(page, "保存");
      await expect(
        page.getByRole("button", { name: "显示片段 4", exact: true }),
      ).toBeVisible();
      for (const ordinal of [1, 2, 3])
        await page
          .getByRole("button", { name: `隐藏片段 ${ordinal}`, exact: true })
          .click();
      await save(page, "保存");
      await expect(
        page.getByRole("button", { name: "定位轨迹", exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "返回详情", exact: true }).click();
      await page
        .getByRole("button", { name: "历史记录", exact: true })
        .click();
      const timeline = page.getByRole("list", { name: "操作时间线" });
      await expect(timeline.getByRole("button").first()).toContainText(
        "当前状态",
      );
      await expect(
        timeline.getByRole("button", { name: /调整显示/ }),
      ).toHaveCount(2);
      await timeline.getByRole("button").last().click();
      await expect(
        page.getByText("正在查看历史状态", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "恢复到此状态", exact: true }),
      ).toBeVisible();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "下载此时的 KML", exact: true })
        .click();
      const file = await download;
      expect(await readFile((await file.path())!, "utf8")).toContain(
        "120,30 120.01,30 120.02,30 120.03,30",
      );
      await page
        .getByRole("button", { name: "恢复到此状态", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "确认恢复", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(timeline.getByRole("button").first()).toContainText(
        "调整显示",
      );
      await page
        .getByRole("button", { name: "恢复到此状态", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "确认恢复", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "确认恢复", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(timeline.getByRole("button").first()).toContainText(
        "恢复历史状态",
      );
      await expect(timeline.getByRole("button").first()).toContainText(
        "当前状态",
      );
      await expect(page.getByText("编辑任务", { exact: true })).toHaveCount(0);
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

test("split into named, tagged journeys with a concise confirmation", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/map?panel=library");
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/edit-fixture",
    {},
  );
  try {
    await tool(page, "轨迹库");
    await filterTracks(page, fixture.path.split("/").at(-1)!);
    await page
      .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
      .click();
    await page.getByRole("button", { name: "编辑轨迹", exact: true }).click();
    await page.getByRole("button", { name: "拆分行程", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "确认拆分…", exact: true }),
    ).toBeDisabled();
    for (const [i, tag] of [
      [1, "徒步"],
      [2, "火车"],
    ] as const) {
      await page
        .getByRole("combobox", { name: `行程 ${i} 活动标签`, exact: true })
        .click();
      await page.getByRole("option", { name: tag, exact: true }).click();
    }
    await page.getByRole("button", { name: "确认拆分…", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "确认拆分行程" });
    await expect(confirmation).toContainText("将生成以下 2 条行程");
    await expect(confirmation).not.toContainText("有效期");
    await confirmation
      .getByRole("button", { name: "确认拆分", exact: true })
      .click();
    await expect(confirmation).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "编辑轨迹", exact: true }),
    ).toBeVisible();
    const list = await call<{ entries: { id: string; path: string }[] }>(
      page,
      `/api/tracks?search=${encodeURIComponent(
        fixture.path
          .split("/")
          .at(-1)!
          .replace(/\.kml$/, ""),
      )}`,
    );
    expect(list.entries).toHaveLength(2);
    for (const entry of list.entries) {
      const d = await call<{ entry: { version_id: string } }>(
        page,
        `/api/tracks/${entry.id}`,
      );
      const t = await call<{ tag: string }>(
        page,
        `/api/tracks/${entry.id}/tag?version_id=${d.entry.version_id}`,
      );
      expect(["徒步", "火车"]).toContain(t.tag);
    }
  } finally {
    const remaining = await call<{ entries: { id: string }[] }>(
      page,
      `/api/tracks?search=${encodeURIComponent(
        fixture.path
          .split("/")
          .at(-1)!
          .replace(/\.kml$/, ""),
      )}`,
    );
    for (const entry of remaining.entries)
      if (entry.id !== fixture.id)
        await call(page, "/api/test/edit-cleanup", { id: entry.id });
    await call(page, "/api/test/edit-cleanup", { id: fixture.id });
  }
});
