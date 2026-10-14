import path from "node:path";
import os from "node:os";
import { realpathSync, existsSync } from "node:fs";

export interface PathEnvironment {
  platform: string;
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
}
export function pathEnvironment(): PathEnvironment {
  return {
    platform: process.platform,
    home: os.homedir(),
    cwd: process.cwd(),
    env: process.env,
  };
}
export function userConfigPath(environment = pathEnvironment()): string {
  const { platform, home, env } = environment;
  const p = platform.startsWith("win") ? path.win32 : path.posix;
  const base = platform.startsWith("win")
    ? env.APPDATA || p.join(home, "AppData", "Roaming")
    : platform === "darwin"
      ? p.join(home, "Library", "Application Support")
      : env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : p.join(home, ".config");
  return p.join(base, "tracktool", "config.json");
}
export function displayPath(
  value: string,
  environment = pathEnvironment(),
): string {
  const p = environment.platform.startsWith("win") ? path.win32 : path.posix;
  const absolute = p.resolve(environment.cwd, value);
  const relative = p.relative(environment.cwd, absolute);
  if (
    !p.isAbsolute(relative) &&
    relative.split(p.sep).filter((part) => part === "..").length <= 1
  )
    return relative || ".";
  const belowHome = p.relative(environment.home, absolute);
  if (
    !p.isAbsolute(belowHome) &&
    belowHome !== ".." &&
    !belowHome.startsWith(`..${p.sep}`)
  )
    return belowHome ? p.join("~", belowHome) : "~";
  return absolute;
}
export function resolvePath(
  value: string,
  environment = pathEnvironment(),
): string {
  const p = environment.platform.startsWith("win") ? path.win32 : path.posix;
  const expanded =
    value === "~"
      ? environment.home
      : value.startsWith("~/") || value.startsWith("~\\")
        ? p.join(environment.home, value.slice(2))
        : value;
  const absolute = p.resolve(environment.cwd, expanded);
  if (environment.platform !== process.platform) return absolute;
  let parent = absolute;
  const tail: string[] = [];
  while (!existsSync(parent) && p.dirname(parent) !== parent) {
    tail.unshift(p.basename(parent));
    parent = p.dirname(parent);
  }
  return p.join(realpathSync(parent), ...tail);
}
