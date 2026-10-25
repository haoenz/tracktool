export const EXPORT_FORMATS = ["zip-deflate", "zip-zstd", "tar-xz"] as const;
export const COMPRESSION_PRESETS = ["store", "normal", "extreme"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type CompressionPreset = (typeof COMPRESSION_PRESETS)[number];
export interface ExportOptions {
  format?: ExportFormat;
  compression?: CompressionPreset;
}

export const EXPORT_FORMAT_OPTIONS = [
  { value: "zip-deflate", label: "ZIP · Deflate" },
  { value: "zip-zstd", label: "ZIP · Zstd" },
  { value: "tar-xz", label: "TAR · XZ" },
] satisfies { value: ExportFormat; label: string }[];
export const COMPRESSION_OPTIONS = [
  { value: "store", label: "仅打包" },
  { value: "normal", label: "正常" },
  { value: "extreme", label: "极致压缩" },
] satisfies { value: CompressionPreset; label: string }[];

// Missing fields belong to older requests; only new UI/CLI requests default to extreme.
export function exportEncoding(options: ExportOptions = {}) {
  const format = options.format ?? "zip-deflate";
  const compression = options.compression ?? "normal";
  const tar = format === "tar-xz";
  const codec =
    compression === "store"
      ? "store"
      : tar
        ? "xz"
        : format === "zip-zstd"
          ? "zstd"
          : "deflate";
  const extension = tar ? (codec === "store" ? ".tar" : ".tar.xz") : ".zip";
  return {
    format,
    compression,
    codec,
    extension,
    filename: `Archive${extension}`,
    contentType: tar
      ? codec === "store"
        ? "application/x-tar"
        : "application/x-xz"
      : "application/zip",
    level:
      codec === "store"
        ? 0
        : codec === "zstd"
          ? compression === "extreme"
            ? 22
            : 3
          : compression === "extreme"
            ? 9
            : 6,
  } as const;
}
export const EXPORT_FILENAMES = [
  "Archive.zip",
  "Archive.tar",
  "Archive.tar.xz",
];
