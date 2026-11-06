import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
import { createApp } from "../../dist/node/server/app.js";

const execute = promisify(execFile),
  cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  text: string,
  access?: { publicOrigin?: string; cloudflareAccess?: boolean },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-entry-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  await writeFile(file, text);
  const app = await createApp({
    access,
    configStore: new FileConfigStore({ path: file }),
    token: "test-token",
    envKey: "",
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  return { app, address, file };
}
it("serves the built page; CLI and HTTP share the exact public result without private fields", async () => {
  const { app, address, file } = await setup(
    JSON.stringify({
      archive_path: "/合成/轨迹",
      google_api_key: "fixture-secret",
      custom: "private-extra",
    }),
  );
  const page = await fetch(`${address}/map`).then((r) => r.text());
  expect(page).toContain("test-token");
  expect(page).not.toContain("fixture-secret");
  const response = await fetch(`${address}/api/config`, {
    headers: { "X-Tracktool-Token": "test-token" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(JSON.stringify(body)).not.toMatch(/fixture-secret|private-extra/);
  await app.close(); // CLI must work without a live server.
  const cli = await execute(
    process.execPath,
    [
      "dist/node/cli/main.js",
      "--dry-run",
      "config",
      "show",
      "--public",
      "--config",
      file,
    ],
    { env: { ...process.env, TRACKTOOL_GOOGLE_API_KEY: "" } },
  );
  expect(cli.stderr).toBe("");
  expect(JSON.parse(cli.stdout)).toEqual(body.data);
  const raw = await execute(process.execPath, [
    "dist/node/cli/main.js",
    "config",
    "show",
    "--config",
    file,
  ]);
  expect(JSON.parse(raw.stdout).google_api_key).toBe("fixture-secret");
});
it("guards token, Host and Origin using the actual listening interface", async () => {
  const { address } = await setup("{}");
  for (const headers of [
    {},
    { "X-Tracktool-Token": "wrong" },
    { "X-Tracktool-Token": "test-token", Host: "attacker.example" },
    { "X-Tracktool-Token": "test-token", Origin: "http://attacker.example" },
  ]) {
    // Node's fetch can rewrite Host; use the HTTP transport to exercise the wire header.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(`${address}/api/config`, { headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(status).toBe(403);
  }
  expect(
    (
      await fetch(`${address}/api/config`, {
        headers: { "X-Tracktool-Token": "test-token", Origin: address },
      })
    ).status,
  ).toBe(200);
});
it("accepts only the configured HTTPS origin behind a tunnel and preserves local rendering", async () => {
  const { address } = await setup("{}", {
    publicOrigin: "https://tracks.example.test",
    cloudflareAccess: true,
  });
  const wire = (route: string, headers: Record<string, string>) =>
    new Promise<{ status: number | undefined; text: string }>(
      (resolve, reject) => {
        get(`${address}${route}`, { headers }, (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, text }),
          );
        }).on("error", reject);
      },
    );
  const headers = {
    Host: "tracks.example.test",
    "X-Tracktool-Token": "test-token",
  };
  expect(
    (
      await wire("/api/config", {
        ...headers,
        Origin: "https://tracks.example.test",
      })
    ).status,
  ).toBe(200);
  expect((await wire("/map", headers)).text).toContain(
    'name="tracktool-logout"',
  );
  expect((await wire("/map", {})).text).not.toContain(
    'name="tracktool-logout"',
  );
  expect((await wire("/render", {})).text).toContain("test-token");
  const rejected: Record<string, string>[] = [
    { Origin: "http://tracks.example.test" },
    { Origin: "https://attacker.example" },
    { Origin: address },
    { Host: "attacker.example", "X-Forwarded-Host": "tracks.example.test" },
    { "X-Tracktool-Token": "wrong" },
  ];
  for (const extra of rejected)
    expect((await wire("/api/config", { ...headers, ...extra })).status).toBe(
      403,
    );
  expect(
    (
      await wire("/api/config", {
        "X-Tracktool-Token": "test-token",
        Origin: "https://tracks.example.test",
        "X-Forwarded-Host": "tracks.example.test",
        "X-Forwarded-Proto": "https",
      })
    ).status,
  ).toBe(403);
});
it("returns the same sanitized configuration error and exit code through both entrypoints", async () => {
  const { address, file } = await setup('{"secret": broken}');
  const response = await fetch(`${address}/api/config`, {
    headers: { "X-Tracktool-Token": "test-token" },
  });
  expect(response.status).toBe(400);
  const body = await response.json();
  try {
    await execute(process.execPath, [
      "dist/node/cli/main.js",
      "config",
      "show",
      "--public",
      "--config",
      file,
    ]);
    throw new Error("expected failure");
  } catch (error) {
    const e = error as { code: number; stderr: string; stdout: string };
    expect(e.code).toBe(1);
    expect(e.stdout).toBe("");
    expect(JSON.parse(e.stderr)).toEqual(body);
  }
  expect(JSON.stringify(body)).not.toContain("secret");
});
it("provides real command help and the autocomplete plugin", async () => {
  const help = await execute(process.execPath, [
    "dist/node/cli/main.js",
    "config",
    "show",
    "--help",
  ]);
  expect(help.stdout).toContain("--public");
  const completion = await execute(process.execPath, [
    "dist/node/cli/main.js",
    "autocomplete",
    "--help",
  ]);
  expect(completion.stdout).toContain("autocomplete");
});
