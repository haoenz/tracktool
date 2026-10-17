import { expect, type Page } from "@playwright/test";
/** Navigate only through visible workspace controls. */
export async function tool(page: Page, name: string) {
  await expect(page.locator(".project-icon")).toBeVisible();
  if (["地图样式", "设置"].includes(name)) {
    const settings = page.getByRole("button", { name: "设置", exact: true });
    if ((await settings.getAttribute("aria-expanded")) !== "true")
      await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    return;
  }
  if (name === "返回浏览") {
    await page.getByRole("button", { name: "退出工程", exact: true }).click();
    return;
  }
  const tracks = page.locator(".project-icon");
  if ((await tracks.getAttribute("aria-expanded")) !== "true")
    await tracks.click();
  await expect(tracks).toHaveAttribute("aria-expanded", "true");
  if (name === "轨迹库") {
    await page.getByRole("button", { name: "打开轨迹列表", exact: true }).click();
    return;
  }
  const currentPanel = new URL(page.url()).searchParams.get("panel");
  const inProject = await page
    .getByRole("region", { name: "当前出图工程" })
    .isVisible();
  if (inProject && !["export", "project"].includes(currentPanel ?? "")) {
    await page.getByRole("button", { name: "导出轨迹", exact: true }).click();
    await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
    await page.getByRole("option", { name: "PNG图像", exact: true }).click();
    await expect(page.getByRole("group", { name: "出图设置" })).toBeVisible();
  } else if (
    !inProject &&
    !["export", "project"].includes(currentPanel ?? "")
  ) {
    const home = page.getByRole("button", { name: "返回轨迹库", exact: true });
    if (await home.isVisible()) await home.click();
    await page.getByRole("button", { name: "导出轨迹", exact: true }).click();
    await page.getByRole("combobox", { name: "导出类型", exact: true }).click();
    await page.getByRole("option", { name: "PNG图像", exact: true }).click();
  }
  if (["新建出图工程", "打开已有工程"].includes(name)) {
    await page.getByRole("button", { name, exact: true }).click();
    if (name === "新建出图工程")
      await expect(
        page.getByRole("button", { name: "退出工程", exact: true }),
      ).toBeEnabled();
  }
  const tab =
    name === "工程样式"
      ? "样式"
      : name === "项目"
        ? "更多"
        : name === "出图"
          ? "画框与输出"
          : undefined;
  if (tab)
    await page
      .getByRole("group", { name: "出图设置" })
      .getByRole("button", { name: tab, exact: true })
      .click();
}
export async function selectProjectTrack(page: Page, entry: string) {
  await tool(page, "出图");
  await page
    .getByRole("group", { name: "出图设置" })
    .getByRole("button", { name: "内容", exact: true })
    .click();
  await page.getByRole("combobox", { name: "出图轨迹", exact: true }).click();
  await page
    .getByRole("combobox", { name: "搜索出图轨迹", exact: true })
    .fill(entry);
  await page.getByRole("option", { name: entry, exact: true }).click();
  await page.keyboard.press("Escape");
}
export async function batchTrack(page: Page, entry: string) {
  await tool(page, "轨迹库");
  const back = page.getByRole("button", { name: "返回列表", exact: true });
  if (await back.isVisible()) await back.click();
  if (
    !(await page
      .getByRole("region", { name: "批量操作", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "批量操作", exact: true }).click();
  const row = page
    .getByRole("button", { name: `查看 ${entry}`, exact: true })
    .locator("..");
  await row.getByRole("checkbox").check();
}
export async function saveProject(page: Page, name: string) {
  await page
    .getByRole("region", { name: "当前出图工程" })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: "另存工程" });
  await modal.getByLabel("另存为名称").fill(name);
  await modal.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.locator(".save-state")).toHaveText("已保存");
}

export async function filterTracks(page: Page, search: string) {
  await page.getByLabel("筛选轨迹", { exact: true }).fill(search);
}
export async function expectTrackFilter(page: Page, search: string) {
  await expect(page.getByLabel("筛选轨迹", { exact: true })).toHaveValue(
    search,
  );
}

export async function pickEditorPoint(page: Page, index: number) {
  await page.getByRole("button", { name: "定位轨迹", exact: true }).click();
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
  const point = await page.evaluate((index) => {
    const r = window.renderer!;
    const feature = r.data!.features.find(
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
  await page.mouse.click(point.x, point.y);
}
