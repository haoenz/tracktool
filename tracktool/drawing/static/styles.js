// OpenMapTiles geometry-only style, independent of UI and label layout.
const empty = { type: "FeatureCollection", features: [] };
const palettes = {
  light: {
    ground: "#eeeae2",
    land: "#e2e8d7",
    water: "#b9d5de",
    road: "#ffffff",
    minor: "#d3cdc1",
    border: "#b9b0a2",
    building: "#d9d2c5",
  },
  dark: {
    ground: "#202c33",
    land: "#283b3c",
    water: "#14242e",
    road: "#516268",
    minor: "#37474e",
    border: "#718084",
    building: "#334149",
  },
};
export function basemapPreset(state, config) {
  return config.basemaps?.find((source) => source.id === state.style.basemap);
}
export function mapStyle(state, config, data) {
  const preset = basemapPreset(state, config);
  const raster = preset || state.style.basemap === "satellite";
  const p =
    palettes[state.style.basemap] ||
    (preset?.imagery || state.style.basemap === "satellite"
      ? palettes.dark
      : palettes.light);
  const base = raster
    ? [
        {
          id: "background",
          type: "background",
          paint: { "background-color": p.ground },
        },
        {
          id: "satellite",
          type: "raster",
          source: "satellite",
          paint: { "raster-fade-duration": 0 },
        },
      ]
    : [
        {
          id: "background",
          type: "background",
          paint: { "background-color": p.ground },
        },
        {
          id: "landcover",
          type: "fill",
          source: "base",
          "source-layer": "landcover",
          paint: { "fill-color": p.land, "fill-opacity": 0.55 },
        },
        {
          id: "landuse",
          type: "fill",
          source: "base",
          "source-layer": "landuse",
          paint: { "fill-color": p.land, "fill-opacity": 0.35 },
        },
        {
          id: "water",
          type: "fill",
          source: "base",
          "source-layer": "water",
          paint: { "fill-color": p.water },
        },
        {
          id: "waterway",
          type: "line",
          source: "base",
          "source-layer": "waterway",
          paint: {
            "line-color": p.water,
            "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 2],
          },
        },
        {
          id: "boundary",
          type: "line",
          source: "base",
          "source-layer": "boundary",
          filter: ["<=", ["get", "admin_level"], 6],
          paint: {
            "line-color": p.border,
            "line-width": 0.6,
            "line-dasharray": [3, 3],
          },
        },
        {
          id: "buildings",
          type: "fill",
          source: "base",
          "source-layer": "building",
          minzoom: 13,
          paint: { "fill-color": p.building },
        },
        {
          id: "roads-minor",
          type: "line",
          source: "base",
          "source-layer": "transportation",
          minzoom: 9,
          paint: {
            "line-color": p.minor,
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 16, 3],
          },
        },
        {
          id: "roads-major",
          type: "line",
          source: "base",
          "source-layer": "transportation",
          filter: [
            "in",
            ["get", "class"],
            ["literal", ["motorway", "trunk", "primary", "secondary"]],
          ],
          paint: {
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
        },
      ];
  return {
    version: 8,
    sources: {
      ...(raster
        ? {
            satellite: {
              type: "raster",
              tiles: [
                `${location.origin}/tiles/${preset?.id || "satellite"}/{z}/{x}/{y}.png`,
              ],
              tileSize: preset?.tile_size || 256,
              maxzoom: preset?.maxzoom || 18,
            },
          }
        : {
            base: {
              type: "vector",
              tiles: [`${location.origin}/tiles/vector/{z}/{x}/{y}.pbf`],
              maxzoom: config.vectorMaxZoom,
            },
          }),
      tracks: { type: "geojson", data: data || empty, tolerance: 0 },
    },
    layers: [
      ...base,
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
        },
      },
    ],
  };
}
