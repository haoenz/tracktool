import { expect, it } from "vitest";
import { mkdtemp, copyFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readTrackData,
  encodeTrackData,
  openArchive,
} from "../../dist/node/api.js";
it("public API returns independent precise arrays and versioned JSON", async () => {
  const data = await readTrackData("tests/ts/fixtures/xml/complex.kml"),
    encoded = encodeTrackData(data);
  expect(encoded.schema).toBe(1);
  const times = encoded.tracks.flatMap((t) =>
    t.segments.flatMap((s) => s.time_us ?? []),
  );
  expect(times.length).toBeGreaterThan(0);
  expect(times.every((t) => /^-?\d+$/.test(t))).toBe(true);
  expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
  const again = await readTrackData("tests/ts/fixtures/xml/complex.kml");
  data.tracks[0]!.segments[0]!.longitude[0] = 0;
  expect(again.tracks[0]!.segments[0]!.longitude[0]).not.toBe(0);
});
it("archive API preserves original bytes, snapshot SHA and clean cancellation/close", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-api-"));
  await copyFile(
    "tests/ts/fixtures/maps/archive.sqlite3",
    path.join(dir, "archive.sqlite3"),
  );
  const archive = openArchive(dir);
  try {
    const entries = await archive.listEntries();
    expect(entries.length).toBeGreaterThan(0);
    const bytes = await archive.readBytes("Train/same.kml"),
      value = await archive.readTrackData("Train/same.kml");
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(value.sha256);
    expect(value.data.tracks.length).toBeGreaterThan(0);
    const abort = new AbortController();
    abort.abort();
    await expect(
      archive.readBytes("Train/same.kml", abort.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(archive.readBytes("missing.kml")).rejects.toMatchObject({
      code: "USER_INPUT",
    });
  } finally {
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("data CLI emits JSON without terminal control codes and Chromium setup supports dry-run", async () => {
  const exec = promisify(execFile),
    cli = path.resolve("dist/node/cli/main.js");
  const { stdout } = await exec(process.execPath, [
    cli,
    "data",
    "track",
    "tests/ts/fixtures/xml/complex.kml",
  ]);
  expect(JSON.parse(stdout).schema).toBe(1);
  expect(stdout).not.toContain("\u001b");
  const install = await exec(process.execPath, [
    cli,
    "setup",
    "chromium",
    "--dry-run",
  ]);
  expect(install.stdout.toLowerCase()).toContain("chromium");
  expect(
    await readFile("resources/maps/static/vendor/Noto-LICENSE.txt", "utf8"),
  ).toContain("OFL");
});
it("public API works from node --input-type=module without leaking eval flags into workers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-api-eval-"));
  await copyFile(
    "tests/ts/fixtures/maps/archive.sqlite3",
    path.join(dir, "archive.sqlite3"),
  );
  const { pathToFileURL } = await import("node:url");
  try {
    const program = `import {readTrackData,openArchive} from ${JSON.stringify(pathToFileURL(path.resolve("dist/node/api.js")).href)};const data=await readTrackData(${JSON.stringify(path.resolve("tests/ts/fixtures/xml/complex.kml"))});const a=openArchive(${JSON.stringify(dir)});try{const result=await a.readTrackData('Train/same.kml');console.log(JSON.stringify([data.name,result.data.tracks.length]));}finally{await a.close();}`;
    const result = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      program,
    ]);
    expect(JSON.parse(result.stdout)[1]).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
