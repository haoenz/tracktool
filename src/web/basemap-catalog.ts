import type { MapConfig } from "../shared/map.js";

export type BasemapChoice = {
  value: string;
  label: string;
  vendor: string;
  hint?: string;
};

// Open-map vendors share one heading so the list reads by licensing, not by
// whoever happens to host the tiles.
export const openVendors = new Set([
  "OSM",
  "memomaps",
  "OpenTopoMap",
  "OpenFreeMap",
]);
export const vendorName = (group: string) =>
  openVendors.has(group) ? "开放地图" : group;
const vendorOrder = [
  "开放地图",
  "高德",
  "谷歌",
  "ArcGIS",
  "必应",
  "腾讯",
  "360",
];
// Hand-picked order inside each vendor: general maps first, then imagery,
// then the large-font variants.
const basemapOrder = [
  "vector",
  "osm-standard",
  "opentopomap-terrain",
  "memomaps-transport",
  "amap-road",
  "amap-satellite",
  "amap-road-legacy",
  "google-satellite",
  "google-road",
  "google-terrain",
  "google-hybrid",
  "google-hybrid-large",
  "google-road-large",
  "google-terrain-large",
  "esri-satellite",
  "esri-topo",
  "bing-satellite",
  "bing-terrain",
  "tencent-satellite",
  "tencent-road",
  "tencent-terrain",
  "360-road",
];
const vendorRank = (vendor: string) => {
  const index = vendorOrder.indexOf(vendor);
  return index === -1 ? vendorOrder.length : index;
};
const basemapRank = (id: string) => {
  const index = basemapOrder.indexOf(id);
  return index === -1 ? basemapOrder.length : index;
};
export const basemapLabel = (config: MapConfig, id: string) => {
  if (id === "vector") return "开放地图 · OpenFreeMap 矢量底图";
  const preset = config.basemaps.find((basemap) => basemap.id === id);
  return preset ? `${vendorName(preset.group)} · ${preset.name}` : id;
};
const presetCrs = (basemap: MapConfig["basemaps"][number]) =>
  basemap.format === "vector" ? "wgs84" : basemap.crs;
/** Badges only mark sources whose CRS differs from the render canvas. */
const crsBadge = (source: string) => (source === "gcj02" ? "GCJ-02" : "WGS84");
export function basemapChoices(
  config: MapConfig,
  crs: "wgs84" | "gcj02",
): BasemapChoice[] {
  return [
    {
      value: "vector",
      label: "OpenFreeMap 矢量底图",
      vendor: "OpenFreeMap",
      hint: crs === "gcj02" ? "WGS84" : undefined,
    },
    ...config.basemaps.map((basemap) => {
      const source = presetCrs(basemap);
      return {
        value: basemap.id,
        label: basemap.name,
        vendor: basemap.group,
        hint: source === crs ? undefined : crsBadge(source),
      };
    }),
  ];
}
export function groupBasemaps(choices: BasemapChoice[]) {
  const groups = new Map<string, BasemapChoice[]>();
  for (const choice of choices) {
    const vendor = vendorName(choice.vendor);
    const items = groups.get(vendor);
    if (items) items.push(choice);
    else groups.set(vendor, [choice]);
  }
  for (const items of groups.values())
    items.sort(
      (left, right) => basemapRank(left.value) - basemapRank(right.value),
    );
  return [...groups].sort(
    ([left], [right]) => vendorRank(left) - vendorRank(right),
  );
}
export function activeVendor(
  groups: [string, BasemapChoice[]][],
  value: string,
): string {
  return (
    groups.find(([, items]) =>
      items.some((item) => item.value === value),
    )?.[0] ??
    groups[0]?.[0] ??
    ""
  );
}
