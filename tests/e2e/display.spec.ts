import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { tool, selectProjectTrack, saveProject } from "./map-tools.js";
import type { Project } from "../../src/shared/project.js";
import type { Selection } from "../../src/shared/map.js";
import type { TrackDetail } from "../../src/shared/track-edit.js";
import type {} from "../../src/drawing/globals.js";

async function call<T>(page: Page, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ url, body }) => {
      const token = document.querySelector<HTMLMetaElement>(
        'meta[name="tracktool-token"]',
      )!.content;
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-tracktool-token": token,
          "x-tracktool-render": token,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { url, body },
  ) as Promise<T>;
}
const state = (page: Page) => page.evaluate(() => window.renderer!.state);
const geometry = (page: Page) =>
  page.evaluate(() => window.renderer!.data!.features.map((f) => f.geometry));

test("project display stays fixed, exports the same geometry, and updates only explicitly", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/map");
  const fixture = await call<{ id: string; path: string }>(
    page,
    "/api/test/edit-fixture",
    {},
  );
  const projectName = `P4-${fixture.id}`;
  try {
    await page.reload();
    await tool(page, "新建出图工程");
    await selectProjectTrack(page, fixture.path);
    await expect.poll(async () => (await state(page)).tracks.length).toBe(1);
    await page.locator(".project-presentation summary").click();
    const defaults = await call<TrackDetail>(page, `/api/tracks/${fixture.id}`);
    await page
      .getByRole("checkbox", { name: "项目默认连接相邻段", exact: true })
      .click();
    await page
      .getByRole("button", { name: "应用到当前项目", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await state(page)).tracks[0]?.override?.settings.default_connect,
      )
      .toBe(false);
    const fixed = await state(page),
      fixedGeometry = await geometry(page);
    expect(
      (await call<TrackDetail>(page, `/api/tracks/${fixture.id}`)).settings,
    ).toEqual(defaults.settings);
    await saveProject(page, projectName);
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出展示 KML", exact: true })
      .click();
    const kml = await readFile((await (await download).path())!, "utf8");
    expect(kml).toContain("tracktool:display:1");
    expect(kml.match(/<LineString /g)).toHaveLength(2);
    expect(kml).not.toContain("<name>连接线</name>");
    const png = await call<{ job: string }>(page, "/api/export", fixed);
    const render = await call<{ state: Project; tracks: Selection["tracks"] }>(
      page,
      `/api/render/${png.job}`,
    );
    expect(
      render.tracks.flatMap((t) => t.geojson.features.map((f) => f.geometry)),
    ).toEqual(fixedGeometry);
    await expect
      .poll(
        async () =>
          (
            await call<{ status: string; error?: string }>(
              page,
              `/api/jobs/${png.job}`,
            )
          ).status,
        { timeout: 60000 },
      )
      .toBe("done");
    await call(page, "/api/test/edit-presentation", { id: fixture.id });
    await tool(page, "轨迹库");
    await page
      .getByRole("button", { name: /^(隐藏|显示) 索引未命中$/, exact: true })
      .click();
    expect(
      (await state(page)).tracks.find((t) => t.entry_id === fixture.id),
    ).toEqual(fixed.tracks[0]);
    await page
      .getByRole("button", { name: /^(隐藏|显示) 索引未命中$/, exact: true })
      .click();
    await tool(page, "出图");
    await expect.poll(() => geometry(page)).toEqual(fixedGeometry);
    const reopened = await call<{ state: Project } & Selection>(
      page,
      "/api/projects/load",
      { archive: fixed.archive, name: projectName },
    );
    expect(reopened.state.tracks).toEqual(fixed.tracks);
    expect(
      reopened.tracks.flatMap((t) => t.geojson.features.map((f) => f.geometry)),
    ).toEqual(fixedGeometry);
    await page
      .getByRole("group", { name: "出图设置" })
      .getByRole("button", { name: "内容", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", {
        name: "采用库中当前版本并重置项目覆盖",
        exact: true,
      })
      .click();
    await expect
      .poll(async () => (await state(page)).tracks[0]?.presentation_id)
      .not.toBe(fixed.tracks[0]!.presentation_id);
    expect((await state(page)).tracks[0]!.override).toBeUndefined();
    expect((await geometry(page))[0]).toMatchObject({
      type: "MultiLineString",
      coordinates: [
        [
          [120.04, 30],
          [120.05, 30],
        ],
      ],
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("project-display-mobile.png"),
    });
    expect(errors).toEqual([]);
  } finally {
    await call(page, "/api/test/edit-cleanup", {
      id: fixture.id,
      project: projectName,
    });
  }
});
