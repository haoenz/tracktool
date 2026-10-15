/** Overview colors follow aggregate KML styles; ground tracks use alpha to reveal overlaps. */
export const TRACK_STYLES = {
  Default: { label: "普通行程", color: "#ff5722", opacity: 0.4 },
  Train: { label: "火车行程", color: "#383041", opacity: 0.4 },
  Flight: { label: "飞机行程", color: "#00adb5", opacity: 26 / 255 },
  Unknown: { label: "未分类", color: "#69796f", opacity: 1 },
} as const;
