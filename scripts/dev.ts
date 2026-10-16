import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const backend = spawn(
  process.execPath,
  [
    "--watch",
    "--watch-preserve-output",
    "dist/node/server/main.js",
    "--host",
    "127.0.0.1",
    "--port",
    "8766",
    "--no-browser",
  ],
  { stdio: "inherit" },
);

function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
}

let vite: ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (vite) stop(vite);
    stop(backend);
  });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (backend.exitCode !== null)
      throw new Error(`后台进程提前退出，退出码 ${backend.exitCode}`);
    try {
      const response = await fetch("http://127.0.0.1:8766/");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The backend is still starting.
    }
    await delay(100);
  }
  if (!ready) throw new Error("等待后台启动超时");

  vite = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "0.0.0.0",
      "--port",
      "8765",
      "--strictPort",
    ],
    { stdio: "inherit" },
  );
  const code = await new Promise<number>((resolve) => {
    vite!.once("exit", (exitCode) => resolve(exitCode ?? 1));
    backend.once("exit", (exitCode) => {
      stop(vite!);
      resolve(exitCode ?? 1);
    });
  });
  process.exitCode = code;
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (vite) stop(vite);
  stop(backend);
}
