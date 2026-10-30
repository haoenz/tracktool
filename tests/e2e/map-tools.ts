import { expect, type Page } from "@playwright/test";
import type {} from "../../src/drawing/globals.js";
const openVendors = ["OSM", "memomaps", "OpenTopoMap", "OpenFreeMap"];
export async function pickAppearance(page: Page, name: string) {
  await page.getByRole("combobox", { name: "配色", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}
/** Pick a basemap through the two-level vendor picker. */
export async function pickBasemap(page: Page, id: string) {
  const { vendor, name } = await page.evaluate(
    ({ id, open }) => {
      if (id === "vector")
        return { vendor: "开放地图", name: "OpenFreeMap 矢量底图" };
      const preset = window.renderer!.config.basemaps.find((b) => b.id === id)!;
      return {
        vendor: open.includes(preset.group) ? "开放地图" : preset.group,
        name: preset.name,
      };
    },
    { id, open: openVendors },
  );
  await page.getByRole("button", { name: vendor, exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function openMenu(page: Page) {
  const icon = page.locator(".app-icon");
  if ((await icon.getAttribute("aria-expanded")) !== "true") await icon.click();
  await expect(icon).toHaveAttribute("aria-expanded", "true");
}
/** Navigate only through visible workspace controls. */
export async function tool(page: Page, name: string) {
  await expect(page.locator(".app-icon")).toBeVisible();
  if (["地图样式", "设置"].includes(name)) {
    const settings = page.getByRole("button", { name: "设置", exact: true });
    if ((await settings.getAttribute("aria-expanded")) !== "true")
      await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    if (name === "地图样式") {
      const mapSettings = page.getByRole("button", {
        name: "地图设置",
        exact: true,
      });
      if (!(await page.getByLabel("图源", { exact: true }).isVisible()))
        await mapSettings.click();
    }
    return;
  }
  if (name === "返回浏览") {
    const exit = page.getByRole("button", { name: "退出出图", exact: true });
    if (await exit.isVisible()) {
      await exit.click();
      return;
    }
    const icon = page.locator(".app-icon");
    if ((await icon.getAttribute("aria-expanded")) === "true")
      await icon.click();
    return;
  }
  await openMenu(page);
  if (name === "轨迹库") {
    const list = page.getByRole("button", {
      name: "打开轨迹列表",
      exact: true,
    });
    if ((await list.getAttribute("aria-expanded")) !== "true")
      await list.click();
    await expect(list).toHaveAttribute("aria-expanded", "true");
    return;
  }
  if (name === "出图") {
    const bar = page.getByRole("region", { name: "出图设置" });
    if (!(await bar.isVisible()))
      await page.getByRole("button", { name: "出图", exact: true }).click();
    await expect(bar).toBeVisible();
    return;
  }
  if (name === "导出轨迹") {
    await page.getByRole("button", { name: "导出轨迹", exact: true }).click();
    return;
  }
  await page.getByRole("button", { name, exact: true }).click();
}
export async function setTrackVisible(
  page: Page,
  entry: string,
  visible = true,
) {
  await tool(page, "轨迹库");
  const back = page.getByRole("button", { name: "返回列表", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByLabel("筛选轨迹", { exact: true }).fill(entry);
  const row = page.locator(".track-row").filter({ hasText: entry }).first();
  await expect(row).toBeVisible();
  const toggle = row.getByRole("button", {
    name: visible ? /^显示 / : /^隐藏 /,
  });
  if (await toggle.count()) await toggle.click();
  await expect
    .poll(async () => (await row.innerText()).includes(entry))
    .toBe(true);
}
export async function batchTrack(page: Page, entry: string) {
  await tool(page, "轨迹库");
  const back = page.getByRole("button", { name: "返回列表", exact: true });
  if (await back.isVisible()) await back.click();
  const batch = page.getByRole("button", { name: "批量操作", exact: true });
  if ((await batch.getAttribute("aria-pressed")) !== "true")
    await batch.click();
  await page
    .getByRole("button", { name: `选择 ${entry}`, exact: true })
    .click();
}
export async function filterTracks(page: Page, search: string) {
  await page.getByLabel("筛选轨迹", { exact: true }).fill(search);
}
export async function expectTrackFilter(page: Page, search: string) {
  await expect(page.getByLabel("筛选轨迹", { exact: true })).toHaveValue(
    search,
  );
}

export async function pickEditorPoint(
  page: Page,
  index: number,
  locate = true,
) {
  if (locate) {
    const selectedButton = page
      .getByLabel("选择编辑片段", { exact: true })
      .getByRole("button", { pressed: true });
    const select = page.getByRole("combobox", {
      name: "选择编辑片段",
      exact: true,
    });
    if (await selectedButton.count()) await selectedButton.click();
    else if (await select.count()) {
      const selected = (await select.innerText()).trim();
      // Selecting the same Radix option does not emit a change or refit the map.
      await select.click();
      await page
        .getByRole("option")
        .filter({ hasNotText: selected })
        .first()
        .click();
      await select.click();
      await page.getByRole("option", { name: selected, exact: true }).click();
      await expect(select).toBeFocused();
    }
  }
  const handle = page.getByRole("button", { name: /调整面板高度/ });
  const sheet = await page.locator(".map-app").getAttribute("data-sheet");
  const mobile = await handle.isVisible();
  if (mobile) {
    await handle.press("Home");
    await expect
      .poll(
        async () =>
          (await page
            .getByRole("complementary", { name: "地图控制面板" })
            .boundingBox())!.height,
      )
      .toBeLessThan(60);
  }
  await expect
    .poll(() =>
      page.evaluate(() => !!window.renderer && !window.renderer.map.isMoving()),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!window.renderer?.data?.features.some(
            (f) =>
              f.properties?.segment_id &&
              !String(f.properties.segment_id).startsWith("ux-") &&
              f.geometry.type === "MultiLineString",
          ),
      ),
    )
    .toBe(true);
  // The frame is CSS-transformed and can settle after the camera stops, so
  // re-project and re-check the hit target until the canvas owns the point.
  let point: { x: number; y: number } | undefined;
  let lastHit = "";
  let candidateX = 0,
    candidateY = 0;
  for (let attempt = 0; attempt < 50 && !point; attempt++) {
    const candidate = await page.evaluate((index) => {
      const r = window.renderer!;
      const feature = (r.displayData ?? r.data)!.features.find(
        (f) =>
          f.properties?.segment_id &&
          !String(f.properties.segment_id).startsWith("ux-") &&
          f.geometry.type === "MultiLineString",
      )!;
      if (feature.geometry.type !== "MultiLineString")
        throw Error("Expected line");
      const coord = feature.geometry.coordinates[0]![index]!;
      const p = r.map.project([coord[0]!, coord[1]!]),
        box = r.mapElement.getBoundingClientRect();
      return {
        x: box.left + (p.x * box.width) / r.mapElement.clientWidth,
        y: box.top + (p.y * box.height) / r.mapElement.clientHeight,
      };
    }, index);
    candidateX = candidate.x;
    candidateY = candidate.y;
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element ? element.className + "|" + element.tagName : "null";
    }, candidate);
    if (hit.startsWith("maplibregl-canvas")) point = candidate;
    else {
      lastHit = hit;
      await page.waitForTimeout(100);
    }
  }
  if (!point) {
    const state = await page.evaluate(() => {
      const r = window.renderer!;
      const panel = document.getElementById("map-panel");
      return JSON.stringify({
        camera: r.state.camera,
        panel: panel?.getBoundingClientRect().toJSON(),
        stage: document
          .querySelector(".map-stage")
          ?.getBoundingClientRect()
          .toJSON(),
        groups: (r.data?.features ?? []).map((f) => f.properties?.segment_id),
      });
    });
    throw new Error(
      `地图点位被遮挡，无法拾取：${lastHit} @ ${candidateX},${candidateY} ${state}`,
    );
  }
  await page.mouse.click(point.x, point.y);
  if (mobile && sheet !== "collapsed") {
    await handle.press(sheet === "full" ? "End" : "ArrowUp");
    await expect(page.locator(".map-app")).toHaveAttribute(
      "data-sheet",
      sheet!,
    );
  }
}
