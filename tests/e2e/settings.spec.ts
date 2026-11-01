import { expect, test, type Page } from "@playwright/test";
import { resetDisplay } from "./display-reset.js";
import { pickAppearance, pickBasemap, tool } from "./map-tools.js";

test.beforeEach(async ({ request }) => {
  await resetDisplay(request);
});

for (const width of [1280, 390]) {
  test(`track styles preview, persist and reset independently at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/map?panel=settings");
    await pickAppearance(page, "深色");
    await page.getByRole("button", { name: "轨迹样式", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "轨迹样式", exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel("选中轨迹颜色", { exact: true })).toHaveValue(
      "#ffd700",
    );
    await expect(page.getByLabel("未分类颜色", { exact: true })).toHaveCount(0);
    await expect(
      page.getByLabel("未分类不透明度", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "当前轨迹常用颜色" }),
    ).toHaveCount(0);
    const number = (name: string) =>
      page.getByRole("spinbutton", { name, exact: true });
    await page
      .getByRole("slider", { name: "全部轨迹线宽滑块" })
      .press("ArrowRight");
    await expect(number("全部轨迹线宽")).toHaveValue("3");
    await number("全部轨迹线宽").fill("6.5");
    await number("全部轨迹线宽").blur();
    await page.getByLabel("普通行程颜色", { exact: true }).fill("#9333ea");
    await number("普通行程不透明度").fill("25");
    await number("普通行程不透明度").blur();
    await page.getByLabel("选中轨迹颜色", { exact: true }).fill("#1677ff");
    await number("选中轨迹线宽").fill("7");
    await number("选中轨迹线宽").blur();
    await expect(
      page.getByRole("switch", { name: "描边", exact: true }),
    ).toHaveCount(0);
    const saved = async () => {
      const response = await request.get("/api/bootstrap", {
        headers: { "X-Tracktool-Token": "e2e" },
      });
      return (await response.json()).state.style;
    };
    await expect.poll(saved).toMatchObject({
      appearance: "dark",
      tracks: {
        width: 6.5,
        categories: { Default: { color: "#9333ea", opacity: 0.25 } },
        current: { color: "#1677ff", width: 7 },
      },
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const renderer = window.renderer!;
          const map = renderer.map;
          const overview = map
            .getStyle()
            .layers.find(
              (layer) =>
                layer.id.startsWith("overview-") && layer.id.endsWith("-line"),
            );
          return {
            detailWidth:
              Number(map.getPaintProperty("track-lines", "line-width")) /
              renderer.displayScale,
            haloLayers: map
              .getStyle()
              .layers.filter(
                (item) =>
                  item.id === "track-halo" ||
                  (item.id.startsWith("overview-") &&
                    item.id.endsWith("-halo")),
              ).length,
            overviewWidth: overview
              ? Number(
                  (
                    map.getPaintProperty(overview.id, "line-width") as unknown[]
                  ).at(-1),
                ) / renderer.displayScale
              : undefined,
            overviewColor: overview
              ? map.getPaintProperty(overview.id, "line-color")
              : undefined,
          };
        }),
      )
      .toMatchObject({
        detailWidth: 7,
        overviewWidth: 6.5,
        haloLayers: 0,
        overviewColor: [
          "case",
          expect.any(Array),
          "#1677ff",
          [
            "match",
            ["get", "kind"],
            "Default",
            "#9333ea",
            "Train",
            expect.any(String),
            "Flight",
            expect.any(String),
            expect.any(String),
          ],
        ],
      });
    await page.reload();
    await page.getByRole("button", { name: "轨迹样式", exact: true }).click();
    await expect(number("全部轨迹线宽")).toHaveValue("6.5");
    await expect(page.getByLabel("选中轨迹颜色", { exact: true })).toHaveValue(
      "#1677ff",
    );
    await expect(
      page.getByRole("switch", { name: "描边", exact: true }),
    ).toHaveCount(0);
    await page.locator(".settings-panel").evaluate((panel) => {
      const controls = panel.closest(".map-controls");
      if (controls) controls.scrollTop = 0;
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const panel = page.locator(".settings-panel");
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("track-styles.png") });
    await page
      .getByRole("button", { name: "恢复默认样式", exact: true })
      .click();
    await expect.poll(saved).toMatchObject({
      appearance: "dark",
      tracks: {
        width: 2.5,
        current: { width: 3, color: "#ffd700" },
      },
    });
    await page.getByRole("button", { name: "返回设置", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "轨迹样式", exact: true }),
    ).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("track style save failures can be retried from the style panel", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  await page.route("**/api/display", (route) =>
    route.fulfill({
      status: 500,
      json: { error: { message: "测试保存失败" } },
    }),
  );
  await page.getByRole("button", { name: "轨迹样式", exact: true }).click();
  await page.getByLabel("选中轨迹颜色", { exact: true }).fill("#1677ff");
  await expect(page.getByRole("alert")).toContainText("显示样式保存失败");
  await page.unroute("**/api/display");
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/api/display") && response.ok(),
  );
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await saved;
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("selected track stays highlighted while previewing its color in settings", async ({
  page,
}) => {
  await page.goto("/map?panel=library");
  await page
    .getByRole("button", {
      name: "查看 Default/2026-10-01 中文.kml",
      exact: true,
    })
    .click();
  const paint = () =>
    page.evaluate(() => {
      const renderer = window.renderer!;
      const map = renderer.map;
      const layer = map
        .getStyle()
        .layers.find(
          (item) =>
            item.id.startsWith("overview-") && item.id.endsWith("-line"),
        );
      if (!layer) return;
      return {
        color: map.getPaintProperty(layer.id, "line-color"),
      };
    });
  await expect.poll(paint).toMatchObject({
    color: [
      "case",
      ["==", ["get", "trackId"], expect.stringMatching(/.+/)],
      "#ffd700",
      expect.any(Array),
    ],
  });
  const before = await paint();
  await tool(page, "设置");
  await page.getByRole("button", { name: "轨迹样式", exact: true }).click();
  await expect.poll(paint).toEqual(before);
  await page.getByLabel("选中轨迹颜色", { exact: true }).fill("#9333ea");
  const previousColor = before!.color as unknown[];
  await expect.poll(paint).toEqual({
    color: ["case", previousColor[1], "#9333ea", previousColor[3]],
  });
});

test("editing keeps operation colors without track outlines", async ({
  page,
}) => {
  await page.goto("/map?panel=settings");
  await page.getByRole("button", { name: "轨迹样式", exact: true }).click();
  await page.getByLabel("选中轨迹颜色", { exact: true }).fill("#9333ea");
  const width = page.getByRole("spinbutton", {
    name: "选中轨迹线宽",
    exact: true,
  });
  await width.fill("7");
  await width.blur();
  await tool(page, "轨迹库");
  await page
    .getByRole("button", {
      name: "查看 Default/2026-10-01 中文.kml",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "编辑轨迹", exact: true }).click();
  await page.getByRole("button", { name: "断开轨迹", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "段编辑地图" }),
  ).toHaveAttribute("data-status", "ready");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "断开轨迹", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const renderer = window.renderer!;
        const map = renderer.map;
        const layer = map
          .getStyle()
          .layers.find(
            (item) =>
              item.id.startsWith("overview-") && item.id.endsWith("-line"),
          );
        if (!layer) return;
        const source = layer.id.slice(0, -5);
        return {
          line: map.getPaintProperty(layer.id, "line-opacity"),
          haloLayers: map
            .getStyle()
            .layers.filter((item) => item.id.endsWith("-halo")).length,
          point: map.getPaintProperty(`${source}-point`, "circle-opacity"),
          stroke: map.getPaintProperty(
            `${source}-point`,
            "circle-stroke-width",
          ),
          detailWidth:
            Number(map.getPaintProperty("track-lines", "line-width")) /
            renderer.displayScale,
          detailColor: map.getPaintProperty("track-lines", "line-color"),
        };
      }),
    )
    .toMatchObject({
      line: 0,
      haloLayers: 0,
      point: 0,
      stroke: 0,
      detailWidth: 7,
      detailColor: expect.arrayContaining(["#dc2626", "#16a34a", "#ea580c"]),
    });
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
    await page.goto("/map?panel=settings");
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
    // Switching CRS rebuilds the overview; keep the poll well above that.
    await expect
      .poll(() => page.evaluate(() => window.renderer?.state.style.basemap), {
        timeout: 15_000,
      })
      .toBe("osm-standard");
    await choice("返回设置").click();
    await pickAppearance(page, "浅色");
    await expectAppearance(page, "light");
    // Switching CRS rebuilds the overview; keep the poll well above that.
    await expect
      .poll(() => page.evaluate(() => window.renderer?.state.style.basemap), {
        timeout: 15_000,
      })
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
  await page.goto("/map?panel=settings");
  await expect(
    page.getByRole("combobox", { name: "进入时轨迹", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "轨迹样式", exact: true }).click();
  const choice = page.getByRole("combobox", {
    name: "进入时轨迹",
    exact: true,
  });
  await expect(choice).toHaveText("全部显示");
  await choice.click();
  await page.getByRole("option", { name: "全部隐藏", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "轨迹样式", exact: true }).click();
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

test("settings group map controls and server configuration writes require CLI", async ({
  page,
}, info) => {
  const errors: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/map?panel=settings");
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  await expect(page.getByLabel("图源", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回设置", exact: true }).click();
  const mapSettings = page.getByRole("button", {
    name: "地图设置",
    exact: true,
  });
  await expect(mapSettings).toBeFocused();
  await expect(page.locator(".settings-panel").getByRole("button")).toHaveCount(
    2,
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
  await expect(page.locator(".app-icon")).toBeVisible();
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
  await page.goto("/map?panel=settings");
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
  await page.goto("/map?panel=settings");
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
  await opacity.blur();
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
  await page.goto("/map?panel=settings");
  await page.getByRole("button", { name: "地图设置", exact: true }).click();
  const layer = page.getByRole("group", { name: "铁路图层", exact: true });
  await layer.getByRole("switch").check();
  await layer.locator(".settings-layer-toggle").click();
  const opacity = layer.getByRole("spinbutton", { name: "铁路不透明度" });
  await opacity.fill("90");
  await opacity.blur();
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
  await page.goto("/map?panel=settings");
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
