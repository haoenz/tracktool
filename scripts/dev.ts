import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "8765" },
    "backend-port": { type: "string", default: "8766" },
    config: { type: "string" },
    archive: { type: "string" },
    cache: { type: "string" },
    "state-dir": { type: "string" },
    "files-root": { type: "string", multiple: true },
  },
});
const port = Number(values.port);
const backendPort = Number(values["backend-port"]);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const token = randomBytes(32).toString("hex");
const controller = new AbortController();
const { signal } = controller;
const env = {
  ...process.env,
  NODE_ENV: "development",
  TRACKTOOL_DEV_TOKEN: token,
  TRACKTOOL_DEV_BACKEND: backendUrl,
};
type ManagedProcess = {
  child: ChildProcess;
  ended: boolean;
  done: Promise<number>;
};
const children = new Set<ManagedProcess>();
const watchers: FSWatcher[] = [];
let wake = () => {};
let pendingBuild = true;
let debounce: ReturnType<typeof setTimeout> | undefined;

function launch(args: string[], development = false): ManagedProcess {
  signal.throwIfAborted();
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: development ? env : process.env,
  });
  const handle: ManagedProcess = {
    child,
    ended: false,
    done: new Promise<number>((done) => {
      child.once("error", (error) => {
        process.stderr.write(`无法启动进程：${error.message}\n`);
        done(1);
      });
      child.once("exit", (code) => done(code ?? 1));
    }),
  };
  children.add(handle);
  void handle.done.then(() => {
    handle.ended = true;
    children.delete(handle);
    wake();
  });
  return handle;
}

async function stop(handle: ManagedProcess | undefined) {
  if (!handle || handle.ended) return;
  handle.child.kill("SIGTERM");
  const force = setTimeout(() => handle.child.kill("SIGKILL"), 5000);
  try {
    await handle.done;
  } finally {
    clearTimeout(force);
  }
}

function shutdown(code: number) {
  if (signal.aborted) return;
  process.exitCode = code;
  controller.abort();
  wake();
  for (const child of children) void stop(child);
}
for (const event of ["SIGINT", "SIGTERM"] as const)
  process.once(event, () => shutdown(130));

async function checkPort(host: string, port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("开发服务端口必须是 1–65535 之间的整数");
  await new Promise<void>((done, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(new Error(`端口 ${port} 不可用，请先停止占用它的服务`)),
    );
    server.listen(port, host, () => server.close(() => done()));
  });
}

async function startBackend(root: string) {
  const args = [
    join(root, "node/server/main.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(backendPort),
    "--no-browser",
  ];
  for (const key of ["config", "archive", "cache", "state-dir"] as const)
    if (values[key]) args.push(`--${key}`, values[key]);
  for (const root of values["files-root"] ?? [])
    args.push("--files-root", root);
  const handle = launch(args, true);
  try {
    const deadline = Date.now() + 15000;
    while (!signal.aborted && !handle.ended && Date.now() < deadline) {
      try {
        const response = await fetch(`${backendUrl}/`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
        // A response from a different process must not count as readiness.
        if (
          response.ok &&
          (await response.text()).includes(`content="${token}"`)
        )
          return handle;
      } catch {
        // Readiness is bounded and only probes an idempotent page request.
      }
      await delay(100, undefined, { signal });
    }
    throw new Error(
      handle.ended ? "后台启动失败，请查看上方错误" : "等待后台启动超时",
    );
  } catch (error) {
    await stop(handle);
    throw error;
  }
}

function scheduleBuild() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    pendingBuild = true;
    wake();
  }, 250);
}

let session: string | undefined;
let current: string | undefined;
let backend: ManagedProcess | undefined;
let vite: ManagedProcess | undefined;
let retries = 0;
try {
  if (port === backendPort) throw new Error("网页和后台必须使用不同端口");
  await checkPort(values.host, port);
  await checkPort("127.0.0.1", backendPort);
  await mkdir(".dev", { recursive: true });
  session = await mkdtemp(resolve(".dev/session-"));
  watchers.push(
    watch("src", { recursive: true }, (_event, name) => {
      const file = name?.toString().replaceAll("\\", "/");
      if (
        !file ||
        !file.startsWith("web/") ||
        [
          "web/render.ts",
          "web/render.html",
          "web/map.css",
          "web/api.ts",
        ].includes(file)
      )
        scheduleBuild();
    }),
  );
  watchers.push(watch("resources/maps", { recursive: true }, scheduleBuild));
  watchers.push(
    watch(".", (_event, name) => {
      if (
        ["tsconfig.json", "tsconfig.build.json"].includes(
          name?.toString() ?? "",
        )
      )
        scheduleBuild();
    }),
  );
  for (const watcher of watchers)
    watcher.on("error", (error) => {
      process.stderr.write(`监听源码失败：${error.message}\n`);
      shutdown(1);
    });

  while (!signal.aborted) {
    if (vite?.ended) throw new Error("网页开发服务已退出");
    if (pendingBuild) {
      pendingBuild = false;
      const next = await mkdtemp(join(session, "build-"));
      process.stdout.write("正在构建独立的开发资源…\n");
      try {
        const build = launch(["scripts/build.ts", "--out-dir", next]);
        if ((await build.done) !== 0)
          throw new Error("开发构建失败，修复代码并保存后将自动重试");
        if (signal.aborted) break;
        await stop(backend);
        backend = undefined;
        try {
          backend = await startBackend(next);
        } catch (error) {
          if (current && !signal.aborted) {
            process.stderr.write("新后台未能启动，正在恢复上一次成功的构建…\n");
            backend = await startBackend(current);
          }
          throw error;
        }
        const previous = current;
        current = next;
        retries = 0;
        if (previous)
          await rm(previous, { recursive: true, force: true }).catch(
            (error: Error) => {
              process.stderr.write(`清理旧开发资源失败：${error.message}\n`);
            },
          );
        if (!vite)
          vite = launch(
            [
              "node_modules/vite/bin/vite.js",
              "--host",
              values.host,
              "--port",
              String(port),
              "--strictPort",
            ],
            true,
          );
        process.stdout.write(
          "开发后台已就绪；正式构建与检查不会影响此服务。\n",
        );
      } catch (error) {
        await rm(next, { recursive: true, force: true });
        if (!current || signal.aborted) throw error;
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (backend && !backend.ended)
          process.stderr.write("继续使用上一次成功的开发构建。\n");
      }
      continue;
    }
    if (current && (!backend || backend.ended) && retries < 3) {
      retries += 1;
      process.stderr.write(`后台已退出，正在重新启动（${retries}/3）…\n`);
      await delay(500 * retries, undefined, { signal });
      try {
        backend = await startBackend(current);
      } catch (error) {
        if (signal.aborted) throw error;
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      if (retries === 3)
        process.stderr.write(
          "自动重启次数已用完；若后台再次退出，请修复代码并保存，或重新运行 pnpm dev。\n",
        );
      continue;
    }
    await new Promise<void>((done) => {
      wake = done;
    });
  }
} catch (error) {
  if (!signal.aborted) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    shutdown(1);
  }
} finally {
  for (const watcher of watchers) watcher.close();
  clearTimeout(debounce);
  await Promise.all([...children].map(stop));
  if (session) await rm(session, { recursive: true, force: true });
}
