import { expect, type Page } from "@playwright/test";
/** Navigate using visible map entry points; never patch URL or app state. */
export async function tool(page: Page, name: string) {
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
  const group =
    name === "轨迹库"
      ? "轨迹库"
      : name === "处理记录" || name === "轨迹处理"
        ? "轨迹处理"
        : "轨迹导出";
  await page.getByRole("tab", { name: group, exact: true }).click();
  if (["新建出图工程", "打开已有工程", "返回浏览", "处理记录"].includes(name)) {
    await page.getByRole("button", { name, exact: true }).click();
    if (name === "新建出图工程")
      await expect(
        page.getByRole("button", { name: "返回浏览", exact: true }),
      ).toBeEnabled();
  }
}
