import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigData } from "../domain/config.js";
import {
  changeTagList,
  DEFAULTS,
  normalizeScalar,
  tagMap,
} from "../domain/config.js";
import { AppError } from "../domain/errors.js";
import type { ConfigStore } from "../services/ports.js";
import { digest, exclusive, present, replace } from "./durable-files.js";
import type { PathEnvironment } from "./paths.js";
import { pathEnvironment, resolvePath, userConfigPath } from "./paths.js";

export class FileConfigStore implements ConfigStore {
  readonly path: string;
  readonly environment: PathEnvironment;
  constructor(
    options: {
      path?: string;
      environment?: PathEnvironment;
    } = {},
  ) {
    this.environment = options.environment ?? pathEnvironment();
    this.path = options.path
      ? resolvePath(options.path, this.environment)
      : userConfigPath(this.environment);
  }
  async load(): Promise<ConfigData> {
    let text: string | undefined;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AppError("USER_INPUT", `无法读取配置文件：${this.path}`, {
          cause: error,
        });
    }
    let value: ConfigData = {};
    if (text !== undefined) {
      try {
        value = JSON.parse(text) as ConfigData;
      } catch (error) {
        throw new AppError("USER_INPUT", "配置文件不是有效 JSON", {
          cause: error,
        });
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new AppError("USER_INPUT", "配置必须是 JSON 对象");
    }
    return { ...structuredClone(DEFAULTS), ...value };
  }
  async set(key: string, value: string, plan = false): Promise<ConfigData> {
    if (!Object.hasOwn(DEFAULTS, key)) normalizeScalar(key, value);
    const before = present(this.path) ? await readFile(this.path) : undefined;
    const current = await this.load();
    const next = key.startsWith("track_tag.")
      ? changeTagList(current, key, value)
      : { ...current, [key]: this.normalize(key, value) };
    tagMap(next);
    if (!plan) {
      await mkdir(path.dirname(this.path), { recursive: true });
      const bytes = Buffer.from(JSON.stringify(next, null, 2) + "\n");
      if (before) replace(this.path, bytes, digest(before));
      else exclusive(this.path, bytes);
    }
    return next;
  }
  normalize(key: string, value: string): unknown {
    return key === "archive_path"
      ? resolvePath(value, this.environment)
      : normalizeScalar(key, value);
  }
}
