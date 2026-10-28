import { expect, test, type Page } from "@playwright/test";
import type { StoredPrint } from "../../src/web/print-store.js";
import { resetDisplay } from "./display-reset.js";

async function saved(page: Page): Promise<StoredPrint[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("tracktool-print", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const rows = db
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .getAll();
          rows.onsuccess = () => {
            db.close();
            resolve(rows.result);
          };
          rows.onerror = () => {
            db.close();
            reject(rows.error);
          };
        };
      }),
  );
}

test("reload continues the current draft and edits during PNG export cannot overwrite its snapshot", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await resetDisplay(request);
  await page.goto("/map?panel=print");
  const title = page.getByLabel("标题", { exact: true });
  await title.fill("连续编辑");
  await expect(
    page.getByRole("button", { name: "草稿 1", exact: true }),
  ).toBeVisible();
  const id = (await saved(page))[0]!.id;
  await page.reload();
  await expect(title).toHaveValue("连续编辑");
  await title.fill("已导出快照");
  await expect
    .poll(() => saved(page).then((rows) => rows[0]?.document.title))
    .toBe("已导出快照");
  expect((await saved(page)).map((row) => row.id)).toEqual([id]);

  let submitted!: () => void;
  let release!: () => void;
  const submittedPromise = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/print", async (route) => {
    const response = await route.fetch();
    submitted();
    await hold;
    await route.fulfill({ response });
  });
  const pending = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("button", { name: "导出 PNG", exact: true }).click();
  await submittedPromise;
  await title.fill("导出期间继续编辑");
  await expect
    .poll(() => saved(page).then((rows) => rows[0]?.document.title))
    .toBe("导出期间继续编辑");
  release();
  expect((await pending).suggestedFilename()).toBe("已导出快照.png");
  await expect
    .poll(() =>
      saved(page).then((rows) => rows.map((row) => row.document.title).sort()),
    )
    .toEqual(["导出期间继续编辑", "已导出快照"].sort());
  expect((await saved(page)).find((row) => row.id === id)!.document.title).toBe(
    "已导出快照",
  );
});
