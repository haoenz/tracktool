import { exclusive, replace, digest, present } from "./durable-files.js";
import { readFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigStore } from "../services/ports.js";
import {
  DEFAULTS,
  normalizeScalar,
  changeTagList,
  tagMap,
} from "../domain/config.js";
import type { ConfigData } from "../domain/config.js";
import { AppError } from "../domain/errors.js";
import { pathEnvironment, resolvePath, userConfigPath } from "./paths.js";
import type { PathEnvironment } from "./paths.js";

export class FileConfigStore implements ConfigStore {
  readonly path: string;
  readonly legacyPath: string | undefined;
  readonly environment: PathEnvironment;
  constructor(
    options: {
      path?: string;
      legacyPath?: string | null;
      environment?: PathEnvironment;
    } = {},
  ) {
    this.environment = options.environment ?? pathEnvironment();
    this.path = options.path
      ? resolvePath(options.path, this.environment)
      : userConfigPath(this.environment);
    // An explicit file is isolated: it never falls back to the user's legacy configuration.
    this.legacyPath =
      options.legacyPath === null || options.path
        ? undefined
        : (options.legacyPath ??
          fileURLToPath(new URL("../../../config.json", import.meta.url)));
  }
  async load(
    options: { persistMigration?: boolean } = {},
  ): Promise<ConfigData> {
    let text: string | undefined, loadedPath: string | undefined;
    for (const source of [this.path, this.legacyPath].filter((p): p is string =>
      Boolean(p),
    )) {
      try {
        text = await readFile(source, "utf8");
        loadedPath = source;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AppError("USER_INPUT", `无法读取配置文件：${source}`, {
            cause: error,
          });
      }
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
    const migratedKey = "kml_zip_path" in value;
    if (migratedKey) {
      if (!("archive_path" in value))
        value.archive_path = value.kml_zip_path
          ? path.dirname(
              resolvePath(String(value.kml_zip_path), this.environment),
            )
          : "";
      delete value.kml_zip_path;
    }
    const config = { ...structuredClone(DEFAULTS), ...value };
    if (
      options.persistMigration &&
      loadedPath &&
      (migratedKey || loadedPath !== this.path)
    ) {
      await mkdir(path.dirname(this.path), { recursive: true });
      const bytes = Buffer.from(JSON.stringify(config, null, 2) + "\n");
      if (loadedPath === this.path)
        replace(this.path, bytes, digest(Buffer.from(text!)));
      else {
        exclusive(this.path, bytes);
        // Remove only the exact legacy bytes consumed, after durable publication.
        if ((await readFile(loadedPath, "utf8")) === text)
          await unlink(loadedPath).catch(() => {});
      }
    }
    return config;
  }
  async set(key: string, value: string, plan = false): Promise<ConfigData> {
    if (!Object.hasOwn(DEFAULTS, key))
      throw new AppError("USER_INPUT", `Unknown config key: ${key}`);
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
