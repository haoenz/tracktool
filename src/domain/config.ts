import {
  CategorySchema,
  LogLevelSchema,
  PublicConfigSchema,
} from "../shared/contracts.js";
import type { PublicConfig } from "../shared/contracts.js";
import { AppError } from "./errors.js";

export type ConfigData = Record<string, unknown>;
export const DEFAULTS: ConfigData = {
  log_level: "INFO",
  archive_path: "",
  archive_history: true,
  kml_backup_dir_name: "Backup",
  output_filters: "",
  google_api_key: "",
  "track_tag.Default": [
    "默认",
    "徒步",
    "爬山",
    "骑行",
    "驾车",
    "摩托",
    "轮船",
    "散步",
  ],
  "track_tag.Train": ["轨交", "缆车", "地铁", "火车"],
  "track_tag.Flight": ["飞机", "滑翔"],
};
export const categories = CategorySchema.options;
export function parseBool(value: unknown): boolean | undefined {
  const text = String(value).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(text)) return true;
  if (["false", "off", "no", "0"].includes(text)) return false;
  return undefined;
}
export function parseTagSpec(spec: string): { sign: string; names: string[] } {
  const sign = /^[+-]/.test(spec) ? spec[0]! : "";
  const body = spec.slice(sign.length);
  if (!body.trim()) {
    if (sign)
      throw new AppError(
        "USER_INPUT",
        `Nothing follows ${sign} in activity specification`,
      );
    return { sign, names: [] };
  }
  const names = body.split(",").map((s) => s.trim());
  if (names.some((n) => !n))
    throw new AppError(
      "USER_INPUT",
      "Empty activity name (names are comma-separated)",
    );
  return { sign, names: [...new Set(names)] };
}
export function tagMap(data: ConfigData): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [key, values] of Object.entries(data)) {
    if (!key.startsWith("track_tag.")) continue;
    const category = key.slice("track_tag.".length);
    if (!CategorySchema.safeParse(category).success)
      throw new AppError(
        "USER_INPUT",
        `Unknown track category in config: ${key}`,
      );
    if (!Array.isArray(values))
      throw new AppError(
        "USER_INPUT",
        `${key} must be a list of activity names`,
      );
    for (const activity of values) {
      const name = String(activity).trim();
      if (!name)
        throw new AppError("USER_INPUT", `Empty activity name in ${key}`);
      const owner = result.get(name);
      if (owner !== undefined && owner !== category)
        throw new AppError(
          "USER_INPUT",
          `Activity "${name}" is listed under both ${owner} and ${category}`,
        );
      result.set(name, category);
    }
  }
  return result;
}
export function changeTagList(
  data: ConfigData,
  key: string,
  spec: string,
): ConfigData {
  if (
    !key.startsWith("track_tag.") ||
    !CategorySchema.safeParse(key.slice(10)).success
  )
    throw new AppError("USER_INPUT", `Unknown track category: ${key}`);
  const result = structuredClone(data);
  const { sign, names } = parseTagSpec(spec);
  const current = Array.isArray(data[key]) ? data[key].map(String) : [];
  result[key] =
    sign === "+"
      ? [...new Set([...current, ...names])]
      : sign === "-"
        ? current.filter((v) => !names.includes(v))
        : names;
  if (sign !== "-")
    for (const category of categories) {
      const other = `track_tag.${category}`;
      if (other !== key && Array.isArray(result[other]))
        result[other] = result[other].filter((v) => !names.includes(String(v)));
    }
  return result;
}
export function normalizeScalar(key: string, value: string): unknown {
  if (!Object.hasOwn(DEFAULTS, key))
    throw new AppError("USER_INPUT", `Unknown config key: ${key}`);
  if (key === "log_level") {
    const parsed = LogLevelSchema.safeParse(value.toUpperCase());
    if (!parsed.success)
      throw new AppError("USER_INPUT", `Unknown log level: ${value}`);
    return parsed.data;
  }
  if (key === "archive_history") {
    const parsed = parseBool(value);
    if (parsed === undefined)
      throw new AppError("USER_INPUT", "archive_history is true or false");
    return parsed;
  }
  if (key.startsWith("track_tag.")) parseTagSpec(value);
  return value;
}
export function resolveApiKey(
  data: ConfigData,
  envValue?: string,
  override?: string,
): string {
  return (envValue || override || String(data.google_api_key || "")).trim();
}
export function publicConfig(data: ConfigData, envKey?: string): PublicConfig {
  tagMap(data);
  const level = LogLevelSchema.safeParse(String(data.log_level).toUpperCase());
  return PublicConfigSchema.parse({
    log_level: level.success ? level.data : "INFO",
    archive_path: String(data.archive_path || ""),
    archive_history: parseBool(data.archive_history) ?? true,
    kml_backup_dir_name: String(data.kml_backup_dir_name || "Backup"),
    google_api_key_configured: Boolean(resolveApiKey(data, envKey)),
    "track_tag.Default": (data["track_tag.Default"] as unknown[]).map((v) =>
      String(v).trim(),
    ),
    "track_tag.Train": (data["track_tag.Train"] as unknown[]).map((v) =>
      String(v).trim(),
    ),
    "track_tag.Flight": (data["track_tag.Flight"] as unknown[]).map((v) =>
      String(v).trim(),
    ),
  });
}
