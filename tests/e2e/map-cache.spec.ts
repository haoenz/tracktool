import { expect, test } from "@playwright/test";

test("the browser reuses map and overview tile responses without crossing sessions", async ({
  page,
}) => {
  await page.goto("/map");
  await page.waitForFunction(
    () => !!document.querySelector('meta[name="tracktool-token"]'),
  );
  const resources = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="tracktool-token"]',
    )!.content;
    const headers = { "X-Tracktool-Token": token };
    const bootstrap = await (await fetch("/api/bootstrap", { headers })).json();
    return {
      token,
      version: bootstrap.config.versions.map_resources as string,
    };
  });
  let overview = "";
  await expect
    .poll(async () => {
      overview = await page.evaluate(async (token) => {
        const status = await (
          await fetch("/api/overview", {
            headers: { "X-Tracktool-Token": token },
          })
        ).json();
        return status.version ?? "";
      }, resources.token);
      return overview;
    })
    .not.toBe("");
  const urls = [
    `/tiles/vector/18/0/0.pbf?v=${resources.version}`,
    `/api/overview/tiles/${overview}/18/0/0.pbf`,
  ];
  for (const url of urls) {
    const transfers = await page.evaluate(
      async ({ url, token }) => {
        performance.clearResourceTimings();
        const sizes = [];
        for (let i = 0; i < 2; i++) {
          const response = await fetch(url, {
            headers: { "X-Tracktool-Token": token },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await response.arrayBuffer();
          sizes.push(
            (
              performance
                .getEntriesByName(new URL(url, location.href).href)
                .at(-1) as PerformanceResourceTiming
            ).transferSize,
          );
        }
        return sizes;
      },
      { url, token: resources.token },
    );
    expect(transfers[0]).toBeGreaterThan(0);
    expect(transfers[1]).toBe(0);
  }
  const denied = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      headers: { "X-Tracktool-Token": "expired" },
    });
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
    };
  }, urls[1]!);
  expect(denied).toEqual({ status: 403, cache: "no-store" });
});
