import { ExifTool } from "exiftool-vendored";
import { lstat } from "node:fs/promises";
import type { MetadataBackend } from "../services/media-ports.js";
import type { Metadata } from "../domain/media-time.js";
import { AppError, checkCancelled } from "../domain/errors.js";
export function resolveRawTags(
  raw: Record<string, unknown>,
  tags: readonly string[],
): Metadata {
  const result: Metadata = {};
  for (const tag of tags) {
    let value = raw[tag];
    if (value === undefined && !tag.includes(":"))
      value = raw["Composite:" + tag];
    if (value === undefined) {
      const parts = tag.split(":"),
        name = parts.at(-1)!;
      const candidates = Object.keys(raw).filter(
        (k) =>
          k.split(":").at(-1) === name &&
          (parts.length === 1 ||
            k.split(":")[0]!.toLowerCase().startsWith(parts[0]!.toLowerCase())),
      );
      if (candidates.length === 1) value = raw[candidates[0]!];
    }
    if (value !== undefined && value !== null)
      result[tag] = String(value).trim();
  }
  return result;
}
export class ExifMetadata implements MetadataBackend {
  private tool?: ExifTool;
  private filters: RegExp[];
  constructor(
    private readonly executable = process.env.TRACKTOOL_EXIFTOOL,
    private readonly timeout = 30_000,
    outputFilters = "",
    private readonly warning: (message: string) => void = () => {},
  ) {
    try {
      this.filters = outputFilters
        .split("|")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => new RegExp(v));
    } catch (cause) {
      throw new AppError(
        "USER_INPUT",
        "Invalid output_filters regular expression",
        { cause },
      );
    }
  }
  private messages(values: unknown, fatal = false): void {
    for (const value of Array.isArray(values)
      ? values
      : values
        ? [values]
        : []) {
      const message = String(value);
      if (this.filters.some((filter) => filter.test(message))) continue;
      if (fatal || /\bError\b/.test(message))
        throw new AppError("TOOL", `ExifTool: ${message}`);
      this.warning(message);
    }
  }
  private getTool(): ExifTool {
    return (this.tool ??= new ExifTool({
      ...(this.executable ? { exiftoolPath: this.executable } : {}),
      maxProcs: 2,
      taskTimeoutMillis: this.timeout,
      ignoreMinorErrors: false,
    }));
  }
  private async run<T>(
    signal: AbortSignal,
    action: (tool: ExifTool) => Promise<T>,
  ): Promise<T> {
    checkCancelled(signal);
    const tool = this.getTool();
    const cancel = () => {
      if (this.tool === tool) this.tool = undefined;
      void tool.end(false);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await action(tool);
      checkCancelled(signal);
      return result;
    } catch (error) {
      checkCancelled(signal);
      throw new AppError(
        "TOOL",
        `ExifTool: ${error instanceof Error ? error.message : "operation failed"}`,
        { cause: error },
      );
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  async read(
    file: string,
    tags: readonly string[],
    signal: AbortSignal,
  ): Promise<Metadata> {
    const raw = await this.run(signal, (tool) =>
      tool.readRaw(file, {
        readArgs: ["-G1", "-n", ...tags.map((t) => `-${t}`)],
      }),
    );
    const record = raw as unknown as Record<string, unknown>;
    this.messages(record.errors, true);
    this.messages(record.Error ?? record["ExifTool:Error"], true);
    this.messages(record.warnings);
    return resolveRawTags(record, tags);
  }
  private async arguments(file: string, overwrite: boolean): Promise<string[]> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new AppError("USER_INPUT", `Not a regular media file: ${file}`);
    if (!overwrite) {
      const backup = await lstat(file + "_original").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      });
      if (backup && (!backup.isFile() || backup.isSymbolicLink()))
        throw new AppError(
          "USER_INPUT",
          `Backup path is occupied: ${file}_original`,
        );
    }
    return [
      ...(overwrite ? ["-overwrite_original"] : []),
      ...(stat.size >= 2 ** 32 ? ["-api", "largefilesupport=1"] : []),
    ];
  }
  async write(
    file: string,
    tags: Metadata,
    overwrite: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const writeArgs = await this.arguments(file, overwrite);
    // Values remain structured: never interpret user metadata as command arguments.
    const values = Object.keys(tags).some((key) => key.startsWith("IPTC:"))
      ? { "IPTC:CodedCharacterSet": "UTF8", ...tags }
      : tags;
    const result = await this.run(signal, (tool) =>
      tool.write(file, values, { writeArgs }),
    );
    this.messages(result.warnings);
  }
  async shift(
    file: string,
    tags: readonly string[],
    seconds: number,
    overwrite: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(seconds))
      throw new AppError("USER_INPUT", "Invalid time difference");
    const n = Math.abs(seconds),
      operand = `0:0:${Math.floor(n / 86400)} ${Math.floor((n % 86400) / 3600)}:${Math.floor((n % 3600) / 60)}:${n % 60}`;
    const writeArgs = [
      ...(await this.arguments(file, overwrite)),
      ...tags.map((tag) => `-${tag}${seconds < 0 ? "-" : "+"}=${operand}`),
    ];
    const result = await this.run(signal, (tool) =>
      tool.write(file, {}, { writeArgs }),
    );
    this.messages(result.warnings);
  }
  async close(): Promise<void> {
    const tool = this.tool;
    this.tool = undefined;
    await tool?.end();
  }
}
