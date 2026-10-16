import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import os from "node:os";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "../domain/errors.js";
import { OVERVIEW_TILING } from "../domain/overview.js";
import { databasePath } from "../infrastructure/archive/database.js";
import { OverviewService } from "../infrastructure/overview/service.js";
import { digest } from "../infrastructure/overview/files.js";
import { OverviewCrs, OverviewVersion } from "../shared/overview.js";

export function overviewRoutes(
  app: FastifyInstance,
  options: { archive: () => Promise<string>; cache?: string },
) {
  let current: { source: string; service: OverviewService } | undefined;
  let gate: Promise<unknown> = Promise.resolve();
  const get = () => {
    const p = gate.then(async () => {
      const configured = await options.archive();
      const source = configured
        ? await realpath(databasePath(configured)).catch(() => {
            throw new AppError(
              "USER_INPUT",
              "后台配置的轨迹库不存在或无法读取",
            );
          })
        : "";
      if (current?.source !== source) {
        await current?.service.close();
        current = undefined;
        if (source)
          current = {
            source,
            service: new OverviewService(
              source,
              path.join(
                options.cache ??
                  path.join(os.homedir(), ".cache/tracktool/maps"),
                "overview-v1",
                digest(source),
              ),
            ),
          };
      }
      return current?.service;
    });
    gate = p.catch(() => {});
    return p;
  };
  const required = async () => {
    const service = await get();
    if (!service) throw new AppError("USER_INPUT", "后台尚未配置轨迹库");
    return service;
  };
  const signal = (request: FastifyRequest, reply: FastifyReply) => {
    const controller = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    request.raw.once("aborted", () => controller.abort());
    return controller.signal;
  };
  const crsQuery = z.object({ crs: OverviewCrs.default("wgs84") }).strict();
  app.get("/api/overview", async (request) => {
    const { crs } = crsQuery.parse(request.query),
      service = await get();
    return service
      ? service.status(crs)
      : {
          state: "unconfigured",
          crs,
          version: null,
          updating: false,
          maxZoom: OVERVIEW_TILING.maxZoom,
        };
  });
  app.post("/api/overview/retry", async (request) => {
    const { crs } = crsQuery.parse(request.query);
    return (await required()).retry(crs);
  });
  app.get("/api/overview/entries", async (request) => {
    const query = z
      .object({
        version: OverviewVersion,
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        from: z
          .string()
          .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
          .default(""),
        to: z
          .string()
          .regex(/^$|^\d{4}-\d{2}-\d{2}$/)
          .default(""),
        sort: z.enum(["date-desc", "date-asc", "name"]).default("date-desc"),
        q: z.string().max(200).default(""),
        kind: z.string().max(200).default("all"),
        ids: z
          .string()
          .max(20100)
          .optional()
          .refine(
            (v) => !v || v.split(",").length <= 100,
            "最多查询 100 个条目",
          ),
      })
      .strict()
      .parse(request.query);
    const m = await (await required()).manifest(query.version);
    const text = query.q.toLocaleLowerCase(),
      rows = m.entries.filter(
        (e) =>
          (!query.from || (!!e.date && e.date >= query.from)) &&
          (!query.to || (!!e.date && e.date <= query.to)) &&
          (query.kind === "all" || e.kind === query.kind) &&
          (!query.ids || query.ids.split(",").includes(e.id)) &&
          (!text ||
            `${e.name} ${e.entry} ${e.kind} ${e.date} ${e.tags ?? ""}`
              .toLocaleLowerCase()
              .includes(text)),
      );
    rows.sort((a, b) =>
      query.sort === "name"
        ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        : !a.date
          ? !b.date
            ? a.id.localeCompare(b.id)
            : 1
          : !b.date
            ? -1
            : (query.sort === "date-desc"
                ? b.date.localeCompare(a.date)
                : a.date.localeCompare(b.date)) || a.id.localeCompare(b.id),
    );
    return {
      version: m.version,
      total: rows.length,
      entries: rows.slice(query.offset, query.offset + query.limit),
    };
  });
  app.get("/api/overview/entries/:id/geometry", async (request, reply) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const { version } = z
      .object({ version: OverviewVersion })
      .strict()
      .parse(request.query);
    return (await required()).detail(version, id, signal(request, reply));
  });
  app.get(
    "/api/overview/tiles/:version/:z/:x/:y.pbf",
    async (request, reply) => {
      const p = z
        .object({
          version: OverviewVersion,
          z: z.coerce.number().int().min(0).max(18),
          x: z.coerce.number().int().min(0),
          y: z.coerce.number().int().min(0),
        })
        .parse(request.params);
      z.object({}).strict().parse(request.query);
      if (p.x >= 2 ** p.z || p.y >= 2 ** p.z)
        throw new AppError("USER_INPUT", "无效瓦片坐标");
      const bytes = await (
        await required()
      ).tile(p.version, p.z, p.x, p.y, signal(request, reply));
      return reply
        .type("application/vnd.mapbox-vector-tile")
        .header("Content-Encoding", "gzip")
        .send(bytes);
    },
  );
  app.addHook("onClose", async () => {
    await gate;
    await current?.service.close();
  });
}
