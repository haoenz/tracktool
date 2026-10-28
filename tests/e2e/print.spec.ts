import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { tool } from "./map-tools.js";
import type { Page } from "@playwright/test";
import type { PrintDocument } from "../../src/shared/print.js";
import type { StoredPrint } from "../../src/web/print-store.js";
import { resetDisplay } from "./display-reset.js";
import sharp from "sharp";

test.beforeEach(async ({ request }) => resetDisplay(request));

async function drafts(page: Page): Promise<StoredPrint[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("tracktool-print", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("drafts")) {
            db.close();
            resolve([]);
            return;
          }
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

async function exportJson(page: Page): Promise<PrintDocument> {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const file = await pending;
  return JSON.parse(
    await readFile((await file.path())!, "utf8"),
  ) as PrintDocument;
}

async function importJson(page: Page, value: unknown) {
  await page.locator(".print-panel input[type=file]").setInputFiles({
    name: "print.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
}

test("print bar frames the current map, exports JSON and restores a local draft", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await page.goto("/map");
  await tool(page, "出图");
  const bar = page.getByRole("region", { name: "出图设置" });
  await expect(bar).toBeVisible();
  await expect(page.locator(".map-stage.print")).toHaveCount(1);
  const frame = page.locator(".frame-holder");
  await expect(frame).toBeVisible();
  const box = (await frame.boundingBox())!;
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(100);
  // The attribution strip belongs to the exported frame, so the preview shows
  // it inside the frame as well.
  expect(
    await page.evaluate(() => {
      const credit = window.renderer!.credit.getBoundingClientRect();
      const frame = document
        .querySelector(".map-frame")!
        .getBoundingClientRect();
      return credit.bottom <= frame.bottom + 2 && credit.top >= frame.top - 2;
    }),
  ).toBe(true);

  const title = bar.getByLabel("标题", { exact: true });
  await title.fill("测试出图");
  await bar.getByRole("combobox", { name: "画框比例", exact: true }).click();
  await page.getByRole("option", { name: /1:1/ }).click();
  await expect(bar.getByText(/^\d+ × \d+ px$/)).toBeVisible();
  const size = await bar.getByText(/^\d+ × \d+ px$/).innerText();
  const [width, height] = size.replace(" px", "").split(" × ").map(Number);
  expect(width).toBe(height);

  const json = page.waitForEvent("download");
  await bar.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const file = await json;
  expect(file.suggestedFilename()).toBe("测试出图.json");
  const path = info.outputPath("print.json");
  await file.saveAs(path);
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    format: string;
    title: string;
    tracks: unknown[];
  };
  expect(parsed.format).toBe("tracktool-print");
  expect(parsed.title).toBe("测试出图");
  expect(parsed.tracks.length).toBeGreaterThan(0);

  await title.fill("修改后的标题");
  await page.locator(".print-panel input[type=file]").setInputFiles(path);
  await expect(title).toHaveValue("测试出图");

  await page.waitForTimeout(1200);
  const drafts = bar.getByRole("button", { name: /^草稿/ });
  await drafts.click();
  const dialog = page.getByRole("dialog", { name: "最近草稿" });
  await expect(dialog).toContainText("测试出图");
  await dialog
    .getByRole("button", { name: "恢复", exact: true })
    .first()
    .click();
  await expect(dialog).toBeHidden();
  await expect(title).toHaveValue("测试出图");

  const png = page.waitForEvent("download", { timeout: 90_000 });
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/print") && r.request().method() === "POST",
  );
  await bar.getByRole("button", { name: "导出 PNG", exact: true }).click();
  const submitted = await response;
  expect(submitted.ok(), await submitted.text()).toBe(true);
  expect((await png).suggestedFilename()).toBe("测试出图.png");
});

test("one full-screen map keeps its camera and frame through ratio changes and reload", async ({
  page,
}) => {
  await page.goto("/map?panel=print");
  const panel = page.getByRole("region", { name: "出图设置" });
  await expect(panel).toBeVisible();
  await expect(page.locator('.map-stage[data-status="ready"]')).toBeVisible();
  await page.evaluate(() => {
    window.renderer!.map.jumpTo({ center: [120, 30], zoom: 8 });
  });
  const before = await page.evaluate(() => ({
    camera: window.renderer!.state.camera,
    scale: window.renderer!.frame.style.transform,
    canvas: (window.renderer!.map.getCanvas().id = "original-canvas"),
  }));
  await page.getByLabel("输出宽度", { exact: true }).fill("1000");
  await page.getByLabel("输出宽度", { exact: true }).press("Enter");
  for (const ratio of ["1:1", "2:3", "16:9", "3:4"]) {
    await page.getByRole("combobox", { name: "画框比例" }).click();
    await page.getByRole("option", { name: new RegExp(`^${ratio}`) }).click();
    await expect
      .poll(() => page.evaluate(() => window.renderer!.state.frame.ratio))
      .toBe(ratio);
    expect(await page.evaluate(() => window.renderer!.state.camera)).toEqual(
      before.camera,
    );
    expect(
      await page.evaluate(() => window.renderer!.frame.style.transform),
    ).toBe(before.scale);
    await expect(page.locator("#original-canvas")).toHaveCount(1);
    expect(await page.evaluate(() => window.renderer!.state.output.width)).toBe(
      1000,
    );
  }
  const frame = (await page.locator(".frame-holder").boundingBox())!;
  const controls = (await page.locator("#map-panel").boundingBox())!;
  expect(frame.x).toBeGreaterThan(controls.x + controls.width);
  const viewport = page.viewportSize()!;
  expect(frame.x + frame.width / 2).toBeCloseTo(
    (controls.x + controls.width + viewport.width) / 2,
    0,
  );
  const camera = await page.evaluate(() => window.renderer!.state.camera);
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(page.locator(".map-stage.print")).toHaveCount(1);
  await expect
    .poll(() => page.locator(".frame-holder").boundingBox())
    .toEqual(frame);
  expect(await page.evaluate(() => window.renderer!.state.camera)).toEqual(
    camera,
  );
  await page.getByLabel("标题", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".map-stage.print")).toHaveCount(0);
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(1);
  await tool(page, "出图");
  await page.evaluate(() => {
    window.renderer!.map.jumpTo({ center: [120, 80], zoom: 0 });
  });
  const canvas = (await page.locator(".maplibregl-canvas").boundingBox())!;
  expect(canvas.x).toBeLessThanOrEqual(0);
  expect(canvas.y).toBeLessThanOrEqual(0);
  expect(canvas.x + canvas.width).toBeGreaterThanOrEqual(viewport.width);
  expect(canvas.y + canvas.height).toBeGreaterThanOrEqual(viewport.height);
});

test("mobile print keeps the map full screen and the frame clear of the bottom panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map?panel=print");
  await expect(page.getByRole("region", { name: "出图设置" })).toBeVisible();
  const frame = (await page.locator(".frame-holder").boundingBox())!;
  const panel = (await page.locator("#map-panel").boundingBox())!;
  const stage = (await page.locator(".map-stage").boundingBox())!;
  expect(stage).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect(frame.y).toBeGreaterThan(0);
  expect(frame.y + frame.height).toBeLessThan(panel.y);
});

test("LAN-compatible UUIDs, atomic ten-draft retention, continuous editing and export boundaries", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  await page.goto("/map?panel=print");
  const title = page.getByLabel("标题", { exact: true });
  await expect(title).toBeVisible();
  await title.fill("连续编辑一");
  await expect.poll(() => drafts(page).then((rows) => rows.length)).toBe(1);
  await title.fill("连续编辑二");
  await expect
    .poll(() => drafts(page).then((rows) => rows[0]?.document.title))
    .toBe("连续编辑二");
  expect(await drafts(page)).toHaveLength(1);
  for (let i = 0; i < 12; i++) {
    await title.fill(`导出 ${i}`);
    const json = await exportJson(page);
    await expect
      .poll(() =>
        drafts(page).then((rows) =>
          rows.some(
            (row) => JSON.stringify(row.document) === JSON.stringify(json),
          ),
        ),
      )
      .toBe(true);
  }
  const rows = await drafts(page);
  expect(rows).toHaveLength(10);
  expect(rows.some((row) => row.document.title === "导出 0")).toBe(false);
  expect(
    rows.every((row) =>
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(
        row.id,
      ),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /^草稿/ }).click();
  const dialog = page.getByRole("dialog", { name: "最近草稿" });
  await dialog.getByRole("button", { name: "删除草稿" }).first().click();
  await expect.poll(() => drafts(page).then((rows) => rows.length)).toBe(9);
});

test("JSON and drafts share path-only recovery and reload never applies an old document", async ({
  page,
  request,
}) => {
  await page.goto("/map?panel=print");
  const original = await exportJson(page);
  const value = {
    ...original,
    archive: "/a/different/archive.sqlite3",
    title: "跨库恢复",
    style: { ...original.style, appearance: "dark" },
    tracks: [
      { entry: original.tracks[0]!.entry, sha256: "0".repeat(64) },
      { entry: "deleted.kml", sha256: original.tracks[0]!.sha256 },
    ],
  };
  page.on("dialog", async (dialog) => {
    await dialog.dismiss();
    throw new Error("跨库文档不应阻塞确认");
  });
  await importJson(page, value);
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "跨库恢复",
  );
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "1 条轨迹已不存在" }),
  ).toContainText("1 条轨迹已更新");
  expect((await exportJson(page)).tracks).toEqual([original.tracks[0]]);
  // Exercise the server with a foreign/nonexistent archive path as well.
  const submitted = await request.post("/api/print", {
    headers: { "X-Tracktool-Token": "e2e" },
    data: { document: value },
  });
  expect(submitted.ok(), await submitted.text()).toBe(true);
  const job = await submitted.json();
  expect(job.warnings).toContain("1 条轨迹已不存在");
  expect(job.warnings).toContain("1 条轨迹已更新");
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`/api/jobs/${job.job}`, {
              headers: { "X-Tracktool-Token": "e2e" },
            })
          ).json()
        ).status,
      { timeout: 90_000 },
    )
    .toMatch(/done|failed/);
  await expect
    .poll(() =>
      drafts(page).then((rows) =>
        rows.some((row) => row.document.title === value.title),
      ),
    )
    .toBe(true);
  await page.evaluate(
    (value) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("tracktool-print", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("drafts", "readwrite");
          tx.objectStore("drafts").put({
            id: "foreign",
            archive: value.archive,
            document: value,
            updatedAt: Date.now() + 1000,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    value,
  );
  await resetDisplay(request);
  await page.reload();
  await expect(page.getByRole("region", { name: "出图设置" })).toBeVisible();
  expect(
    await page.evaluate(() => window.renderer!.state.style.appearance),
  ).toBe("light");
  await page.getByRole("button", { name: /^草稿/ }).click();
  await page
    .getByRole("dialog", { name: "最近草稿" })
    .getByRole("button", { name: "恢复", exact: true })
    .first()
    .click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "1 条轨迹已不存在" }),
  ).toContainText("1 条轨迹已更新");
});

test("storage failure has one toast, never blocks PNG/JSON, and panel errors stay in the panel", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get: () => {
        throw new Error("blocked");
      },
    });
  });
  await page.goto("/map?panel=print");
  await page.getByLabel("标题", { exact: true }).fill("存储不可用");
  await expect(
    page.getByText("浏览器无法保存出图草稿，请及时导出 JSON。", {
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".map-errors, .print-panel")
      .filter({ hasText: "浏览器无法保存" }),
  ).toHaveCount(0);
  expect((await exportJson(page)).title).toBe("存储不可用");
  await page.locator(".print-panel input[type=file]").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await expect(page.locator(".print-panel [role=alert]")).toContainText(
    "出图文档无法读取",
  );
  await expect(
    page
      .locator(".map-errors, [data-sonner-toast]")
      .filter({ hasText: "出图文档无法读取" }),
  ).toHaveCount(0);
  const png = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("button", { name: "导出 PNG", exact: true }).click();
  expect((await png).suggestedFilename()).toBe("存储不可用.png");
});

for (const basemap of ["vector", "amap-satellite"]) {
  test(`preview pixels, title and credit match PNG for ${basemap}`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.goto("/map?panel=print");
    const value = await exportJson(page);
    value.title = "取景一致性";
    value.camera = { center: [103, 29], zoom: 6 };
    value.style = { ...value.style, basemap, appearance: "dark" };
    value.output = { width: 1000, height: 750 };
    await importJson(page, value);
    await expect
      .poll(() => page.evaluate(() => window.renderer!.state.style.basemap))
      .toBe(basemap);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.renderer!.map.getStyle().sources).some((id) =>
            id.startsWith("overview-"),
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(async () => {
      await window.renderer!.ready();
      await document.fonts.ready;
      window.renderer!.draw();
    });
    await expect(
      page.locator('[data-sonner-toast][data-visible="true"]'),
    ).toHaveCount(0, { timeout: 10_000 });
    const preview = await page
      .locator(".frame-holder")
      .screenshot({ path: info.outputPath("preview.png") });
    const pending = page.waitForEvent("download", { timeout: 90_000 });
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/print") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "导出 PNG", exact: true }).click();
    const submitted = await response;
    expect(submitted.ok(), await submitted.text()).toBe(true);
    const file = await pending;
    await file.saveAs(info.outputPath("export.png"));
    const png = await readFile((await file.path())!);
    expect(await sharp(png).metadata()).toMatchObject({
      width: 1000,
      height: 750,
    });
    const normalize = (bytes: Buffer) =>
      sharp(bytes).resize(480, 360).removeAlpha().raw().toBuffer();
    const actual = await normalize(preview);
    const expected = await normalize(png);
    // Ignore the one-pixel frame outline, and compare decorations separately
    // so a blank map cannot conceal a missing title or attribution strip.
    for (const [top, bottom] of [
      [2, 40],
      [40, 340],
      [340, 358],
    ]) {
      let difference = 0,
        count = 0;
      for (let y = top!; y < bottom!; y++)
        for (let x = 2; x < 478; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * 480 + x) * 3 + c;
            difference += Math.abs(actual[i]! - expected[i]!);
            count++;
          }
      expect(difference / count).toBeLessThan(4);
    }
  });
}
