import { openAsBlob, openSync, writeSync, closeSync, fsyncSync } from "node:fs";
import {
  BlobReader,
  ZipReader,
  ZipWriter,
  Uint8ArrayReader,
  registerCodec,
  type FileEntry,
  type DecompressionStreamOptions,
} from "@zip.js/zip.js";
import { createZstdDecompress } from "node:zlib";
import { Duplex } from "node:stream";
import { AppError } from "../../domain/errors.js";
import { memberName } from "../../domain/archive.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
// Python 3.14 ZIP_ZSTANDARD archives use 93 (early archives used 20).
class ZstdStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  constructor() {
    const pair = Duplex.toWeb(createZstdDecompress());
    this.readable = pair.readable as unknown as ReadableStream<Uint8Array>;
    this.writable = pair.writable;
  }
}
for (const compressionMethod of [20, 93])
  registerCodec({
    compressionMethod,
    format: "zstd",
    DecompressionStream: ZstdStream,
  });
// Optional codecs are loaded only when a historical ZIP actually uses them.
let bzip2: Promise<import("@foxglove/wasm-bz2")> | undefined;
class LegacyStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: string, options: DecompressionStreamOptions = {}) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    super({
      transform(chunk) {
        length += chunk.length;
        if (length > MAX_KML_BYTES * 2)
          throw new Error("Compressed member exceeds limit");
        chunks.push(chunk);
      },
      async flush(controller) {
        const size = options.uncompressedSize;
        if (size === undefined || size > MAX_KML_BYTES)
          throw new Error("Invalid uncompressed size");
        const data = Buffer.concat(chunks);
        if (format === "bzip2") {
          const { default: Bzip2 } = await import("@foxglove/wasm-bz2");
          controller.enqueue(
            (await (bzip2 ??= Bzip2.init())).decompress(
              data,
              Math.max(1, size),
            ),
          );
        } else {
          // ZIP method 14: version[2], property length[2], properties[5], raw LZMA1.
          if (
            data.length < 9 ||
            data.readUInt16LE(2) !== 5 ||
            data.readUInt32LE(5) > MAX_KML_BYTES
          )
            throw new Error("Invalid LZMA properties");
          const header = Buffer.alloc(13);
          data.copy(header, 0, 4, 9);
          header.writeBigUInt64LE(BigInt(size), 5);
          const { lzma } = await import("@napi-rs/lzma");
          controller.enqueue(
            await lzma.decompress(Buffer.concat([header, data.subarray(9)])),
          );
        }
      },
    });
  }
}
registerCodec({
  compressionMethod: 12,
  format: "bzip2",
  DecompressionStream: LegacyStream,
});
registerCodec({
  compressionMethod: 14,
  format: "lzma",
  DecompressionStream: LegacyStream,
});
export async function readZip(
  file: string,
  consume: (name: string, raw: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const reader = new ZipReader(new BlobReader(await openAsBlob(file)), {
    useWebWorkers: false,
    checkSignature: true,
    filenameValidation: "strict",
  });
  try {
    const names = new Set<string>();
    for await (const entry of reader.getEntriesGenerator()) {
      const name = entry.filename;
      memberName(entry.directory ? name.replace(/\/$/, "") : name);
      if (
        names.has(name) ||
        entry.rawFilename.includes(0) ||
        ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
      )
        throw new AppError(
          "USER_INPUT",
          `Duplicate or unsafe ZIP member: ${name}`,
        );
      names.add(name);
      if (entry.uncompressedSize > MAX_KML_BYTES)
        throw new AppError("USER_INPUT", `ZIP member exceeds 128 MiB: ${name}`);
      // Bound actual output as well as declared size; CRC is checked even for directory entries.
      const chunks: Uint8Array[] = [];
      let size = 0;
      await (entry as FileEntry).getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            size += chunk.length;
            if (size > MAX_KML_BYTES)
              throw new AppError("USER_INPUT", "ZIP member exceeds 128 MiB");
            chunks.push(chunk);
          },
        }),
        { checkSignature: true },
      );
      if (entry.directory) continue;
      if (!name.toLowerCase().endsWith(".kml"))
        throw new AppError("USER_INPUT", `Non-KML ZIP member: ${name}`);
      await consume(name, Buffer.concat(chunks));
    }
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError(
      "USER_INPUT",
      `ZIP validation failed: ${cause instanceof Error ? cause.message : "invalid archive"}`,
      { cause },
    );
  } finally {
    await reader.close();
  }
}
export async function writeZip(
  file: string,
  entries: Iterable<{ path: string; raw: Uint8Array }>,
): Promise<void> {
  const fd = openSync(file, "wx", 0o600);
  try {
    const writer = new ZipWriter(
      new WritableStream<Uint8Array>({
        write(chunk) {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
        },
      }),
      { useWebWorkers: false, level: 6 },
    );
    for (const entry of entries)
      await writer.add(entry.path, new Uint8ArrayReader(entry.raw));
    await writer.close();
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
