import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { AppError } from "../domain/errors.js";
import { MapService } from "../services/map-service.js";
import { ArchiveClient } from "../infrastructure/archive/client.js";
import { MapResources } from "../infrastructure/maps/resources.js";
import { Exports } from "../infrastructure/maps/export.js";
import { resolvePath } from "../infrastructure/paths.js";
import {
  defaultProject,
  ProjectSchema,
  upgradeProject,
} from "../shared/project.js";
import { PresentationSchema } from "../shared/track-edit.js";
import { presentationDigest } from "../infrastructure/archive/identity.js";
import { SelectionRequest } from "../shared/map.js";
export interface MapOptions {
  archiveDefault?: () => Promise<string>;
  cache?: string;
  initialArchive?: string;
  resources?: () => MapResources;
  refresh?: boolean;
}
const location = z.object({ path: z.string().min(1).max(4096) }),
  archive = z.object({ archive: z.string().min(1).max(4096) }),
  named = archive.extend({ name: z.string().min(1).max(240) });
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
    return {
      config: r.publicConfig(),
      state: defaultProject(r.versions()),
      initialArchive:
        options.initialArchive ?? (await options.archiveDefault?.()) ?? "",
      directory: process.cwd(),
    };
  });
  app.get("/api/cities", async () => {
    const cities = (await getResources()).cities;
    // The web renderer only reads these four fields; omit gazetteer metadata
    // that would otherwise dominate the payload (670 KB -> 230 KB).
    return {
      coverage: cities.coverage,
      labels: cities.labels.map(({ id, name, level, position }) => ({
        id,
        name,
        level,
        position,
      })),
    };
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
  app.post("/api/projects", async (request) => ({
    names: await service.projects(archive.parse(request.body).archive),
  }));
  app.post("/api/projects/save", async (request) => {
    const b = z
        .object({ name: z.string(), state: z.unknown() })
        .parse(request.body),
      r = await getResources(),
      result = await service.project(b.state);
    if (!isDeepStrictEqual(result.state.versions, r.versions()))
      throw new AppError(
        "USER_INPUT",
        "项目资源版本不同，请先确认使用当前资源",
      );
    await service.save(b.name, result.state);
    return { ok: true };
  });
  app.post("/api/projects/load", async (request) => {
    const b = named.parse(request.body),
      result = await service.load(b.archive, b.name);
    return {
      ...result,
      versionsChanged: !isDeepStrictEqual(
        result.state.versions,
        (await getResources()).versions(),
      ),
    };
  });
  app.post("/api/project", async (request) => {
    const result = await service.project(request.body);
    return {
      ...result,
      versionsChanged: !isDeepStrictEqual(
        result.state.versions,
        (await getResources()).versions(),
      ),
    };
  });
  app.post("/api/project/presentation", async (request) => {
    const body = z
      .object({
        state: z.unknown(),
        entry_id: z.string(),
        settings: PresentationSchema.nullable(),
      })
      .strict()
      .parse(request.body);
    const state = ProjectSchema.parse(upgradeProject(body.state));
    const track = state.tracks.find((t) => t.entry_id === body.entry_id);
    if (!track) throw new AppError("USER_INPUT", "项目中没有该行程");
    if (body.settings)
      track.override = {
        settings: body.settings,
        sha256: presentationDigest(body.settings),
      };
    else delete track.override;
    return service.project(state);
  });
  app.post("/api/project/update-track", async (request) => {
    const body = z
      .object({ state: z.unknown(), entry_id: z.string() })
      .strict()
      .parse(request.body);
    const state = ProjectSchema.parse(upgradeProject(body.state));
    const i = state.tracks.findIndex((t) => t.entry_id === body.entry_id);
    if (i < 0) throw new AppError("USER_INPUT", "项目中没有该行程");
    state.tracks[i] = await client.currentReference(
      state.archive,
      body.entry_id,
    );
    return service.project(state);
  });
  app.post("/api/export-kml", async (request) => {
    const result = await service.project(request.body);
    if (result.errors.length)
      throw new AppError("USER_INPUT", "源轨迹缺失或无法关联，不能导出");
    return {
      job: jobs.submitKml(
        result.state,
        await client.displayKml(result.archive, result.state.tracks),
      ),
    };
  });
  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/kml",
    async (request, reply) => {
      const j = jobs.get(request.params.id);
      if (!j.kml) throw new AppError("USER_INPUT", "展示 KML 不存在或已过期");
      return reply
        .type("application/vnd.google-earth.kml+xml")
        .header(
          "Content-Disposition",
          'attachment; filename="tracktool-display.kml"',
        )
        .send(j.kml);
    },
  );
  app.post("/api/basemap-check", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.body),
      r = await getResources();
    if (!r.presets[id]) throw new AppError("USER_INPUT", "未知内置地图源");
    await r.tile(id, 2, 3, 1);
    return { id, ok: true };
  });
  app.post("/api/export", async (request) => {
    const result = await service.project(request.body),
      r = await getResources();
    if (result.errors.length)
      throw new AppError("USER_INPUT", "源轨迹缺失或变化，不能导出");
    if (!isDeepStrictEqual(result.state.versions, r.versions()))
      throw new AppError(
        "USER_INPUT",
        "项目资源版本不同，请确认使用当前资源并另存项目",
      );
    if (result.state.style.basemap === "satellite" && !r.satellite)
      throw new AppError("USER_INPUT", "卫星底图未配置");
    r.checkText(result.state.title);
    return { job: jobs.submit(result.state, result.tracks) };
  });
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request) => {
    const j = jobs.get(request.params.id);
    return { status: j.status, error: j.error, report: j.report };
  });
  app.get<{ Params: { id: string } }>(
    "/api/jobs/:id/png",
    async (request, reply) => {
      const j = jobs.get(request.params.id);
      if (!j.png) throw new AppError("USER_INPUT", "导出尚未完成");
      return reply
        .type("image/png")
        .header(
          "Content-Disposition",
          'attachment; filename="tracktool-map.png"',
        )
        .send(j.png);
    },
  );
  app.get<{ Params: { id: string } }>("/api/render/:id", async (request) => {
    if (request.headers["x-tracktool-render"] !== token)
      throw new AppError("FORBIDDEN", "独立出图会话无效");
    const j = jobs.get(request.params.id);
    if (!j.tracks) throw new AppError("USER_INPUT", "出图数据已释放");
    return {
      state: j.state,
      tracks: j.tracks,
      config: (await getResources()).publicConfig(),
    };
  });
  app.get<{ Params: { font: string; span: string } }>(
    "/glyphs/:font/:span",
    async (request, reply) => {
      if (request.params.font !== "Noto Sans Regular")
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
          ),
        );
    },
  );
  app.get<{ Params: { source: string; z: string; x: string; y: string } }>(
    "/tiles/:source/:z/:x/:y",
    async (request, reply) => {
      const p = request.params,
        r = await (
          await getResources()
        ).tile(
          p.source,
          Number(p.z),
          Number(p.x),
          Number(p.y.replace(/\.(pbf|png)$/, "")),
          cancellation(request, reply),
          request.headers["x-tracktool-render"] === token,
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
