import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GoogleGeocode } from "../../dist/node/infrastructure/geocode.js";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
const dirs: string[] = [];
const signal = new AbortController().signal;
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-utility-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it("geocode chooses locality across all results, retries transport errors and hides API secrets", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("secret"))
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "OK",
          results: [
            {
              address_components: [
                {
                  types: ["administrative_area_level_2"],
                  long_name: "fallback",
                },
              ],
            },
            {
              address_components: [
                { types: ["locality"], long_name: "City" },
                { types: ["country"], long_name: "Country", short_name: "CC" },
              ],
            },
          ],
        }),
      ),
    );
  const client = new GoogleGeocode(request, async () => {});
  expect(await client.get([0, 0], "secret", "en", signal)).toEqual({
    city: "City",
    country: "Country",
    country_code_iso: "CC",
    state: "",
  });
  expect(request).toHaveBeenCalledTimes(2);
  await expect(
    new GoogleGeocode(
      async () =>
        new Response(
          JSON.stringify({ status: "REQUEST_DENIED", error_message: "secret" }),
        ),
    ).get([0, 0], "secret", "en", signal),
  ).rejects.toThrow(/^Google 地理编码接口返回：REQUEST_DENIED$/);
});
it("config set validates tag ownership, persists Unicode atomically and previews without files", async () => {
  const file = path.join(tmp(), "config.json"),
    store = new FileConfigStore({ path: file });
  await store.set("track_tag.Train", "+散步", true);
  expect(existsSync(file)).toBe(false);
  const value = await store.set("track_tag.Train", "+散步");
  expect(value["track_tag.Default"]).not.toContain("散步");
  expect(value["track_tag.Train"]).toContain("散步");
  await store.set("auto_fill_locations", "off");
  expect((await store.load()).auto_fill_locations).toBe(false);
  await expect(store.set("unknown-setting", "off")).rejects.toThrow();
  await expect(store.set("unknown", "x")).rejects.toThrow();
  expect(JSON.parse(readFileSync(file, "utf8"))["track_tag.Train"]).toContain(
    "散步",
  );
});
