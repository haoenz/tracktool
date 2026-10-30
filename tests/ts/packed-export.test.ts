import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { openAsBlob, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { pack } from "tar-stream";
import { ZipReader, BlobReader } from "@zip.js/zip.js";
import {
  checkPackedStructure,
  writePackedExport,
  readPackedExport,
} from "../../dist/node/infrastructure/archive/packed-export.js";
import {
  EXPORT_FORMATS,
  COMPRESSION_PRESETS,
  exportEncoding,
  type ExportOptions,
} from "../../dist/node/shared/export-format.js";
import { validateExport } from "../../dist/node/domain/export-format.js";
import {
  ArchiveWriter,
  addEntry,
} from "../../dist/node/infrastructure/archive/writer.js";
import { ArchiveClient } from "../../dist/node/infrastructure/archive/client.js";
import { transaction } from "../../dist/node/infrastructure/archive/database.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tracktool-packed-"));
  dirs.push(dir);
  return dir;
}
const combinations = EXPORT_FORMATS.flatMap((format) =>
  COMPRESSION_PRESETS.map((compression) => ({ format, compression })),
);
const entries = [
  {
    path: "Default/中文轨迹.kml",
    raw: Buffer.from("<kml>原始精度 120.123456789012345</kml>".repeat(100)),
  },
  { path: `Train/${"长目录/".repeat(25)}空.kml`, raw: Buffer.alloc(0) },
];

it.each(combinations)(
  "roundtrips $format / $compression, including Unicode, long paths and empty members",
  async (options) => {
    const file = path.join(await tmp(), exportEncoding(options).filename);
    await writePackedExport(file, entries, options);
    const actual: typeof entries = [];
    await readPackedExport(
      file,
      (name, raw) => {
        actual.push({ path: name, raw: Buffer.from(raw) });
      },
      options,
    );
    expect(actual).toEqual(entries);
    if (options.format !== "tar-xz") {
      const zip = new ZipReader(new BlobReader(await openAsBlob(file)));
      try {
        expect(
          (await zip.getEntries()).map((entry) => entry.compressionMethod),
        ).toEqual(
          entries.map(() =>
            options.compression === "store"
              ? 0
              : options.format === "zip-zstd"
                ? 93
                : 8,
          ),
        );
      } finally {
        await zip.close();
      }
      // Python 3.14 reads method 93 independently of zip.js.
      const out = execFileSync("python3", [
        "-c",
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; sys.stdout.buffer.write(z.read(z.namelist()[0]))",
        file,
      ]);
      expect(out).toEqual(entries[0]!.raw);
    } else {
      expect(execFileSync("tar", ["-xOf", file, entries[0]!.path])).toEqual(
        entries[0]!.raw,
      );
    }
    const empty = path.join(
      path.dirname(file),
      `empty${exportEncoding(options).extension}`,
    );
    await writePackedExport(empty, [], options);
    let count = 0;
    await readPackedExport(
      empty,
      () => {
        count++;
      },
      options,
    );
    expect(count).toBe(0);
  },
);

it("checks the ZIP container without decompressing members", async () => {
  const dir = await tmp(),
    file = path.join(dir, "export.zip"),
    entries = [
      { path: "Default/2026-10/a.kml", raw: Buffer.from("<kml>a</kml>") },
      { path: "Default/2026-10/b.kml", raw: Buffer.from("<kml>b</kml>") },
    ];
  await writePackedExport(file, entries);
  await checkPackedStructure(
    file,
    entries.map((entry) => entry.path),
  );
  await expect(
    checkPackedStructure(file, ["Default/2026-10/a.kml"]),
  ).rejects.toThrow("压缩包内容校验失败");
  const bytes = await readFile(file);
  await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await expect(
    checkPackedStructure(
      file,
      entries.map((entry) => entry.path),
    ),
  ).rejects.toThrow();
});

it("validates the resolved extension and keeps old requests on normal ZIP", () => {
  expect(exportEncoding()).toMatchObject({ codec: "deflate", level: 6 });
  expect(
    validateExport("out.tar", { format: "tar-xz", compression: "store" }).codec,
  ).toBe("store");
  expect(() =>
    validateExport("out.tar.xz", { format: "tar-xz", compression: "store" }),
  ).toThrow(".tar");
  expect(() =>
    validateExport("out.zip", {
      format: "zip-zstd",
      compression: "unknown",
    } as unknown as ExportOptions),
  ).toThrow("不支持");
});

it.each(["duplicate", "traversal", "link", "truncated", "size", "checksum"])(
  "rejects unsafe or corrupt TAR: %s",
  async (kind) => {
    const file = path.join(await tmp(), "bad.tar");
    const stream = pack();
    const writing = pipeline(stream, createWriteStream(file));
    stream.entry(
      {
        name: kind === "traversal" ? "../bad.kml" : "good.kml",
        type: kind === "link" ? "symlink" : "file",
        linkname: kind === "link" ? "outside" : undefined,
      },
      Buffer.alloc(0),
    );
    if (kind === "duplicate")
      stream.entry({ name: "good.kml" }, Buffer.alloc(0));
    stream.finalize();
    await writing;
    const bytes = await readFile(file);
    if (kind === "truncated") await writeFile(file, bytes.subarray(0, -512));
    if (kind === "checksum") {
      bytes[0] = 0xff;
      await writeFile(file, bytes);
    }
    if (kind === "size") {
      bytes.write("01000000001\0", 124, "ascii");
      bytes.fill(32, 148, 156);
      const checksum = bytes.subarray(0, 512).reduce((sum, n) => sum + n, 0);
      bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
      await writeFile(file, bytes);
    }
    await expect(
      readPackedExport(file, () => {}, {
        format: "tar-xz",
        compression: "store",
      }),
    ).rejects.toThrow();
  },
);

it("reports missing XZ, but store mode needs no executable and never overwrites an existing file", async () => {
  const dir = await tmp();
  vi.stubEnv("PATH", dir);
  const file = path.join(dir, "out.tar.xz");
  await expect(
    writePackedExport(file, entries, { format: "tar-xz" }),
  ).rejects.toThrow("安装系统 xz");
  const tar = path.join(dir, "out.tar");
  await writePackedExport(tar, entries, {
    format: "tar-xz",
    compression: "store",
  });
  const original = await readFile(tar);
  await expect(
    writePackedExport(tar, [], { format: "tar-xz", compression: "store" }),
  ).rejects.toThrow();
  expect(await readFile(tar)).toEqual(original);
});

it.each(["normal", "extreme"] as const)(
  "detects damaged XZ (%s)",
  async (compression) => {
    const file = path.join(await tmp(), "bad.tar.xz");
    const options = { format: "tar-xz", compression } as const;
    await writePackedExport(file, entries, options);
    const bytes = await readFile(file);
    await writeFile(file, bytes.subarray(0, -8));
    await expect(readPackedExport(file, () => {}, options)).rejects.toThrow();
  },
);

it("cancels an XZ export cooperatively through the archive worker and removes staging files", async () => {
  const dir = await tmp();
  const writer = new ArchiveWriter();
  await writer.init(dir);
  const database = path.join(dir, "archive.sqlite3");
  transaction(database, true, (db) =>
    addEntry(db, "large.kml", randomBytes(8 * 1024 * 1024), "Default"),
  );
  const client = new ArchiveClient();
  const controller = new AbortController();
  const output = path.join(dir, "Archive.tar.xz");
  try {
    const result = client.execute(
      {
        kind: "backup",
        database,
        output,
        exportOptions: { format: "tar-xz", compression: "extreme" },
      },
      controller.signal,
    );
    const cancelled = expect(result).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await vi.waitFor(
      async () =>
        expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(
          true,
        ),
      { timeout: 5000 },
    );
    controller.abort();
    await cancelled;
    expect(
      (await readdir(dir)).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".xz"),
      ),
    ).toEqual([]);
    expect(
      (await client.execute({ kind: "status", database })).status?.entries,
    ).toBe(1);
  } finally {
    await client.close();
  }
});
