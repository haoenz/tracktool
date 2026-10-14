/** Installed-production verification. Run from the source checkout with a fresh consumer directory. */
import {
  copyFile,
  writeFile,
  mkdir,
  symlink,
  readFile,
  readdir,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
const consumer = path.resolve(process.argv[2]),
  evidenceDir = path.resolve(process.argv[3] || "sandbox/release-check"),
  root = path.join(consumer, "node_modules/tracktool");
await mkdir(evidenceDir, { recursive: true });
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const originalEnv = { ...process.env },
  isolated = path.join(consumer, "node-runtime-bin");
if (process.platform !== "win32") {
  await mkdir(isolated, { recursive: true });
  for (const name of ["node", "perl", "ffmpeg", "ldd", "grep", "sed"]) {
    const target =
      name === "node"
        ? process.execPath
        : spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
    if (!target) continue;
    try {
      await symlink(target, path.join(isolated, name));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  process.env.PATH = isolated;
}
const pythonAbsent = ["python", "python3", "uv"].every(
  (command) => spawnSync(command, ["--version"]).error?.code === "ENOENT",
);
if (process.platform !== "win32")
  assert.ok(pythonAbsent, "Python must be absent from isolated runtime PATH");
process.env.XDG_CONFIG_HOME = path.join(consumer, "isolated-config");
delete process.env.TRACKTOOL_EXIFTOOL;
const cli = path.join(root, "dist/node/cli/main.js"),
  config = path.join(consumer, "config.json");
await writeFile(config, "{}");
function run(...args) {
  if (!["data", "setup"].includes(args[0]) && !args.includes("--config"))
    args.unshift("--config", config);
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: consumer,
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}
const timings = {};
async function timed(name, action) {
  const start = performance.now();
  const result = await action();
  timings[name] = (performance.now() - start) / 1000;
  return result;
}
for (const entry of ["cli", "server"]) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, `dist/node/${entry}/main.js`), "--help"],
    { encoding: "utf8", cwd: consumer },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout);
}
run("setup", "chromium", "--dry-run");
const archive = path.join(consumer, "map-archive.sqlite3");
await copyFile("tests/ts/fixtures/maps/archive.sqlite3", archive);
const { createApp } = await import(
    pathToFileURL(path.join(root, "dist/node/server/app.js"))
  ),
  { FileConfigStore } = await import(
    pathToFileURL(path.join(root, "dist/node/infrastructure/config-store.js"))
  ),
  { MapResources } = await import(
    pathToFileURL(path.join(root, "dist/node/infrastructure/maps/resources.js"))
  );
const assets = JSON.parse(
  await readFile(path.join(root, "dist/maps/data/assets.json"), "utf8"),
);
for (const [file, info] of Object.entries(assets.files))
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(root, "dist/maps", file)))
      .digest("hex"),
    info.sha256,
    file,
  );
const tile = Buffer.from([26, 9, 10, 5, 119, 97, 116, 101, 114, 120, 2]);
const resources = new MapResources(path.join(consumer, "cache"), {
  env: {},
  fetch: async (url) =>
    url === "https://tiles.openfreemap.org/planet"
      ? Buffer.from(
          JSON.stringify({
            tiles: ["https://offline.test/{z}/{x}/{y}.pbf"],
            vector_layers: [
              { id: "water", fields: {} },
              { id: "transportation", fields: { class: "String" } },
              { id: "landcover", fields: {} },
            ],
          }),
        )
      : tile,
});
const app = await createApp({
  token: "package-test-token",
  configStore: new FileConfigStore({ path: config }),
  maps: { initialArchive: archive, resources: () => resources },
  work: { stateDir: path.join(consumer, "state"), roots: [consumer], archive },
});
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
const api = async (url, body) => {
  const response = await fetch(origin + url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Tracktool-Token": "package-test-token",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
};
let report, png;
try {
  for (const route of [
    "/map",
    "/archive",
    "/tracks",
    "/media",
    "/tasks",
    "/settings",
  ])
    assert.equal((await fetch(origin + route)).status, 200);
  const { state } = await (await api("/api/bootstrap")).json();
  const selected = await timed("cold_selection", async () =>
    (
      await api("/api/selection", { archive, entries: ["Train/same.kml"] })
    ).json(),
  );
  assert.equal(selected.errors.length, 0);
  await timed("cached_selection", () =>
    api("/api/selection", { archive, entries: ["Train/same.kml"] }),
  );
  state.archive = archive;
  state.title = "独立安装验收";
  state.tracks = selected.tracks.map((t) => ({
    entry: t.entry,
    sha256: t.sha256,
  }));
  await api("/api/projects/save", { name: "release-project", state });
  const loaded = await (
    await api("/api/projects/load", { archive, name: "release-project" })
  ).json();
  assert.equal(loaded.state.title, state.title);
  await timed("independent_png", async () => {
    const { job } = await (await api("/api/export", state)).json();
    for (let i = 0; i < 180; i++) {
      report = await (await api(`/api/jobs/${job}`)).json();
      if (report.status === "failed") throw new Error(report.error);
      if (report.status === "done") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(report.status, "done");
    png = Buffer.from(await (await api(`/api/jobs/${job}/png`)).arrayBuffer());
    await writeFile(path.join(evidenceDir, "map.png"), png);
    assert.deepEqual(
      [png.readUInt32BE(16), png.readUInt32BE(20)],
      [1920, 1440],
    );
  });
} finally {
  await app.close();
}
const dataArchive = path.join(consumer, "tracks"),
  source = path.join(consumer, "2026-10-01 轨迹.kml");
await copyFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml", source);
const original = await readFile(source);
run("archive", "init", dataArchive);
run("config", "set", "archive_path", dataArchive, "--config", config);
await timed("push", async () => run("kml", "push", source, "--config", config));
run("archive", "backup", "--config", config);
run("archive", "rebuild", "--config", config);
run("kml", "pop", path.basename(source), "--config", config);
assert.deepEqual(await readFile(source), original);
const recovered = path.join(consumer, "restored");
run("archive", "import-zip", path.join(dataArchive, "Archive.zip"), recovered);
assert.ok(JSON.parse(run("data", "entries", recovered)).entries.length);
const publicApi = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import {openArchive} from 'tracktool';const a=openArchive(${JSON.stringify(recovered)});try{const es=await a.listEntries();if(!es.length)throw Error('Empty');const r=await a.readTrackData(es[0].entry);if(!r.data.tracks.length)throw Error('No data');console.log(r.sha256);}finally{await a.close();}`,
  ],
  { cwd: consumer, encoding: "utf8" },
);
assert.equal(publicApi.status, 0, publicApi.stderr);
const photo = path.join(consumer, "照片.jpg");
await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
  .jpeg()
  .toFile(photo);
run(
  "exif",
  "set",
  photo,
  "--make",
  "SONY",
  "-t",
  "IPTC:City=杭州",
  "-t",
  "ExifIFD:DateTimeOriginal=2024:05:01 00:30:00",
  "--config",
  config,
);
const backup = await readFile(photo + "_original");
run("exif", "shift-time", photo, "--by", "-1h", "--config", config);
assert.deepEqual(await readFile(photo + "_original"), backup);
assert.ok(
  run("exif", "info", photo, "--config", config).includes(
    "2024-04-30T23:30:00+08:00",
  ),
);
const video = path.join(consumer, "clip.mov");
const make = spawnSync(process.env.TRACKTOOL_FFMPEG || "ffmpeg", [
  "-nostdin",
  "-n",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=16x16:r=1",
  "-t",
  "1",
  "-c:v",
  "mpeg4",
  "-metadata",
  "creation_time=2024-05-01T12:00:00Z",
  video,
]);
assert.equal(make.status, 0, String(make.stderr));
run("exif", "to-mp4", video, "--config", config);
run(
  "exif",
  "to-mp4",
  path.join(consumer, "clip.mp4"),
  "--timezone-policy",
  "keep",
  "--config",
  config,
);
const listing = await readdir(root);
assert.ok(!listing.includes("tracktool"));
assert.ok(!listing.includes("pyproject.toml"));
assert.ok(!listing.includes("uv.lock"));
const result = {
  package: `tracktool@${manifest.version}`,
  node: process.version,
  platform: process.platform,
  python_on_path: !pythonAbsent,
  production_resources_verified: true,
  public_api: true,
  archive_zip_recovery: true,
  original_bytes: true,
  media_first_backup: true,
  real_ffmpeg: true,
  png_dimensions: [1920, 1440],
  png_bytes: png.length,
  chromium: report.report.chromium,
  timings_seconds: timings,
  peak_rss_kib: process.resourceUsage().maxRSS,
};
await writeFile(
  path.join(evidenceDir, "package.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
process.env.PATH = originalEnv.PATH;
