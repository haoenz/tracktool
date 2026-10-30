import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "out-dir": { type: "string" } } });
const output = resolve(values["out-dir"] ?? "dist");
if (
  output !== resolve("dist") &&
  output !== resolve(".dev") &&
  !output.startsWith(`${resolve(".dev")}${sep}`)
)
  throw new Error("构建目录必须是 dist 或 .dev 下的目录");

let child: ChildProcess | undefined;
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true;
    process.exitCode = 130;
    child?.kill("SIGTERM");
  });

for (const args of [
  ["scripts/build-maps.ts", "--out-dir", output, "--clean"],
  [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.build.json",
    "--outDir",
    resolve(output, "node"),
    ...(output === resolve("dist")
      ? ["--tsBuildInfoFile", resolve(output, "node", ".tsbuildinfo")]
      : ["--incremental", "false"]),
    "--noEmitOnError",
  ],
  // Vite only strips types; type-check the browser source before shipping it.
  // Minimal development roots without a web config are skipped.
  ...(existsSync("tsconfig.web.json")
    ? [
        [
          "node_modules/typescript/bin/tsc",
          "-p",
          "tsconfig.web.json",
          "--noEmit",
        ],
      ]
    : []),
  [
    "node_modules/vite/bin/vite.js",
    "build",
    "--outDir",
    resolve(output, "web"),
  ],
  ["scripts/build-maps.ts", "--out-dir", output],
]) {
  if (stopped) break;
  const code = await new Promise<number>((done) => {
    child = spawn(process.execPath, args, { stdio: "inherit" });
    child.once("error", (error) => {
      process.stderr.write(`无法启动构建：${error.message}\n`);
      done(1);
    });
    child.once("exit", (code) => done(code ?? 1));
  });
  child = undefined;
  if (code !== 0) {
    process.exitCode = stopped ? 130 : code;
    break;
  }
}
