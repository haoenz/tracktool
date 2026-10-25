import { createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { Transform, Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pack, extract } from "tar-stream";
import { AppError, checkCancelled } from "../../domain/errors.js";
import { memberName } from "../../domain/archive.js";
import { MAX_KML_BYTES } from "../../domain/trackdata.js";
import {
  exportEncoding,
  type ExportOptions,
} from "../../shared/export-format.js";
import { syncFile } from "../durable-files.js";
import { readZip, writeZip } from "./zip.js";

type Member = { path: string; raw: Uint8Array };
type Consumer = (name: string, raw: Uint8Array) => void | Promise<void>;

async function throughXz(
  input: Readable,
  output: Writable,
  args: string[],
  signal?: AbortSignal,
) {
  checkCancelled(signal);
  // Ignore user presets so the advertised profile is reproducible and never silently downgraded.
  const child = spawn("xz", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XZ_DEFAULTS: "", XZ_OPT: "" },
  });
  let spawnError: Error | undefined;
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const abort = () => {
    child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const streams = [
    pipeline(input, child.stdin, { signal }),
    pipeline(child.stdout, output, { signal }),
  ];
  try {
    const [, , code] = await Promise.all([...streams, closed]);
    checkCancelled(signal);
    if (spawnError || code !== 0)
      throw new AppError(
        "TOOL",
        spawnError
          ? "无法启动 XZ，请安装系统 xz 工具后重试"
          : `XZ 执行失败：${stderr.trim() || code}`,
        { cause: spawnError },
      );
  } catch (cause) {
    abort();
    input.destroy();
    output.destroy();
    await Promise.allSettled(streams);
    await closed;
    checkCancelled(signal);
    if (cause instanceof AppError) throw cause;
    throw new AppError(
      "TOOL",
      spawnError
        ? "无法启动 XZ，请安装系统 xz 工具后重试"
        : `XZ 数据处理失败${stderr.trim() ? `：${stderr.trim()}` : ""}`,
      { cause: spawnError ?? cause },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function writePackedExport(
  file: string,
  entries: Iterable<Member>,
  options: ExportOptions = {},
  signal?: AbortSignal,
) {
  checkCancelled(signal);
  const encoding = exportEncoding(options);
  if (encoding.format !== "tar-xz")
    return writeZip(file, entries, options, signal);
  const archive = pack();
  const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
  const transfer =
    encoding.codec === "store"
      ? pipeline(archive, output, { signal })
      : throughXz(
          Readable.from(archive),
          output,
          [
            encoding.compression === "extreme" ? "-9e" : "-6",
            "--threads=1",
            "--no-adjust",
            "--stdout",
          ],
          signal,
        );
  const populate = (async () => {
    for (const entry of entries) {
      checkCancelled(signal);
      memberName(entry.path);
      await new Promise<void>((resolve, reject) => {
        archive.entry(
          {
            name: entry.path,
            size: entry.raw.length,
            type: "file",
            mode: 0o600,
            mtime: new Date(0),
          },
          Buffer.from(entry.raw),
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
    archive.finalize();
  })();
  try {
    await Promise.all([transfer, populate]);
    checkCancelled(signal);
    syncFile(file);
  } catch (cause) {
    archive.destroy();
    output.destroy();
    await Promise.allSettled([transfer, populate]);
    checkCancelled(signal);
    if (cause instanceof AppError) throw cause;
    throw new AppError("TOOL", "压缩包写入失败", { cause });
  }
}

export async function readPackedExport(
  file: string,
  consume: Consumer,
  options: ExportOptions = {},
  signal?: AbortSignal,
) {
  checkCancelled(signal);
  const encoding = exportEncoding(options);
  if (encoding.format !== "tar-xz") return readZip(file, consume, signal);
  const archive = extract();
  const input = createReadStream(file);
  let length = 0;
  let tail = Buffer.alloc(0);
  // tar-stream tolerates missing end markers; exports must have two complete zero blocks.
  const framing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      tail = Buffer.concat([tail, chunk]).subarray(-1024);
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        length < 1024 || length % 512 !== 0 || tail.some((byte) => byte !== 0)
          ? new AppError("USER_INPUT", "TAR 文件不完整或结束标记无效")
          : null,
      );
    },
  });
  const transfer =
    encoding.codec === "store"
      ? pipeline(input, framing, { signal })
      : throughXz(
          input,
          framing,
          ["--decompress", "--stdout", "--memlimit-decompress=256MiB"],
          signal,
        );
  const parsing = pipeline(framing, archive, { signal });
  const consumeEntries = (async () => {
    const names = new Set<string>();
    for await (const entry of archive) {
      checkCancelled(signal);
      const { name, type, size } = entry.header;
      memberName(name);
      if (
        type !== "file" ||
        names.has(name) ||
        !name.toLowerCase().endsWith(".kml")
      )
        throw new AppError(
          "USER_INPUT",
          `TAR 成员不是普通 KML 文件或路径重复：${name}`,
        );
      if (size === undefined || size < 0 || size > MAX_KML_BYTES)
        throw new AppError(
          "USER_INPUT",
          `TAR 成员大小无效或超过 128 MiB：${name}`,
        );
      names.add(name);
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const value of entry) {
        const chunk = value as Buffer;
        bytes += chunk.length;
        if (bytes > MAX_KML_BYTES)
          throw new AppError("USER_INPUT", "TAR 成员超过 128 MiB");
        chunks.push(chunk);
      }
      if (bytes !== size)
        throw new AppError("USER_INPUT", `TAR 成员不完整：${name}`);
      await consume(name, Buffer.concat(chunks));
    }
  })();
  try {
    await Promise.all([transfer, parsing, consumeEntries]);
  } catch (cause) {
    input.destroy();
    framing.destroy();
    archive.destroy();
    await Promise.allSettled([transfer, parsing, consumeEntries]);
    checkCancelled(signal);
    if (cause instanceof AppError) throw cause;
    throw new AppError("USER_INPUT", "TAR 压缩包校验失败", { cause });
  }
}
