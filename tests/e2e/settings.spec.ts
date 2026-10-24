import { expect, test, type Page } from "@playwright/test";
import { resetDisplay } from "./display-reset.js";
import { pickAppearance, pickBasemap, tool } from "./map-tools.js";

test.beforeEach(async ({ request }) => {
  await resetDisplay(request);
});

async function expectAppearance(page: Page, appearance: "light" | "dark") {
  await expect(page.locator("html")).toHaveClass(
    appearance === "dark" ? "dark" : "",
  );
  await expect
    .poll(() => page.evaluate(() => window.renderer?.state.style.appearance))
    .toBe(appearance);
  await expect(page.locator("html")).toHaveCSS("color-scheme", appearance);
}

for (const width of [1280, 390]) {
  test(`global appearance follows the system and persists explicit choices at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/settings");
    const choice = (name: string) =>
      page.getByRole("button", { name, exact: true });
    await expect(
      page.getByRole("combobox", { name: "配色", exact: true }),
    ).toHaveText("跟随系统");
    await expectAppearance(page, "dark");
    const panel = page.getByRole("complementary", { name: "地图控制面板" });
    const darkBackground = await panel.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await page.screenshot({ path: info.outputPath("settings-dark.png") });

    await pickAppearance(page, "浅色");
    await expectAppearance(page, "light");
    await expect(panel).not.toHaveCSS("background-color", darkBackground);
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expectAppearance(page, "light");
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "配色", exact: true }),
    ).toHaveText("浅色");
    await expectAppearance(page, "light");

    await pickAppearance(page, "跟随系统");
    await expectAppearance(page, "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectAppearance(page, "light");
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "配色", exact: true }),
    ).toHaveText("跟随系统");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectAppearance(page, "dark");

    await pickAppearance(page, "深色");
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "配色", exact: true }),
    ).toHaveText("深色");
    await expectAppearance(page, "dark");
    await choice("地图设置").click();
    await expect(
      page.getByRole("combobox", { name: "配色", exact: true }),
    ).toHaveCount(0);
    await pickBasemap(page, "osm-standard");
    await expect
      .poll(() => page.evaluate(() => window.renderer?.state.style.basemap))
      .toBe("osm-standard");
    await choice("返回设置").click();
    await pickAppearance(page, "浅色");
    await expectAppearance(page, "light");
    await expect
      .poll(() => page.evaluate(() => window.renderer?.state.style.basemap))
      .toBe("osm-standard");
    await choice("地图设置").click();
    await pickBasemap(page, "vector");
    await expect
      .poll(() => page.evaluate(() => window.renderer?.state.style.basemap))
      .toBe("vector");
    await expectAppearance(page, "light");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("entry visibility preference applies on refresh and to new tabs", async ({
  page,
  context,
}) => {
  const visibility = (target: Page) =>
    target
      .getByRole("complementary", { name: "地图控制面板" })
      .getByRole("button", { name: "切换当前列表可见性", exact: true });
  await page.goto("/settings");
  const choice = page.getByRole("combobox", {
    name: "进入时轨迹",
    exact: true,
  });
  await expect(choice).toHaveText("全部显示");
  await choice.click();
  await page.getByRole("option", { name: "全部隐藏", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "进入时轨迹", exact: true }),
  ).toHaveText("全部隐藏");
  // The stored tab snapshot predates the new preference and must not revive it.
  await page.goto("/map?panel=library");
  await expect(visibility(page)).toHaveAttribute("data-visibility", "none", {
    timeout: 15_000,
  });

  const second = await context.newPage();
  await second.goto("/map?panel=library");
  await expect(visibility(second)).toHaveAttribute("data-visibility", "none", {
    timeout: 15_000,
  });
  await second.close();
});

test("global appearance survives project changes and synchronizes browser tabs", async ({
  page,
  context,
}) => {
  await page.goto("/settings");
  await pickAppearance(page, "深色");
  await expectAppearance(page, "dark");
  await tool(page, "新建出图工程");
  await expectAppearance(page, "dark");
  const second = await context.newPage();
  await second.goto("/settings");
  await expectAppearance(second, "dark");
  await pickAppearance(second, "浅色");
  await expectAppearance(page, "light");
  await expectAppearance(second, "light");
  await tool(page, "返回浏览");
  await page
    .getByRole("button", { name: "放弃修改并返回", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "当前出图工程" })).toHaveCount(
    0,
  );
  await expectAppearance(page, "light");
  await tool(page, "设置");
  await expect(
    page.getByRole("combobox", { name: "配色", exact: true }),
  ).toHaveText("浅色");
  await second.close();
});

test("settings group map controls and server configuration writes require CLI", async ({
  page,
}, info) => {
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/settings");
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回设置", exact: true }).click();
  const mapSettings = page.getByRole("button", {
    name: "地图设置",
    exact: true,
  });
  await expect(mapSettings).toBeFocused();
  await expect(page.locator(".settings-panel").getByRole("button")).toHaveCount(
    1,
  );
  await expect(page.getByLabel("图源", { exact: true })).toHaveCount(0);
  await mapSettings.press("Enter");
  await expect(
    page.getByRole("heading", { name: "地图设置", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("图源", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "地图工具", exact: true });
  await expect(page.locator(".project-icon")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".workspace-tools")).toHaveCount(0);
  await tool(page, "轨迹库");
  await expect(page.getByRole("tab")).toHaveCount(0);
  for (const name of ["打开轨迹列表", "上传轨迹", "导出轨迹"])
    await expect(nav.getByRole("button", { name, exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await expect(
    page.getByText("配置文件不是有效 JSON", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("配置项", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/bootstrap");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
});

test("layers retain filters and opacity when disabled and reloaded", async ({
  page,
  request,
}) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  const layer = page.getByRole("group", { name: "电力图层", exact: true });
  await expect(layer.getByRole("switch")).not.toBeChecked();
  await expect(layer.getByRole("spinbutton")).toHaveCount(0);
  const closedHeight = (await layer.boundingBox())!.height;
  await layer.getByRole("switch").check();
  await expect(layer.getByRole("switch")).toBeChecked();
  // The opacity input appears in the heading row without changing its height.
  await expect
    .poll(async () => (await layer.boundingBox())!.height)
    .toBe(closedHeight);
  const opacity = layer.getByRole("spinbutton", { name: "电力不透明度" });
  await expect(opacity).toHaveValue("100");
  await opacity.fill("20");
  await expect(opacity).toHaveValue("20");
  await layer.locator(".settings-layer-toggle").click();
  await layer.getByRole("combobox", { name: "电力设施", exact: true }).click();
  await page.getByRole("option", { name: "仅线路", exact: true }).click();
  await layer
    .getByRole("combobox", { name: "电力最低电压", exact: true })
    .click();
  await page.getByRole("option", { name: "220", exact: true }).click();
  await expect(layer).toContainText("仅线路 · ≥ 220 kV");
  await layer.getByRole("switch").uncheck();
  await expect(layer.getByRole("spinbutton")).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await request.get("/api/bootstrap", {
        headers: { "X-Tracktool-Token": "e2e" },
      });
      const { state } = await response.json();
      return {
        overlay: state.style.overlays.find(
          (o: { id: string }) => o.id === "openinframap-power",
        ),
        power: state.style.power,
      };
    })
    .toEqual({
      overlay: { id: "openinframap-power", enabled: false, opacity: 0.2 },
      power: { facilities: "none", min_voltage: 220 },
    });
  await page.reload();
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await expect(layer.getByRole("switch")).not.toBeChecked();
  await expect(layer).toContainText("仅线路 · ≥ 220 kV");
  await expect(layer).not.toContainText("已关闭");
  await expect(layer.getByRole("spinbutton")).toHaveCount(0);
  await expect(
    layer.getByRole("combobox", { name: "电力设施", exact: true }),
  ).toBeHidden();
  await layer.locator(".settings-layer-toggle").click();
  await expect(
    layer.getByRole("combobox", { name: "电力设施", exact: true }),
  ).toBeVisible();
  await layer.getByRole("switch").check();
  await expect(opacity).toHaveValue("20");
});

test("railway modes share one layer and incompatible basemaps preserve its settings", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  const layer = page.getByRole("group", { name: "铁路图层", exact: true });
  await layer.getByRole("switch").check();
  await layer.locator(".settings-layer-toggle").click();
  const opacity = layer.getByRole("spinbutton", { name: "铁路不透明度" });
  await opacity.fill("90");
  await layer.getByRole("combobox", { name: "铁路显示内容" }).click();
  await page.getByRole("option", { name: "铁路限速", exact: true }).click();
  await expect(layer).toHaveCount(1);
  await expect(opacity).toHaveValue("90");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.renderer!.state.style.overlays.filter((o) =>
          o.id.startsWith("openrailwaymap-"),
        ),
      ),
    )
    .toEqual([{ id: "openrailwaymap-maxspeed", enabled: true, opacity: 0.9 }]);
  await pickBasemap(page, "amap-satellite");
  // Staging the new basemap can take a few seconds on a loaded machine.
  await expect(layer).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("[data-sonner-toaster]")).toHaveCount(0);
  await expect(
    page.getByRole("radiogroup", { name: "道路", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await pickBasemap(page, "vector");
  await expect(layer).toHaveCount(1);
  await expect(layer.getByRole("switch")).not.toBeChecked();
  await layer.getByRole("switch").check();
  await expect(opacity).toHaveValue("90");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await layer.scrollIntoViewIfNeeded();
  const bounds = await layer.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: info.outputPath("layers-mobile.png"),
    animations: "disabled",
  });
});

test("map content hides inherited controls and lists every feature category", async ({
  page,
}) => {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // Advertise feature capabilities using the local fixture tiles only.
    body.config.vectorLayers = {
      ...body.config.vectorLayers,
      water: { class: "String" },
      place: { class: "String" },
      mountain_peak: { ele: "Number" },
      building: {},
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await expect(
    page.getByRole("radiogroup", { name: "道路", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "地名", exact: true }),
  ).toBeVisible();
  const buildings = page.getByRole("radiogroup", {
    name: "建筑",
    exact: true,
  });
  await expect(
    buildings.getByRole("radio", { name: "显示（13 级起）", exact: true }),
  ).toBeChecked();
  await buildings.getByRole("radio", { name: "关闭", exact: true }).check();
  await expect(
    buildings.getByRole("radio", { name: "关闭", exact: true }),
  ).toBeChecked();
  await pickBasemap(page, "osm-standard");
  await expect(
    page.getByRole("radiogroup", { name: "道路", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "路网", exact: true }),
  ).toHaveCount(0);
  await pickBasemap(page, "vector");
  await expect(
    buildings.getByRole("radio", { name: "关闭", exact: true }),
  ).toBeChecked();
});
