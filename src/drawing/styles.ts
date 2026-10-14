import type { Project } from "../shared/project.js";
import type { MapConfig, MapPreset, TrackGeoJSON } from "../shared/map.js";
import type {
  StyleSpecification,
  SourceSpecification,
  RasterSourceSpecification,
} from "maplibre-gl";
type Layer = Record<string, unknown>;
import { presetFor, activeOverlays, effectiveFeatures } from "./layers.js";
export const basemapPreset = presetFor;
const empty: TrackGeoJSON = { type: "FeatureCollection", features: [] };
const name = [
  "coalesce",
  ["get", "name:zh"],
  ["get", "name"],
  ["get", "name:latin"],
  "",
];
const major = [
  "in",
  ["get", "class"],
  ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]],
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
      "track",
      "path",
      "pedestrian",
      "construction",
    ],
  ],
];
export function mapStyle(
  state: Project,
  config: MapConfig,
  data?: TrackGeoJSON,
): StyleSpecification {
  const preset = presetFor(state, config),
    raster = !!preset || state.style.basemap === "satellite";
  const dark =
    state.style.basemap === "dark" ||
    preset?.imagery ||
    state.style.basemap === "satellite";
  const p = dark
    ? {
        ground: "#202c33",
        land: "#283b3c",
        water: "#14242e",
        road: "#849399",
        minor: "#526970",
        border: "#d0bd99",
        building: "#637774",
        text: "#f1f0e8",
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
        text: "#273b43",
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
  const vector = !raster || Object.values(f).some((v) => v !== "none");
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
    tiles: [`${location.origin}/tiles/${id}/{z}/{x}/{y}.png`],
    tileSize: s?.tile_display_size || s?.tile_size || 256,
    minzoom: s?.minzoom || 0,
    maxzoom: s?.maxzoom || 18,
    scheme: "xyz",
  });
  if (raster) {
    sources.satellite = rasterSource(preset, preset?.id || "satellite");
    base.push({
      id: "satellite",
      type: "raster",
      source: "satellite",
      paint: { "raster-fade-duration": 0 },
    });
  } else {
    for (const [id, type, paint] of [
      ["landcover", "fill", { "fill-color": p.land, "fill-opacity": 0.55 }],
      ["landuse", "fill", { "fill-color": p.land, "fill-opacity": 0.35 }],
      ["water", "fill", { "fill-color": p.water }],
      [
        "waterway",
        "line",
        {
          "line-color": p.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 2],
        },
      ],
    ] as [string, string, Record<string, unknown>][])
      if (config.vectorLayers?.[id])
        base.push({ id, type, source: "base", "source-layer": id, paint });
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
        { minzoom: 9, filter: ["all", roadClasses, ["!", major]] },
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
  const symbol = (
    id: string,
    layer: string,
    minzoom: number,
    filter: unknown,
    field: unknown = name,
    layout: Record<string, unknown> = {},
  ) =>
    labels.push({
      id,
      type: "symbol",
      source: "base",
      "source-layer": layer,
      minzoom,
      ...(filter ? { filter } : {}),
      layout: {
        "text-field": field,
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-padding": 5,
        "text-max-width": 10,
        ...layout,
      },
      paint: {
        "text-color": p.text,
        "text-halo-color": p.halo,
        "text-halo-width": 1.5,
      },
    });
  if (f.places !== "none") {
    symbol(
      "place-country",
      "place",
      0,
      ["==", ["get", "class"], "country"],
      name,
      { "text-size": 16 },
    );
    symbol(
      "place-city",
      "place",
      3,
      ["in", ["get", "class"], ["literal", ["city", "state"]]],
      name,
      { "text-size": 15 },
    );
    if (f.places === "all")
      symbol(
        "place-local",
        "place",
        9,
        [
          "in",
          ["get", "class"],
          ["literal", ["town", "village", "hamlet", "suburb", "neighbourhood"]],
        ],
        name,
        { "text-size": 12 },
      );
  }
  if (f.road_names !== "none")
    symbol(
      "road-names",
      "transportation_name",
      f.road_names === "major" ? 10 : 12,
      f.road_names === "major" ? major : roadClasses,
      name,
      { "symbol-placement": "line", "symbol-spacing": 300, "text-size": 11 },
    );
  if (f.poi !== "none")
    symbol("poi", "poi", f.poi === "major" ? 12 : 14, [
      "<=",
      ["coalesce", ["get", "rank"], 100],
      f.poi === "major" ? 3 : 15,
    ]);
  if (f.housenumbers !== "none")
    symbol(
      "housenumbers",
      "housenumber",
      16,
      null,
      ["to-string", ["get", "housenumber"]],
      { "text-size": 10 },
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
    );
  if (f.water_names !== "none")
    symbol("water-names", "water_name", 4, null, name, { "text-size": 13 });
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
      ...labels,
      ...annotations,
      ...themes,
      {
        id: "track-halo",
        type: "line",
        source: "tracks",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": p.halo,
          "line-opacity": 0.8,
          "line-width": state.style.width + 2,
        },
      },
      {
        id: "track-lines",
        type: "line",
        source: "tracks",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": state.style.color,
          "line-width": state.style.width,
        },
      },
      {
        id: "track-points",
        type: "circle",
        source: "tracks",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-color": state.style.color,
          "circle-radius": state.style.width / 2,
          "circle-stroke-color": p.halo,
          "circle-stroke-width": 1,
        },
      },
    ],
  } as unknown as StyleSpecification;
}
function powerLayers(
  state: Project,
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
