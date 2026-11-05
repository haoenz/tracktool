import type { MapState } from "../shared/map-state.js";
import type { MapConfig, MapPreset, TrackGeoJSON } from "../shared/map.js";
import {
  MAP_LABEL_FONTS,
  MAP_LABEL_PROPERTY,
  MAP_LABEL_ORDER_PROPERTY,
} from "../shared/map-label.js";
import { labelZoom } from "./label-zoom.js";
import type {
  StyleSpecification,
  SourceSpecification,
  RasterSourceSpecification,
} from "maplibre-gl";
type Layer = Record<string, unknown>;
import {
  presetFor,
  activeOverlays,
  canvasCrs,
  effectiveFeatures,
} from "./layers.js";
export const basemapPreset = presetFor;
const empty: TrackGeoJSON = { type: "FeatureCollection", features: [] };
const name = ["coalesce", ["get", MAP_LABEL_PROPERTY], ""];
const major = [
  "in",
  ["get", "class"],
  ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]],
];
const minorClasses = [
  "in",
  ["get", "class"],
  [
    "literal",
    [
      "motorway",
      "trunk",
      "primary",
      "secondary",
      "tertiary",
      "minor",
      "service",
    ],
  ],
];
const paths = [
  "in",
  ["get", "class"],
  ["literal", ["path", "track", "pedestrian"]],
];
const roadClasses = [
  "in",
  ["get", "class"],
  [
    "literal",
    [
      "motorway",
      "trunk",
      "primary",
      "secondary",
      "tertiary",
      "minor",
      "service",
      "path",
      "track",
      "pedestrian",
    ],
  ],
];
export function mapStyle(
  state: MapState,
  config: MapConfig,
  data?: TrackGeoJSON,
  displayScale = 1,
  labelZoomOffset = 0,
): StyleSpecification {
  const preset = presetFor(state, config),
    raster = !!preset,
    canvas = canvasCrs(state, config);
  const dark = state.style.appearance === "dark" || !!preset?.imagery;
  const p = dark
    ? {
        ground: "#202c33",
        land: "#283b3c",
        water: "#14242e",
        road: "#849399",
        minor: "#526970",
        border: "#d0bd99",
        building: "#637774",
        park: "#31443a",
        aeroway: "#556a6f",
        text: "#f1f0e8",
        secondaryText: "#bac4c8",
        regionText: "#c8bdd5",
        oceanText: "#8ec9e6",
        seaText: "#94cce2",
        lakeText: "#8dcbd6",
        parkText: "#a6ceab",
        peakText: "#d5bd98",
        halo: "#18242c",
      }
    : {
        ground: "#eeeae2",
        land: "#e2e8d7",
        water: "#b9d5de",
        road: "#ffffff",
        minor: "#b5aca0",
        border: "#998570",
        building: "#c6baaa",
        park: "#cfe0bb",
        aeroway: "#d8d0c4",
        text: "#273b43",
        secondaryText: "#5f686d",
        regionText: "#6c617a",
        oceanText: "#2b607f",
        seaText: "#346f8b",
        lakeText: "#276878",
        parkText: "#426d47",
        peakText: "#7b5b35",
        halo: "#faf8f2",
      };
  const sources: Record<string, SourceSpecification> = {
    tracks: { type: "geojson", data: data || empty, tolerance: 0 },
  };
  const base: Layer[] = [
      {
        id: "background",
        type: "background",
        paint: { "background-color": p.ground },
      },
    ],
    geometry: Layer[] = [],
    labels: Layer[] = [],
    themes: Layer[] = [];
  const f = effectiveFeatures(state, config);
  // GCJ-02 canvases accept raster tiles only; vector tiles stay WGS84.
  const vector =
    canvas === "wgs84" &&
    (!raster || Object.values(f).some((v) => v !== "none"));
  if (vector)
    sources.base = {
      type: "vector",
      tiles: [`${location.origin}/tiles/vector/{z}/{x}/{y}.pbf`],
      maxzoom: config.vectorMaxZoom,
    };
  const rasterSource = (
    s: MapPreset | undefined,
    id: string,
  ): RasterSourceSpecification => ({
    type: "raster",
    tiles: [
      `${location.origin}/tiles/${id}/{z}/{x}/{y}.png${canvas === "gcj02" ? "?crs=gcj02" : ""}`,
    ],
    tileSize: s?.tile_display_size || s?.tile_size || 256,
    minzoom: s?.minzoom || 0,
    maxzoom: s?.maxzoom || 18,
    scheme: "xyz",
  });
  if (raster) {
    sources.satellite = rasterSource(preset, preset!.id);
    base.push({
      id: "satellite",
      type: "raster",
      source: "satellite",
      paint: { "raster-fade-duration": 0 },
    });
  } else {
    const surfaces = [
      ["landcover", "fill", { "fill-color": p.land, "fill-opacity": 0.55 }, 0],
      ["landuse", "fill", { "fill-color": p.land, "fill-opacity": 0.35 }, 0],
      ["water", "fill", { "fill-color": p.water }, 0],
      [
        "waterway",
        "line",
        {
          "line-color": p.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 2],
        },
        0,
      ],
      ["park", "fill", { "fill-color": p.park, "fill-opacity": 0.5 }, 11],
    ] as [string, string, Record<string, unknown>, number][];
    for (const [id, type, paint, minzoom] of surfaces)
      if (f[id] !== "none" && config.vectorLayers?.[id])
        base.push({
          id,
          type,
          source: "base",
          "source-layer": id,
          paint,
          ...(minzoom ? { minzoom } : {}),
        });
  }
  const geom = (
    id: string,
    layer: string,
    type: string,
    paint: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    geometry.push({
      id,
      source: "base",
      "source-layer": layer,
      type,
      paint,
      ...extra,
    });
  if (f.boundaries !== "none")
    geom(
      "boundary",
      "boundary",
      "line",
      { "line-color": p.border, "line-width": 1, "line-dasharray": [3, 3] },
      {
        filter: [
          "<=",
          ["get", "admin_level"],
          ({ country: 2, region: 6, local: 10 } as Record<string, number>)[
            f.boundaries!
          ],
        ],
      },
    );
  if (f.buildings !== "none")
    geom(
      "buildings",
      "building",
      "fill",
      {
        "fill-color": p.building,
        "fill-opacity": 0.45,
        "fill-outline-color": p.border,
      },
      { minzoom: 13 },
    );
  if (f.aeroway !== "none")
    geom(
      "aeroway",
      "aeroway",
      "line",
      {
        "line-color": p.aeroway,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 16, 2.5],
      },
      { minzoom: 11 },
    );
  if (f.paths !== "none")
    geom(
      "paths",
      "transportation",
      "line",
      {
        "line-color": p.minor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 17, 1.8],
        "line-dasharray": [2, 1.5],
      },
      { minzoom: 12, filter: paths },
    );
  if (f.roads !== "none") {
    if (f.roads === "all")
      geom(
        "roads-minor",
        "transportation",
        "line",
        {
          "line-color": p.minor,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 16, 3],
        },
        { minzoom: 9, filter: ["all", minorClasses, ["!", major]] },
      );
    geom(
      "roads-major",
      "transportation",
      "line",
      {
        "line-color": p.road,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5,
          0.4,
          10,
          1.2,
          16,
          5,
        ],
      },
      { filter: major },
    );
  }
  const rank = ["number", ["get", "rank"], 100];
  const placeOrder = [
    "+",
    ["*", ["max", 0, rank], 2],
    ["number", ["get", MAP_LABEL_ORDER_PROPERTY], 0],
  ];
  const symbol = (
    id: string,
    layer: string,
    minzoom: number,
    filter: unknown,
    field: unknown = name,
    layout: Record<string, unknown> = {},
    paint: Record<string, unknown> = {},
    maxzoom?: number,
  ) => {
    const zoom = labelZoom(minzoom, maxzoom, labelZoomOffset);
    labels.push({
      id,
      type: "symbol",
      source: "base",
      "source-layer": layer,
      minzoom: zoom.minzoom,
      ...(zoom.maxzoom === undefined ? {} : { maxzoom: zoom.maxzoom }),
      ...(filter ? { filter } : {}),
      layout: {
        "text-field": field,
        "text-font": [MAP_LABEL_FONTS[0]],
        "text-padding": 5 * displayScale,
        "text-max-width": 10,
        // A data-driven key also sorts across tile boundaries. Equal ranks
        // must not fall back to camera-dependent tile loading order.
        ...(layer === "place"
          ? {
              "symbol-sort-key": placeOrder,
              "symbol-z-order": "source",
              "symbol-placement": "point",
              "text-anchor": "center",
              "text-allow-overlap": false,
              "text-ignore-placement": false,
            }
          : {}),
        ...layout,
        "text-size": Number(layout["text-size"] ?? 12) * displayScale,
        ...(typeof layout["symbol-spacing"] === "number"
          ? { "symbol-spacing": layout["symbol-spacing"] * displayScale }
          : {}),
      },
      paint: {
        "text-color": p.text,
        "text-halo-color": p.halo,
        "text-halo-width": 1.5 * displayScale,
        "text-opacity": zoom.opacity,
        ...paint,
      },
    });
  };
  if (f.places !== "none") {
    symbol(
      "place-country",
      "place",
      0,
      ["==", ["get", "class"], "country"],
      name,
      {
        "text-size": 22,
        "text-font": [MAP_LABEL_FONTS[1]],
        "text-letter-spacing": 0.08,
      },
      {},
      4.5,
    );
    const majorCity = [
      "any",
      ["<=", rank, 3],
      ["in", ["get", "capital"], ["literal", [2, 4]]],
    ];
    symbol(
      "place-state",
      "place",
      4,
      ["in", ["get", "class"], ["literal", ["state", "province", "region"]]],
      name,
      {
        "text-size": 20,
        "text-font": [MAP_LABEL_FONTS[1]],
        "text-letter-spacing": 0.1,
      },
      { "text-color": p.regionText },
      7,
    );
    symbol(
      "place-city-major",
      "place",
      6.5,
      ["all", ["==", ["get", "class"], "city"], majorCity],
      name,
      {
        "text-size": 18,
        "text-font": [MAP_LABEL_FONTS[1]],
      },
      {},
      9.5,
    );
    symbol(
      "place-city",
      "place",
      9,
      ["all", ["==", ["get", "class"], "city"], ["!", majorCity]],
      name,
      { "text-size": 15 },
      {},
      12,
    );
    if (f.places === "all") {
      symbol(
        "place-town",
        "place",
        11.5,
        ["==", ["get", "class"], "town"],
        name,
        {
          "text-size": 13,
        },
        {},
        14,
      );
      symbol(
        "place-local",
        "place",
        13.5,
        [
          "in",
          ["get", "class"],
          ["literal", ["village", "hamlet", "isolated_dwelling"]],
        ],
        name,
        { "text-size": 12 },
        { "text-color": p.secondaryText },
      );
      symbol(
        "place-neighbourhood",
        "place",
        13.5,
        [
          "in",
          ["get", "class"],
          ["literal", ["borough", "suburb", "quarter", "neighbourhood"]],
        ],
        name,
        { "text-size": 11 },
        { "text-color": p.secondaryText },
      );
    }
  }
  if (f.road_names !== "none")
    symbol(
      "road-names",
      "transportation_name",
      f.road_names === "major" ? 10 : 12,
      f.road_names === "major" ? major : roadClasses,
      name,
      { "symbol-placement": "line", "symbol-spacing": 300, "text-size": 11 },
      { "text-color": p.secondaryText },
    );
  if (f.poi !== "none")
    symbol(
      "poi",
      "poi",
      f.poi === "major" ? 12 : 14,
      ["<=", ["coalesce", ["get", "rank"], 100], f.poi === "major" ? 3 : 15],
      name,
      { "text-size": 11.5 },
      { "text-color": p.secondaryText },
    );
  if (f.housenumbers !== "none")
    symbol(
      "housenumbers",
      "housenumber",
      16,
      null,
      ["to-string", ["get", "housenumber"]],
      { "text-size": 10 },
      { "text-color": p.secondaryText },
    );
  if (f.peaks !== "none")
    symbol(
      "peaks",
      "mountain_peak",
      9,
      null,
      f.peaks === "elevation"
        ? [
            "concat",
            name,
            [
              "case",
              ["has", "ele"],
              ["concat", " · ", ["to-string", ["get", "ele"]], " m"],
              "",
            ],
          ]
        : name,
      {},
      { "text-color": p.peakText },
    );
  if (f.water_names !== "none") {
    symbol(
      "water-ocean",
      "water_name",
      0,
      ["==", ["get", "class"], "ocean"],
      name,
      { "text-size": 17, "text-letter-spacing": 0.18 },
      { "text-color": p.oceanText },
      6.5,
    );
    symbol(
      "water-sea",
      "water_name",
      6,
      ["in", ["get", "class"], ["literal", ["sea", "bay", "strait"]]],
      name,
      { "text-size": 15, "text-letter-spacing": 0.1 },
      { "text-color": p.seaText },
      10.5,
    );
    // OpenMapTiles groups reservoirs with lakes; unknown water classes retain
    // the inland-water style rather than disappearing from custom sources.
    symbol(
      "water-names",
      "water_name",
      4,
      [
        "!",
        [
          "in",
          ["get", "class"],
          ["literal", ["ocean", "sea", "bay", "strait"]],
        ],
      ],
      name,
      { "text-size": 12.5, "text-letter-spacing": 0.03 },
      { "text-color": p.lakeText },
    );
  }
  if (f.park !== "none")
    symbol(
      "park-names",
      "park",
      13,
      ["has", "name"],
      name,
      {
        "text-size": 11,
      },
      { "text-color": p.parkText },
    );
  if (f.aerodrome !== "none")
    symbol(
      "aerodrome",
      "aerodrome_label",
      10,
      ["has", "name"],
      name,
      {
        "text-size": 11,
      },
      { "text-color": p.secondaryText },
    );
  const annotations: Layer[] = [];
  for (const o of activeOverlays(state, config)) {
    if (o.format === "vector") {
      sources[o.id] = {
        type: "vector",
        tiles: [`${location.origin}/tiles/${o.id}/{z}/{x}/{y}.pbf`],
        minzoom: o.minzoom,
        maxzoom: o.maxzoom,
      };
      themes.push(...powerLayers(state, o));
    } else {
      sources[o.id] = rasterSource(o, o.id);
      (o.category === "annotation" ? annotations : themes).push({
        id: o.id,
        type: "raster",
        source: o.id,
        paint: { "raster-opacity": o.opacity, "raster-fade-duration": 0 },
      });
    }
  }
  // Fixed order: foundation, optional geometry, ordinary annotation, themes, user tracks.
  return {
    version: 8,
    glyphs: `${location.origin}/glyphs/{fontstack}/{range}.pbf`,
    sources,
    layers: [
      ...base,
      ...geometry,
      // MapLibre places symbols from the last layer backwards. Give major
      // places precedence over local details when their collision boxes meet.
      ...labels.toReversed(),
      ...annotations,
      ...themes,
      {
        id: "track-lines",
        type: "line",
        source: "tracks",
        filter: [
          "all",
          ["==", ["geometry-type"], "LineString"],
          [
            "!",
            [
              "all",
              ["==", ["get", "gapReason"], "tunnel"],
              [
                "in",
                ["get", "trackId"],
                ["literal", state.style.tracks.hiddenTunnelEntries],
              ],
            ],
          ],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": state.style.tracks.current.color,
          "line-width": state.style.tracks.current.width * displayScale,
        },
      },
      {
        id: "track-points",
        type: "circle",
        source: "tracks",
        filter: [
          "all",
          ["==", ["geometry-type"], "Point"],
          [
            "!",
            [
              "all",
              ["==", ["get", "gapReason"], "tunnel"],
              [
                "in",
                ["get", "trackId"],
                ["literal", state.style.tracks.hiddenTunnelEntries],
              ],
            ],
          ],
        ],
        paint: {
          "circle-color": state.style.tracks.current.color,
          "circle-radius":
            (state.style.tracks.current.width / 2) * displayScale,
          "circle-stroke-width": 0,
        },
      },
    ],
  } as unknown as StyleSpecification;
}
function powerLayers(
  state: MapState,
  o: MapPreset & { opacity: number },
): Layer[] {
  const v = ["to-number", ["get", "voltage"], 0];
  const color = [
    "step",
    v,
    "#777782",
    10,
    "#6e97b8",
    25,
    "#55b555",
    52,
    "#b59f10",
    132,
    "#b55d00",
    220,
    "#c73030",
    310,
    "#b54eb2",
    550,
    "#00c1cf",
  ];
  const filter = [
    ">=",
    [
      "max",
      v,
      ...[2, 3, 4].map((n) => ["to-number", ["get", `voltage_${n}`], 0]),
    ],
    state.style.power.min_voltage,
  ];
  const make = (
    id: string,
    layer: string,
    type: string,
    paint: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `power-${id}`,
    source: o.id,
    "source-layer": layer,
    type,
    paint,
    ...extra,
  });
  const layers = [
    make(
      "lines",
      "power_line",
      "line",
      {
        "line-color": color,
        "line-opacity": o.opacity,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 14, 3],
      },
      { filter },
    ),
  ];
  const facilities = state.style.power.facilities;
  if (["all", "substations"].includes(facilities)) {
    layers.push(
      make(
        "substation-area",
        "power_substation",
        "fill",
        {
          "fill-color": color,
          "fill-opacity": o.opacity * 0.3,
          "fill-outline-color": "#ba527b",
        },
        { minzoom: 13, filter },
      ),
    );
    layers.push(
      make(
        "substation",
        "power_substation_point",
        "circle",
        {
          "circle-color": color,
          "circle-radius": 4,
          "circle-opacity": o.opacity,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
          "circle-stroke-opacity": o.opacity,
        },
        { minzoom: 5, filter },
      ),
    );
  }
  if (["all", "generation"].includes(facilities)) {
    const energy = [
      "match",
      ["get", "source"],
      "solar",
      "#e5ae28",
      "wind",
      "#369bac",
      "hydro",
      "#477bd1",
      "nuclear",
      "#bd45cc",
      "#d75d41",
    ];
    layers.push(
      make(
        "plant-area",
        "power_plant",
        "fill",
        {
          "fill-color": energy,
          "fill-opacity": o.opacity * 0.25,
          "fill-outline-color": "#e07825",
        },
        { minzoom: 5 },
      ),
    );
    for (const layer of ["power_plant_point", "power_generator"])
      layers.push(
        make(
          layer,
          layer,
          "circle",
          {
            "circle-color": energy,
            "circle-radius": layer === "power_generator" ? 3 : 6,
            "circle-opacity": o.opacity,
            "circle-stroke-color": "#fff",
            "circle-stroke-width": 1,
            "circle-stroke-opacity": o.opacity,
          },
          { minzoom: layer === "power_generator" ? 12 : 5 },
        ),
      );
  }
  return layers;
}
