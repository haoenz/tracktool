import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { COMMANDS } from "../../dist/node/cli/commands.js";
const exec = promisify(execFile),
  cli = path.resolve("dist/node/cli/main.js"),
  dirs: string[] = [];
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tracktool-utility-cli-"));
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
it("covers the current business commands and resolves every help page", async () => {
  const names = Object.keys(COMMANDS).filter(
    (n) =>
      !["completion", "data:", "setup:"].some((prefix) => n.startsWith(prefix)),
  );
  expect(names).toHaveLength(31);
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
      "track:export-display",
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
it("keeps configuration, Google queries and completion without media commands", async () => {
  const d = tmp();
  expect(
    (await run(d, ["config", "set", "track_tag.Default", "-散步"])).code,
  ).toBe(0);
  expect(
    JSON.parse(readFileSync(path.join(d, "config.json"), "utf8"))[
      "track_tag.Default"
    ],
  ).not.toContain("散步");
  expect(
    (await run(d, ["google", "location", "0, 0", "--dry-run"])).stdout,
  ).toContain("Would query");
  expect(Object.keys(COMMANDS).some((name) => name.startsWith("exif:"))).toBe(
    false,
  );
  const removed = await run(d, ["exif", "info", "photo.jpg"]);
  expect(removed.code).not.toBe(0);
  const completion = (await exec(process.execPath, [cli, "completion", "zsh"]))
    .stdout;
  expect(completion).not.toContain("timezone-policy");
  expect(completion).toContain("track_tag.Default");
});
