import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAP_CATALOG } from "../../src/shared/map-catalog.js";
import { defaultProject, type Project } from "../../src/shared/project.js";
import type { MapConfig, MapPreset } from "../../src/shared/map.js";
import {
  canvasCrs,
  defaults,
  featureControls,
  featureGroups,
  featureReason,
  effectiveFeatures,
} from "../../src/drawing/layers.js";
import { mapStyle } from "../../src/drawing/styles.js";

const layers = [
  "aerodrome_label",
  "aeroway",
  "boundary",
  "building",
  "housenumber",
  "landcover",
  "landuse",
  "mountain_peak",
  "park",
  "place",
  "poi",
  "transportation",
  "transportation_name",
  "water",
  "water_name",
  "waterway",
];
const preset = (id: string, content: string[] = []): MapPreset => ({
  id,
  name: id,
  group: "测试",
  tile_size: 256,
  tile_display_size: 256,
  maxzoom: 18,
  minzoom: 0,
  crs: "wgs84",
  imagery: false,
  has_text: true,
  overlay_only: false,
  attribution: "",
  kind: "basemap",
  format: "raster",
  content,
  scheme: "xyz",
  addressing: "",
  coverage: "",
  content_note: "",
  available: true,
  category: "base",
});
const config = (basemaps: MapPreset[] = []): MapConfig => ({
  versions: {},
  vectorMaxZoom: 14,
  basemaps,
  overlays: [],
  vectorLayers: Object.fromEntries(
    layers.map((id) => [
      id,
      {
        class: "String",
        name: "String",
        ele: "Number",
        housenumber: "String",
        admin_level: "Number",
        rank: "Number",
      },
    ]),
  ),
  attribution: "credit",
  customVectorAttribution: "",
  cacheTime: 0,
});
const styleWith = (
  edit: (state: Project) => void,
  basemaps: MapPreset[] = [],
) => {
  const state = defaultProject();
  edit(state);
  return mapStyle(state, config(basemaps)).layers.map((layer) => layer.id);
};

beforeAll(() => vi.stubGlobal("location", { origin: "http://localhost" }));
afterAll(() => vi.unstubAllGlobals());

describe("map content controls", () => {
  it("groups every control exactly once and keeps defaults inside the catalog", () => {
    const grouped = featureGroups.flatMap((group) => group.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(Object.keys(featureControls).sort());
    expect(Object.keys(defaults).sort()).toEqual(
      Object.keys(MAP_CATALOG.features).sort(),
    );
    const features: Record<string, readonly string[]> = MAP_CATALOG.features;
    for (const [key, value] of Object.entries(defaults))
      expect(features[key]).toContain(value);
  });

  it("draws optional surfaces and paths only when enabled", () => {
    const base = styleWith(() => {});
    expect(base).toContain("landcover");
    expect(base).toContain("landuse");
    expect(base).toContain("water");
    expect(base).toContain("paths");
    expect(base).not.toContain("park");
    expect(base).not.toContain("aeroway");
    expect(base).not.toContain("aerodrome");

    const all = styleWith((state) => {
      for (const key of ["park", "aerodrome", "aeroway"])
        state.style.features[key] = "all";
    });
    expect(all).toContain("park");
    expect(all).toContain("park-names");
    expect(all).toContain("aeroway");
    expect(all).toContain("aerodrome");

    const bare = styleWith((state) => {
      for (const key of ["landcover", "landuse", "water", "waterway", "paths"])
        state.style.features[key] = "none";
    });
    expect(bare).not.toContain("landcover");
    expect(bare).not.toContain("landuse");
    expect(bare).not.toContain("water");
    expect(bare).not.toContain("waterway");
    expect(bare).not.toContain("paths");
  });

  it("keeps the palette independent from the vector source", () => {
    const background = (appearance: "light" | "dark") =>
      (
        mapStyle(
          {
            ...defaultProject(),
            style: { ...defaultProject().style, appearance },
          },
          config(),
        ).layers[0]!.paint as { "background-color": string }
      )["background-color"];
    expect(background("light")).not.toBe(background("dark"));
    const state = defaultProject();
    state.style.appearance = "dark";
    expect(effectiveFeatures(state, config()).water).toBe("all");
  });

  it("derives the canvas CRS from the basemap and keeps vector tiles out of GCJ-02", () => {
    const gcj = preset("gcj-base", ["roads"]);
    gcj.crs = "gcj02";
    const cfg = config([gcj]);
    const state = defaultProject();
    expect(canvasCrs(state, cfg)).toBe("wgs84");
    state.style.basemap = "gcj-base";
    expect(canvasCrs(state, cfg)).toBe("gcj02");
    const style = mapStyle(state, cfg);
    const raster = style.sources.satellite as { tiles: string[] };
    expect(raster.tiles[0]).toContain("?crs=gcj02");
    expect(style.sources.base).toBeUndefined();
    expect(style.layers.map((layer) => layer.id)).toEqual([
      "background",
      "satellite",
      "track-halo",
      "track-lines",
      "track-points",
    ]);
    expect(effectiveFeatures(state, cfg).roads).toBe("none");
  });

  it("treats image surfaces as part of the picture but keeps lines and labels", () => {
    const state = defaultProject();
    state.style.basemap = "raster";
    const cfg = config([preset("raster", ["roads"])]);
    expect(featureReason(state, cfg, "water")).toContain("图片底图");
    expect(featureReason(state, cfg, "park")).toContain("图片底图");
    expect(effectiveFeatures(state, cfg).water).toBe("none");
    expect(featureReason(state, cfg, "paths")).toBe("");
  });
});
