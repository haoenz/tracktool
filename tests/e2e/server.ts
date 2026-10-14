import { mkdtemp, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../../dist/node/server/app.js";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
import { MapResources } from "../../dist/node/infrastructure/maps/resources.js";
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "tracktool-m3-browser-"),
);
const configPath = path.join(temporary, "config.json");
await copyFile("tests/e2e/config.json", configPath);
const archive = path.join(temporary, "archive.sqlite3");
await copyFile("tests/ts/fixtures/maps/archive.sqlite3", archive);
// A valid empty MVT layer: no external requests or misleading basemap fixtures.
const tile = Buffer.from([26, 9, 10, 5, 119, 97, 116, 101, 114, 120, 2]);
const raster = await sharp({
  create: { width: 256, height: 256, channels: 3, background: "#dce9ef" },
})
  .png()
  .toBuffer();
const resources = new MapResources(path.join(temporary, "cache"), {
  env: {},
  fetch: async (url) => {
    if (url === "https://tiles.openfreemap.org/planet")
      return Buffer.from(
        JSON.stringify({
          tiles: ["https://example.test/{z}/{x}/{y}.pbf"],
          maxzoom: 14,
          vector_layers: [
            { id: "transportation", fields: { class: "String" } },
            { id: "water", fields: {} },
            { id: "landcover", fields: {} },
          ],
        }),
      );
    if (url.startsWith("https://example.test/")) return tile;
    if (url.includes("google.com"))
      throw new Error("Synthetic unavailable provider");
    if (url.includes("bing.com")) await new Promise((r) => setTimeout(r, 400));
    return raster;
  },
});
const app = await createApp({
  work: {
    stateDir: path.join(temporary, "work"),
    roots: [temporary, process.cwd()],
    archive: temporary,
  },
  configStore: new FileConfigStore({ path: configPath }),
  maps: { initialArchive: archive, resources: () => resources },
});
let fault = "";
app.post("/api/test/fault", async (request) => {
  fault = (request.body as { mode: string }).mode;
  return { ok: true };
});
app.addHook("onRequest", async (request, reply) => {
  if (
    request.headers["x-tracktool-render"] &&
    ((fault === "tiles" && request.url.startsWith("/tiles/")) ||
      (fault === "font" && request.url.endsWith(".otf")))
  )
    return reply.code(503).send("Synthetic resource failure");
});
await app.listen({ host: "127.0.0.1", port: 18765 });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => rm(temporary, { recursive: true, force: true }));
  });
