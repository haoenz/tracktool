/** Validate the installed track workflow and restart with Python absent from PATH. */
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import assert from "node:assert/strict";
const evidenceDir = path.resolve(process.argv[3] || "sandbox/release-check");
const consumer = path.resolve(process.argv[2]);
const bin = path.join(consumer, "runtime-bin");
await mkdir(bin, { recursive: true });
for (const [name, target] of [["node", process.execPath]]) {
  try {
    await symlink(target, path.join(bin, name));
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
const env = {
  ...process.env,
  PATH: bin,
  XDG_CONFIG_HOME: path.join(consumer, "config"),
};
for (const name of ["python", "python3", "uv"])
  assert.equal(spawnSync(name, ["--version"], { env }).error?.code, "ENOENT");
const main = path.join(
  consumer,
  "node_modules/tracktool/dist/node/server/main.js",
);
const config = path.join(consumer, "config.json");
await writeFile(
  config,
  JSON.stringify({ google_api_key: "package-private-key" }),
);
let child, address, token;
async function start() {
  child = spawn(
    process.execPath,
    [
      main,
      "--port",
      "0",
      "--config",
      config,
      "--files-root",
      consumer,
      "--state-dir",
      path.join(consumer, "state"),
      "--no-browser",
    ],
    { env, cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stderr.on("data", (b) => {
    errors += b;
  });
  address = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Server timeout: " + errors)),
      15000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}: ${errors}`));
    });
    child.stdout.on("data", (b) => {
      output += b;
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
  });
  const html = await (await fetch(address + "/map")).text();
  token = html.match(/name="tracktool-token" content="([^"]+)"/)?.[1];
  assert.ok(token, html);
  for (const route of ["/map?panel=library", "/map?panel=settings"])
    assert.equal((await fetch(address + route)).status, 200);
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(address + asset)).status, 200);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    await ended;
  } finally {
    clearTimeout(timeout);
  }
}
async function api(route, body) {
  const r = await fetch(address + "/api/work" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-tracktool-token": token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function done(id) {
  for (let i = 0; i < 200; i++) {
    const t = await api("/tasks/" + id);
    if (!["queued", "running"].includes(t.status)) {
      assert.equal(t.status, "succeeded", JSON.stringify(t));
      return t;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Task timeout");
}
try {
  await start();
  const kml = Buffer.from(
    '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>网页轨迹</name><Placemark><LineString><coordinates>120,30,10 120.01,30.01,20</coordinates></LineString></Placemark></Document></kml>',
  );
  const uploadResponse = await fetch(
    address + "/api/work/uploads?name=" + encodeURIComponent("网页轨迹.kml"),
    {
      method: "POST",
      headers: {
        "x-tracktool-token": token,
        "content-type": "application/octet-stream",
      },
      body: kml,
    },
  );
  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json();
  const preview = await done(
    (
      await api("/preview", {
        operation: "kml:set-tag",
        inputs: uploaded.files,
        options: { tag: "骑行", create: true },
      })
    ).id,
  );
  const result = await done(
    (await api("/tasks/" + preview.id + "/apply", {})).id,
  );
  assert.ok(!JSON.stringify(result).includes("package-private-key"));
  const response = await fetch(
    address + "/api/work/tasks/" + result.id + "/download?index=0",
    { headers: { "x-tracktool-token": token } },
  );
  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength > kml.byteLength);
  await stop();
  await start();
  assert.equal((await api("/tasks/" + result.id)).status, "succeeded");
  assert.equal((await api("/uploads")).uploads.length, 1);
  await api("/uploads/" + uploaded.id + "/cleanup", {});
  assert.equal((await api("/uploads")).uploads.length, 0);
  const version = JSON.parse(
    await readFile(
      path.join(consumer, "node_modules/tracktool/package.json"),
      "utf8",
    ),
  ).version;
  const evidence = {
    package: "tracktool@" + version,
    node: process.version,
    python_on_path: false,
    production_spa: true,
    uploaded_track_preview_apply_download: true,
    persisted_after_process_restart: true,
    upload_cleanup: true,
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, "web-package.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  await stop();
}
