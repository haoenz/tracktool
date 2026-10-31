import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError, checkCancelled } from "../domain/errors.js";
import {
  EXPORT_FILENAMES,
  exportEncoding,
  type ExportOptions,
} from "../shared/export-format.js";
import type { FileListing, UploadResult } from "../shared/work.js";
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
export class WorkFiles {
  readonly uploads: string;
  readonly exports: string;
  constructor(
    readonly stateDir: string,
    readonly roots: string[],
  ) {
    this.uploads = path.join(stateDir, "uploads");
    this.exports = path.join(stateDir, "exports");
  }
  async prepare() {
    await mkdir(this.uploads, { recursive: true });
    await mkdir(this.exports, { recursive: true });
  }
  exportDirectory(output?: string): string | undefined {
    if (!output || !path.isAbsolute(output)) return;
    const parts = path.relative(this.exports, output).split(path.sep);
    if (
      parts.length !== 2 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        parts[0]!,
      ) ||
      ![...EXPORT_FILENAMES, "collections"].includes(parts[1]!)
    )
      return;
    return path.join(this.exports, parts[0]!);
  }
  async exportOutput(
    zip: boolean,
    output?: string,
    options: ExportOptions = {},
  ): Promise<string> {
    const name = zip ? exportEncoding(options).filename : "collections";
    if (!output) {
      await this.prepare();
      const directory = path.join(this.exports, randomUUID());
      await mkdir(directory, { mode: 0o700 });
      output = path.join(directory, name);
    }
    if (!this.exportDirectory(output) || path.basename(output) !== name)
      throw new AppError(
        "FORBIDDEN",
        "网页导出只能使用受管临时目录，请重新导出",
      );
    return this.resolve(output, false);
  }
  async resolve(value: string, existing = true): Promise<string> {
    if (!value || !path.isAbsolute(value))
      throw new AppError("USER_INPUT", "请选择完整的服务端路径");
    const absolute = path.resolve(value);
    let parent = absolute;
    const tail: string[] = [];
    while (true) {
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink())
          throw new AppError("USER_INPUT", "不允许使用符号链接");
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        if (existing || parent === path.dirname(parent))
          throw new AppError("USER_INPUT", `路径不存在：${value}`);
        tail.unshift(path.basename(parent));
        parent = path.dirname(parent);
      }
    }
    const canonical = path.join(await realpath(parent), ...tail);
    const roots = await Promise.all(
      [...this.roots, this.uploads, this.exports].map((root) =>
        realpath(root).catch(() => path.resolve(root)),
      ),
    );
    if (!roots.some((root) => inside(root, canonical)))
      throw new AppError("FORBIDDEN", "此路径不在已开放的服务端目录中");
    // Nested links are visible via canonicalization; reject aliases even if they point within a root.
    if (canonical !== absolute)
      throw new AppError("USER_INPUT", "请使用真实路径，不能通过符号链接访问");
    if (
      inside(this.stateDir, canonical) &&
      !inside(this.uploads, canonical) &&
      !inside(this.exports, canonical)
    )
      throw new AppError("FORBIDDEN", "任务数据库不属于可操作文件");
    return canonical;
  }
  async list(value?: string): Promise<FileListing> {
    const folder = await this.resolve(value || this.roots[0]!);
    const entries = await readdir(folder, { withFileTypes: true });
    const result: FileListing = {
      path: folder,
      parent: path.dirname(folder),
      roots: this.roots,
      entries: [],
    };
    for (const item of entries.slice(0, 2000)) {
      if (
        item.name.startsWith(".") ||
        item.isSymbolicLink() ||
        (!item.isFile() && !item.isDirectory())
      )
        continue;
      const file = path.join(folder, item.name);
      if (inside(this.stateDir, file) && !inside(this.uploads, file)) continue;
      const info = await stat(file);
      result.entries.push({
        name: item.name,
        path: file,
        directory: item.isDirectory(),
        size: info.size,
      });
    }
    result.entries.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
    return result;
  }
  async upload(
    name: string,
    stream: Readable,
    id?: string,
  ): Promise<UploadResult> {
    if (
      !name ||
      path.basename(name) !== name ||
      /[\\\x00-\x1f]/.test(name) ||
      name === "." ||
      name === ".." ||
      name.length > 240
    )
      throw new AppError("USER_INPUT", "无效的上传文件名");
    if (id && !/^[0-9a-f-]{36}$/.test(id))
      throw new AppError("USER_INPUT", "无效的上传批次");
    await this.prepare();
    const batch = id ?? randomUUID(),
      directory = path.join(this.uploads, batch);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, name),
      temporary = file + "." + randomUUID() + ".part";
    let bytes = 0;
    try {
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            callback(
              bytes > 8 * 1024 ** 3
                ? new AppError("USER_INPUT", "单个上传文件不能超过 8 GiB")
                : null,
              chunk,
            );
          },
        }),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      // Exclusive hard-link publication also rejects colliding uploaded names.
      const { link } = await import("node:fs/promises");
      await link(temporary, file);
      await unlink(temporary);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error instanceof AppError
        ? error
        : new AppError("USER_INPUT", "上传失败或同名文件已存在", {
            cause: error,
          });
    }
    return { id: batch, directory, files: [file], bytes };
  }
  async cleanup(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new AppError("USER_INPUT", "无效的上传批次");
    await rm(path.join(this.uploads, id), { recursive: true, force: true });
  }
  async fileSignature(
    file: string,
    signal: AbortSignal,
    // Only reused inside one fingerprint pass: the same file can be reached
    // through a directory and a direct selection, but a later call must see
    // same-size edits even when the timestamp was restored.
    hashes = new Map<string, string>(),
    deep = false,
  ): Promise<unknown> {
    checkCancelled(signal);
    let info;
    try {
      info = await lstat(file, { bigint: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    if (info.isSymbolicLink())
      throw new AppError("USER_INPUT", "输入或输出包含符号链接");
    if (info.isDirectory() && deep)
      return this.directorySignature(file, signal, 0, { count: 0 });
    if (info.isDirectory()) {
      const entries = (await readdir(file))
        .filter(
          (name) =>
            !name.startsWith(".") &&
            !/archive\.sqlite3(?:-wal|-shm)?$/.test(name),
        )
        .sort();
      if (entries.length > 5000)
        throw new AppError(
          "USER_INPUT",
          "目录超过 5000 个文件，请缩小选择范围",
        );
      return Promise.all(
        entries.map(async (name) => {
          const child = path.join(file, name),
            childInfo = await lstat(child, { bigint: true });
          return childInfo.isDirectory()
            ? [name, "directory"]
            : [
                name,
                childInfo.isSymbolicLink() ? "symlink" : "file",
                String(childInfo.size),
                String(childInfo.mtimeNs),
              ];
        }),
      );
    }
    if (!info.isFile())
      throw new AppError("USER_INPUT", "只支持普通文件或目录");
    // Full hashes of directly selected files catch same-size changes with
    // restored timestamps. Reuse the digest while inode size and mtime match:
    // one apply fingerprints the same inputs two or three times.
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    const known = hashes.get(key);
    if (known) return [key, known];
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) {
      checkCancelled(signal);
      hash.update(chunk as Buffer);
    }
    const digest = hash.digest("hex");
    hashes.set(key, digest);
    return [key, digest];
  }
  /** Nested directories are part of the fingerprint, not just their name. */
  private async directorySignature(
    directory: string,
    signal: AbortSignal,
    depth: number,
    budget: { count: number },
  ): Promise<unknown> {
    checkCancelled(signal);
    if (depth > 8) return [path.basename(directory), "too-deep"];
    const entries = (await readdir(directory))
      .filter(
        (name) =>
          !name.startsWith(".") &&
          !/archive\.sqlite3(?:-wal|-shm)?$/.test(name),
      )
      .sort();
    const result: unknown[] = [];
    for (const name of entries) {
      if (++budget.count > 5000)
        throw new AppError(
          "USER_INPUT",
          "目录超过 5000 个文件，请缩小选择范围",
        );
      const file = path.join(directory, name),
        info = await lstat(file, { bigint: true });
      if (info.isSymbolicLink()) result.push([name, "symlink"]);
      else if (info.isDirectory())
        result.push([
          name,
          await this.directorySignature(file, signal, depth + 1, budget),
        ]);
      else result.push([name, "file", String(info.size), String(info.mtimeNs)]);
    }
    return result;
  }
  async sweep(activePaths: string[], age = 7 * 86400_000) {
    await this.prepare();
    for (const entry of await readdir(this.uploads, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      const directory = path.join(this.uploads, entry.name);
      if (activePaths.some((p) => inside(directory, p))) continue;
      if (Date.now() - (await stat(directory)).mtimeMs > age)
        await rm(directory, { recursive: true, force: true });
    }
  }
  async regularPaths(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter(
          (e) =>
            e.isFile() &&
            !e.name.startsWith(".") &&
            !e.name.endsWith("_original"),
        )
        .map((e) => path.join(directory, e.name));
    } catch {
      return [];
    }
  }
}
