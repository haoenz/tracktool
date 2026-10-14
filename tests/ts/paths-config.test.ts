import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileConfigStore } from "../../src/infrastructure/config-store.js";
import {
  displayPath,
  resolvePath,
  userConfigPath,
} from "../../src/infrastructure/paths.js";

const temp: string[] = [];
afterEach(async () => {
  await Promise.all(
    temp.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const environment = {
  platform: "linux",
  home: "/home/test",
  cwd: "/home/test/projects/tracktool",
  env: {},
};
it("uses platform config locations without relative XDG paths", () => {
  expect(userConfigPath(environment)).toBe(
    "/home/test/.config/tracktool/config.json",
  );
  expect(
    userConfigPath({ ...environment, env: { XDG_CONFIG_HOME: "relative" } }),
  ).toBe("/home/test/.config/tracktool/config.json");
  expect(
    userConfigPath({ ...environment, env: { XDG_CONFIG_HOME: "/config" } }),
  ).toBe("/config/tracktool/config.json");
  expect(userConfigPath({ ...environment, platform: "darwin" })).toBe(
    "/home/test/Library/Application Support/tracktool/config.json",
  );
  expect(
    userConfigPath({
      ...environment,
      platform: "win32",
      home: "C:\\Users\\test",
      env: { APPDATA: "D:\\AppData" },
    }),
  ).toBe("D:\\AppData\\tracktool\\config.json");
});
it("displays nearby paths and handles Windows drive boundaries lexically", () => {
  expect(displayPath("/home/test/projects/other", environment)).toBe(
    "../other",
  );
  expect(displayPath("/home/test/photos", environment)).toBe("~/photos");
  expect(
    displayPath("D:\\photos", {
      ...environment,
      platform: "win32",
      cwd: "C:\\app",
      home: "C:\\Users\\test",
    }),
  ).toBe("D:\\photos");
});
it("loads isolated config, migrates legacy keys in memory, and resolves symlink parents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-config-"));
  temp.push(dir);
  const file = path.join(dir, "config.json"),
    original = JSON.stringify({
      kml_zip_path: path.join(dir, "archive.zip"),
      custom: 1,
    });
  await writeFile(file, original);
  const store = new FileConfigStore({ path: file }),
    config = await store.load();
  expect(config.archive_path).toBe(dir);
  expect(config.custom).toBe(1);
  expect(config).not.toHaveProperty("kml_zip_path");
  expect(await readFile(file, "utf8")).toBe(original);
  expect(
    (await new FileConfigStore({ path: path.join(dir, "missing") }).load())
      .archive_path,
  ).toBe("");
  await symlink(
    dir,
    path.join(dir, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(resolvePath(path.join(dir, "link", "new"))).toBe(
    path.join(dir, "new"),
  );
  await writeFile(file, '{"secret": invalid}');
  await expect(store.load()).rejects.toThrow("配置文件不是有效 JSON");
});
