import { mkdtemp, copyFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ArchiveClient } from "../../dist/node/infrastructure/archive/client.js";
const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-lifecycle-")),
  archive = path.join(dir, "archive.sqlite3");
await copyFile("tests/ts/fixtures/maps/archive.sqlite3", archive);
const db = new Database(archive);
db.pragma("foreign_keys=ON");
const rows = [];
for (let i = 0; i < 25; i++) {
  const raw = Buffer.from(
      `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>${i}</name><Placemark><gx:Track>${"<gx:coord>104 30 0</gx:coord>".repeat(100_000)}</gx:Track></Placemark></Document></kml>`,
    ),
    digest = createHash("sha256").update(raw).digest("hex"),
    entry = `Default/${i}.kml`;
  db.prepare("INSERT INTO kml_objects VALUES (?,?,?,?)").run(
    digest,
    "zlib",
    raw.length,
    deflateSync(raw),
  );
  db.prepare(
    "INSERT INTO archive_entries(id,path,sha256,category) VALUES (?,?,?,?)",
  ).run(`lifecycle-${i}`, entry, digest, "Default");
  rows.push(entry);
}
db.close();
const client = new ArchiveClient();
const server = createServer((_q, r) => r.end("pong"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let baseline = 0,
  finished = false;
const rss = [],
  latency = [];
const ping = (async () => {
  while (!finished) {
    const begin = performance.now();
    await (await fetch(origin)).text();
    latency.push(performance.now() - begin);
    await new Promise((r) => setTimeout(r, 10));
  }
})();
try {
  for (let i = 0; i < rows.length; i++) {
    {
      const result = await client.selection(archive, [rows[i]]);
      if (result.tracks[0]?.points !== 100_000) throw new Error("Lost points");
    }
    global.gc?.();
    await new Promise((r) => setTimeout(r, 25));
    const memory = process.memoryUsage().rss / 1024 / 1024;
    if (i === 4) baseline = memory;
    if (i >= 5) rss.push(memory);
  }
  finished = true;
  await ping;
  latency.sort((a, b) => a - b);
  const result = {
    node: process.version,
    iterations: 20,
    sample_points: 100_000,
    warmup_iterations: 5,
    baseline_rss_mib: baseline,
    rss_mib: rss,
    post_warmup_rss_growth_mib: Math.max(...rss) - baseline,
    idle_ping_p95_ms: latency[Math.floor(latency.length * 0.95)],
    ping_samples: latency.length,
    peak_rss_kib: process.resourceUsage().maxRSS,
    stats: await client.stats(),
  };
  result.passed =
    result.post_warmup_rss_growth_mib <= 96 && result.idle_ping_p95_ms <= 250;
  await writeFile(
    process.argv[2] || "sandbox/release-performance/lifecycle.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
} finally {
  finished = true;
  await ping;
  await client.close();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
