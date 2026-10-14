import { pathEnvironment } from "./paths.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  stat,
  readdir,
  realpath,
  link,
  unlink,
  copyFile,
  rename,
  mkdir,
  open,
} from "node:fs/promises";
import type { MediaFiles } from "../services/media-ports.js";
import type { MediaAction, MediaFile } from "../domain/media.js";
import { MEDIA_EXTENSIONS, fail } from "../domain/media.js";
import { AppError, checkCancelled } from "../domain/errors.js";
/** Expand home without dereferencing the final file: preflight must see symlinks. */
export function resolveMediaPath(value: string): string {
  const environment = pathEnvironment();
  return path.resolve(
    value === "~"
      ? environment.home
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(environment.home, value.slice(2))
        : value,
  );
}
async function occupied(file: string) {
  try {
    return await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
async function plain(file: string) {
  const s = await occupied(file);
  return !!s?.isFile() && !s.isSymbolicLink();
}
async function identical(left: string, right: string): Promise<boolean> {
  if (
    !(await plain(left)) ||
    !(await plain(right)) ||
    (await stat(left)).size !== (await stat(right)).size
  )
    return false;
  const a = await open(left, "r");
  try {
    const b = await open(right, "r");
    try {
      const x = Buffer.alloc(1024 * 1024),
        y = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = await a.read(x),
          m = await b.read(y);
        if (
          n.bytesRead !== m.bytesRead ||
          !x.subarray(0, n.bytesRead).equals(y.subarray(0, m.bytesRead))
        )
          return false;
        if (!n.bytesRead) return true;
      }
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
  }
}
export async function runProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeout = 120_000,
): Promise<void> {
  checkCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "",
      timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    signal.addEventListener("abort", kill, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    };
    child.on("error", (error) => {
      cleanup();
      reject(new AppError("TOOL", `${executable}: ${error.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (signal.aborted) reject(new AppError("CANCELLED", "操作已取消"));
      else if (code !== 0 || timedOut)
        reject(
          new AppError(
            "TOOL",
            `${executable} ${timedOut ? "timed out" : "failed"}: ${stderr}`,
          ),
        );
      else resolve();
    });
  });
}
export class LocalMediaFiles implements MediaFiles {
  join(...parts: string[]) {
    return path.join(...parts);
  }
  directory(file: string) {
    return path.dirname(file);
  }
  async exists(file: string) {
    return !!(await occupied(file));
  }
  async isDirectory(file: string) {
    const s = await occupied(file);
    return !!s?.isDirectory() && !s.isSymbolicLink();
  }
  async mkdir(file: string) {
    await mkdir(file, { recursive: true });
  }
  async renameDirectory(source: string, target: string) {
    if (await occupied(target))
      throw new AppError("USER_INPUT", `Directory already exists: ${target}`);
    await rename(source, target);
  }
  async discover(input: string | string[]): Promise<MediaFile[]> {
    let names: string[];
    if (Array.isArray(input)) names = input;
    else {
      const file = path.resolve(input);
      const s = await occupied(file);
      if (!s) throw new AppError("USER_INPUT", `Path not found: ${file}`);
      names = s.isDirectory()
        ? (await readdir(file, { withFileTypes: true }))
            .filter(
              (e) =>
                e.isFile() &&
                MEDIA_EXTENSIONS[path.extname(e.name).toLowerCase()],
            )
            .map((e) => path.join(file, e.name))
            .sort()
        : [file];
    }
    return names.map((file) => {
      const absolute = path.resolve(file),
        extension = path.extname(absolute);
      return {
        path: absolute,
        name: path.basename(absolute),
        extension: extension.toLowerCase(),
        stem: path.basename(absolute, extension),
        directory: path.dirname(absolute),
      };
    });
  }
  private async key(file: string) {
    const parent = await realpath(path.dirname(file)).catch(() =>
      path.resolve(path.dirname(file)),
    );
    const key = path.join(parent, path.basename(file));
    return process.platform === "win32" ? key.toLowerCase() : key;
  }
  async preflight(
    plans: MediaAction[][],
    skipExisting = false,
  ): Promise<MediaAction[][]> {
    const checked = plans.map((p) => [...p]),
      owners = new Map<string, Set<number>>();
    for (const [i, plan] of plans.entries()) {
      if (plan.some((a) => a.kind === "failed")) continue;
      try {
        const paths = new Set<string>();
        for (const action of plan) {
          if (["skip", "lookup"].includes(action.kind)) continue;
          paths.add(await this.key(action.file));
          const source = await occupied(action.file);
          if (source?.isSymbolicLink()) {
            paths.add(await realpath(action.file));
            checked[i] = fail(
              plan[0]!.file,
              "Media input is a symbolic link",
              false,
            );
          }
          let backup: string | undefined;
          if (action.kind === "write" || action.kind === "shift") {
            if (!action.overwrite) backup = action.file + "_original";
          }
          if (action.kind === "move" || action.kind === "remux") {
            paths.add(await this.key(action.output));
            const target = await occupied(action.output);
            if (
              target &&
              ((await this.key(action.output)) !==
                (await this.key(action.file)) ||
                target.isSymbolicLink())
            )
              checked[i] =
                action.kind === "remux" &&
                skipExisting &&
                (await plain(action.output))
                  ? [
                      {
                        kind: "skip",
                        file: plan[0]!.file,
                        reason: "Output already exists",
                      },
                    ]
                  : fail(
                      plan[0]!.file,
                      `Output already exists: ${action.output}`,
                      false,
                    );
            let parent = path.dirname(action.output);
            while (parent !== path.dirname(parent)) {
              const s = await occupied(parent);
              if (s && !s.isDirectory())
                checked[i] = fail(
                  plan[0]!.file,
                  `Output directory is blocked: ${parent}`,
                  false,
                );
              parent = path.dirname(parent);
            }
            if (action.kind === "remux" && action.mp4)
              backup = action.file + "_original";
          }
          if (backup) {
            paths.add(await this.key(backup));
            if ((await occupied(backup)) && !(await plain(backup)))
              checked[i] = fail(
                plan[0]!.file,
                `Backup path is occupied: ${backup}`,
                false,
              );
          }
        }
        for (const p of paths) {
          const set = owners.get(p) ?? new Set<number>();
          set.add(i);
          owners.set(p, set);
        }
      } catch (error) {
        checked[i] = fail(
          plan[0]!.file,
          `Cannot check paths: ${String(error)}`,
          false,
        );
      }
    }
    for (const [p, indices] of owners)
      if (indices.size > 1)
        for (const i of indices)
          checked[i] = fail(
            plans[i]![0]!.file,
            `Batch path conflict: ${p}`,
            false,
          );
    return checked;
  }
  private async move(source: string, target: string) {
    if (path.resolve(source) === path.resolve(target)) return;
    await link(source, target);
    await unlink(source);
  }
  async moveFolder(
    file: string,
    folder: string,
    plan: boolean,
  ): Promise<boolean> {
    if (
      !folder ||
      path.basename(folder) !== folder ||
      folder === "." ||
      folder === ".."
    )
      throw new AppError(
        "USER_INPUT",
        "Failure/group folder must be a simple folder name",
      );
    const target = path.join(path.dirname(file), folder, path.basename(file));
    if (await occupied(target)) {
      if (await identical(file, target)) {
        if (!plan) await unlink(file);
        return !plan;
      }
      return false;
    }
    if (plan) return false;
    await mkdir(path.dirname(target), { recursive: true });
    await this.move(file, target);
    return true;
  }
  async apply(action: MediaAction, signal: AbortSignal): Promise<void> {
    checkCancelled(signal);
    if (action.kind === "move") {
      await this.move(action.file, action.output);
      return;
    }
    if (action.kind !== "remux") return;
    const checked = (await this.preflight([[action]]))[0]![0]!;
    if (checked.kind === "failed")
      throw new AppError("USER_INPUT", checked.reason);
    const initial = await lstat(action.file, { bigint: true });
    const temp = path.join(
      path.dirname(action.output),
      `.tracktool-${randomUUID()}.mp4`,
    );
    try {
      if (action.mp4 && action.quicktime)
        await copyFile(action.file, temp, constants.COPYFILE_EXCL);
      else
        await runProcess(
          process.env.TRACKTOOL_FFMPEG || "ffmpeg",
          [
            "-nostdin",
            "-n",
            "-i",
            action.file,
            "-c",
            "copy",
            ...(action.mp4 ? ["-map", "0"] : []),
            "-metadata",
            `creation_time=${action.utc}`,
            temp,
          ],
          signal,
        );
      checkCancelled(signal);
      const current = await lstat(action.file, { bigint: true });
      if (
        current.isSymbolicLink() ||
        current.ino !== initial.ino ||
        current.dev !== initial.dev ||
        current.size !== initial.size ||
        current.mtimeNs !== initial.mtimeNs
      )
        throw new AppError(
          "USER_INPUT",
          "Media source changed during conversion",
        );
      if (action.mp4 && !(await occupied(action.file + "_original"))) {
        const backup = temp + ".backup";
        try {
          await copyFile(action.file, backup, constants.COPYFILE_EXCL);
          try {
            await link(backup, action.file + "_original");
          } catch (e) {
            if (
              (e as NodeJS.ErrnoException).code !== "EEXIST" ||
              !(await plain(action.file + "_original"))
            )
              throw e;
          }
        } finally {
          await unlink(backup).catch(() => {});
        }
      }
      if (action.mp4 && !(await plain(action.file + "_original")))
        throw new AppError("USER_INPUT", "Backup path is occupied");
      if (path.resolve(action.output) === path.resolve(action.file))
        await rename(temp, action.output);
      else await this.move(temp, action.output);
      if (
        action.mp4 &&
        path.resolve(action.output) !== path.resolve(action.file)
      )
        await unlink(action.file);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
}
