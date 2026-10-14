#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isIPv4 } from "node:net";
import { setGlobalProxyFromEnv } from "node:http";
import { spawn } from "node:child_process";
import { createApp } from "./app.js";
import { FileConfigStore } from "../infrastructure/config-store.js";
import { AppError, errorInfo } from "../domain/errors.js";

try {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8765" },
      config: { type: "string" },
      archive: { type: "string" },
      cache: { type: "string" },
      "state-dir": { type: "string" },
      "files-root": { type: "string", multiple: true },
      "no-browser": { type: "boolean" },
      "refresh-basemap": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    process.stdout.write(
      "tracktool-map [--host 127.0.0.1] [--port 8765] [--config PATH]\n地图、归档、媒体与持久化任务。支持 --archive PATH --cache PATH --state-dir PATH --files-root PATH（可重复）--refresh-basemap --no-browser。\n",
    );
  else {
    setGlobalProxyFromEnv({
      ...process.env,
      NO_PROXY: [
        process.env.no_proxy ?? process.env.NO_PROXY ?? "",
        "localhost",
        "127.0.0.1",
      ].join(","),
      no_proxy: undefined,
    });
    const port = Number(values.port);
    if (
      !isIPv4(values.host) ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535
    )
      throw new AppError(
        "USER_INPUT",
        "host 必须是 IPv4，port 必须在 0–65535 之间",
      );
    const app = await createApp({
      configStore: new FileConfigStore({ path: values.config }),
      maps: {
        initialArchive: values.archive,
        cache: values.cache,
        refresh: values["refresh-basemap"],
      },
      work: {
        stateDir: values["state-dir"],
        roots: values["files-root"],
        archive: values.archive,
      },
      envKey: process.env.TRACKTOOL_GOOGLE_API_KEY,
    });
    const address = await app.listen({ host: values.host, port });
    process.stdout.write(`Tracktool：${address}（Ctrl+C 停止）\n`);
    if (!values["no-browser"]) {
      const url = address.replace("0.0.0.0", "127.0.0.1");
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "cmd"
            : "xdg-open";
      const browser = spawn(
        command,
        process.platform === "win32" ? ["/c", "start", "", url] : [url],
        { stdio: "ignore", detached: true },
      );
      browser.on("error", () => {});
      browser.unref();
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void app.close();
      });
  }
} catch (error) {
  const info = errorInfo(error);
  process.stderr.write(`${JSON.stringify({ error: info })}\n`);
  process.exitCode = info.exitCode;
}
