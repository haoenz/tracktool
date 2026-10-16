import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { COMMANDS } from "../../dist/node/cli/commands.js";
const exec = promisify(execFile),
  cli = path.resolve("dist/node/cli/main.js"),
  dirs: string[] = [];
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-m5-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
async function run(dir: string, args: string[]) {
  try {
    const result = await exec(
      process.execPath,
      [cli, ...args, "--config", path.join(dir, "config.json")],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1" } },
    );
    return { ...result, code: 0 };
  } catch (error) {
    const e = error as { stdout: string; stderr: string; code: number };
    return e;
  }
}
it("covers the current business commands, excludes pop and resolves every help page", async () => {
  const names = Object.keys(COMMANDS).filter(
    (n) =>
      !["completion", "data:", "setup:"].some((prefix) => n.startsWith(prefix)),
  );
  expect(names).toHaveLength(45);
  expect(names).not.toContain("kml:pop");
  expect(names).not.toContain("kml:to-multigeom");
  expect(names).toEqual(
    expect.arrayContaining([
      "track:list",
      "track:fill-locations",
      "track:locations",
      "track:show",
      "track:history",
      "track:operation",
      "track:preview",
      "track:apply",
      "track:export",
    ]),
  );
  expect(names).toEqual(expect.arrayContaining(["kml:download", "kml:delete"]));
  expect(names).toEqual(
    expect.arrayContaining(["archive:full-backup", "archive:restore-backup"]),
  );
  for (const name of names) {
    const result = await exec(process.execPath, [
      cli,
      ...name.split(":"),
      "--help",
    ]);
    expect(result.stdout).toContain("USAGE");
  }
}, 60000);
it("supports negative config list values, negative time flags and negative altitude positional values", async () => {
  const d = tmp(),
    file = path.join(d, "中文 image.jpg");
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toFile(file);
  expect(
    (await run(d, ["config", "set", "track_tag.Default", "-散步"])).code,
  ).toBe(0);
  expect(
    JSON.parse(readFileSync(path.join(d, "config.json"), "utf8"))[
      "track_tag.Default"
    ],
  ).not.toContain("散步");
  const set = await run(d, [
    "exif",
    "set",
    file,
    "--make",
    "SONY",
    "--position",
    "0, 0",
    "--altitude",
    "10",
    "-t",
    "ExifIFD:DateTimeOriginal=2024:05:01 00:30:00",
  ]);
  expect(set.code, set.stderr).toBe(0);
  const shift = await run(d, [
    "--dry-run",
    "exif",
    "shift-time",
    file,
    "--by",
    "-1h",
  ]);
  expect(shift.code, shift.stderr).toBe(0);
  expect(shift.stderr).toContain("shift");
  expect(shift.stdout).toBe("");
  const altitude = await run(d, [
    "exif",
    "shift-altitude",
    file,
    "-20",
    "--overwrite",
  ]);
  expect(altitude.code, altitude.stderr).toBe(0);
  const info = await run(d, ["exif", "info", file]);
  expect(info.stdout).toBe("2024-05-01T00:30:00+08:00\n0 0\n-10\n");
  expect(info.stderr).not.toMatch(/\x1b\[/);
  expect(
    (await run(d, ["google", "location", "0, 0", "--dry-run"])).stdout,
  ).toContain("Would query");
  const completion = (await exec(process.execPath, [cli, "completion", "zsh"]))
    .stdout;
  expect(completion).toContain("timezone-policy");
  expect(completion).toContain("auto keep force");
  expect(completion).toContain("track_tag.Default");
});
it("reports partial failures and isolates malformed media while preserving dry-run bytes", async () => {
  const d = tmp(),
    file = path.join(d, "broken.jpg");
  writeFileSync(file, "");
  const result = await run(d, ["exif", "show-missing", d, "GPSAltitude"]);
  expect(result.code, result.stderr).toBe(3);
  expect(result.stdout).toContain("File\tMissing");
  expect(result.stderr).toContain("broken.jpg");
  const preview = await run(d, [
    "exif",
    "set",
    file,
    "-t",
    "IPTC:City=杭州",
    "--dry-run",
  ]);
  expect(preview.code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("");
  expect(existsSync(file + "_original")).toBe(false);
});
it("rejects an explicit media symlink without modifying its target", async () => {
  const d = tmp(),
    target = path.join(d, "original.jpg"),
    alias = path.join(d, "alias.jpg");
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .jpeg()
    .toFile(target);
  const { symlinkSync } = await import("node:fs");
  symlinkSync(target, alias);
  const original = readFileSync(target);
  const result = await run(d, [
    "exif",
    "set",
    alias,
    "-t",
    "IPTC:City=Changed",
  ]);
  expect(result.code).toBe(3);
  expect(readFileSync(target)).toEqual(original);
  expect(existsSync(target + "_original")).toBe(false);
});
