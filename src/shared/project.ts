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
export const ProjectSchema = z
  .object({
    schema: z.literal(2),
    archive: z.string().max(4096),
    tracks: z
      .array(
        z
          .object({
            entry: z.string().min(1).max(4096),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .passthrough(),
      )
      .max(200),
    camera: z
      .object({
        center: z.tuple([number(-180, 180), number(-85, 85)]),
        zoom: number(0, 18),
      })
      .passthrough(),
    style: z
      .object({
        basemap: z
          .string()
          .refine(
            (id) =>
              ["light", "dark", "satellite"].includes(id) ||
              presets[id]?.kind === "basemap",
          ),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        width: number(0.5, 12),
        cities: z.enum(["none", "county"]),
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
      .passthrough(),
    frame: z
      .object({
        ratio: z.enum(["4:3", "3:2", "16:9", "1:1", "3:4", "2:3"]),
        width: z.number(),
        height: z.number(),
      })
      .passthrough(),
    output: z
      .object({
        width: number(256, 4096).int(),
        height: number(256, 4096).int(),
      })
      .passthrough(),
    title: z
      .string()
      .refine(
        (s) => [...s].length <= 60 && !/[\u0000-\u001f]/.test(s),
        "标题最多 60 字，不能包含控制字符",
      ),
    versions: z.record(z.string(), z.unknown()),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (new Set(value.tracks.map((t) => t.entry)).size !== value.tracks.length)
      issue("重复轨迹");
    const [width, height] = catalog.frames[value.frame.ratio];
    if (value.frame.width !== width || value.frame.height !== height)
      issue("画框逻辑尺寸与比例不一致");
    if (
      Math.abs(value.output.height - (value.output.width * height) / width) >
      0.51
    )
      issue("输出尺寸必须保持画框比例");
    const seen = new Set<string>(),
      content = new Set(presets[value.style.basemap]?.content ?? []);
    for (const overlay of value.style.overlays) {
      if (seen.has(overlay.id)) issue("重复叠加层");
      seen.add(overlay.id);
      if (!overlay.enabled) continue;
      const source = presets[overlay.id];
      if (!source) continue;
      if (source.crs !== (presets[value.style.basemap]?.crs ?? "wgs84"))
        issue("坐标系不兼容");
      if (source.content.some((c) => content.has(c))) issue("已含同类内容");
      source.content.forEach((c) => content.add(c));
    }
  });
export type Project = z.infer<typeof ProjectSchema>;
export function defaultProject(
  versions: Record<string, unknown> = {},
): Project {
  return {
    schema: 2,
    archive: "",
    tracks: [],
    camera: { center: [105, 35], zoom: 3.5 },
    style: {
      basemap: "light",
      color: "#e05240",
      width: 3,
      cities: "county",
      features: { ...catalog.defaults },
      overlays: [],
      power: { min_voltage: 0, facilities: "all" },
    },
    frame: { ratio: "4:3", width: 960, height: 720 },
    output: { width: 1920, height: 1440 },
    title: "",
    versions,
  };
}
export function upgradeProject(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = structuredClone(input) as Record<string, unknown>;
  if (
    value.schema !== 1 ||
    !value.style ||
    typeof value.style !== "object" ||
    Array.isArray(value.style)
  )
    return value;
  const style = value.style as Record<string, unknown>;
  value.schema = 2;
  style.features ??= { ...catalog.defaults };
  style.overlays ??= [];
  style.power ??= { min_voltage: 0, facilities: "all" };
  const legacy: Record<string, string> = catalog.legacy;
  if (
    typeof style.basemap === "string" &&
    Object.hasOwn(legacy, style.basemap)
  ) {
    const old = style.basemap;
    style.basemap = legacy[old];
    style.overlays = [{ id: old, enabled: true, opacity: 1 }];
    value.migration = `旧透明底图「${old}」已迁为叠加层，搭配「${String(style.basemap)}」；轨迹和视野不变。`;
  }
  return value;
}
