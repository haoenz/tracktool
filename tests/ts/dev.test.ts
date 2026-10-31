import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("缺少端口");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tracktool-dev-test-"));
  const put = async (file: string, content: string) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  };
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  await put("package.json", '{"type":"module"}');
  await put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["src/server/**/*.ts"],
    }),
  );
  await put(
    "tsconfig.build.json",
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { rootDir: "src", outDir: "dist/node" },
    }),
  );
  await put("src/server/version.ts", 'export const version: string = "one";');
  await put(
    "src/server/main.ts",
    `
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { version } from "./version.js";
if (version === "crash") throw new Error("Synthetic startup failure");
const { values } = parseArgs({ options: {
  host: { type: "string" }, port: { type: "string" }, "no-browser": { type: "boolean" },
}});
const token = process.env.TRACKTOOL_DEV_TOKEN!;
const server = createServer(async (req, res) => {
  if (req.url === "/api/version") {
    const allowed = req.headers["x-tracktool-token"] === token && req.headers.host === values.host + ":" + values.port && (!req.headers.origin || req.headers.origin === "http://" + req.headers.host);
    res.writeHead(allowed ? 200 : 403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version, pid: process.pid }));
  } else {
    const file = req.url === "/static/vendor/probe.txt" ? "static/vendor/probe.txt" : req.url === "/render" ? "render.html" : "index.html";
    res.end((await readFile(new URL("../../web/" + file, import.meta.url), "utf8")).replace("__TRACKTOOL_TOKEN__", token));
  }
});
server.listen(Number(values.port), values.host);
for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => server.close());
`,
  );
  await put(
    "src/web/index.html",
    '<html><head><meta name="tracktool-token" content="__TRACKTOOL_TOKEN__" /></head><body><script type="module" src="/main.ts"></script></body></html>',
  );
  await put("src/web/main.ts", 'document.title = "fixture";');
  await put(
    "src/web/render.html",
    '<html><body>render fixture<script type="module" src="/render.ts"></script></body></html>',
  );
  await put("src/web/render.ts", 'document.title = "render fixture";');
  await put("src/web/map.css", "body { margin: 0; }");
  await put("src/drawing/probe.ts", "export const probe = 1;");
  await put("resources/maps/data/assets.json", "{}");
  await put("resources/maps/static/vendor/probe.txt", "isolated resource");
  await mkdir(join(root, "scripts"));
  for (const file of [
    "scripts/build.ts",
    "scripts/build-maps.ts",
    "scripts/dev.ts",
    "vite.config.ts",
  ])
    await copyFile(file, join(root, file));
  return { root, put };
}

it("isolates development builds, preserves the last good backend, recovers crashes and cleans up", async () => {
  const { root, put } = await fixture();
  const port = await freePort();
  let backendPort = await freePort();
  while (backendPort === port) backendPort = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      "scripts/dev.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--backend-port",
      String(backendPort),
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  const until = async (check: () => Promise<boolean>, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(50);
    }
    throw new Error(`等待开发服务超时：\n${output}`);
  };
  const request = (path: string, token?: string) =>
    fetch(url + path, {
      headers: token ? { "x-tracktool-token": token } : {},
      signal: AbortSignal.timeout(2000),
    });
  try {
    await until(async () => {
      try {
        return (await request("/")).ok;
      } catch {
        return false;
      }
    });
    const html = await (await request("/")).text();
    const token = html.match(/name="tracktool-token" content="([^"]+)"/)?.[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const version = async () => {
      const response = await request("/api/version", token);
      return response.ok
        ? ((await response.json()) as { version: string; pid: number })
        : undefined;
    };
    const first = (await version())!;
    expect(first.version).toBe("one");
    expect((await request("/api/version", "wrong")).status).toBe(403);
    expect(await (await request("/static/vendor/probe.txt")).text()).toBe(
      "isolated resource",
    );
    expect(await (await request("/render")).text()).toContain("render fixture");
    expect(await readdir(root)).not.toContain("dist");

    // A normal clean build must not touch any resource the live dev server uses.
    await put("dist/node/stale.js", "stale");
    const build = spawn(process.execPath, ["scripts/build.ts"], {
      cwd: root,
      stdio: "ignore",
    });
    const built = new Promise<number | null>((done) =>
      build.once("exit", done),
    );
    while (build.exitCode === null) {
      expect(await version()).toEqual(first);
      expect((await request("/")).status).toBe(200);
      expect(await (await request("/static/vendor/probe.txt")).text()).toBe(
        "isolated resource",
      );
      await delay(50);
    }
    expect(await built).toBe(0);
    expect(await readdir(join(root, "dist/node"))).not.toContain("stale.js");

    await put("src/server/version.ts", "export const version: string = 123;");
    await until(async () => output.includes("开发构建失败"));
    expect(await version()).toEqual(first);
    await put("src/server/version.ts", 'export const version: string = "two";');
    await until(async () => (await version())?.version === "two");
    expect(await (await request("/")).text()).toContain(`content="${token}"`);

    // A successful compile can still fail at startup; restore the prior snapshot.
    await put(
      "src/server/version.ts",
      'export const version: string = "crash";',
    );
    await until(async () => output.includes("正在恢复上一次成功的构建"));
    await until(async () => (await version())?.version === "two");
    await until(async () => output.includes("继续使用上一次成功的开发构建"));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const previous = (await version())!;
      process.kill(previous.pid, "SIGKILL");
      await until(async () => output.includes(`正在重新启动（${attempt}/3）`));
      expect((await request("/")).status).toBe(200);
      const unavailable = await request("/api/version", token);
      expect(unavailable.status).toBe(503);
      expect((await unavailable.json()).error.message).toContain(
        "开发后台暂时不可用",
      );
      await until(async () => {
        const next = await version();
        return !!next && next.pid !== previous.pid && next.version === "two";
      });
    }
    const last = (await version())!;
    process.kill(last.pid, "SIGKILL");
    await delay(1800);
    expect((await request("/api/version", token)).status).toBe(503);
    await put(
      "src/server/version.ts",
      'export const version: string = "three";',
    );
    await until(async () => (await version())?.version === "three");

    // Plain UI edits are handled by Vite without restarting the backend.
    const stable = await version();
    await put("src/web/main.ts", 'document.title = "updated fixture";');
    await delay(500);
    expect(await version()).toEqual(stable);

    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(await readdir(join(root, ".dev"))).toEqual([]);
    await expect(request("/")).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${backendPort}/`)).rejects.toThrow();
  } finally {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 6000);
    await exited;
    clearTimeout(force);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

it("serves trusted HTTPS with default certificates and proxies HTTPS origins to the HTTP backend", async () => {
  const { root } = await fixture();
  const data = join(root, "data");
  const certificates = join(data, "tracktool-tls");
  await mkdir(certificates, { recursive: true });
  // These public test credentials never use the developer's CA or private key.
  const cert = await readFile("tests/ts/fixtures/https/test-cert.pem");
  await writeFile(join(certificates, "tracktool.pem"), cert);
  await copyFile(
    "tests/ts/fixtures/https/test-key.pem",
    join(certificates, "tracktool-key.pem"),
  );
  const port = await freePort();
  let backendPort = await freePort();
  while (backendPort === port) backendPort = await freePort();
  const child = spawn(
    process.execPath,
    [
      "scripts/dev.ts",
      "--ssl",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--backend-port",
      String(backendPort),
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_DATA_HOME: data,
        NO_PROXY: "127.0.0.1,localhost",
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  const url = `https://127.0.0.1:${port}`;
  const request = (path: string, token?: string) =>
    new Promise<{ status: number; text: string }>((done, reject) => {
      const req = httpsRequest(
        url + path,
        {
          ca: cert,
          method: token ? "POST" : "GET",
          headers: token ? { "x-tracktool-token": token, origin: url } : {},
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("error", reject);
          response.on("end", () =>
            done({ status: response.statusCode!, text }),
          );
        },
      );
      req.setTimeout(2000, () => req.destroy(new Error("HTTPS 请求超时")));
      req.on("error", reject);
      req.end();
    });
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await request("/")).status;
          } catch {
            return 0;
          }
        },
        { timeout: 30000, message: "HTTPS 开发服务应正常启动" },
      )
      .toBe(200);
    const html = (await request("/")).text;
    const token = html.match(/name="tracktool-token" content="([^"]+)"/)?.[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const response = await request("/api/version", token);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).version).toBe("one");
    expect((await request("/api/version", "wrong")).status).toBe(403);
    expect((await request("/static/vendor/probe.txt")).text).toBe(
      "isolated resource",
    );
    expect((await request("/render")).text).toContain("render fixture");
    expect(
      (await request(`/@fs/${certificates}/tracktool-key.pem`)).status,
    ).toBe(403);
    expect((await fetch(`http://127.0.0.1:${backendPort}/`)).status).toBe(200);
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(await readdir(join(root, ".dev"))).toEqual([]);
  } catch (error) {
    throw new Error(`HTTPS 开发服务验证失败：\n${output}`, { cause: error });
  } finally {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 6000);
    await exited;
    clearTimeout(force);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

it.each([
  { args: ["--ssl-cert", "missing.pem"], message: "必须同时提供" },
  { args: ["--ssl"], message: "无法读取 HTTPS 证书或私钥" },
  {
    args: ["--ssl-cert", "invalid.pem", "--ssl-key", "invalid.pem"],
    message: "HTTPS 证书或私钥无效",
  },
])(
  "rejects invalid HTTPS configuration before building: $message",
  async ({ args, message }) => {
    const root = await mkdtemp(join(tmpdir(), "tracktool-dev-invalid-"));
    await writeFile(join(root, "invalid.pem"), "invalid test certificate");
    try {
      const child = spawn(
        process.execPath,
        [resolve("scripts/dev.ts"), ...args],
        {
          cwd: root,
          env: { ...process.env, XDG_DATA_HOME: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      expect(await new Promise((done) => child.once("exit", done))).toBe(1);
      expect(output).toContain(message);
      expect(output).not.toContain("正在构建");
      expect(await readdir(root)).not.toContain(".dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
