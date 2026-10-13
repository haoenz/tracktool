import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mapStyle } from "../tracktool/drawing/static/styles.js";
import {
  defaults,
  featureControls,
  effectiveFeatures,
  cityReason,
  reconcileOverlays,
} from "../tracktool/drawing/static/layers.js";
globalThis.location = { origin: "http://localhost" };
const sources = JSON.parse(
  fs.readFileSync(
    new URL("../tracktool/drawing/data/basemaps.json", import.meta.url),
  ),
).sources;
const config = {
  basemaps: sources.filter((s) => s.kind === "basemap"),
  overlays: sources.filter((s) => s.kind === "overlay"),
  vectorMaxZoom: 14,
  vectorLayers: Object.fromEntries(
    Object.values(featureControls).map(([, , layer, field]) => [
      layer,
      field ? { [field]: "String" } : {},
    ]),
  ),
};
for (const layer of ["landcover", "landuse", "water", "waterway"])
  config.vectorLayers[layer] = {};
const make = () => ({
  style: {
    basemap: "light",
    color: "#ff7700",
    width: 3,
    cities: "county",
    features: { ...defaults },
    overlays: [],
    power: { min_voltage: 0, facilities: "all" },
  },
});
test("default vector controls its own data, themes below track halo", () => {
  const state = make();
  state.style.features.road_names = "all";
  state.style.overlays = [
    { id: "openinframap-power", enabled: true, opacity: 0.6 },
  ];
  const style = mapStyle(state, config);
  assert.equal(
    Object.keys(style.sources).filter((s) => s === "base").length,
    1,
  );
  assert(style.layers.find((l) => l.id === "road-names"));
  assert(
    style.layers.findIndex((l) => l.id === "power-lines") <
      style.layers.findIndex((l) => l.id === "track-halo"),
  );
  state.style.features.roads = "none";
  assert(
    !mapStyle(state, config).layers.some((l) => l.id.startsWith("roads-")),
  );
  assert.equal(
    mapStyle(state, config).layers.find((l) => l.id === "power-lines").paint[
      "line-opacity"
    ],
    0.6,
  );
});
test("labelled raster suppresses each burned content without suppressing themes", () => {
  const state = make();
  state.style.basemap = "osm-standard";
  state.style.features.places = "all";
  state.style.overlays = [
    { id: "openrailwaymap-standard", enabled: true, opacity: 1 },
  ];
  assert.equal(effectiveFeatures(state, config).roads, "none");
  assert.equal(effectiveFeatures(state, config).buildings, "none");
  assert(cityReason(state, config));
  assert(mapStyle(state, config).sources["openrailwaymap-standard"]);
  state.style.basemap = "esri-satellite";
  assert.equal(effectiveFeatures(state, config).roads, "all");
});
test("annotation is inseparable and disables duplicate vector content", () => {
  const state = make();
  state.style.basemap = "esri-satellite";
  state.style.features.places = "all";
  state.style.overlays = [
    { id: "tianditu-labels", enabled: true, opacity: 0.5 },
  ];
  const f = effectiveFeatures(state, config);
  assert.equal(f.roads, "none");
  assert.equal(f.places, "none");
  assert(cityReason(state, config));
  assert.equal(
    mapStyle(state, config).layers.find((l) => l.id === "tianditu-labels")
      .paint["raster-opacity"],
    0.5,
  );
});
test("basemap transition preserves compatible selection and explains incompatible one", () => {
  const state = make();
  state.style.overlays = [
    { id: "openseamap-seamarks", enabled: true, opacity: 0.4 },
  ];
  state.style.basemap = "dark";
  assert.deepEqual(reconcileOverlays(state, config), []);
  state.style.basemap = "amap-satellite";
  assert(reconcileOverlays(state, config)[0].includes("坐标"));
  assert.deepEqual(state.style.overlays, [
    { id: "openseamap-seamarks", enabled: false, opacity: 0.4 },
  ]);
  assert(
    Object.values(effectiveFeatures(state, config)).every((v) => v === "none"),
  );
});
test("GeoNames and OSM places are mutually exclusive; missing schema never guessed", () => {
  const state = make();
  assert.equal(cityReason(state, config), "");
  state.style.features.places = "all";
  assert(cityReason(state, config));
  const missing = { ...config, vectorLayers: {} };
  assert.equal(effectiveFeatures(state, missing).places, "none");
});
