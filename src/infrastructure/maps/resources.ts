import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";
import { AppError, checkCancelled } from "../../domain/errors.js";
import { MAP_LABEL_FONTS } from "../../shared/map-label.js";
import type { MapConfig, MapPreset } from "../../shared/map.js";
import { Downloads } from "./downloads.js";
import {
  rasterReprojectionVersion,
  reprojectGcjTile,
} from "./raster-reprojection.js";
import { TileCache } from "./tile-cache.js";
import { Transport } from "./transport.js";
import { labelVectorTile, vectorLabelVersion } from "./vector-labels.js";
type Preset = MapPreset & { url: string; invalid_tile_sha256?: string[] };
type Vector = {
  tiles: string[];
  vector_layers: { id: string; fields?: Record<string, string> }[];
  maxzoom?: number;
};
type Assets = {
  maplibre: string;
  gcoord: string;
  font: string;
  files: Record<string, { sha256: string }>;
  renderer_sha256: string;
};
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const credit = "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors";
export function tileUrl(
  source: { url: string },
  z: number,
  x: number,
  y: number,
): string {
  let quadkey = "";
  for (let i = z - 1; i >= 0; i--)
    quadkey += String(((x >> i) & 1) + 2 * ((y >> i) & 1));
  const inverted = 2 ** z - 1 - y;
  const values: Record<string, string | number> = {
    x,
    y,
    z,
    quadkey,
    galileo: "Galileo".slice(0, (3 * x + y) % 8),
    y_tms: inverted,
    x16: Math.floor(x / 16),
    y_tms16: Math.floor(inverted / 16),
  };
  return source.url.replace(/\{([a-z0-9_]+)\}/g, (_, name: string) =>
    String(values[name]),
  );
}
export class MapResources {
  readonly root: string;
  readonly presets: Record<string, Preset>;
  readonly assets: Assets;
  readonly tiles: TileCache;
  readonly downloads: Downloads;
  // Separate queues avoid holding download slots while waiting for source tiles.
  private readonly reprojections = new Downloads(2, { custom: 2 });
  private vector?: Vector;
  private preparing?: Promise<void>;
  private font?: opentype.Font;
  private env: Record<string, string | undefined>;
  private fetcher: (url: string) => Promise<Buffer>;
  constructor(
    readonly cache: string,
    options: {
      root?: string;
      env?: Record<string, string | undefined>;
      fetch?: (url: string) => Promise<Buffer>;
    } = {},
  ) {
    this.root =
      options.root ?? fileURLToPath(new URL("../../../maps/", import.meta.url));
    this.env = options.env ?? process.env;
    this.presets = Object.fromEntries(
      (
        JSON.parse(
          readFileSync(path.join(this.root, "data/basemaps.json"), "utf8"),
        ) as { sources: Preset[] }
      ).sources.map((p) => [p.id, p]),
    );
    this.assets = JSON.parse(
      readFileSync(path.join(this.root, "data/assets.json"), "utf8"),
    ) as Assets;
    if (
      this.env.TRACKTOOL_MAP_TILEJSON &&
      !this.env.TRACKTOOL_MAP_VECTOR_ATTRIBUTION
    )
      throw new AppError(
        "USER_INPUT",
        "自定义矢量源需配置 TRACKTOOL_MAP_VECTOR_ATTRIBUTION 以保留实际来源署名",
      );
    const setting = (
      name: string,
      value: number,
      low: number,
      high: number,
    ) => {
      const n = Number(this.env[name] ?? value);
      if (!Number.isInteger(n) || n < low || n > high)
        throw new AppError("USER_INPUT", `${name} 需为 ${low}–${high} 的整数`);
      return n;
    };
    const workers = setting("TRACKTOOL_MAP_DOWNLOADS", 8, 1, 32),
      capacity =
        setting("TRACKTOOL_MAP_CACHE_MIB", 1024, 1, 16384) * 1024 * 1024;
    const limits: Record<string, number> = {
      google: 8,
      bing: 4,
      vector: 6,
      openrailwaymap: 2,
      openseamap: 2,
      openinframap: 2,
    };
    try {
      const configured: unknown = JSON.parse(
        this.env.TRACKTOOL_MAP_PROVIDER_LIMITS ?? "{}",
      );
      if (
        !configured ||
        typeof configured !== "object" ||
        Array.isArray(configured)
      )
        throw new Error();
      for (const [k, v] of Object.entries(configured)) {
        if (
          !Object.hasOwn(limits, k) ||
          typeof v !== "number" ||
          !Number.isInteger(v) ||
          v < 1 ||
          v > 32
        )
          throw new Error();
        limits[k] = v;
      }
    } catch {
      throw new AppError(
        "USER_INPUT",
        "TRACKTOOL_MAP_PROVIDER_LIMITS 需为已知提供方到 1–32 整数的 JSON",
      );
    }
    this.tiles = new TileCache(cache, capacity);
    this.downloads = new Downloads(workers, limits);
    const transport = new Transport();
    this.fetcher = options.fetch ?? ((url) => transport.fetch(url));
  }
  async prepare(refresh = false): Promise<void> {
    if (this.vector && !refresh) return;
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareOnce(refresh).finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }
  private async prepareOnce(refresh: boolean) {
    for (const [name, info] of Object.entries(this.assets.files))
      if (hash(await readFile(path.join(this.root, name))) !== info.sha256)
        throw new AppError("USER_INPUT", `前端或字体文件校验失败：${name}`);
    const url =
        this.env.TRACKTOOL_MAP_TILEJSON ??
        "https://tiles.openfreemap.org/planet",
      metadata = path.join(this.cache, `basemap-${hash(url)}.json`);
    let value: Vector | undefined;
    if (!refresh)
      try {
        value = JSON.parse(await readFile(metadata, "utf8")) as Vector;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AppError("USER_INPUT", "底图缓存无效，请刷新底图");
      }
    value ??= JSON.parse((await this.fetcher(url)).toString("utf8")) as Vector;
    if (
      !Array.isArray(value.tiles) ||
      !value.tiles.length ||
      !value.tiles.every(
        (u) => typeof u === "string" && u.startsWith("https:"),
      ) ||
      !Array.isArray(value.vector_layers) ||
      !["transportation", "water", "landcover"].every((id) =>
        value!.vector_layers.some((l) => l.id === id),
      )
    )
      throw new AppError(
        "USER_INPUT",
        "需要 OpenMapTiles schema；Shortbread 尚无适配器",
      );
    await this.atomic(metadata, Buffer.from(JSON.stringify(value)));
    this.vector = value;
  }
  private async atomic(file: string, data: Buffer) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, data, { flush: true });
      await rename(tmp, file);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  versions(): Record<string, unknown> {
    const templates = this.vector?.tiles ?? [];
    return {
      renderer: "tracktool-map-ts-v1",
      raster_reprojection: rasterReprojectionVersion,
      vector_labels: vectorLabelVersion,
      renderer_sha256: this.assets.renderer_sha256,
      playwright: "1.61.0",
      maplibre: this.assets.maplibre,
      gcoord: this.assets.gcoord,
      basemap_presets_sha256: hash(
        readFileSync(path.join(this.root, "data/basemaps.json")),
      ),
      font: this.assets.font,
      font_sha256:
        this.assets.files["static/vendor/NotoSansCJKsc-Regular.otf"]!.sha256,
      basemap: {
        templates: templates.map((u) => {
          const p = new URL(u);
          return p.host === "tiles.openfreemap.org" && !p.search && !p.hash
            ? u
            : "custom";
        }),
        sha256: hash(JSON.stringify(templates)),
      },
      vector_attribution: this.env.TRACKTOOL_MAP_VECTOR_ATTRIBUTION ?? credit,
    };
  }
  checkText(text: string) {
    if (!this.font) {
      const bytes = readFileSync(
        path.join(this.root, "static/vendor/NotoSansCJKsc-Regular.otf"),
      );
      this.font = opentype.parse(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    }
    const missing = [
      ...new Set(
        [...text].filter(
          (c) => !/^\s$/.test(c) && !this.font!.charToGlyphIndex(c),
        ),
      ),
    ].sort();
    if (missing.length)
      throw new AppError(
        "USER_INPUT",
        `固定字体缺少字符：${missing.slice(0, 20).join("")}；请修改标题，不能用缺字方框导出`,
      );
  }
  publicConfig(): MapConfig {
    const presets = Object.values(this.presets).map((s) => {
      const keys = [
        "id",
        "name",
        "group",
        "tile_size",
        "tile_display_size",
        "maxzoom",
        "crs",
        "imagery",
        "has_text",
        "overlay_only",
        "attribution",
        "kind",
        "format",
        "content",
        "minzoom",
        "scheme",
        "addressing",
        "coverage",
        "content_note",
      ] as const;
      return {
        ...Object.fromEntries(keys.map((k) => [k, s[k]])),
        available: true,
        category: s.category ?? "base",
      } as MapPreset;
    });
    return {
      versions: this.versions(),
      vectorMaxZoom: Math.min(14, this.vector?.maxzoom ?? 14),
      basemaps: presets.filter((s) => s.kind === "basemap"),
      overlays: presets.filter((s) => s.kind === "overlay"),
      vectorLayers: Object.fromEntries(
        (this.vector?.vector_layers ?? []).map((l) => [l.id, l.fields ?? {}]),
      ),
      attribution: credit,
      customVectorAttribution: this.env.TRACKTOOL_MAP_VECTOR_ATTRIBUTION ?? "",
      cacheTime: Math.floor(Date.now() / 1000),
    };
  }
  async glyph(
    span: string,
    signal?: AbortSignal,
    exporting = false,
    font: string = MAP_LABEL_FONTS[0],
  ): Promise<Buffer> {
    if (!MAP_LABEL_FONTS.some((allowed) => allowed === font))
      throw new AppError("USER_INPUT", "无效地图字体");
    const m = /^(\d+)-(\d+)$/.exec(span),
      start = Number(m?.[1]),
      end = Number(m?.[2]);
    if (!m || start % 256 || end !== start + 255 || start < 0 || start > 65280)
      throw new AppError("USER_INPUT", "无效字体范围");
    const url = `https://tiles.openfreemap.org/fonts/${encodeURIComponent(font)}/${span}.pbf`,
      key = hash(`glyph-v1:${url}`);
    return this.downloads.load(
      key,
      "vector",
      async () => {
        const cached = this.tiles.get(key);
        if (cached) return cached;
        const data = await this.fetcher(url);
        if (data[0] !== 10)
          throw new AppError("USER_INPUT", "地图字体返回无效数据");
        this.tiles.put(key, data);
        return data;
      },
      signal,
      exporting,
    );
  }
  /** Browsing and PNG export share label normalization and raster reprojection. */
  async displayTile(
    source: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
    exporting = false,
    crs: "wgs84" | "gcj02" = "wgs84",
  ): Promise<{ data: Buffer; mime: string }> {
    checkCancelled(signal);
    this.checkTile(source, z, x, y);
    const preset = this.presets[source];
    if (crs === "gcj02") {
      if (preset?.crs !== "gcj02" || preset.format === "vector")
        throw new AppError("USER_INPUT", "GCJ-02 画布不支持该图层");
      return this.tile(source, z, x, y, signal, exporting);
    }
    if (source === "vector") {
      const original = await this.tile(source, z, x, y, signal, exporting);
      checkCancelled(signal);
      // Keep upstream tiles intact; rule changes only invalidate derived tiles.
      const key = hash(
        JSON.stringify([vectorLabelVersion, hash(original.data)]),
      );
      const cached = this.tiles.get(key);
      if (cached !== undefined) {
        try {
          await this.validate(source, cached, false);
          return { ...original, data: cached };
        } catch {
          this.tiles.delete(key);
        }
      }
      const data = labelVectorTile(original.data);
      this.tiles.put(key, data);
      return { ...original, data };
    }
    if (preset?.crs !== "gcj02" || preset.format === "vector")
      return this.tile(source, z, x, y, signal, exporting);
    const key = hash(
      JSON.stringify([rasterReprojectionVersion, preset, z, x, y]),
    );
    const data = await this.reprojections.load(
      key,
      "custom",
      async () => {
        const hit = this.tiles.get(key);
        if (hit !== undefined) {
          try {
            await this.validate(source, hit, false);
            return hit;
          } catch {
            this.tiles.delete(key);
          }
        }
        const result = await reprojectGcjTile(
          z,
          x,
          y,
          preset.tile_size,
          async (tx, ty) =>
            (await this.tile(source, z, tx, ty, undefined, exporting)).data,
        );
        this.tiles.put(key, result);
        return result;
      },
      signal,
      exporting,
    );
    return { data, mime: "image/png" };
  }
  private checkTile(source: string, z: number, x: number, y: number) {
    const preset = this.presets[source];
    if (
      (source !== "vector" && !preset) ||
      ![z, x, y].every(Number.isInteger) ||
      z < 0 ||
      z > 18 ||
      x < 0 ||
      y < 0 ||
      x >= 2 ** z ||
      y >= 2 ** z
    )
      throw new AppError("USER_INPUT", "无效瓦片坐标");
    if (preset && (z < preset.minzoom || z > preset.maxzoom))
      throw new AppError("USER_INPUT", "地图源不支持该瓦片级别");
  }
  async tile(
    source: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
    exporting = false,
  ): Promise<{ data: Buffer; mime: string }> {
    checkCancelled(signal);
    this.checkTile(source, z, x, y);
    const preset = this.presets[source];
    const template = source === "vector" ? this.vector?.tiles[0] : undefined;
    const url = preset
      ? tileUrl(preset, z, x, y)
      : template
          ?.replace("{z}", String(z))
          .replace("{x}", String(x))
          .replace("{y}", String(y));
    if (!url) throw new AppError("USER_INPUT", "地图源尚未配置");
    const key = hash(
      JSON.stringify([
        "tile-v2",
        source,
        url,
        preset?.tile_size ?? 256,
        preset ?? (source === "vector" ? this.vector : ""),
      ]),
    );
    const cached = async () => {
      const data = this.tiles.get(key);
      if (data !== undefined) {
        try {
          await this.validate(source, data, false);
          return data;
        } catch {
          this.tiles.delete(key);
        }
      }
      return undefined;
    };
    const hit = await cached();
    const data =
      hit ??
      (await this.downloads.load(
        key,
        preset ? source.split("-")[0]! : "vector",
        async () => {
          const hit = await cached();
          if (hit !== undefined) return hit;
          const data = await this.fetcher(url);
          await this.validate(source, data);
          this.tiles.put(key, data);
          return data;
        },
        signal,
        exporting,
      ));
    return {
      data,
      mime:
        source === "vector" || preset?.format === "vector"
          ? "application/x-protobuf"
          : data[0] === 255
            ? "image/jpeg"
            : data.toString("ascii", 0, 4) === "RIFF"
              ? "image/webp"
              : "image/png",
    };
  }
  async validate(
    source: string,
    data: Buffer,
    decodeRaster = true,
  ): Promise<void> {
    const preset = this.presets[source];
    if (!data.length && source === "openinframap-power") return;
    if (!data.length) throw new AppError("USER_INPUT", "数据源返回空瓦片");
    if (preset?.invalid_tile_sha256?.includes(hash(data)))
      throw new AppError(
        "USER_INPUT",
        "地图源返回暂无地图的占位图片，不能导出；请更换底图",
      );
    if (source === "vector" || preset?.format === "vector") {
      const fields = (bytes: Buffer): [number, number | Buffer][] => {
        let i = 0;
        const result: [number, number | Buffer][] = [];
        const varint = () => {
          let n = 0;
          for (let shift = 0; shift < 70; shift += 7) {
            if (i >= bytes.length) throw new Error();
            const b = bytes[i++]!;
            n += (b & 127) * 2 ** shift;
            if (b < 128) return n;
          }
          throw new Error();
        };
        while (i < bytes.length) {
          const tag = varint(),
            wire = tag & 7;
          if (!Math.floor(tag / 8)) throw new Error();
          let value: number | Buffer;
          if (wire === 0) value = varint();
          else if ([1, 2, 5].includes(wire)) {
            const size = wire === 2 ? varint() : wire === 1 ? 8 : 4;
            if (i + size > bytes.length) throw new Error();
            value = bytes.subarray(i, i + size);
            i += size;
          } else throw new Error();
          result.push([Math.floor(tag / 8), value]);
        }
        return result;
      };
      try {
        const layers = fields(data).filter(([k]) => k === 3);
        if (!layers.length) throw new Error();
        for (const [, layer] of layers) {
          if (!Buffer.isBuffer(layer)) throw new Error();
          const values = new Map(fields(layer));
          const name = values.get(1);
          if (
            !Buffer.isBuffer(name) ||
            ![1, 2].includes(values.get(15) as number)
          )
            throw new Error();
          new TextDecoder("utf-8", { fatal: true }).decode(name);
        }
      } catch {
        throw new AppError(
          "USER_INPUT",
          "地图源返回无效矢量瓦片，请重试或更换底图",
        );
      }
      return;
    }
    try {
      const image = sharp(data, { failOn: "warning" }),
        info = await image.metadata(),
        size = preset?.tile_size ?? 256;
      if (
        !["png", "jpeg", "webp"].includes(info.format ?? "") ||
        info.width !== size ||
        info.height !== size
      )
        throw new Error();
      // Current cache hits need header/size validation, while downloads
      // must also prove the complete raster decodes.
      if (decodeRaster) await image.raw().toBuffer();
    } catch (cause) {
      throw new AppError(
        "USER_INPUT",
        "地图源返回无效图片或错误瓦片尺寸，不能导出；请更换底图",
        { cause },
      );
    }
  }
  async close() {
    await this.reprojections.close();
    await this.downloads.close();
    this.tiles.close();
  }
}
