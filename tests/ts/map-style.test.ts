import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { SymbolLayerSpecification } from "maplibre-gl";
import { MAP_CATALOG } from "../../src/shared/map-catalog.js";
import { defaultMapState, type MapState } from "../../src/shared/map-state.js";
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
import {
  MAP_LABEL_PROPERTY,
  MAP_LABEL_ORDER_PROPERTY,
} from "../../src/shared/map-label.js";
const require = createRequire(import.meta.url);
const styleRequire = createRequire(require.resolve("maplibre-gl"));
const styleSpec = styleRequire("@maplibre/maplibre-gl-style-spec") as {
  validateStyleMin(style: unknown): { message: string }[];
  createExpression(expression: unknown):
    | {
        result: "success";
        value: {
          evaluate(
            globals: { zoom: number },
            feature: { type: number; properties: Record<string, unknown> },
          ): unknown;
        };
      }
    | { result: "error"; value: unknown };
};

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
  edit: (state: MapState) => void,
  basemaps: MapPreset[] = [],
) => {
  const state = defaultMapState();
  edit(state);
  return mapStyle(state, config(basemaps)).layers.map((layer) => layer.id);
};

beforeAll(() => vi.stubGlobal("location", { origin: "http://localhost" }));
afterAll(() => vi.unstubAllGlobals());

describe("map content controls", () => {
  it("prioritizes important places across tiles with stable ties and fixed anchors", () => {
    const state = defaultMapState();
    state.style.features.places = "all";
    const symbols = mapStyle(state, config()).layers.filter(
      (layer): layer is SymbolLayerSpecification =>
        layer.type === "symbol" && layer["source-layer"] === "place",
    );
    for (const { layout } of symbols) {
      const compiled = styleSpec.createExpression(layout?.["symbol-sort-key"]);
      if (compiled.result !== "success")
        throw new Error(JSON.stringify(compiled.value));
      const priority = (properties: Record<string, unknown>) =>
        Number(compiled.value.evaluate({ zoom: 5 }, { type: 1, properties }));
      expect(
        priority({ rank: 1, [MAP_LABEL_ORDER_PROPERTY]: 0.99 }),
      ).toBeLessThan(priority({ rank: 2, [MAP_LABEL_ORDER_PROPERTY]: 0 }));
      expect(
        priority({ rank: 1, [MAP_LABEL_ORDER_PROPERTY]: 0.1 }),
      ).toBeLessThan(priority({ rank: 1, [MAP_LABEL_ORDER_PROPERTY]: 0.9 }));
      expect(priority({ rank: 6 })).toBeLessThan(priority({}));
      expect(layout).toMatchObject({
        "symbol-z-order": "source",
        "symbol-placement": "point",
        "text-anchor": "center",
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      });
      expect(layout?.["text-variable-anchor"]).toBeUndefined();
    }
    state.camera.center = [160, -40];
    expect(
      mapStyle(state, config()).layers.filter(
        (layer) => layer.type === "symbol" && layer["source-layer"] === "place",
      ),
    ).toEqual(symbols);
  });
  it("hands place labels between adjacent zoom bands without gaps or distant levels overlapping", () => {
    const state = defaultMapState();
    state.style.features.places = "all";
    const placeLayers = mapStyle(state, config()).layers.filter(
      (layer): layer is SymbolLayerSpecification =>
        layer.type === "symbol" && layer["source-layer"] === "place",
    );
    const tiers = [
      "place-country",
      "place-state",
      "place-city-major",
      "place-city",
      "place-town",
      "place-local",
      "place-neighbourhood",
    ];
    const level = (id: string) => Math.min(tiers.indexOf(id), 5);
    const compiled = placeLayers.map((layer) => {
      const result = styleSpec.createExpression(layer.paint?.["text-opacity"]);
      if (result.result !== "success")
        throw new Error(JSON.stringify(result.value));
      return { layer, expression: result.value };
    });
    const visible = (zoom: number) =>
      compiled
        .filter(
          ({ layer, expression }) =>
            zoom >= (layer.minzoom ?? 0) &&
            zoom < (layer.maxzoom ?? 24) &&
            Number(expression.evaluate({ zoom }, { type: 1, properties: {} })) >
              0,
        )
        .map(({ layer }) => layer.id);
    for (let zoom = 0; zoom <= 18; zoom += 0.125) {
      const levels = [...new Set(visible(zoom).map(level))].sort(
        (a, b) => a - b,
      );
      expect(levels.length, `zoom ${zoom}`).toBeGreaterThan(0);
      expect(levels.length, `zoom ${zoom}`).toBeLessThanOrEqual(2);
      expect(levels.at(-1)! - levels[0]!, `zoom ${zoom}`).toBeLessThanOrEqual(
        1,
      );
    }
    for (const [zoom, expected] of [
      [2, ["place-country"]],
      [5, ["place-state"]],
      [8, ["place-city-major"]],
      [10, ["place-city"]],
      [12.5, ["place-town"]],
      [15, ["place-neighbourhood", "place-local"]],
    ] as const)
      expect(visible(zoom)).toEqual([...expected]);
    for (const zoom of [4.25, 6.75, 9.25, 11.75, 13.75]) {
      const active = compiled.filter(({ layer }) =>
        visible(zoom).includes(layer.id),
      );
      for (const { expression } of active)
        expect(
          expression.evaluate({ zoom }, { type: 1, properties: {} }),
        ).toBeCloseTo(0.5);
    }
  });

  it("uses screen zoom for browsing and document zoom for export", () => {
    const state = defaultMapState();
    state.style.features.places = "all";
    state.style.features.water_names = "all";
    const documentStyle = mapStyle(state, config());
    const screenStyle = mapStyle(state, config(), undefined, 4.8, -2);
    expect(styleSpec.validateStyleMin(screenStyle)).toEqual([]);
    const layers = screenStyle.layers.filter(
      (layer) => layer.type === "symbol",
    );
    expect(layers.find((layer) => layer.id === "place-country")?.minzoom).toBe(
      0,
    );
    expect(layers.find((layer) => layer.id === "place-country")?.maxzoom).toBe(
      6.5,
    );
    expect(layers.find((layer) => layer.id === "place-state")?.minzoom).toBe(6);
    expect(layers.find((layer) => layer.id === "place-state")?.maxzoom).toBe(9);
    expect(layers.find((layer) => layer.id === "water-ocean")?.maxzoom).toBe(
      8.5,
    );
    expect(layers.find((layer) => layer.id === "water-sea")?.maxzoom).toBe(
      12.5,
    );
    expect(mapStyle(state, config())).toEqual(documentStyle);
  });
  it.each(["light", "dark"] as const)(
    "distinguishes settlement hierarchy and water names in %s mode",
    (appearance) => {
      const state = defaultMapState();
      state.style.appearance = appearance;
      state.style.features.places = "all";
      state.style.features.water_names = "all";
      const style = mapStyle(state, config());
      expect(styleSpec.validateStyleMin(style)).toEqual([]);
      const symbols = style.layers.filter((layer) => layer.type === "symbol");
      const size = (id: string) =>
        Number(symbols.find((layer) => layer.id === id)?.layout?.["text-size"]);
      const font = (id: string) =>
        symbols.find((layer) => layer.id === id)?.layout?.["text-font"];
      const color = (id: string) =>
        symbols.find((layer) => layer.id === id)?.paint?.["text-color"];
      const hierarchy = [
        "place-country",
        "place-state",
        "place-city-major",
        "place-city",
        "place-town",
        "place-local",
        "place-neighbourhood",
      ].map(size);
      expect(hierarchy).toEqual([...hierarchy].sort((a, b) => b - a));
      expect(new Set(hierarchy).size).toBe(hierarchy.length);
      const order = (id: string) =>
        symbols.findIndex((layer) => layer.id === id);
      expect(order("place-country")).toBeGreaterThan(order("place-state"));
      expect(order("place-state")).toBeGreaterThan(order("place-city-major"));
      expect(order("place-city-major")).toBeGreaterThan(order("place-city"));
      expect(order("place-city")).toBeGreaterThan(order("place-town"));
      expect(order("place-town")).toBeGreaterThan(order("place-neighbourhood"));
      expect(order("place-city")).toBeGreaterThan(order("water-sea"));
      expect(font("place-city-major")).toEqual(["Noto Sans Bold"]);
      expect(font("place-state")).toEqual(["Noto Sans Bold"]);
      expect(font("place-town")).toEqual(["Noto Sans Regular"]);
      const zoomLevels = [
        "place-country",
        "place-state",
        "place-city-major",
        "place-city",
        "place-town",
      ].map((id) => symbols.find((layer) => layer.id === id)!.minzoom!);
      expect(zoomLevels).toEqual([...zoomLevels].sort((a, b) => a - b));
      expect(new Set(zoomLevels).size).toBe(zoomLevels.length);
      expect(size("water-ocean")).toBeGreaterThan(size("water-sea"));
      expect(size("water-sea")).toBeGreaterThan(size("water-names"));
      for (const id of [
        "water-ocean",
        "water-sea",
        "water-names",
        "place-state",
        "place-local",
      ])
        expect(color(id)).not.toEqual(color("place-city"));
      const matching = (source: string, properties: Record<string, unknown>) =>
        symbols
          .filter((layer) => {
            if (layer["source-layer"] !== source) return false;
            const compiled = styleSpec.createExpression(layer.filter);
            if (compiled.result !== "success")
              throw new Error(JSON.stringify(compiled.value));
            return compiled.value.evaluate(
              { zoom: 14 },
              { type: 1, properties },
            );
          })
          .map((layer) => layer.id);
      for (const [properties, id] of [
        [{ class: "city", rank: 2 }, "place-city-major"],
        [{ class: "city", rank: 20, capital: 4 }, "place-city-major"],
        [{ class: "city", rank: 20 }, "place-city"],
        [{ class: "city" }, "place-city"],
        [{ class: "town" }, "place-town"],
        [{ class: "state" }, "place-state"],
        [{ class: "province" }, "place-state"],
        [{ class: "region" }, "place-state"],
        [{ class: "village" }, "place-local"],
        [{ class: "suburb" }, "place-neighbourhood"],
      ] as const)
        expect(matching("place", properties)).toEqual([id]);
      for (const [properties, id] of [
        [{ class: "ocean" }, "water-ocean"],
        [{ class: "sea" }, "water-sea"],
        [{ class: "bay" }, "water-sea"],
        [{ class: "strait" }, "water-sea"],
        [{ class: "lake" }, "water-names"],
        [{ class: "reservoir" }, "water-names"],
        [{}, "water-names"],
      ] as const)
        expect(matching("water_name", properties)).toEqual([id]);
    },
  );
  it("compensates browsing sizes without changing document sizes or basemap geometry", () => {
    const state = defaultMapState();
    for (const key of [
      "places",
      "road_names",
      "poi",
      "water_names",
      "park",
      "aerodrome",
      "housenumbers",
    ])
      state.style.features[key] = "all";
    const snapshot = structuredClone(state);
    const original = mapStyle(state, config());
    const enlarged = mapStyle(state, config(), undefined, 4);
    for (const layer of original.layers) {
      const scaled = enlarged.layers.find((item) => item.id === layer.id)!;
      if (layer.type === "symbol" && scaled.type === "symbol") {
        expect(scaled.layout?.["text-size"]).toBe(
          Number(layer.layout?.["text-size"]) * 4,
        );
        expect(scaled.paint?.["text-halo-width"]).toBe(
          Number(layer.paint?.["text-halo-width"]) * 4,
        );
      } else if (layer.id === "track-lines" || layer.id === "track-halo") {
        expect((scaled.paint as Record<string, unknown>)["line-width"]).toBe(
          Number((layer.paint as Record<string, unknown>)["line-width"]) * 4,
        );
      } else if (layer.id === "track-points" && scaled.type === "circle") {
        expect(scaled.paint?.["circle-radius"]).toBe(state.style.width * 2);
        expect(scaled.paint?.["circle-stroke-width"]).toBe(4);
      } else expect(scaled).toEqual(layer);
    }
    expect(state).toEqual(snapshot);
    expect(mapStyle(state, config())).toEqual(original);
  });
  it("uses single names throughout the shared browser and print style", () => {
    const state = defaultMapState();
    for (const key of [
      "places",
      "road_names",
      "poi",
      "water_names",
      "park",
      "aerodrome",
      "housenumbers",
    ])
      state.style.features[key] = "all";
    state.style.features.peaks = "elevation";
    const layers = mapStyle(state, config()).layers.filter(
      (layer) => layer.type === "symbol",
    );
    expect(layers.map((layer) => layer.id)).toEqual(
      expect.arrayContaining([
        "place-country",
        "place-state",
        "place-city-major",
        "place-city",
        "place-town",
        "place-local",
        "place-neighbourhood",
        "road-names",
        "poi",
        "housenumbers",
        "peaks",
        "water-ocean",
        "water-sea",
        "water-names",
        "park-names",
        "aerodrome",
      ]),
    );
    for (const layer of layers) {
      const field = JSON.stringify(layer.layout?.["text-field"]);
      expect(field).toContain(
        layer.id === "housenumbers" ? "housenumber" : MAP_LABEL_PROPERTY,
      );
      expect(field).not.toContain("name:zh");
    }
    expect(
      JSON.stringify(
        layers.find((layer) => layer.id === "peaks")?.layout?.["text-field"],
      ),
    ).toContain('"ele"');
  });
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
            ...defaultMapState(),
            style: { ...defaultMapState().style, appearance },
          },
          config(),
        ).layers[0]!.paint as { "background-color": string }
      )["background-color"];
    expect(background("light")).not.toBe(background("dark"));
    const state = defaultMapState();
    state.style.appearance = "dark";
    expect(effectiveFeatures(state, config()).water).toBe("all");
  });

  it("derives the canvas CRS from the basemap and keeps vector tiles out of GCJ-02", () => {
    const gcj = preset("gcj-base", ["roads"]);
    gcj.crs = "gcj02";
    const cfg = config([gcj]);
    const state = defaultMapState();
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
    const state = defaultMapState();
    state.style.basemap = "raster";
    const cfg = config([preset("raster", ["roads"])]);
    expect(featureReason(state, cfg, "water")).toContain("图片底图");
    expect(featureReason(state, cfg, "park")).toContain("图片底图");
    expect(effectiveFeatures(state, cfg).water).toBe("none");
    expect(featureReason(state, cfg, "paths")).toBe("");
  });
});
