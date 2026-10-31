import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { transaction } from "../../dist/node/infrastructure/archive/database.js";
import {
  deleteEntry,
  previewDeletion,
} from "../../dist/node/infrastructure/archive/deletion.js";
import { trackDetail } from "../../dist/node/infrastructure/archive/track-reader.js";
import { VersionStore } from "../../dist/node/infrastructure/archive/versions.js";
import { addEntry } from "../../dist/node/infrastructure/archive/writer.js";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
import { DisplayStore } from "../../dist/node/infrastructure/display-store.js";
import { MapResources } from "../../dist/node/infrastructure/maps/resources.js";
import { createApp } from "../../dist/node/server/app.js";
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "tracktool-m3-browser-"),
);
const configPath = path.join(temporary, "config.json");
await copyFile("tests/e2e/config.json", configPath);
const display = new DisplayStore(path.join(temporary, "display.json"));
const archive = path.join(temporary, "archive.sqlite3");
await copyFile("tests/ts/fixtures/maps/archive.sqlite3", archive);
// A valid empty MVT layer: no external requests or misleading basemap fixtures.
const tile = Buffer.from([26, 9, 10, 5, 119, 97, 116, 101, 114, 120, 2]);
const raster = await sharp({
  create: { width: 256, height: 256, channels: 3, background: "#dce9ef" },
})
  .png()
  .toBuffer();
const raster512 = await sharp(raster).resize(512, 512).png().toBuffer();
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
    if (url.includes("openrailwaymap.org")) return raster512;
    if (url.includes("openinframap.org")) return tile;
    if (url.includes("google.com"))
      throw new Error("Synthetic unavailable provider");
    if (url.includes("bing.com")) await new Promise((r) => setTimeout(r, 400));
    return raster;
  },
});
const app = await createApp({
  token: "e2e",
  work: {
    stateDir: path.join(temporary, "work"),
    roots: [temporary, process.cwd()],
    archive: temporary,
  },
  configStore: new FileConfigStore({ path: configPath }),
  maps: {
    initialArchive: archive,
    cache: path.join(temporary, "cache"),
    resources: () => resources,
    display,
  },
});
app.post("/api/test/reset-display", async () => {
  await display.clear();
  return { ok: true };
});
let fault = "";
app.post("/api/test/edit-fixture", async (request) => {
  const name = `Default/2026-10-14 编辑测试-${randomUUID()}.kml`;
  const count =
    (request.body as { segmentCount?: 1 | 2 | 3 })?.segmentCount ?? 2;
  const segments = [
    "120,30 120.01,30 120.02,30 120.03,30",
    "120.04,30 120.05,30",
    "120.06,30 120.07,30",
  ].slice(0, count);
  const raw = Buffer.from(
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${segments.map((coordinates) => `<Placemark><LineString><coordinates>${coordinates}</coordinates></LineString></Placemark>`).join("")}</Document></kml>`,
  );
  return transaction(archive, true, (db) => addEntry(db, name, raw, "Default"));
});
app.post("/api/test/analysis-fixture", async (request) => {
  const duplicateTime = (request.body as { duplicateTime?: boolean })
    ?.duplicateTime;
  const name = `Default/2026-10-14 统计测试-${randomUUID()}.kml`;
  const segments = [0, 1].map((segment) => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      time: new Date(
        Date.UTC(2026, 9, 14, 8) +
          (segment * 3600 + (duplicateTime && i === 1 ? 0 : i) * 30) * 1000,
      ).toISOString(),
      lon: 120 + segment * 0.05 + i * 0.0004,
      lat: 30 + Math.sin(i / 8) * 0.003,
      alt: 100 + segment * 30 + Math.sin(i / 8) * 30,
    }));
    return `<gx:Track>${points.map((p) => `<when>${p.time}</when>`).join("")}${points.map((p) => `<gx:coord>${p.lon} ${p.lat} ${p.alt}</gx:coord>`).join("")}</gx:Track>`;
  });
  const raw = Buffer.from(
    `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>山间步道</name><ExtendedData><Data name="TrackTags"><value>徒步</value></Data></ExtendedData><Placemark><MultiGeometry>${segments.join("")}</MultiGeometry></Placemark></Document></kml>`,
  );
  return transaction(archive, true, (db) => addEntry(db, name, raw, "Default"));
});
app.post("/api/test/edit-cleanup", async (request) => {
  const plan = previewDeletion(archive, {
    entry_id: (request.body as { id: string }).id,
  });
  return deleteEntry(archive, {
    archive_id: plan.archive_id,
    request_key: randomUUID(),
    expected: plan.expected,
  });
});
app.post("/api/test/edit-presentation", async (request) => {
  const id = (request.body as { id: string }).id,
    detail = trackDetail(archive, id),
    store = new VersionStore(archive);
  store.publish({
    archive_id: detail.archive_id,
    request_key: randomUUID(),
    kind: "presentation",
    algorithm_version: "browser-test",
    params: {},
    inputs: [store.current(id)],
    outputs: [
      {
        kind: "presentation",
        entry_id: id,
        settings: { ...detail.settings, ignored: [detail.settings.order[0]!] },
      },
    ],
  });
  return trackDetail(archive, id);
});
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
