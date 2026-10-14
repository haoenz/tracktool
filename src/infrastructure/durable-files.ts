import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { AppError } from "../domain/errors.js";
export const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function syncFile(file: string): void {
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function temporary(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
}
export function sameFile(file: string, bytes: Uint8Array): boolean {
  return (
    present(file) &&
    !lstatSync(file).isSymbolicLink() &&
    lstatSync(file).isFile() &&
    readFileSync(file).equals(Buffer.from(bytes))
  );
}
export function exclusive(
  file: string,
  bytes: Uint8Array,
  retry = false,
): void {
  if (present(file)) {
    if (retry && sameFile(file, bytes)) {
      syncFile(file);
      syncDirectory(path.dirname(file));
      return;
    }
    throw new AppError(
      "USER_INPUT",
      `Refusing to overwrite existing target: ${file}`,
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const stage = temporary(file);
  try {
    writeFileSync(stage, bytes, { flag: "wx", mode: 0o600 });
    syncFile(stage);
    try {
      linkSync(stage, file);
    } catch (cause) {
      throw new AppError(
        "USER_INPUT",
        `Cannot publish without overwrite: ${file}`,
        { cause },
      );
    }
    syncDirectory(path.dirname(file));
  } finally {
    if (existsSync(stage)) unlinkSync(stage);
  }
}
export function replace(
  file: string,
  bytes: Uint8Array,
  expected?: string,
): void {
  if (present(file) && lstatSync(file).isSymbolicLink())
    throw new AppError("USER_INPUT", `Refusing symbolic link: ${file}`);
  const stage = temporary(file);
  try {
    writeFileSync(stage, bytes, { flag: "wx", mode: 0o600 });
    syncFile(stage);
    if (
      expected !== undefined &&
      (!present(file) || digest(readFileSync(file)) !== expected)
    )
      throw new AppError(
        "USER_INPUT",
        `File changed during operation: ${file}`,
      );
    renameSync(stage, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (existsSync(stage)) unlinkSync(stage);
  }
}
