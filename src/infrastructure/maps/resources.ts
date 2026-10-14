import { readFile, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import opentype from "opentype.js";
import { AppError } from "../../domain/errors.js";
import type { MapConfig, MapPreset, Cities } from "../../shared/map.js";
import { TileCache } from "./tile-cache.js";
import { Downloads } from "./downloads.js";
import { Transport } from "./transport.js";
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
/** Match Python json.dumps(sort_keys=True), including ASCII escaping and separators. */
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${pythonJson(k)}: ${pythonJson(v)}`)
      .join(", ")}}`;
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
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
  readonly cities: Cities;
  readonly assets: Assets;
  readonly tiles: TileCache;
  readonly downloads: Downloads;
  private vector?: Vector;
  private preparing?: Promise<void>;
  private font?: opentype.Font;
  readonly satellite: string;
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
    this.cities = JSON.parse(
      readFileSync(path.join(this.root, "data/cities-cn.json"), "utf8"),
    ) as Cities;
    if (
      this.env.TRACKTOOL_MAP_TILEJSON &&
      !this.env.TRACKTOOL_MAP_VECTOR_ATTRIBUTION
    )
      throw new AppError(
        "USER_INPUT",
        "自定义矢量源需配置 TRACKTOOL_MAP_VECTOR_ATTRIBUTION 以保留实际来源署名",
      );
    this.satellite = this.env.TRACKTOOL_MAP_SATELLITE_URL ?? "";
    if (
      this.satellite &&
      !(
        this.env.TRACKTOOL_MAP_SATELLITE_ATTRIBUTION &&
        this.env.TRACKTOOL_MAP_SATELLITE_VERSION
      )
    )
      throw new AppError(
        "USER_INPUT",
        "卫星数据源需同时配置 URL、ATTRIBUTION 和 VERSION",
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
      custom: 4,
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
    if (!value && !refresh && !this.env.TRACKTOOL_MAP_TILEJSON)
      try {
        const old = JSON.parse(
          await readFile(path.join(this.cache, "basemap.json"), "utf8"),
        ) as Vector;
        if (
          old.tiles?.every((u) => new URL(u).host === "tiles.openfreemap.org")
        )
          value = old;
      } catch {
        /* No usable legacy cache. */
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
    this.checkText(this.cities.labels.map((l) => l.name).join(""));
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
      cities_sha256: hash(
        readFileSync(path.join(this.root, "data/cities-cn.json")),
      ),
      basemap: {
        templates: templates.map((u) => {
          const p = new URL(u);
          return p.host === "tiles.openfreemap.org" && !p.search && !p.hash
            ? u
            : "custom";
        }),
        sha256: hash(JSON.stringify(templates)),
      },
      satellite: this.env.TRACKTOOL_MAP_SATELLITE_VERSION ?? "",
      satellite_sha256: this.satellite ? hash(this.satellite) : "",
      vector_attribution: this.env.TRACKTOOL_MAP_VECTOR_ATTRIBUTION ?? credit,
      satellite_attribution: this.env.TRACKTOOL_MAP_SATELLITE_ATTRIBUTION ?? "",
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
      satellite: !!this.satellite,
      basemaps: presets.filter((s) => s.kind === "basemap"),
      overlays: presets.filter((s) => s.kind === "overlay"),
      vectorLayers: Object.fromEntries(
        (this.vector?.vector_layers ?? []).map((l) => [l.id, l.fields ?? {}]),
      ),
      attribution: credit,
      customVectorAttribution: this.env.TRACKTOOL_MAP_VECTOR_ATTRIBUTION ?? "",
      satelliteAttribution: this.env.TRACKTOOL_MAP_SATELLITE_ATTRIBUTION ?? "",
      cityAttribution: "GeoNames · CC BY 4.0",
      cityCoverage: this.cities.coverage,
      cacheTime: Math.floor(Date.now() / 1000),
    };
  }
  async glyph(
    span: string,
    signal?: AbortSignal,
    exporting = false,
  ): Promise<Buffer> {
    const m = /^(\d+)-(\d+)$/.exec(span),
      start = Number(m?.[1]),
      end = Number(m?.[2]);
    if (!m || start % 256 || end !== start + 255 || start < 0 || start > 65280)
      throw new AppError("USER_INPUT", "无效字体范围");
    const url = `https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/${span}.pbf`,
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
  async tile(
    source: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
    exporting = false,
  ): Promise<{ data: Buffer; mime: string }> {
    const preset = this.presets[source];
    if (
      (!["vector", "satellite"].includes(source) && !preset) ||
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
    const template =
      source === "vector" ? this.vector?.tiles[0] : this.satellite;
    const url = preset
      ? tileUrl(preset, z, x, y)
      : template
          ?.replace("{z}", String(z))
          .replace("{x}", String(x))
          .replace("{y}", String(y));
    if (!url) throw new AppError("USER_INPUT", "地图源尚未配置");
    const key = hash(
      pythonJson([
        "tile-v2",
        source,
        url,
        preset?.tile_size ?? 256,
        preset ??
          (source === "vector"
            ? this.vector
            : (this.env.TRACKTOOL_MAP_SATELLITE_VERSION ?? "")),
      ]),
    );
    const cached = async () => {
      const data = this.tiles.get(key);
      if (data !== undefined) {
        try {
          await this.validate(source, data);
          return data;
        } catch {
          this.tiles.delete(key);
        }
      }
      const oldKey = `legacy:${hash((this.env.TRACKTOOL_MAP_SATELLITE_VERSION ?? "") + url)}`,
        old = this.tiles.get(oldKey);
      if (old !== undefined) {
        try {
          await this.validate(source, old);
          this.tiles.put(key, old);
          return old;
        } catch {
          /* Invalid legacy entry is discarded. */
        } finally {
          this.tiles.delete(oldKey);
        }
      }
      return undefined;
    };
    const hit = await cached();
    const data =
      hit ??
      (await this.downloads.load(
        key,
        preset
          ? source.split("-")[0]!
          : source === "vector"
            ? "vector"
            : "custom",
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
  async validate(source: string, data: Buffer): Promise<void> {
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
      await image.raw().toBuffer();
    } catch (cause) {
      throw new AppError(
        "USER_INPUT",
        "地图源返回无效图片或错误瓦片尺寸，不能导出；请更换底图",
        { cause },
      );
    }
  }
  async close() {
    await this.downloads.close();
    this.tiles.close();
  }
}
