// Composition policy shared by editor and export; no tile reprojection is implied.
export const featureControls = {
  places: [
    "地名",
    { none: "关闭", major: "国家与城市", all: "城市、乡镇与街区" },
    "place",
    "class",
  ],
  roads: [
    "道路",
    { none: "关闭", major: "主干道路", all: "全部道路" },
    "transportation",
    "class",
  ],
  road_names: [
    "道路名称",
    { none: "关闭", major: "主干路名", all: "全部路名" },
    "transportation_name",
    "name",
  ],
  boundaries: [
    "行政边界",
    { none: "关闭", country: "国界", region: "省 / 地区", local: "县及以下" },
    "boundary",
    "admin_level",
  ],
  poi: [
    "兴趣点",
    { none: "关闭", major: "精选", all: "详细（近景）" },
    "poi",
    "rank",
  ],
  buildings: ["建筑轮廓", { none: "关闭", all: "显示（13 级起）" }, "building"],
  housenumbers: [
    "门牌",
    { none: "关闭", all: "显示（16 级起）" },
    "housenumber",
    "housenumber",
  ],
  peaks: [
    "山峰",
    { none: "关闭", name: "名称", elevation: "名称与海拔" },
    "mountain_peak",
    "ele",
  ],
  water_names: [
    "水域名称",
    { none: "关闭", all: "显示" },
    "water_name",
    "name",
  ],
};
export const defaults = {
  places: "none",
  roads: "all",
  road_names: "none",
  boundaries: "region",
  poi: "none",
  buildings: "all",
  housenumbers: "none",
  peaks: "none",
  water_names: "none",
};
export const presetFor = (state, config) =>
  config.basemaps?.find((s) => s.id === state.style.basemap);
export function activeOverlays(state, config) {
  return (state.style.overlays || [])
    .filter((o) => o.enabled)
    .map((o) => ({ ...config.overlays.find((s) => s.id === o.id), ...o }));
}
export function overlayReason(state, config, source, peers = true) {
  const base = presetFor(state, config);
  if (source.crs !== (base?.crs || "wgs84"))
    return "坐标系不兼容，尚未实现瓦片重投影";
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
export function featureReason(state, config, key) {
  const base = presetFor(state, config);
  if ((base?.crs || "wgs84") !== "wgs84")
    return "OSM 要素为 WGS84，不能叠到 GCJ-02 瓦片";
  if (base?.content.includes(key)) return "底图已烧入同类内容，无法独立移除";
  if (activeOverlays(state, config).some((o) => o.content.includes(key)))
    return "已由透明注记层提供，按整体控制";
  const [, , layer, field] = featureControls[key];
  if (
    !config.vectorLayers?.[layer] ||
    (field && !(field in config.vectorLayers[layer]))
  )
    return "当前矢量源未提供所需图层 / 字段";
  return "";
}
export function effectiveFeatures(state, config) {
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [
      key,
      featureReason(state, config, key)
        ? "none"
        : state.style.features?.[key] || defaults[key],
    ]),
  );
}
export function cityReason(state, config) {
  if (
    presetFor(state, config)?.content.includes("places") ||
    activeOverlays(state, config).some((o) => o.content.includes("places"))
  )
    return "已有地名，暂停重复城市标注";
  if (effectiveFeatures(state, config).places !== "none")
    return "使用 OSM 地名，暂停 GeoNames 城市标注";
  return "";
}
export function reconcileOverlays(state, config) {
  const notes = [];
  const active = [];
  for (const o of state.style.overlays) {
    if (!o.enabled) continue;
    const source = config.overlays.find((s) => s.id === o.id);
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
