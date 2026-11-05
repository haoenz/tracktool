import { filterTracks, tool, pickEditorPoint } from "./map-tools.js";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.use({ actionTimeout: 10000 });
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
  test(`version editing, drawing, visibility and history preview at ${width}px`, async ({
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
      const openEditor = async (view = "编辑轨迹") => {
        await tool(page, "轨迹库");
        await filterTracks(page, fixture.path.split("/").at(-1)!);
        await page
          .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
          .click();
        await page.getByRole("button", { name: view, exact: true }).click();
      };
      await openEditor();
      await page.getByRole("button", { name: "断开轨迹", exact: true }).click();
      await pickEditorPoint(page, 1);
      await save(page);
      await page.reload();
      await openEditor("分段管理");
      const insert = page.getByRole("button", {
        name: "在片段 1与片段 2之间补绘轨迹",
        exact: true,
      });
      const connection = page.getByRole("combobox", {
        name: "片段 1与片段 2的中断原因",
      });
      const classify = async (label: string) => {
        await connection.click();
        await page.getByRole("option", { name: label, exact: true }).click();
      };
      await classify("隧道");
      await expect(insert).toBeDisabled();
      await classify("未分类");
      await expect(insert).toBeEnabled();
      await classify("其他中断");
      await page.getByRole("button", { name: "返回详情", exact: true }).click();
      await page.getByRole("button", { name: "分段管理", exact: true }).click();
      await expect(connection).toContainText("未分类");
      await expect(insert).toBeEnabled();
      await page
        .getByRole("button", {
          name: "在片段 1与片段 2之间补绘轨迹",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "补绘轨迹", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "返回分段管理", exact: true }),
      ).toHaveCount(1);
      const map = page.getByRole("region", { name: "段编辑地图" });
      await expect(map).toHaveAttribute("data-status", "ready", {
        timeout: 20000,
      });
      await map.scrollIntoViewIfNeeded();
      const canvas = page.locator(".maplibregl-canvas");
      // Click the visible viewport; the shared map canvas extends beyond it
      // to support the print frame without recreating the map.
      const viewport = page.locator(".map-stage");
      await viewport.click({
        position: { x: width > 700 ? 700 : 120, y: 220 },
      });
      await viewport.click({
        position: { x: width > 700 ? 750 : 160, y: 240 },
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
      const annotation = display.getByRole("combobox", {
        name: "片段 1与片段 4的中断原因",
      });
      await expect(annotation).toContainText("未分类");
      await annotation.click();
      await page.getByRole("option", { name: "隧道", exact: true }).click();
      await expect(
        display.getByRole("button", { name: /之间补绘轨迹/ }).first(),
      ).toBeDisabled();
      await display.getByRole("button", { name: "取消", exact: true }).click();
      await expect(displaySave).toBeDisabled();
      await expect(annotation).toContainText("未分类");
      await annotation.click();
      await page.getByRole("option", { name: "隧道", exact: true }).click();
      await save(page);
      const snapshot = await call<{
        entry: { generation: number };
        settings: unknown;
      }>(page, `/api/tracks/${fixture.id}`);
      const tunnelSwitch = display.getByRole("checkbox", {
        name: "显示本行程的隧道连接线",
      });
      await tunnelSwitch.uncheck();
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              JSON.stringify(
                window.renderer!.map.getFilter("track-lines"),
              ).includes(id),
            fixture.id,
          ),
        )
        .toBe(true);
      await expect(displaySave).toBeDisabled();
      expect(await call(page, `/api/tracks/${fixture.id}`)).toEqual(snapshot);
      await tunnelSwitch.check();
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              JSON.stringify(
                window.renderer!.map.getFilter("track-lines"),
              ).includes(id),
            fixture.id,
          ),
        )
        .toBe(false);
      await expect(displaySave).toBeDisabled();

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
      ).toHaveCount(0);
      await page.getByRole("button", { name: "返回详情", exact: true }).click();
      await page.getByRole("button", { name: "历史记录", exact: true }).click();
      const timeline = page.getByRole("list", { name: "操作时间线" });
      await expect(timeline.getByRole("button").first()).toContainText(
        "当前状态",
      );
      await expect(
        timeline.getByRole("button", { name: /调整显示/ }),
      ).toHaveCount(3);
      const oldest = timeline
        .getByRole("listitem")
        .last()
        .getByRole("button")
        .first();
      await oldest.click();
      await expect(oldest).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("button", { name: "恢复到此状态", exact: true }),
      ).toHaveCount(0);
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "下载此时的 KML", exact: true })
        .click();
      const file = await download;
      expect(await readFile((await file.path())!, "utf8")).toContain(
        "120,30 120.01,30 120.02,30 120.03,30",
      );
      await page.getByRole("button", { name: "返回详情", exact: true }).click();
      await page.getByRole("button", { name: "历史记录", exact: true }).click();
      await expect(timeline.getByRole("button").first()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(timeline.getByRole("button").first()).toContainText(
        "当前状态",
      );
      await expect(timeline.getByRole("button").first()).toContainText(
        "调整显示",
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

for (const width of [1280, 390])
  test(`split into named, tagged journeys with a concise confirmation at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map?panel=library");
    const fixture = await call<{ id: string; path: string }>(
      page,
      "/api/test/edit-fixture",
      { segmentCount: 3 },
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
        page.getByRole("button", { name: "确认", exact: true }),
      ).toBeDisabled();
      const cancel = page.getByRole("button", { name: "取消", exact: true });
      await expect(cancel).toBeDisabled();
      await page
        .getByRole("button", { name: "定位片段 2", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "定位片段 2", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(cancel).toBeDisabled();
      await page
        .getByRole("button", { name: "行程 1 活动标签", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(cancel).toBeDisabled();
      await expect(
        page.getByRole("region", { name: "行程 2", exact: true }),
      ).toHaveCount(0);
      const boundary = page.getByRole("button", {
        name: "在片段 2 与片段 3 之间拆分",
        exact: true,
      });
      await boundary.focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("textbox", { name: "行程 2 名称", exact: true }),
      ).toBeFocused();
      await expect(
        page
          .getByRole("region", { name: "行程 1", exact: true })
          .getByRole("button", { name: /^定位片段/ }),
      ).toHaveCount(2);
      await expect(
        page
          .getByRole("region", { name: "行程 2", exact: true })
          .getByRole("button", { name: /^定位片段/ }),
      ).toHaveCount(1);
      for (const [i, tag] of [
        [1, "徒步"],
        [2, "火车"],
      ] as const) {
        await page
          .getByRole("button", { name: `行程 ${i} 活动标签`, exact: true })
          .click();
        const picker = page.getByRole("group", {
          name: `行程 ${i} 活动标签`,
          exact: true,
        });
        if (i === 2)
          await picker.getByRole("tab", { name: "轨道", exact: true }).click();
        await picker.getByRole("button", { name: tag, exact: true }).click();
      }
      const firstName = page.getByRole("textbox", {
        name: "行程 1 名称",
        exact: true,
      });
      const secondName = page.getByRole("textbox", {
        name: "行程 2 名称",
        exact: true,
      });
      const originalName = await firstName.inputValue();
      await firstName.fill("");
      await expect(
        page.getByText("请为每条行程填写名称。", { exact: true }),
      ).toBeVisible();
      await firstName.fill(originalName);
      await secondName.fill(`${originalName}-返程`);
      await page
        .getByRole("region", { name: "行程分组", exact: true })
        .screenshot({
          path: test.info().outputPath(`split-journey-${width}.png`),
        });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "确认", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "确认拆分行程" });
      await expect(confirmation).toContainText("将生成以下 2 条行程");
      await expect(confirmation).not.toContainText("有效期");
      await expect(
        confirmation.getByRole("list", { name: "拆分结果" }),
      ).toContainText("徒步 · 2 个片段 · 6 点");
      await expect(
        confirmation.getByRole("list", { name: "拆分结果" }),
      ).toContainText("火车 · 1 个片段 · 2 点");
      await confirmation
        .getByRole("button", { name: "返回修改", exact: true })
        .click();
      await expect(secondName).toHaveValue(`${originalName}-返程`);
      await page.getByRole("button", { name: "确认", exact: true }).click();
      await expect(confirmation).toBeVisible();
      await confirmation
        .getByRole("button", { name: "确认", exact: true })
        .click();
      await expect(confirmation).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "编辑轨迹", exact: true }),
      ).toBeVisible({ timeout: 20000 });
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
        const d = await call<{
          entry: { version_id: string };
          segments: { point_count: number }[];
        }>(page, `/api/tracks/${entry.id}`);
        const t = await call<{ tag: string }>(
          page,
          `/api/tracks/${entry.id}/tag?version_id=${d.entry.version_id}`,
        );
        expect(["徒步", "火车"]).toContain(t.tag);
        expect(d.segments.map((segment) => segment.point_count)).toEqual(
          t.tag === "徒步" ? [4, 2] : [2],
        );
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

for (const segmentCount of [1, 3] as const)
  test(`split journey handles ${segmentCount} source segments`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/map?panel=library");
    const fixture = await call<{ id: string; path: string }>(
      page,
      "/api/test/edit-fixture",
      { segmentCount },
    );
    try {
      await tool(page, "轨迹库");
      await filterTracks(page, fixture.path.split("/").at(-1)!);
      await page
        .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
        .click();
      await page.getByRole("button", { name: "编辑轨迹", exact: true }).click();
      await page.getByRole("button", { name: "拆分行程", exact: true }).click();
      if (segmentCount === 1) {
        await expect(
          page.getByRole("button", { name: "确认", exact: true }),
        ).toBeDisabled();
        await expect(
          page.getByText("当前只有一个片段，需先断开轨迹才能拆分行程。", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "去断开轨迹", exact: true }),
        ).toHaveCount(0);
        return;
      }
      const splitFirst = page.getByRole("button", {
        name: "在片段 1 与片段 2 之间拆分",
        exact: true,
      });
      const splitSecond = page.getByRole("button", {
        name: "在片段 2 与片段 3 之间拆分",
        exact: true,
      });
      await splitSecond.click();
      const secondName = page.getByRole("textbox", {
        name: "行程 2 名称",
        exact: true,
      });
      await secondName.fill("返程");
      await page
        .getByRole("button", { name: "行程 2 活动标签", exact: true })
        .click();
      await page
        .getByRole("group", { name: "行程 2 活动标签", exact: true })
        .getByRole("button", { name: "徒步", exact: true })
        .click();
      await splitFirst.click();
      await expect(
        page.getByRole("textbox", { name: "行程 3 名称", exact: true }),
      ).toHaveValue("返程");
      await expect(
        page.getByRole("button", { name: "行程 3 活动标签", exact: true }),
      ).toContainText("徒步");
      await expect(
        page
          .getByRole("region", { name: "行程分组", exact: true })
          .getByRole("button", { name: /之间拆分$/ }),
      ).toHaveCount(0);
      for (const i of [1, 2, 3]) {
        const group = page.getByRole("region", {
          name: `行程 ${i}`,
          exact: true,
        });
        await expect(
          group.getByRole("button", { name: /^定位片段/ }),
        ).toHaveCount(1);
        await expect(
          group.getByRole("button", { name: `定位片段 ${i}`, exact: true }),
        ).toBeVisible();
      }
      await page
        .getByRole("button", { name: "将行程 2 并入上一行程", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "行程 1 名称", exact: true }),
      ).toBeFocused();
      await expect(secondName).toHaveValue("返程");
      await expect(
        page.getByRole("button", { name: "行程 2 活动标签", exact: true }),
      ).toContainText("徒步");
      await expect(
        page
          .getByRole("region", { name: "行程 1", exact: true })
          .getByRole("button", { name: /^定位片段/ }),
      ).toHaveCount(2);
      await page
        .getByRole("button", { name: "将行程 2 并入上一行程", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "确认", exact: true }),
      ).toBeDisabled();
      await expect(
        page
          .getByRole("region", { name: "行程 1", exact: true })
          .getByRole("button", { name: /^定位片段/ }),
      ).toHaveCount(3);
      await splitFirst.click();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "行程 2", exact: true }),
      ).toHaveCount(0);
      await expect(
        page
          .getByRole("region", { name: "行程 1", exact: true })
          .getByRole("button", { name: /^定位片段/ }),
      ).toHaveCount(3);
      await expect(
        page.getByRole("button", { name: "取消", exact: true }),
      ).toBeDisabled();
    } finally {
      await call(page, "/api/test/edit-cleanup", { id: fixture.id });
    }
  });

for (const width of [1280, 390])
  test(`imports only one untimed local LineString at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map?panel=library");
    const fixture = await call<{ id: string; path: string }>(
      page,
      "/api/test/edit-fixture",
      {},
    );
    try {
      await filterTracks(page, fixture.path.split("/").at(-1)!);
      await page
        .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
        .click();
      await page.getByRole("button", { name: "分段管理", exact: true }).click();
      await page
        .getByRole("button", { name: /之间补绘轨迹/ })
        .first()
        .click();
      await page.getByRole("combobox", { name: "补绘方式" }).click();
      await page.getByRole("option", { name: "上传轨迹", exact: true }).click();
      const upload = page.getByLabel("导入 KML 轨迹");
      const line =
        "<LineString><coordinates>120,30,12 120.001,30.001,25</coordinates></LineString>";
      const kml = (body: string) =>
        `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark>${body}</Placemark></kml>`;
      for (const [body, label, detail] of [
        [
          line + line,
          "包含多条 LineString",
          "只能上传一条 LineString，当前有 2 条",
        ],
        [
          `<TimeStamp><when>2026-01-01</when></TimeStamp>${line}`,
          "包含时间信息",
          "",
        ],
      ] as const) {
        await upload.setInputFiles({
          name: "invalid.kml",
          mimeType: "application/vnd.google-earth.kml+xml",
          buffer: Buffer.from(kml(body)),
        });
        const row = page.getByRole("article", { name: "invalid.kml" });
        await expect(row.getByText(label)).toBeVisible();
        if (detail) await expect(page.getByText(detail)).toBeVisible();
        await expect(
          page.getByRole("button", { name: "保存", exact: true }),
        ).toBeDisabled();
      }
      await upload.setInputFiles({
        name: "line.kml",
        mimeType: "application/vnd.google-earth.kml+xml",
        buffer: Buffer.from(kml(line)),
      });
      await expect(
        page
          .getByRole("article", { name: "line.kml" })
          .getByText("检查通过 · 2 点"),
      ).toBeVisible();
      await save(page);
      const detail = await call<{
        entry: { version_id: string };
        settings: { order: string[] };
        segments: {
          segment_id: string;
          geometry_kind: string;
          time_status: string;
        }[];
      }>(page, `/api/tracks/${fixture.id}`);
      const added = detail.segments.at(-1)!;
      expect(added).toMatchObject({
        geometry_kind: "LineString",
        time_status: "absent",
      });
      expect(detail.settings.order[1]).toBe(added.segment_id);
      const raw = await page.evaluate(async (url) => {
        const response = await fetch(url, {
          headers: {
            "x-tracktool-token": document.querySelector<HTMLMetaElement>(
              'meta[name="tracktool-token"]',
            )!.content,
          },
        });
        if (!response.ok) throw new Error(await response.text());
        return response.text();
      }, `/api/tracks/${fixture.id}/versions/${detail.entry.version_id}/raw`);
      expect(raw).toContain("120,30,12 120.001,30.001,25");
    } finally {
      await call(page, "/api/test/edit-cleanup", { id: fixture.id });
    }
  });

test("breakpoint detection preserves manual selections and tracks only newly added automatic points", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/map?panel=library");
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/edit-fixture",
    {},
  );
  let detected: number[] | null = [1, 2, 2];
  await page.route("**/api/tracks/detect", (route) =>
    route.fulfill({
      status: detected === null ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        detected === null
          ? { error: { code: "TOOL", message: "查找失败测试", exitCode: 2 } }
          : { after_point_indices: detected },
      ),
    }),
  );
  try {
    await tool(page, "轨迹库");
    await filterTracks(page, fixture.path.split("/").at(-1)!);
    await page
      .getByRole("button", { name: `查看 ${fixture.path}`, exact: true })
      .click();
    await page.getByRole("button", { name: "编辑轨迹", exact: true }).click();
    await page.getByRole("button", { name: "断开轨迹", exact: true }).click();
    await pickEditorPoint(page, 2);
    const sources = page
      .getByRole("table", { name: "已选断点" })
      .locator("tbody tr td:nth-child(4)");
    const detect = page.getByRole("button", { name: "查找断点", exact: true });
    await expect(sources).toHaveText(["手选"]);
    await detect.click();
    await expect(sources).toHaveText(["自动", "手选"]);
    await expect(
      page.getByText("新增 1 处自动断点，已保留原有选择，请检查后保存修改。", {
        exact: true,
      }),
    ).toBeVisible();

    await detect.click();
    await expect(
      page.getByText("未发现新的断点，已保留原有选择。", { exact: true }),
    ).toBeVisible();
    await expect(sources).toHaveText(["自动", "手选"]);
    detected = [];
    await detect.click();
    await expect(detect).toBeEnabled();
    await expect(sources).toHaveText(["自动", "手选"]);
    detected = null;
    await detect.click();
    await expect(page.getByText("查找失败测试", { exact: true })).toBeVisible();
    await expect(sources).toHaveText(["自动", "手选"]);

    // Removing an automatic point and selecting it on the map changes its origin.
    await page.getByRole("button", { name: "取消断点 1", exact: true }).click();
    await page.evaluate(() => {
      const renderer = window.renderer!;
      const line = renderer.displayData!.features.find(
        (feature) =>
          feature.geometry.type === "MultiLineString" &&
          feature.properties?.segment_id &&
          !String(feature.properties.segment_id).startsWith("ux-"),
      )!;
      if (line.geometry.type !== "MultiLineString")
        throw new Error("Expected line");
      const point = line.geometry.coordinates[0]![1]!;
      renderer.map.jumpTo({ center: [point[0]!, point[1]!] });
    });
    await pickEditorPoint(page, 1, false);
    await expect(sources).toHaveText(["手选", "手选"]);
    detected = [1, 2];
    await detect.click();
    await expect(
      page.getByText("未发现新的断点，已保留原有选择。", { exact: true }),
    ).toBeVisible();
    await expect(sources).toHaveText(["手选", "手选"]);

    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(sources).toHaveCount(0);
    await detect.click();
    await expect(sources).toHaveText(["自动", "自动"]);
  } finally {
    await call(page, "/api/test/edit-cleanup", { id: fixture.id });
  }
});
