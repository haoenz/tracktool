import { digest } from "../../dist/node/infrastructure/durable-files.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import {
  ExifMetadata,
  resolveRawTags,
} from "../../dist/node/infrastructure/metadata.js";
import {
  LocalMediaFiles,
  runProcess,
} from "../../dist/node/infrastructure/media-files.js";
import { MediaService } from "../../dist/node/services/media-service.js";
import type { MetadataBackend } from "../../dist/node/services/media-ports.js";
import type { Metadata } from "../../dist/node/domain/media-time.js";
import {
  formatWall,
  resolveVideoTime,
  parseMediaTime,
  parseTimeDiff,
} from "../../dist/node/domain/media-time.js";
import { coordinate, gpsTags } from "../../dist/node/domain/media.js";
import { TAGS as T } from "../../dist/node/domain/tags.js";
import { timestamp } from "../../dist/node/domain/trackdata.js";
import { createContext } from "../../dist/node/services/context.js";
import { DEFAULTS } from "../../dist/node/domain/config.js";
import { GoogleElevation } from "../../dist/node/infrastructure/elevation.js";
import { GoogleGeocode } from "../../dist/node/infrastructure/geocode.js";
import { ArchiveClient } from "../../dist/node/infrastructure/archive/client.js";
import { ArchiveWriter } from "../../dist/node/infrastructure/archive/writer.js";
import { FileConfigStore } from "../../dist/node/infrastructure/config-store.js";
import oracles from "./fixtures/m5/time.json";
const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(path.join(os.tmpdir(), "tracktool-m5-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
const signal = new AbortController().signal;
const ctx = (mode: "plan" | "apply" = "apply") =>
  createContext({ config: DEFAULTS, mode });
class MemoryBackend implements MetadataBackend {
  values = new Map<string, Metadata>();
  writes: string[] = [];
  reads: string[] = [];
  async read(file: string, tags: readonly string[]) {
    this.reads.push(file);
    const values = this.values.get(file) ?? {};
    return Object.fromEntries(
      tags.filter((t) => values[t] !== undefined).map((t) => [t, values[t]!]),
    );
  }
  async write(file: string, tags: Metadata) {
    this.writes.push(file);
    this.values.set(file, { ...this.values.get(file), ...tags });
  }
  async shift(file: string, tags: readonly string[], seconds: number) {
    const values = this.values.get(file) ?? {};
    for (const tag of tags)
      if (values[tag]) {
        const time = resolveVideoTime(
          { [T.QUICKTIME_CREATE_DATE]: values[tag]! },
          "+00:00",
        );
        values[tag] = formatWall(time.wall + BigInt(seconds) * 1_000_000n);
      }
    this.writes.push(file);
    this.values.set(file, values);
  }
}
function service(backend: MetadataBackend = new MemoryBackend()) {
  return new MediaService(
    backend,
    new LocalMediaFiles(),
    new GoogleElevation(),
    new GoogleGeocode(),
    { nearest: async () => undefined },
  );
}
async function image(file: string) {
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#336699" },
  })
    .jpeg()
    .toFile(file);
}
async function video(file: string) {
  await runProcess(
    "ffmpeg",
    [
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
      file,
    ],
    signal,
  );
}
it("matches all 117 Python video timezone oracle cases with exact microseconds", () => {
  expect(oracles).toHaveLength(117);
  for (const test of oracles) {
    const run = () =>
      resolveVideoTime(
        test.tags as unknown as Metadata,
        test.offset,
        test.policy,
      );
    if (test.error) expect(run, JSON.stringify(test)).toThrow();
    else {
      const result = run();
      expect(
        {
          source: result.source,
          instant: String(result.instant),
          wall: formatWall(result.wall, "-"),
          offset: result.offset.replace(":", ""),
        },
        JSON.stringify(test),
      ).toEqual(test.expected);
    }
  }
});
it("parses photo fallback, corrected XMP, UTC headers, zero coordinates and DMS", () => {
  expect(
    parseMediaTime({
      [T.CAPTURE_TIME]: "bad",
      [T.XMP_CAPTURE_TIME]: "2024:05:01 12:00:00.123456+08:00",
      [T.H264_CAPTURE_TIME]: "2024:05:01 12:00:00Z",
    })?.instant,
  ).toBe(timestamp("2024-05-01T04:00:00.123456Z"));
  expect(coordinate("0, 0")).toEqual([0, 0]);
  expect(coordinate("31° 30' 0\" 北 121° 15' 0\" 东")).toEqual([31.5, 121.25]);
  expect(() => parseTimeDiff("1h garbage")).toThrow();
  expect(parseTimeDiff("-1d2h3m4s")).toBe(-93784);
});
it("resolves raw group families and signed Composite values without guessing ambiguous tags", () => {
  expect(
    resolveRawTags(
      {
        "Composite:GPSAltitude": -3,
        "GPS:GPSAltitude": 3,
        "Track1:CreateDate": "one",
        "Track2:CreateDate": "two",
        "Track1:MediaCreateDate": "raw",
      },
      ["GPSAltitude", "CreateDate", "Track:MediaCreateDate"],
    ),
  ).toEqual({ GPSAltitude: "-3", "Track:MediaCreateDate": "raw" });
});
for (const kind of ["memory", "real"] as const)
  it(`shares metadata read/write/shift contract: ${kind}`, async () => {
    const file = path.join(tmp(), "中文 photo.jpg");
    await image(file);
    const backend = kind === "real" ? new ExifMetadata() : new MemoryBackend();
    try {
      expect(
        await backend.read(file, [T.CAPTURE_TIME, T.IPTC_CITY], signal),
      ).toEqual({});
      await backend.write(
        file,
        { [T.IPTC_CITY]: "杭州", [T.CAPTURE_TIME]: "2024:05:01 00:30:00" },
        true,
        signal,
      );
      await backend.shift(file, [T.CAPTURE_TIME], -7200, true, signal);
      expect(
        await backend.read(file, [T.CAPTURE_TIME, T.IPTC_CITY], signal),
      ).toEqual({
        [T.CAPTURE_TIME]: "2024:04:30 22:30:00",
        [T.IPTC_CITY]: "杭州",
      });
      await backend.write(
        file,
        { [T.XMP_CAPTURE_TIME]: "2024:05:01 12:00:00.123456+08:00" },
        true,
        signal,
      );
      expect(
        (await backend.read(file, [T.XMP_CAPTURE_TIME], signal))[
          T.XMP_CAPTURE_TIME
        ],
      ).toBe("2024:05:01 12:00:00.123456+08:00");
    } finally {
      if (backend instanceof ExifMetadata) await backend.close();
    }
  });
it("real ExifTool retains the first backup, reads southern/western GPS and negative altitude", async () => {
  const file = path.join(tmp(), "first.jpg");
  await image(file);
  const original = readFileSync(file),
    backend = new ExifMetadata();
  try {
    await backend.write(file, gpsTags([-31, -121], -12), false, signal);
    expect(readFileSync(file + "_original")).toEqual(original);
    await backend.write(file, { [T.IPTC_CITY]: "南京" }, false, signal);
    expect(readFileSync(file + "_original")).toEqual(original);
    expect(await backend.read(file, T.ALTITUDE_TAGS, signal)).toEqual({
      GPSLatitude: "-31",
      GPSLongitude: "-121",
      GPSAltitude: "-12",
    });
  } finally {
    await backend.close();
  }
});
it("real MOV remux and MP4 timezone rewrite are repeatable and retain first original", async () => {
  const dir = tmp(),
    file = path.join(dir, "中文.mov");
  await video(file);
  const backend = new ExifMetadata(),
    s = service(backend);
  try {
    const first = await s.convert(ctx(), file);
    expect(first.exitCode, JSON.stringify(first.items)).toBe(0);
    const output = path.join(dir, "中文.mp4");
    expect(existsSync(file)).toBe(true);
    const tags = await backend.read(output, T.VIDEO_TIME_TAGS, signal);
    expect(tags[T.XMP_CAPTURE_TIME]).toBe("2024:05:01 12:00:00+08:00");
    expect(tags[T.QUICKTIME_CREATE_DATE]).toBe("2024:05:01 04:00:00");
    const bytes = readFileSync(output);
    expect((await s.convert(ctx(), output)).exitCode).toBe(3);
    expect(readFileSync(output)).toEqual(bytes);
    expect((await s.convert(ctx(), output, { policy: "keep" })).exitCode).toBe(
      0,
    );
    expect(readFileSync(output + "_original")).toEqual(bytes);
    expect((await s.convert(ctx(), output, { policy: "keep" })).exitCode).toBe(
      0,
    );
    expect(readFileSync(output + "_original")).toEqual(bytes);
  } finally {
    await backend.close();
  }
}, 30000);
it.each(["file", "directory", "symlink"])(
  "blocks occupied rename %s before changing metadata",
  async (kind) => {
    const dir = tmp(),
      file = path.join(dir, "VID_20240501_120000_00.mp4"),
      output = path.join(dir, "VID_20240501_130000_00.mp4");
    writeFileSync(file, "original");
    if (kind === "file") writeFileSync(output, "occupied");
    else if (kind === "directory") mkdirSync(output);
    else symlinkSync(path.join(dir, "missing"), output);
    const backend = new MemoryBackend();
    backend.values.set(file, { Make: T.MAKE_INSTA360 });
    const result = await service(backend).shiftTime(ctx(), file, "1h");
    expect(result.exitCode).toBe(3);
    expect(backend.writes).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("original");
  },
);
it.each([false, true])(
  "rejects rename chains but completes independent file (parallel=%s)",
  async (parallel) => {
    const dir = tmp(),
      backend = new MemoryBackend(),
      files = ["120000", "130000", "160000"].map((t) =>
        path.join(dir, `VID_20240501_${t}_00.mp4`),
      );
    for (const file of files) {
      writeFileSync(file, "video");
      backend.values.set(file, { Make: T.MAKE_INSTA360 });
    }
    const result = await service(backend).shiftTime(
      ctx(),
      files,
      "1h",
      undefined,
      { parallel, overwrite: true },
    );
    expect(result.items.map((i) => i.status)).toEqual([
      "failed",
      "failed",
      "succeeded",
    ]);
    expect(backend.writes).toEqual([files[2]]);
    expect(existsSync(path.join(dir, "VID_20240501_170000_00.mp4"))).toBe(true);
  },
);
it("dry-run makes no writes, no paid lookups and no failure directories", async () => {
  const dir = tmp(),
    file = path.join(dir, "a.jpg");
  writeFileSync(file, "image");
  const backend = new MemoryBackend();
  backend.values.set(file, { GPSLatitude: "0", GPSLongitude: "0" });
  const s = service(backend),
    spy = vi.spyOn(s.elevation, "get");
  expect(
    (await s.fillAltitude(ctx("plan"), file, "", { failedFolder: "Failed" }))
      .exitCode,
  ).toBe(0);
  expect(spy).not.toHaveBeenCalled();
  expect(backend.writes).toEqual([]);
  expect(readdirSync(dir)).toEqual(["a.jpg"]);
});
it("batch elevation pads missing values, isolates failures and quarantines only failed inputs", async () => {
  const dir = tmp(),
    files = ["a.jpg", "b.jpg", "c.jpg"].map((n) => path.join(dir, n)),
    backend = new MemoryBackend();
  for (const file of files) {
    writeFileSync(file, "image");
    backend.values.set(file, { GPSLatitude: "0", GPSLongitude: "0" });
  }
  const s = service(backend);
  vi.spyOn(s.elevation, "get").mockResolvedValue([20, null]);
  const result = await s.fillAltitude(ctx(), dir, "key", {
    parallel: true,
    failedFolder: "Failed",
  });
  expect(result.items.map((i) => i.status)).toEqual([
    "succeeded",
    "failed",
    "failed",
  ]);
  expect(backend.writes).toEqual([files[0]]);
  expect(readdirSync(path.join(dir, "Failed"))).toEqual(["b.jpg", "c.jpg"]);
});
it("API-wide elevation failure preserves inputs instead of quarantining an entire batch", async () => {
  const dir = tmp(),
    file = path.join(dir, "a.jpg");
  writeFileSync(file, "image");
  const backend = new MemoryBackend();
  backend.values.set(file, { GPSLatitude: "0", GPSLongitude: "0" });
  const s = service(backend);
  vi.spyOn(s.elevation, "get").mockRejectedValue(new Error("quota"));
  await expect(
    s.fillAltitude(ctx(), dir, "key", { failedFolder: "Failed" }),
  ).rejects.toThrow("quota");
  expect(readdirSync(dir)).toEqual(["a.jpg"]);
});
it("repair-video preflight leaves VID untouched when a timezone decision is pending", async () => {
  const dir = tmp(),
    vid = path.join(dir, "VID");
  mkdirSync(vid);
  const file = path.join(vid, "a.mp4");
  writeFileSync(file, "original");
  const backend = new MemoryBackend();
  backend.values.set(file, { [T.XMP_CAPTURE_TIME]: "2024:05:01 12:00:00Z" });
  expect(
    (await service(backend).repairVideo(ctx(), dir, "unused", "")).exitCode,
  ).toBe(3);
  expect(readdirSync(dir)).toEqual(["VID"]);
  expect(backend.writes).toEqual([]);
});
it("failed ffmpeg leaves source and first backup intact, removing staging output", async () => {
  const dir = tmp(),
    file = path.join(dir, "a.mp4");
  writeFileSync(file, "bad video");
  writeFileSync(file + "_original", "first backup");
  const files = new LocalMediaFiles();
  await expect(
    files.apply(
      {
        kind: "remux",
        file,
        output: file,
        mp4: true,
        quicktime: false,
        utc: "2024-05-01T00:00:00Z",
      },
      signal,
    ),
  ).rejects.toThrow("ffmpeg");
  expect(readFileSync(file, "utf8")).toBe("bad video");
  expect(readFileSync(file + "_original", "utf8")).toBe("first backup");
  expect(readdirSync(dir)).toEqual(["a.mp4", "a.mp4_original"]);
});
it("cancels an external process and reports timeout separately", async () => {
  const abort = new AbortController();
  const work = runProcess(
    process.execPath,
    ["-e", "setTimeout(()=>{},60000)"],
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  await expect(work).rejects.toMatchObject({ code: "CANCELLED" });
  await expect(
    runProcess(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)"],
      signal,
      50,
    ),
  ).rejects.toMatchObject({ code: "TOOL" });
});
it("geocode chooses locality across all results, retries transport errors and hides API secrets", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("secret"))
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "OK",
          results: [
            {
              address_components: [
                {
                  types: ["administrative_area_level_2"],
                  long_name: "fallback",
                },
              ],
            },
            {
              address_components: [
                { types: ["locality"], long_name: "City" },
                { types: ["country"], long_name: "Country", short_name: "CC" },
              ],
            },
          ],
        }),
      ),
    );
  const client = new GoogleGeocode(request, async () => {});
  expect(await client.get([0, 0], "secret", "en", signal)).toEqual({
    city: "City",
    country: "Country",
    country_code_iso: "CC",
    state: "",
  });
  expect(request).toHaveBeenCalledTimes(2);
  await expect(
    new GoogleGeocode(
      async () =>
        new Response(
          JSON.stringify({ status: "REQUEST_DENIED", error_message: "secret" }),
        ),
    ).get([0, 0], "secret", "en", signal),
  ).rejects.toThrow(/^Google geocoding API: REQUEST_DENIED$/);
});
it("config set validates tag ownership, persists Unicode atomically and previews without files", async () => {
  const file = path.join(tmp(), "config.json"),
    store = new FileConfigStore({ path: file });
  await store.set("track_tag.Train", "+散步", true);
  expect(existsSync(file)).toBe(false);
  const value = await store.set("track_tag.Train", "+散步");
  expect(value["track_tag.Default"]).not.toContain("散步");
  expect(value["track_tag.Train"]).toContain("散步");
  await store.set("archive_history", "off");
  expect((await store.load()).archive_history).toBe(false);
  await expect(store.set("unknown", "x")).rejects.toThrow();
  expect(JSON.parse(readFileSync(file, "utf8"))["track_tag.Train"]).toContain(
    "散步",
  );
});
it("archive geotag reads exact timestamp arrays and skips broken candidates", async () => {
  const dir = tmp(),
    writer = new ArchiveWriter();
  await writer.init(dir);
  const database = path.join(dir, "archive.sqlite3");
  const kml = Buffer.from(
    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track><when>2024-05-01T04:00:00.123456Z</when><when>2024-05-01T04:00:10.123456Z</when><gx:coord>121 31 12</gx:coord><gx:coord>122 32 13</gx:coord></gx:Track></Placemark></Document></kml>',
  );
  const file = path.join(dir, "2024-05-01 test.kml");
  writeFileSync(file, kml);
  await writer.execute({
    kind: "push",
    database,
    entries: [
      {
        source: file,
        category: "Default",
        member: "Default/2024-05/" + path.basename(file),
        sha256: digest(kml),
      },
    ],
    move: false,
    backup: path.join(dir, "Backup"),
  });
  const client = new ArchiveClient();
  try {
    const match = await client.nearest(
      database,
      resolveVideoTime({
        [T.QUICKTIME_CREATE_DATE]: "2024:05:01 12:00:05.123456",
      }),
      false,
      60,
      signal,
    );
    expect(match).toMatchObject({
      latitude: 32,
      longitude: 122,
      altitude: 13,
      seconds: 5,
      inside: true,
    });
    expect(
      await client.nearest(
        database,
        resolveVideoTime({ [T.QUICKTIME_CREATE_DATE]: "2024:05:02 12:00:05" }),
        false,
        60,
        signal,
      ),
    ).toBeUndefined();
  } finally {
    await client.close();
  }
});
it("real repair-video can resume from VID_original and skip already converted outputs", async () => {
  const dir = tmp(),
    source = path.join(dir, "VID_original");
  mkdirSync(source);
  const file = path.join(source, "a.mov");
  await video(file);
  const backend = new ExifMetadata(),
    s = service(backend);
  try {
    // Keep the repair step local: conversion and workflow use the real filesystem/tools.
    const repair = vi
      .spyOn(s, "repair")
      .mockResolvedValue({ items: [], plans: [], exitCode: 0 });
    const first = await s.repairVideo(ctx(), dir, "unused", "", {
      policy: "keep",
    });
    expect(first.exitCode, JSON.stringify(first.items)).toBe(0);
    const output = path.join(dir, "VID", "a.mp4"),
      bytes = readFileSync(output);
    const second = await s.repairVideo(ctx(), dir, "unused", "", {
      policy: "keep",
    });
    expect(second.exitCode).toBe(0);
    expect(second.items[0]?.status).toBe("skipped");
    expect(readFileSync(output)).toEqual(bytes);
    expect(existsSync(file)).toBe(true);
    expect(repair).toHaveBeenCalledTimes(2);
  } finally {
    await backend.close();
  }
});
it("repair routes altitude-only and GPS-missing media to separate branches", async () => {
  const dir = tmp(),
    a = path.join(dir, "alt.jpg"),
    b = path.join(dir, "gps.jpg"),
    backend = new MemoryBackend();
  for (const file of [a, b]) writeFileSync(file, "image");
  backend.values.set(a, {
    GPSPosition: "0 0",
    GPSLatitude: "0",
    GPSLongitude: "0",
  });
  backend.values.set(b, { [T.CAPTURE_TIME]: "2024:05:01 12:00:00" });
  const s = service(backend);
  vi.spyOn(s.elevation, "get").mockResolvedValue([42]);
  vi.spyOn(s.tracks, "nearest").mockResolvedValue({
    latitude: 31,
    longitude: 121,
    altitude: 20,
    seconds: 0,
    inside: true,
    name: "track",
    time: 0n,
  });
  expect((await s.repair(ctx(), dir, "database", "key")).exitCode).toBe(0);
  expect(existsSync(path.join(dir, "GoogleAltOK", "alt.jpg"))).toBe(true);
  expect(backend.values.get(b)?.GPSLongitude).toBe("121");
});
it("persists legacy config only on apply, preserving source on preview", async () => {
  const d = tmp(),
    legacy = path.join(d, "legacy.json"),
    target = path.join(d, "new", "config.json");
  writeFileSync(
    legacy,
    JSON.stringify({ kml_zip_path: path.join(d, "Archive.zip") }),
  );
  const store = new FileConfigStore({
    legacyPath: legacy,
    environment: {
      platform: process.platform,
      home: d,
      cwd: d,
      env: { XDG_CONFIG_HOME: path.join(d, "new") },
    },
  });
  const value = await store.load();
  expect(value.archive_path).toBe(d);
  expect(existsSync(store.path)).toBe(false);
  expect(existsSync(legacy)).toBe(true);
  await store.load({ persistMigration: true });
  expect(existsSync(store.path)).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  expect(JSON.parse(readFileSync(store.path, "utf8"))).not.toHaveProperty(
    "kml_zip_path",
  );
  expect(existsSync(target)).toBe(false);
});
it("verification mismatch leaves a file in place even with a failed-folder option", async () => {
  const d = tmp(),
    file = path.join(d, "a.jpg");
  writeFileSync(file, "image");
  const backend = new MemoryBackend();
  backend.values.set(file, {
    [T.CAPTURE_TIME]: "2024:05:01 12:00:00",
    GPSLatitude: "0",
    GPSLongitude: "0",
    GPSAltitude: "10",
  });
  const s = service(backend);
  vi.spyOn(s.tracks, "nearest").mockResolvedValue({
    latitude: 31,
    longitude: 121,
    altitude: 20,
    seconds: 0,
    inside: true,
    name: "track",
    time: 0n,
  });
  const result = await s.geotag(ctx(), file, "database", {
    verify: true,
    failedFolder: "Failed",
  });
  expect(result.exitCode).toBe(3);
  expect(readdirSync(d)).toEqual(["a.jpg"]);
  expect(backend.writes).toEqual([]);
});
it("real ExifTool cancellation releases workers and permits a subsequent read", async () => {
  const file = path.join(tmp(), "a.jpg");
  await image(file);
  const backend = new ExifMetadata(),
    abort = new AbortController();
  try {
    const pending = backend.read(file, [T.MAKE], abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await backend.read(file, [T.MAKE], signal)).toEqual({});
  } finally {
    await backend.close();
  }
});
it("group drops byte-identical copies, keeps different occupied targets and previews without directories", async () => {
  const d = tmp(),
    a = path.join(d, "a.jpg"),
    b = path.join(d, "b.mov");
  writeFileSync(a, "image");
  writeFileSync(b, "video");
  const s = service();
  await s.group(ctx("plan"), d);
  expect(readdirSync(d)).toEqual(["a.jpg", "b.mov"]);
  mkdirSync(path.join(d, "IMG"));
  writeFileSync(path.join(d, "IMG", "a.jpg"), "image");
  mkdirSync(path.join(d, "VID"));
  writeFileSync(path.join(d, "VID", "b.mov"), "different");
  const result = await s.group(ctx(), d);
  expect(result.exitCode).toBe(0);
  expect(existsSync(a)).toBe(false);
  expect(readFileSync(b, "utf8")).toBe("video");
  expect(readFileSync(path.join(d, "VID", "b.mov"), "utf8")).toBe("different");
});
it.each(["directory", "symlink"])(
  "protects occupied first-backup %s before metadata writes",
  async (kind) => {
    const d = tmp(),
      file = path.join(d, "a.jpg"),
      backup = file + "_original";
    writeFileSync(file, "image");
    if (kind === "directory") mkdirSync(backup);
    else symlinkSync(path.join(d, "missing"), backup);
    const backend = new MemoryBackend();
    const result = await service(backend).set(ctx(), file, {
      [T.IPTC_CITY]: "City",
    });
    expect(result.exitCode).toBe(3);
    expect(backend.writes).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("image");
  },
);
