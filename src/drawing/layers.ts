import type { Project } from "../shared/project.js";
import type { MapConfig, MapPreset } from "../shared/map.js";
// Composition policy shared by editor and export; tiles arrive on a WGS84 grid.
export const featureControls: Record<
  string,
  [string, Record<string, string>, string, string?]
> = {
  landcover: ["地表覆盖", { none: "关闭", all: "显示" }, "landcover", "class"],
  landuse: ["土地利用", { none: "关闭", all: "显示" }, "landuse", "class"],
  water: ["水域", { none: "关闭", all: "显示" }, "water", "class"],
  waterway: ["河流", { none: "关闭", all: "显示" }, "waterway", "class"],
  water_names: ["水域", { none: "关闭", all: "显示" }, "water_name", "name"],
  park: ["公园绿地", { none: "关闭", all: "显示" }, "park", "name"],
  peaks: [
    "山峰",
    { none: "关闭", name: "名称", elevation: "名称与海拔" },
    "mountain_peak",
    "ele",
  ],
  roads: [
    "道路",
    { none: "关闭", major: "主干道路", all: "含支路与服务道" },
    "transportation",
    "class",
  ],
  paths: ["步道", { none: "关闭", all: "显示" }, "transportation", "class"],
  road_names: [
    "道路",
    { none: "关闭", major: "主干路名", all: "全部路名" },
    "transportation_name",
    "name",
  ],
  aeroway: ["跑道", { none: "关闭", all: "显示" }, "aeroway", "class"],
  places: [
    "地名",
    { none: "关闭", major: "国家与城市", all: "城市、乡镇与街区" },
    "place",
    "class",
  ],
  boundaries: [
    "边界",
    { none: "关闭", country: "国界", region: "省 / 地区", local: "县及以下" },
    "boundary",
    "admin_level",
  ],
  aerodrome: ["机场", { none: "关闭", all: "显示" }, "aerodrome_label", "name"],
  buildings: ["建筑", { none: "关闭", all: "显示（13 级起）" }, "building"],
  housenumbers: [
    "门牌",
    { none: "关闭", all: "显示（16 级起）" },
    "housenumber",
    "housenumber",
  ],
  poi: [
    "兴趣点",
    { none: "关闭", major: "精选", all: "详细（近景）" },
    "poi",
    "rank",
  ],
};
// Grouping is presentation only; featureControls stays the single source of
// labels and tile-layer bindings.
export const featureGroups: { label: string; keys: string[] }[] = [
  {
    label: "边界与轮廓",
    keys: [
      "water",
      "boundaries",
      "roads",
      "buildings",
      "paths",
      "aeroway",
      "waterway",
    ],
  },
  {
    label: "名称",
    keys: [
      "places",
      "poi",
      "road_names",
      "water_names",
      "peaks",
      "housenumbers",
      "aerodrome",
    ],
  },
  {
    label: "其它",
    keys: ["landcover", "landuse", "park"],
  },
];

export const defaults: Record<string, string> = {
  landcover: "all",
  landuse: "all",
  water: "all",
  waterway: "all",
  water_names: "none",
  park: "none",
  peaks: "none",
  roads: "all",
  paths: "all",
  road_names: "none",
  aeroway: "none",
  places: "none",
  boundaries: "region",
  aerodrome: "none",
  buildings: "all",
  housenumbers: "none",
  poi: "none",
};
// Image basemaps already paint these as pixels; vector overlays cannot split
// them out of the picture.
const imageProvided = new Set([
  "landcover",
  "landuse",
  "water",
  "waterway",
  "park",
  "aeroway",
]);
export const presetFor = (state: Project, config: MapConfig) =>
  config.basemaps?.find((s) => s.id === state.style.basemap);
// The basemap covers the viewport, so its CRS decides the render canvas. Vector
// tiles and the default basemap are WGS84.
export type CanvasCrs = "wgs84" | "gcj02";
export const canvasCrs = (state: Project, config: MapConfig): CanvasCrs =>
  presetFor(state, config)?.crs === "gcj02" ? "gcj02" : "wgs84";
export function activeOverlays(state: Project, config: MapConfig) {
  return (state.style.overlays || [])
    .filter((o) => o.enabled)
    .map((o) => ({ ...config.overlays.find((s) => s.id === o.id)!, ...o }));
}
export function overlayReason(
  state: Project,
  config: MapConfig,
  source: MapPreset,
  peers = true,
) {
  const base = presetFor(state, config);
  if (canvasCrs(state, config) === "gcj02" && source.crs !== "gcj02")
    return "GCJ-02 画布不支持 WGS 叠加";
  if (source.content.some((c) => base?.content.includes(c)))
    return "底图已含同类内容，图片不能拆分";
  if (
    peers &&
    activeOverlays(state, config).some(
      (o) =>
        o.id !== source.id && source.content.some((c) => o.content.includes(c)),
    )
  )
    return "已启用同类叠加层；请先关闭它";
  return "";
}
export function featureReason(state: Project, config: MapConfig, key: string) {
  const base = presetFor(state, config);
  if (canvasCrs(state, config) === "gcj02")
    return "GCJ-02 画布不加载 WGS 矢量要素";
  if (base?.content.includes(key)) return "由底图提供 · 无法单独关闭";
  if (base && imageProvided.has(key)) return "由图片底图提供 · 无法单独关闭";
  const provider = activeOverlays(state, config).find((o) =>
    o.content.includes(key),
  );
  if (provider) return `由${provider.name}提供 · 随该图层控制`;
  const [, , layer, field] = featureControls[key]!;
  if (
    !config.vectorLayers?.[layer] ||
    (field && !(field in config.vectorLayers[layer]!))
  )
    return "当前数据源不支持";
  return "";
}
export function effectiveFeatures(state: Project, config: MapConfig) {
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [
      key,
      featureReason(state, config, key)
        ? "none"
        : state.style.features?.[key] || defaults[key]!,
    ]),
  );
}
export function reconcileOverlays(state: Project, config: MapConfig) {
  const notes = [];
  const active: MapPreset[] = [];
  for (const o of state.style.overlays) {
    if (!o.enabled) continue;
    const source = config.overlays.find((s) => s.id === o.id);
    if (!source) {
      o.enabled = false;
      continue;
    }
    const reason =
      overlayReason(state, config, source, false) ||
      (active.some((s) => s.content.some((c) => source.content.includes(c)))
        ? "同类内容重复"
        : "");
    if (reason) {
      o.enabled = false;
      notes.push(`${source.name}已关闭：${reason}`);
    } else active.push(source);
  }
  return notes;
}
