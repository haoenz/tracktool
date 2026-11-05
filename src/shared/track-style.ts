import { z } from "zod";

/** Ground tracks use alpha to reveal overlaps. */
export const TRACK_STYLES = {
  Default: { label: "普通行程", color: "#ff5722", opacity: 0.4 },
  Train: { label: "火车行程", color: "#383041", opacity: 0.4 },
  Flight: { label: "飞机行程", color: "#00adb5", opacity: 26 / 255 },
  Unknown: { label: "未分类", color: "#69796f", opacity: 1 },
} as const;

export const TRACK_KINDS = ["Default", "Train", "Flight"] as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "请选择有效的轨迹颜色");
const width = z.number().finite().min(1).max(8);
const category = z.object({
  color,
  opacity: z.number().finite().min(0.05).max(1),
});
export const TrackAppearanceSchema = z.object({
  hiddenTunnelEntries: z.array(z.string().min(1)).max(50000).default([]),
  width,
  categories: z.object({
    Default: category,
    Train: category,
    Flight: category,
  }),
  current: z.object({ color, width }),
});
export type TrackAppearance = z.infer<typeof TrackAppearanceSchema>;

export function defaultTrackAppearance(): TrackAppearance {
  return {
    hiddenTunnelEntries: [],
    width: 2.5,
    categories: {
      Default: {
        color: TRACK_STYLES.Default.color,
        opacity: TRACK_STYLES.Default.opacity,
      },
      Train: {
        color: TRACK_STYLES.Train.color,
        opacity: TRACK_STYLES.Train.opacity,
      },
      Flight: {
        color: TRACK_STYLES.Flight.color,
        opacity: TRACK_STYLES.Flight.opacity,
      },
    },
    current: { color: "#ffd700", width: 3 },
  };
}
