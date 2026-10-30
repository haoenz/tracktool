import { expect, it } from "vitest";
import type { MapConfig } from "../../src/shared/map.js";
import {
  activeVendor,
  basemapChoices,
  basemapLabel,
  groupBasemaps,
} from "../../src/web/basemap-catalog.js";

const preset = (
  id: string,
  name: string,
  group: string,
  crs: "wgs84" | "gcj02",
) => ({
  id,
  name,
  group,
  crs,
  format: "raster",
  tile_size: 256,
  minzoom: 0,
  maxzoom: 18,
});
const config = {
  basemaps: [
    preset("custom", "自定义", "其他", "wgs84"),
    preset("amap-satellite", "高德卫星", "高德", "gcj02"),
    preset("amap-road", "高德路网", "高德", "gcj02"),
    preset("osm-standard", "OSM 标准", "OSM", "wgs84"),
  ],
} as unknown as MapConfig;

it("groups by vendor, keeps the hand-picked order and sorts unknown vendors last", () => {
  const groups = groupBasemaps(basemapChoices(config, "wgs84"));
  expect(groups.map(([vendor]) => vendor)).toEqual([
    "开放地图",
    "高德",
    "其他",
  ]);
  expect(groups[0]![1].map((item) => item.value)).toEqual([
    "vector",
    "osm-standard",
  ]);
  expect(groups[1]![1].map((item) => item.value)).toEqual([
    "amap-road",
    "amap-satellite",
  ]);
});

it("marks only sources whose CRS differs from the canvas", () => {
  const wgs = basemapChoices(config, "wgs84");
  expect(wgs.find((item) => item.value === "vector")?.hint).toBeUndefined();
  expect(
    wgs.find((item) => item.value === "osm-standard")?.hint,
  ).toBeUndefined();
  expect(wgs.find((item) => item.value === "amap-road")?.hint).toBe("GCJ-02");

  const gcj = basemapChoices(config, "gcj02");
  expect(gcj.find((item) => item.value === "vector")?.hint).toBe("WGS84");
  expect(gcj.find((item) => item.value === "amap-road")?.hint).toBeUndefined();
  expect(gcj.find((item) => item.value === "osm-standard")?.hint).toBe("WGS84");
});

it("resolves the active vendor and labels presets", () => {
  const groups = groupBasemaps(basemapChoices(config, "wgs84"));
  expect(activeVendor(groups, "amap-road")).toBe("高德");
  expect(activeVendor(groups, "missing")).toBe("开放地图");
  expect(basemapLabel(config, "vector")).toBe(
    "开放地图 · OpenFreeMap 矢量底图",
  );
  expect(basemapLabel(config, "amap-road")).toBe("高德 · 高德路网");
  expect(basemapLabel(config, "missing")).toBe("missing");
});
