import { test, expect } from "@playwright/test";
import { filterTracks } from "./map-tools.js";

for (const width of [1280, 390]) {
  test(`delete confirmation, cancellation and retry at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/map?panel=library");
    const fixture = await page.evaluate(async () => {
      const response = await fetch("/api/test/edit-fixture", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tracktool-token": document.querySelector<HTMLMetaElement>(
            'meta[name="tracktool-token"]',
          )!.content,
        },
        body: "{}",
      });
      return response.json() as Promise<{ path: string }>;
    });
    await page.reload();
    await filterTracks(page, fixture.path.split("/").at(-1)!);
    const row = page.getByRole("button", {
      name: `查看 ${fixture.path}`,
      exact: true,
    });
    await row.click();
    const open = async () => {
      await page.getByRole("button", { name: "更多轨迹操作" }).click();
      await page.getByRole("button", { name: "删除轨迹", exact: true }).click();
    };
    await open();
    const dialog = page.getByRole("dialog");
    const remove = dialog.getByRole("button", {
      name: "删除",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
    await expect(remove).toBeEnabled();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "轨迹详情", exact: true }),
    ).toBeVisible();
    await page.route("**/api/work/tasks/*", async (route) => {
      const response = await route.fetch();
      const task = await response.json();
      if (task.output?.data?.deletion_preview) {
        task.output.data.deletion_preview.dependencies = [
          {
            kind: "project",
            id: "周末出行",
            detail: "Project references this track",
          },
        ];
      }
      await route.fulfill({ response, json: task });
    });
    await open();
    await expect(dialog).toContainText("周末出行");
    await expect(remove).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "查看项目" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await page.unroute("**/api/work/tasks/*");
    await open();
    await expect(remove).toBeEnabled();
    await page.route(
      "**/api/work/tasks/*/apply",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "删除失败测试" } }),
        }),
      { times: 1 },
    );
    await remove.click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("轨迹已删除", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "轨迹详情", exact: true }),
    ).toBeHidden();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(row).toHaveCount(0);
  });
}
