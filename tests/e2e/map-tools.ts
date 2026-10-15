import { expect, type Page } from "@playwright/test";
/** Navigate using visible map entry points; never patch URL or app state. */
export async function tool(page: Page, name: string) {
  await expect(page.locator(".project-icon")).toBeVisible();
  const expand = page.getByRole("button", {
    name: "展开项目菜单",
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  const nav = page.getByRole("navigation", { name: "地图工具", exact: true });
  if (name === "地图样式" || name === "设置") {
    const settings = nav.getByRole("button", { name: "设置", exact: true });
    if ((await settings.getAttribute("aria-pressed")) !== "true")
      await settings.click();
    return;
  }
  const tracks = nav.getByRole("button", { name: "轨迹", exact: true });
  if ((await tracks.getAttribute("aria-pressed")) !== "true")
    await tracks.click();
  if (name === "轨迹库") {
    const back = page.getByRole("button", { name: "返回轨迹库", exact: true });
    if (await back.isVisible()) await back.click();
    return;
  }
  const exportButton = page.getByRole("button", {
    name: "轨迹导出",
    exact: true,
  });
  if (await exportButton.isVisible()) await exportButton.click();
  if (["新建出图工程", "打开已有工程", "返回浏览", "处理记录"].includes(name)) {
    await page.getByRole("button", { name, exact: true }).click();
    if (name === "新建出图工程")
      await expect(
        page.getByRole("button", { name: "返回浏览", exact: true }),
      ).toBeEnabled();
  }
}
