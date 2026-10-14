import { Args, Command, Flags } from "@oclif/core";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
import { readTrackData, openArchive, encodeTrackData } from "../api.js";
import { errorInfo } from "../domain/errors.js";
class DataTrack extends Command {
  static description = "输出轨迹 JSON v1；微秒为十进制字符串、缺失数值为 null";
  static args = { file: Args.string({ required: true }) };
  static flags = {
    entry: Flags.string({ description: "读取归档成员；file 为归档位置" }),
  };
  async run() {
    const { args, flags } = await this.parse(DataTrack);
    const abort = new AbortController(),
      cancel = () => abort.abort();
    process.once("SIGINT", cancel);
    const archive = flags.entry ? openArchive(args.file) : undefined;
    try {
      const result = archive
        ? await archive.readTrackData(flags.entry!, abort.signal)
        : { data: await readTrackData(args.file, abort.signal) };
      this.log(
        JSON.stringify({
          ...encodeTrackData(result.data),
          ...("sha256" in result ? { sha256: result.sha256 } : {}),
        }),
      );
    } catch (e) {
      const info = errorInfo(e);
      process.stderr.write(JSON.stringify({ error: info }) + "\n");
      process.exitCode = info.exitCode;
    } finally {
      process.off("SIGINT", cancel);
      await archive?.close();
    }
  }
}
class DataEntries extends Command {
  static description = "输出归档成员 JSON v1，不修改原件";
  static args = { archive: Args.string({ required: true }) };
  async run() {
    const { args } = await this.parse(DataEntries),
      archive = openArchive(args.archive);
    try {
      this.log(
        JSON.stringify({ schema: 1, entries: await archive.listEntries() }),
      );
    } catch (e) {
      const info = errorInfo(e);
      process.stderr.write(JSON.stringify({ error: info }) + "\n");
      process.exitCode = info.exitCode;
    } finally {
      await archive.close();
    }
  }
}
class SetupChromium extends Command {
  static description = "安装与本包版本匹配的 Chromium，供 PNG 导出使用";
  static flags = {
    "with-deps": Flags.boolean({
      description: "同时安装系统依赖（可能需要系统管理员权限）",
    }),
    "dry-run": Flags.boolean({ description: "显示下载位置，不安装" }),
  };
  async run() {
    const { flags } = await this.parse(SetupChromium);
    const manifest = createRequire(import.meta.url).resolve(
      "playwright/package.json",
    );
    const child = spawn(
      process.execPath,
      [
        path.join(path.dirname(manifest), "cli.js"),
        "install",
        ...(flags["with-deps"] ? ["--with-deps"] : []),
        ...(flags["dry-run"] ? ["--dry-run"] : []),
        "chromium",
      ],
      { stdio: "inherit" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        process.exitCode = code ?? 2;
        resolve();
      });
    });
  }
}
export const DATA_COMMANDS = {
  "data:track": DataTrack,
  "data:entries": DataEntries,
  "setup:chromium": SetupChromium,
};
