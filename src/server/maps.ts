import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { AppError } from "../domain/errors.js";
import { MAP_LABEL_FONTS } from "../shared/map-label.js";
import { OVERVIEW_TILING } from "../domain/overview.js";
import { MapService } from "../services/map-service.js";
import { ArchiveClient } from "../infrastructure/archive/client.js";
import { MapResources } from "../infrastructure/maps/resources.js";
import { Exports, type VisibleTrack } from "../infrastructure/maps/export.js";
import { DisplayStore } from "../infrastructure/display-store.js";
import { resolvePath } from "../infrastructure/paths.js";
import {
  defaultMapState,
  MapStyleSchema,
  MapTitleSchema,
  type MapState,
  type MapStyle,
} from "../shared/map-state.js";
import { PrintDocumentSchema, resolvePrintTracks } from "../shared/print.js";
import { SelectionRequest, type MapConfig } from "../shared/map.js";
import type { OverviewCrs, OverviewStatus } from "../shared/overview.js";
import { canvasCrs, reconcileOverlays } from "../drawing/layers.js";
export interface MapOptions {
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
    .object({ crs: z.enum(["wgs84", "gcj02"]).default("wgs84") })
    .strict();
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
  const getResources = async () => {
    resources ??=
      options.resources?.() ??
      new MapResources(
        options.cache ?? path.join(os.homedir(), ".cache/tracktool/maps"),
      );
    await resources.prepare(options.refresh);
    options.refresh = false;
    return resources;
  };
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
      directory: process.cwd(),
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
  app.get("/api/browse", async (request) => {
    const query = z
        .object({ path: z.string().max(4096).optional() })
        .parse(request.query),
      folder = resolvePath(query.path ?? process.cwd());
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (cause) {
      throw new AppError("USER_INPUT", "无法读取服务端目录", { cause });
    }
    const dirs = entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) =>
        a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()),
      );
    return {
      path: folder,
      parent: path.dirname(folder),
      directories: dirs
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(folder, e.name) })),
      archives: dirs
        .filter((e) => e.isFile() && e.name === "archive.sqlite3")
        .map((e) => ({ name: e.name, path: path.join(folder, e.name) })),
    };
  });
  app.post("/api/archive", async (request) =>
    service.catalog(location.parse(request.body).path),
  );
  app.post("/api/selection", async (request, reply) => {
    const b = SelectionRequest.parse(request.body);
    return service.selection(
      b.archive,
      b.entries,
      cancellation(request, reply),
    );
  });
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
      return reply
        .type("application/x-protobuf")
        .send(
          await (
            await getResources()
          ).glyph(
            request.params.span.replace(/\.pbf$/, ""),
            cancellation(request, reply),
            request.headers["x-tracktool-render"] === token,
            request.params.font,
          ),
        );
    },
  );
  app.get<{ Params: { source: string; z: string; x: string; y: string } }>(
    "/tiles/:source/:z/:x/:y",
    async (request, reply) => {
      const p = request.params,
        { crs } = tileCrs.parse(request.query),
        r = await (
          await getResources()
        ).displayTile(
          p.source,
          Number(p.z),
          Number(p.x),
          Number(p.y.replace(/\.(pbf|png)$/, "")),
          cancellation(request, reply),
          request.headers["x-tracktool-render"] === token,
          crs,
        );
      return reply.type(r.mime).send(r.data);
    },
  );
  app.addHook("onClose", async () => {
    await jobs.close();
    await client.close();
    await resources?.close();
  });
}
