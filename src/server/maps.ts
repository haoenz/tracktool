import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { ConfigStore } from "../services/ports.js";
import { TileCacheCapacitySchema } from "../shared/tile-cache.js";
import { AppError } from "../domain/errors.js";
import { MAP_LABEL_FONTS } from "../shared/map-label.js";
import { OVERVIEW_TILING } from "../domain/overview.js";
import { MapService } from "../services/map-service.js";
import { ArchiveClient } from "../infrastructure/archive/client.js";
import { MapResources } from "../infrastructure/maps/resources.js";
import { Exports, type VisibleTrack } from "../infrastructure/maps/export.js";
import { DisplayStore } from "../infrastructure/display-store.js";
import {
  defaultMapState,
  MapStyleSchema,
  MapTitleSchema,
  type MapState,
  type MapStyle,
} from "../shared/map-state.js";
import { PrintDocumentSchema, resolvePrintTracks } from "../shared/print.js";
import type { MapConfig } from "../shared/map.js";
import type { OverviewCrs, OverviewStatus } from "../shared/overview.js";
import { canvasCrs, reconcileOverlays } from "../drawing/layers.js";
import { sendCachedMapResource } from "./map-cache.js";
export interface MapOptions {
  configStore?: ConfigStore;
  archiveDefault?: () => Promise<string>;
  cache?: string;
  display?: DisplayStore;
  initialArchive?: string;
  resources?: () => MapResources;
  refresh?: boolean;
  overview?: (crs: OverviewCrs) => Promise<OverviewStatus>;
}
const location = z.object({ path: z.string().min(1).max(4096) }),
  archive = z.object({ archive: z.string().min(1).max(4096) }),
  tileCrs = z
    .object({
      crs: z.enum(["wgs84", "gcj02"]).default("wgs84"),
      v: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict();
function checkResourceVersion(resources: MapResources, version?: string) {
  if (version !== undefined && version !== resources.resourceVersion)
    throw new AppError("USER_INPUT", "地图资源版本已更新，请刷新页面");
}
function restoreStyle(state: MapState, saved: MapStyle, config: MapConfig) {
  const basemap =
    saved.basemap === "vector" ||
    config.basemaps.some((preset) => preset.id === saved.basemap)
      ? saved.basemap
      : state.style.basemap;
  const available = new Set(config.overlays.map((preset) => preset.id));
  const seen = new Set<string>();
  state.style = {
    ...state.style,
    ...saved,
    basemap,
    overlays: saved.overlays.filter((overlay) => {
      if (!available.has(overlay.id) || seen.has(overlay.id)) return false;
      seen.add(overlay.id);
      return true;
    }),
  };
  // Drop overlays that no longer work with the selected basemap/config.
  reconcileOverlays(state, config);
}
function unconfigured(crs: OverviewCrs): OverviewStatus {
  return {
    state: "unconfigured",
    crs,
    version: null,
    updating: false,
    maxZoom: OVERVIEW_TILING.maxZoom,
  };
}
export function mapRoutes(
  app: FastifyInstance,
  token: string,
  options: MapOptions = {},
) {
  const client = new ArchiveClient(),
    service = new MapService(client);
  let resources: MapResources | undefined;
  const cacheSettings = async () => ({
    capacityMiB: TileCacheCapacitySchema.parse(
      process.env.TRACKTOOL_MAP_CACHE_MIB !== undefined
        ? Number(process.env.TRACKTOOL_MAP_CACHE_MIB)
        : ((await options.configStore?.load())?.map_cache_mib ?? 1024),
    ),
    readOnly:
      process.env.TRACKTOOL_MAP_CACHE_MIB !== undefined ||
      !options.configStore?.set,
  });
  let initialization: Promise<MapResources> | undefined;
  const cacheResources = () => {
    initialization ??= (async () => {
      const settings = await cacheSettings();
      resources =
        options.resources?.() ??
        new MapResources(
          options.cache ?? path.join(os.homedir(), ".cache/tracktool/maps"),
          { cacheMiB: settings.capacityMiB },
        );
      resources.tiles.setCapacity(settings.capacityMiB * 1024 * 1024);
      return resources;
    })().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  };
  const getResources = async () => {
    const r = await cacheResources();
    await r.prepare(options.refresh);
    options.refresh = false;
    return r;
  };
  app.get("/api/settings/tile-cache", cacheSettings);
  let settingWrite = Promise.resolve();
  app.post("/api/settings/tile-cache", async (request) => {
    const { capacityMiB } = z
      .object({ capacityMiB: TileCacheCapacitySchema })
      .strict()
      .parse(request.body);
    const update = settingWrite.then(async () => {
      const previous = await cacheSettings();
      if (previous.readOnly)
        throw new AppError(
          "FORBIDDEN",
          "瓦片缓存容量由服务端配置控制，无法在网页修改",
        );
      const r = await cacheResources();
      await options.configStore!.set!("map_cache_mib", String(capacityMiB));
      try {
        r.tiles.setCapacity(capacityMiB * 1024 * 1024);
      } catch (error) {
        await options.configStore!.set!(
          "map_cache_mib",
          String(previous.capacityMiB),
        );
        r.tiles.setCapacity(previous.capacityMiB * 1024 * 1024);
        throw error;
      }
      return cacheSettings();
    });
    settingWrite = update.then(
      () => {},
      () => {},
    );
    return update;
  });
  const jobs = new Exports(() => {
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP server is not listening");
    return `http://${address.address === "0.0.0.0" ? "127.0.0.1" : address.address}:${address.port}`;
  }, token);
  const cancellation = (request: FastifyRequest, reply: FastifyReply) => {
    const controller = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    request.raw.once("aborted", () => controller.abort());
    return controller.signal;
  };
  app.get("/api/bootstrap", async () => {
    const r = await getResources();
    const config = r.publicConfig();
    const state = defaultMapState();
    const saved = await options.display?.load();
    if (saved) restoreStyle(state, saved, config);
    return {
      config,
      state,
      initialArchive:
        options.initialArchive ?? (await options.archiveDefault?.()) ?? "",
    };
  });
  app.post("/api/display", async (request) => {
    if (!options.display)
      throw new AppError("USER_INPUT", "当前服务没有可用的地图设置存储");
    const body = z
      .object({ style: MapStyleSchema })
      .strict()
      .parse(request.body);
    const r = await getResources();
    const state = defaultMapState();
    restoreStyle(state, body.style, r.publicConfig());
    await options.display.save(state.style);
    return { style: state.style };
  });
  app.post("/api/archive", async (request) =>
    service.catalog(location.parse(request.body).path),
  );
  app.post("/api/print/check-title", async (request) => {
    const { title } = z
      .object({ title: z.string().max(1000) })
      .parse(request.body);
    const parsed = MapTitleSchema.safeParse(title);
    if (!parsed.success)
      return { valid: false, error: parsed.error.issues[0]!.message };
    try {
      (await getResources()).checkText(title);
      return { valid: true };
    } catch (error) {
      if (error instanceof AppError && error.code === "USER_INPUT")
        return { valid: false, error: error.message };
      throw error;
    }
  });
  app.post("/api/print", { bodyLimit: 64 * 1024 * 1024 }, async (request) => {
    const { document } = z
      .object({ document: PrintDocumentSchema })
      .strict()
      .parse(request.body);
    const r = await getResources();
    r.checkText(document.title);
    const activeArchive =
      options.initialArchive ?? (await options.archiveDefault?.());
    if (!activeArchive) throw new AppError("USER_INPUT", "请先配置轨迹库");
    const catalog = await service.catalog(activeArchive);
    const { tracks, warnings } = resolvePrintTracks(document, catalog);
    const visible: VisibleTrack[] = tracks.map(({ id, entry }) => ({
      id,
      entry,
    }));
    const resolved = {
      ...document,
      archive: catalog.archive,
      tracks: tracks.map(({ entry, sha256 }) => ({ entry, sha256 })),
    };
    const config = r.publicConfig();
    const crs = canvasCrs(document, config);
    const overview = options.overview
      ? await options.overview(crs)
      : unconfigured(crs);
    if (visible.length && !overview.version)
      throw new AppError("USER_INPUT", "轨迹概览尚未准备好，请稍后重试");
    return { job: jobs.submit(resolved, visible, overview), warnings };
  });
  app.get("/api/exports", async (request) => {
    const query = archive.parse(request.query);
    return { exports: jobs.list(query.archive) };
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request) => {
    return jobs.summary(request.params.id);
  });
  const disposition = (fileName: string, fallback: string) =>
    `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/png",
    async (request, reply) => {
      const j = jobs.get(request.params.id);
      if (!j.png) throw new AppError("USER_INPUT", "导出尚未完成");
      return reply
        .type("image/png")
        .header(
          "Content-Disposition",
          disposition(j.fileName, "tracktool-map.png"),
        )
        .send(j.png);
    },
  );
  app.post("/api/basemap-check", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.body),
      r = await getResources();
    if (!r.presets[id]) throw new AppError("USER_INPUT", "未知内置地图源");
    await r.displayTile(id, 2, 3, 1);
    return { id, ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/render/:id", async (request) => {
    if (request.headers["x-tracktool-render"] !== token)
      throw new AppError("FORBIDDEN", "独立出图会话无效");
    const j = jobs.get(request.params.id);
    return {
      document: j.document,
      visible: j.visible,
      overview: j.overview,
      config: (await getResources()).publicConfig(),
    };
  });
  app.get<{ Params: { font: string; span: string } }>(
    "/glyphs/:font/:span",
    async (request, reply) => {
      if (!MAP_LABEL_FONTS.some((font) => font === request.params.font))
        throw new AppError("USER_INPUT", "无效地图字体");
      const { v } = z
        .object({
          v: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(request.query);
      const resources = await getResources();
      checkResourceVersion(resources, v);
      const data = await resources.glyph(
        request.params.span.replace(/\.pbf$/, ""),
        cancellation(request, reply),
        request.headers["x-tracktool-render"] === token,
        request.params.font,
      );
      reply.type("application/x-protobuf");
      return v ? sendCachedMapResource(request, reply, data) : reply.send(data);
    },
  );
  app.get<{ Params: { source: string; z: string; x: string; y: string } }>(
    "/tiles/:source/:z/:x/:y",
    async (request, reply) => {
      const p = request.params,
        { crs, v } = tileCrs.parse(request.query),
        resources = await getResources();
      checkResourceVersion(resources, v);
      const r = await resources.displayTile(
        p.source,
        Number(p.z),
        Number(p.x),
        Number(p.y.replace(/\.(pbf|png)$/, "")),
        cancellation(request, reply),
        request.headers["x-tracktool-render"] === token,
        crs,
      );
      reply.type(r.mime);
      return v
        ? sendCachedMapResource(request, reply, r.data)
        : reply.send(r.data);
    },
  );
  app.addHook("onClose", async () => {
    await jobs.close();
    await client.close();
    await resources?.close();
  });
}
