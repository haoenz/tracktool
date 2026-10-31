import { z } from "zod";
import { MAP_CATALOG as catalog } from "./map-catalog.js";

const number = (min: number, max: number) =>
  z.number().finite().min(min).max(max);
const features = z.record(z.string(), z.string()).superRefine((value, ctx) => {
  if (
    Object.keys(value).length !== Object.keys(catalog.features).length ||
    Object.entries(catalog.features).some(
      ([key, options]) =>
        !(options as readonly string[]).includes(value[key] ?? ""),
    )
  ) {
    ctx.addIssue({ code: "custom", message: "地图要素设置无效" });
  }
});
const presets: Record<
  string,
  { kind: string; crs: string; content: readonly string[] }
> = catalog.presets;
export const frames = catalog.frames;

export const MapTitleSchema = z
  .string()
  .refine(
    (s) => [...s].length <= 60 && !/[\u0000-\u001f]/.test(s),
    "标题最多 60 字，不能包含控制字符",
  );

export const MapStyleSchema = z
  .object({
    basemap: z
      .string()
      .refine((id) => id === "vector" || presets[id]?.kind === "basemap"),
    // Vector tiles carry no palette; light/dark stays independent of the source.
    appearance: z.enum(["light", "dark"]),
    color_mode: z.enum(["uniform", "track", "category"]).optional(),
    outline: z.boolean().optional(),
    endpoints: z.boolean().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: number(0.5, 12),
    features,
    overlays: z.array(
      z
        .object({
          id: z.string().refine((id) => presets[id]?.kind === "overlay"),
          enabled: z.boolean(),
          opacity: number(0.1, 1),
        })
        .passthrough(),
    ),
    power: z
      .object({
        min_voltage: z.union([
          z.literal(0),
          z.literal(110),
          z.literal(220),
          z.literal(500),
        ]),
        facilities: z.enum(["none", "substations", "generation", "all"]),
      })
      .passthrough(),
  })
  .passthrough();
export type MapStyle = z.infer<typeof MapStyleSchema>;

export const MapCameraSchema = z
  .object({
    center: z.tuple([number(-180, 180), number(-85, 85)]),
    zoom: number(0, 18),
  })
  .passthrough();

export const MapFrameSchema = z
  .object({
    ratio: z.enum(["4:3", "3:2", "16:9", "1:1", "3:4", "2:3"]),
    width: z.number(),
    height: z.number(),
  })
  .passthrough();
export type MapFrame = z.infer<typeof MapFrameSchema>;

export const MapOutputSchema = z
  .object({
    width: number(256, 4096).int(),
    height: number(256, 4096).int(),
  })
  .passthrough();
export type MapOutput = z.infer<typeof MapOutputSchema>;

const frameCheck = (
  value: { frame: MapFrame; output: MapOutput },
  ctx: z.RefinementCtx,
) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const [width, height] = catalog.frames[value.frame.ratio];
  if (value.frame.width !== width || value.frame.height !== height)
    issue("画框逻辑尺寸与比例不一致");
  if (
    Math.abs(value.output.height - (value.output.width * height) / width) > 0.51
  )
    issue("输出尺寸必须保持画框比例");
};

/** The single map state shared by browsing, printing and export. */
export const MapStateSchema = z
  .object({
    style: MapStyleSchema,
    camera: MapCameraSchema,
    frame: MapFrameSchema,
    output: MapOutputSchema,
    title: MapTitleSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    frameCheck(value, ctx);
    const seen = new Set<string>();
    const content = new Set(presets[value.style.basemap]?.content ?? []);
    for (const overlay of value.style.overlays) {
      if (seen.has(overlay.id))
        ctx.addIssue({ code: "custom", message: "重复叠加层" });
      seen.add(overlay.id);
      if (!overlay.enabled) continue;
      const source = presets[overlay.id];
      if (!source) continue;
      if (source.content.some((key) => content.has(key)))
        ctx.addIssue({ code: "custom", message: "已含同类内容" });
      source.content.forEach((key) => content.add(key));
    }
  });
export type MapState = z.infer<typeof MapStateSchema>;

export function defaultMapState(): MapState {
  return {
    style: {
      basemap: "vector",
      appearance: "light",
      color: "#e05240",
      width: 3,
      features: { ...catalog.defaults },
      overlays: [],
      power: { min_voltage: 0, facilities: "all" },
    },
    camera: { center: [105, 35], zoom: 3.5 },
    frame: { ratio: "4:3", width: 960, height: 720 },
    output: { width: 1920, height: 1440 },
    title: "",
  };
}

export function mapTitleError(title: string) {
  if ([...title].length > 60) return "标题最多 60 字，请缩短后再保存或导出。";
  if (/[\u0000-\u001f]/.test(title)) return "标题不能包含换行或控制字符。";
  return "";
}
