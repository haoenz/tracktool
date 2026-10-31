import { databasePath } from "./archive/database.js";
import { readFile } from "node:fs/promises";
import { lstatSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { AppError } from "../domain/errors.js";
import type { KmlFiles, Source } from "../services/kml-service.js";
import { MAX_KML_BYTES } from "../domain/trackdata.js";
import { digest, exclusive, present, replace } from "./durable-files.js";
import { resolvePath } from "./paths.js";
export class LocalKmlFiles implements KmlFiles {
  join(directory: string, name: string): string {
    return path.join(directory, name);
  }
  async read(file: string): Promise<Source> {
    try {
      if (lstatSync(file).isSymbolicLink())
        throw new AppError("USER_INPUT", `Refusing symbolic link: ${file}`);
      const resolved = resolvePath(file),
        stat = statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_KML_BYTES)
        throw new AppError(
          "USER_INPUT",
          `KML must be a file of at most 128 MiB: ${file}`,
        );
      const bytes = await readFile(resolved);
      return {
        bytes,
        sha256: digest(bytes),
        path: resolved,
        name: path.basename(resolved),
        stem: path.basename(resolved, path.extname(resolved)),
        directory: path.dirname(resolved),
      };
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("USER_INPUT", `Cannot read KML: ${file}`, { cause });
    }
  }
  async write(
    file: string,
    xml: string,
    options: { exclusive?: boolean; expected?: string } = {},
  ): Promise<void> {
    try {
      if (options.exclusive) exclusive(file, Buffer.from(xml));
      else replace(file, Buffer.from(xml), options.expected);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("USER_INPUT", `Cannot write KML: ${file}`, { cause });
    }
  }
  checkOutput(output: string, reserved: string[]): void {
    if (present(output) || reserved.includes(output))
      throw new AppError(
        "USER_INPUT",
        `Refusing existing or reserved merge output: ${output}`,
      );
    if (
      !present(path.dirname(output)) ||
      !statSync(path.dirname(output)).isDirectory()
    )
      throw new AppError("USER_INPUT", "Output directory does not exist");
  }
}
export function expandPaths(inputs: string[]): string[] {
  return inputs.flatMap((input) => {
    const expanded = input.startsWith("~")
      ? resolvePath(input)
      : path.resolve(input);
    const name = path.basename(expanded);
    if (!/[*?[]/.test(name)) return [expanded];
    const directory = path.dirname(expanded);
    let matches: string[] = [];
    try {
      matches = readdirSync(directory)
        .filter((n) => path.matchesGlob(n, name))
        .map((n) => path.join(directory, n))
        .filter((n) => statSync(n).isFile())
        .sort();
    } catch {
      /* Report a consistent user error below. */
    }
    if (!matches.length)
      throw new AppError("USER_INPUT", `No files match pattern: ${input}`);
    return matches;
  });
}
export function workspace(
  config: Record<string, unknown>,
  archive?: string,
): { database: string; directory: string; bundle: string; backup: string } {
  const base = String(config.archive_path || "");
  if (!archive && !base)
    throw new AppError("USER_INPUT", "请配置 archive_path 或传入 --archive");
  const database = databasePath(archive || base);
  const directory = path.dirname(database);
  if (!present(database))
    throw new AppError(
      "USER_INPUT",
      `SQLite archive not found: ${database}; run archive init / import-zip`,
    );
  return {
    directory,
    database,
    bundle: path.join(directory, "Archive.zip"),
    backup: path.resolve(
      directory,
      String(config.kml_backup_dir_name || "Backup"),
    ),
  };
}
