/** Same synthetic capacity samples and unchanged M3 budgets; no Python needed. */
import { open, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
const [mode, directory, sample] = process.argv.slice(2);
if (mode === "--child") {
  const bytes = await readFile(path.join(directory, sample));
  const worker = new XmlWorkers(1, 0),
    start = performance.now();
  try {
    const result = await worker.run(bytes, { kind: "tracks", source: sample });
    if (result.coordinateNodes !== 2_000_000) throw new Error("Lost points");
    console.log(
      JSON.stringify({
        sample,
        bytes: bytes.length,
        points: result.coordinateNodes,
        cold_seconds: (performance.now() - start) / 1000,
        peak_rss_kib: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await worker.close();
  }
} else {
  const dest = path.resolve(mode || "sandbox/release-performance");
  await mkdir(dest, { recursive: true });
  const header =
      '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>capacity</name><Placemark><gx:Track>',
    tail = "</gx:Track></Placemark></Document></kml>";
  const block = "<gx:coord>104 30 0</gx:coord>".repeat(10000);
  const samples = ["points-2m.kml", "bytes-128m.kml"];
  for (const name of samples) {
    const file = await open(path.join(dest, name), "w");
    try {
      await file.writeFile(header);
      for (let i = 0; i < 200; i++) await file.write(block);
      if (name === "bytes-128m.kml") {
        let remaining =
          128 * 1024 * 1024 -
          Buffer.byteLength(header + tail) -
          Buffer.byteLength(block) * 200;
        while (remaining) {
          let n = Math.min(1024 * 1024, remaining);
          if (remaining - n > 0 && remaining - n < 7) n -= 7;
          await file.write("<!--" + "x".repeat(n - 7) + "-->");
          remaining -= n;
        }
      }
      await file.write(tail);
    } finally {
      await file.close();
    }
  }
  const rows = [];
  for (const name of samples)
    for (let i = 0; i < 3; i++) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--child", dest, name],
        { encoding: "utf8", timeout: 120000 },
      );
      if (child.error || child.status !== 0)
        throw child.error ?? new Error(child.stderr);
      rows.push(JSON.parse(child.stdout));
    }
  const baseline = JSON.parse(
    await readFile(new URL("./budgets.json", import.meta.url), "utf8"),
  );
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const checks = samples.map((sample) => {
    const data = rows.filter((r) => r.sample === sample),
      cold = median(data.map((r) => r.cold_seconds)),
      peak = Math.max(...data.map((r) => r.peak_rss_kib));
    const budget = baseline.samples[sample];
    return {
      sample,
      cold_median_seconds: cold,
      peak_rss_kib: peak,
      passed: cold <= budget.cold_seconds && peak <= budget.peak_rss_kib,
    };
  });
  const result = {
    node: process.version,
    platform: process.platform,
    rows,
    checks,
    passed: checks.every((r) => r.passed),
  };
  await writeFile(
    path.join(dest, "capacity.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
