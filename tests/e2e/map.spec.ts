import { tool } from "./map-tools.js";
import type {} from "../../src/drawing/globals.js";
import { test, expect } from "@playwright/test";
import sharp from "sharp";
import type { Project } from "../../src/shared/project.js";
import type { Page } from "@playwright/test";
import type { GeoJSONSource } from "maplibre-gl";
async function call<T>(
  page: Page,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ url, body }) => {
      const token = document.querySelector<HTMLMetaElement>(
        'meta[name="tracktool-token"]',
      )!.content;
      const r = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "X-Tracktool-Token": token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as T };
    },
    { url, body },
  );
}

test("archive → selection → styling → save/reopen → JSON → independent PNG", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/map");
  await tool(page, "新建出图工程");
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("button", { name: "收起项目菜单" }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Default/2026-10-01 中文.kml",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Default/2026-10-01 中文.kml", exact: true })
    .click();
  await expect(page.locator(".ant-message")).toContainText("已选择 1 条轨迹");
  await page.getByRole("button", { name: "适合轨迹" }).click();
  await tool(page, "工程样式");
  await page.getByLabel("标题", { exact: true }).fill("中文轨迹 · M3");
  await page.getByRole("spinbutton", { name: "线宽", exact: true }).fill("5");
  await tool(page, "项目");
  await page.getByLabel("项目名称", { exact: true }).fill("验收项目");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.locator(".ant-message")).toContainText("项目已保存");
  await tool(page, "工程样式");
  await page.getByLabel("标题", { exact: true }).fill("未保存的修改");
  await tool(page, "项目");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "载入项目", exact: true }).click();
  await expect(page.locator(".ant-message")).toContainText("项目已载入", {
    timeout: 20000,
  });
  await tool(page, "工程样式");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "中文轨迹 · M3",
  );
  await tool(page, "项目");
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const json = await jsonDownload;
  await json.saveAs(info.outputPath("project.json"));
  await page
    .locator("input[type=file]")
    .setInputFiles(info.outputPath("project.json"));
  await expect(page.locator(".ant-message")).toContainText("项目已载入", {
    timeout: 20000,
  });
  await page.waitForFunction(
    () => !!window.renderer?.loadedFont && window.renderer.map.loaded(),
  );
  await tool(page, "出图");
  const previewReport = await page.evaluate(async () =>
    window.renderer!.ready(),
  );
  let exportedReport: unknown;
  page.on("response", async (response) => {
    if (/\/api\/jobs\/[a-f0-9]+$/.test(response.url())) {
      const result = (await response.json()) as {
        status: string;
        report: unknown;
      };
      if (result.status === "done") exportedReport = result.report;
    }
  });
  await page.screenshot({ path: info.outputPath("map-desktop.png") });
  const pngDownload = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("button", { name: "导出 PNG", exact: true }).click();
  const png = await pngDownload;
  await png.saveAs(info.outputPath("map.png"));
  const metadata = await sharp(info.outputPath("map.png")).metadata();
  expect([metadata.width, metadata.height]).toEqual([1920, 1440]);
  await expect
    .poll(() => exportedReport)
    .toMatchObject({
      labels: previewReport!.labels,
      camera: previewReport!.camera,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起项目菜单" }).click();
  await expect(page.getByLabel("地图预览")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("map-mobile.png") });
  await tool(page, "设置");
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => !!window.renderer)).toBe(true);
  expect(errors).toEqual([]);
});
test("selection updates the GeoJSON source while camera tiles are still pending", async ({
  page,
}) => {
  await page.goto("/map");
  await tool(page, "新建出图工程");
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("checkbox", { name: "Train/same.kml", exact: true }),
  ).toBeVisible();
  await page.waitForFunction(() => window.renderer?.map.loaded());
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => {
      release = r;
    }),
    begun = new Promise<void>((r) => {
      started = r;
    });
  await page.route("**/tiles/**", async (route) => {
    started();
    await waiting;
    await route.continue();
  });
  try {
    await page.evaluate(() => window.renderer!.map.jumpTo({ zoom: 8 }));
    await begun;
    await page
      .getByRole("checkbox", { name: "Train/same.kml", exact: true })
      .click();
    await expect(page.locator(".ant-message")).toContainText("已选择 1 条轨迹");
    const data = await page.evaluate(async () =>
      (window.renderer!.map.getSource("tracks") as GeoJSONSource).getData(),
    );
    expect(data).toMatchObject({
      type: "FeatureCollection",
      features: [
        {
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [100, 26],
                [101, 27],
                [102, 28],
              ],
              [
                [103, 29],
                [104, 30],
              ],
            ],
          },
        },
        { geometry: { type: "MultiPoint", coordinates: [[105, 31]] } },
      ],
    });
  } finally {
    release();
  }
});
test("missing tiles, missing fonts and unsupported title glyphs block independent export", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/map");
  await tool(page, "地图样式");
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
  const bootstrap = await call<{ state: Project }>(page, "/api/bootstrap");
  const state = bootstrap.body.state;
  for (const mode of ["tiles", "font"]) {
    await call(page, "/api/test/fault", { mode });
    try {
      const submitted = await call<{ job: string }>(page, "/api/export", state);
      expect(submitted.status).toBe(200);
      await expect
        .poll(
          async () =>
            (
              await call<{ status: string }>(
                page,
                `/api/jobs/${submitted.body.job}`,
              )
            ).body.status,
          { timeout: 90_000 },
        )
        .toBe("failed");
      expect(
        (await call(page, `/api/jobs/${submitted.body.job}/png`)).status,
      ).toBe(400);
    } finally {
      await call(page, "/api/test/fault", { mode: "" });
    }
  }
  expect(
    (await call(page, "/api/export", { ...state, title: "无法出图 🦄" }))
      .status,
  ).toBe(400);
});
test("outdated resource versions and fingerprints are surfaced before save/export", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/map");
  await expect(
    page.getByRole("checkbox", {
      name: "Default/2026-10-01 中文.kml",
      exact: true,
    }),
  ).toBeVisible();
  const { body: bootstrap } = await call<{
    state: Project;
    initialArchive: string;
  }>(page, "/api/bootstrap");
  await tool(page, "打开已有工程");
  const outdated = { ...bootstrap.state, versions: { old: true } };
  await page.locator("input[type=file]").setInputFiles({
    name: "old.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(outdated)),
  });
  await expect(
    page.getByText("项目资源版本已变化；请确认后另存为新项目"),
  ).toBeVisible();
  await tool(page, "出图");
  await expect(
    page.getByRole("button", { name: "导出 PNG", exact: true }),
  ).toBeDisabled();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "使用当前资源" }).click();
  await expect(
    page.getByRole("button", { name: "导出 PNG", exact: true }),
  ).toBeEnabled();
  await tool(page, "项目");
  const changed = {
    ...bootstrap.state,
    schema: 2,
    archive: bootstrap.initialArchive,
    tracks: [{ entry: "Default/2026-10-01 中文.kml", sha256: "0".repeat(64) }],
  };
  page.once("dialog", (d) => d.accept());
  await page.locator("input[type=file]").setInputFiles({
    name: "changed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(changed)),
  });
  await expect(page.locator(".map-errors [role=alert]")).toContainText(
    "无法唯一关联原始基线",
  );
  await tool(page, "出图");
  await expect(
    page.getByRole("button", { name: "导出 PNG", exact: true }),
  ).toBeDisabled();
});
test("rapid source changes only commit the latest choice", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/map");
  await tool(page, "地图样式");
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
  let release!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => {
    started = r;
  });
  await page.route("**/api/basemap-check", async (route) => {
    started();
    await waiting;
    await route.fulfill({ json: { ok: true } });
  });
  const { body: bootstrap } = await call<{
    config: { basemaps: { id: string; name: string; group: string }[] };
  }>(page, "/api/bootstrap");
  const bing = bootstrap.config.basemaps.find((b) => b.id.startsWith("bing-"))!;
  await page.getByLabel("底图", { exact: true }).fill(bing.name);
  await page.getByText(`${bing.group} · ${bing.name}`, { exact: true }).click();
  await startedPromise;
  expect(await page.evaluate(() => window.renderer?.state.style.basemap)).toBe(
    "light",
  );
  await page.getByLabel("底图", { exact: true }).fill("深色矢量");
  await page.getByText("深色矢量", { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.style.basemap), {
      timeout: 20000,
    })
    .toBe("dark");
  const completed = page.waitForResponse("**/api/basemap-check");
  release();
  await completed;
  expect(await page.evaluate(() => window.renderer?.state.style.basemap)).toBe(
    "dark",
  );
});
test("failed source retains the current map; a later source wins and camera/style changes avoid selection API", async ({
  page,
}) => {
  test.setTimeout(60_000);
  let selections = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/selection")) selections++;
  });
  await page.goto("/map");
  await tool(page, "地图样式");
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
  const config = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="tracktool-token"]',
    )!.content;
    return (
      await (
        await fetch("/api/bootstrap", {
          headers: { "X-Tracktool-Token": token },
        })
      ).json()
    ).config as { basemaps: { id: string; name: string; group: string }[] };
  });
  const google = config.basemaps.find((b) => b.id.startsWith("google-"))!;
  await page.getByLabel("底图", { exact: true }).fill(google.name);
  await page
    .getByText(`${google.group} · ${google.name}`, { exact: true })
    .click();
  await expect(page.locator(".map-errors [role=alert]")).toContainText(
    "原地图已保留",
  );
  expect(await page.evaluate(() => window.renderer?.state.style.basemap)).toBe(
    "light",
  );
  await page.getByLabel("底图", { exact: true }).click();
  await page.getByText("深色矢量", { exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.style.basemap), {
      timeout: 20000,
    })
    .toBe("dark");
  await expect(page.getByLabel("标题", { exact: true })).not.toBeVisible();
  expect(selections).toBe(0);
});
test("panels preserve the map, selection and unfinished edits on desktop and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/map");
  await tool(page, "新建出图工程");
  await tool(page, "轨迹库");
  await page
    .getByRole("checkbox", { name: "Train/same.kml", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Train/same.kml", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "适合轨迹", exact: true }).click();
  await tool(page, "工程样式");
  await page.getByLabel("标题", { exact: true }).fill("切换面板保留的草稿");
  const camera = await page.evaluate(() => window.renderer!.state.camera);
  const canvas = await page.locator(".maplibregl-canvas").elementHandle();
  await tool(page, "设置");
  await expect(page.getByLabel("底图", { exact: true })).toBeVisible();
  await tool(page, "处理记录");
  await expect(
    page.getByRole("heading", { name: "处理记录", exact: true }),
  ).toBeVisible();
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("checkbox", { name: "Train/same.kml", exact: true }),
  ).toBeChecked();
  await tool(page, "工程样式");
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "切换面板保留的草稿",
  );
  expect(await canvas!.evaluate((el) => el.isConnected)).toBe(true);
  expect(await page.evaluate(() => window.renderer!.state.camera)).toEqual(
    camera,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "收起项目菜单", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "地图控制面板" }),
  ).toHaveCount(0);
  await expect(page.locator(".map-stage.export-preview")).toHaveCSS(
    "height",
    "844px",
  );
  await tool(page, "轨迹库");
  await expect(
    page.getByRole("checkbox", { name: "Train/same.kml", exact: true }),
  ).toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("the configured library stays fixed when importing a project from another machine", async ({
  page,
}) => {
  await page.goto("/map");
  const track = page.getByRole("checkbox", {
    name: "Train/same.kml",
    exact: true,
  });
  await track.click();
  await expect(track).toBeChecked();
  await expect(
    page.getByRole("button", { name: "浏览目录", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("服务端归档路径", { exact: true })).toHaveCount(
    0,
  );
  const state = await page.evaluate(() => window.renderer!.state);
  await tool(page, "打开已有工程");
  await page.locator("input[type=file]").setInputFiles({
    name: "another-machine.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ ...state, archive: "/another-machine/archive.sqlite3" }),
    ),
  });
  await expect(page.locator(".ant-message")).toContainText("项目已载入", {
    timeout: 20000,
  });
  expect(await page.evaluate(() => window.renderer!.state.archive)).toBe(
    state.archive,
  );
  await tool(page, "轨迹库");
  await expect(track).toBeChecked();
  await page.getByRole("button", { name: "管理轨迹库", exact: true }).click();
  await expect(page.getByLabel("归档目录", { exact: true })).toHaveCount(0);
  await page.getByLabel("操作", { exact: true }).click();
  await expect(
    page.getByRole("option", { name: "建立归档", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "轨迹入库", exact: true }),
  ).toBeVisible();
});

test("project icon expands tools and collapses the active panel", async ({
  page,
}) => {
  await page.goto("/map");
  const expand = page.getByRole("button", {
    name: "展开项目菜单",
    exact: true,
  });
  const nav = page.getByRole("navigation", { name: "地图工具", exact: true });
  await expect(expand).toBeVisible();
  await expect(nav).toBeHidden();
  await expect(page.getByLabel("地图控制面板", { exact: true })).toBeHidden();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["轨迹", "设置"]) {
      await expand.click();
      await nav.getByRole("button", { name, exact: true }).click();
      await expect(
        page.getByLabel("地图控制面板", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "收起项目菜单", exact: true })
        .click();
      await expect(nav).toBeHidden();
      await expect(
        page.getByLabel("地图控制面板", { exact: true }),
      ).toBeHidden();
    }
  }
});
