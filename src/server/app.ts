import { workRoutes, type WorkOptions } from "./work.js";
import { ZodError } from "zod";
import { mapRoutes, type MapOptions } from "./maps.js";
import { overviewRoutes } from "./overview.js";
import Fastify, { type FastifyInstance } from "fastify";
import staticFiles from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ConfigStore } from "../services/ports.js";
import { createContext } from "../services/context.js";
import { getPublicConfig } from "../services/config.js";
import { AppError, errorInfo } from "../domain/errors.js";
import { EditError } from "../infrastructure/archive/edit-previews.js";

export async function createApp(options: {
  configStore: ConfigStore;
  envKey?: string;
  token?: string;
  webRoot?: string;
  maps?: MapOptions;
  work?: WorkOptions;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });
  const token = options.token ?? randomBytes(32).toString("hex");
  const webRoot =
    options.webRoot ?? fileURLToPath(new URL("../../web/", import.meta.url));
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    const address = request.raw.socket.localAddress;
    const port = request.raw.socket.localPort;
    const allowed = new Set([`${address}:${port}`]);
    if (address?.startsWith("127.")) allowed.add(`localhost:${port}`);
    const host = request.headers.host;
    if (!host || !allowed.has(host))
      throw new AppError(
        "FORBIDDEN",
        "请使用服务器 IP 地址访问（拒绝未知 Host）",
      );
    if (request.headers.origin && request.headers.origin !== `http://${host}`)
      throw new AppError("FORBIDDEN", "拒绝跨站请求");
    if (request.routeOptions.url?.startsWith("/api/")) {
      const supplied = request.headers["x-tracktool-token"];
      if (
        typeof supplied !== "string" ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        throw new AppError("FORBIDDEN", "本地会话已过期，请刷新页面");
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const info = errorInfo(
      error instanceof ZodError
        ? new AppError(
            "USER_INPUT",
            error.issues.map((i) => i.message).join("；"),
          )
        : error,
    );
    reply
      .code(
        error instanceof EditError
          ? error.status
          : info.code === "FORBIDDEN"
            ? 403
            : info.code === "USER_INPUT"
              ? 400
              : 500,
      )
      .send({ error: info });
  });
  app.get("/api/config", async () => ({
    data: getPublicConfig(
      createContext({ config: await options.configStore.load() }),
      options.envKey,
    ),
  }));
  workRoutes(app, options.configStore, options.envKey, options.work);
  overviewRoutes(app, {
    cache: options.maps?.cache,
    archive: async () =>
      options.maps?.initialArchive ??
      options.work?.archive ??
      String((await options.configStore.load()).archive_path ?? ""),
  });
  mapRoutes(app, token, {
    ...options.maps,
    archiveDefault: async () =>
      String((await options.configStore.load()).archive_path ?? ""),
  });
  await app.register(staticFiles, {
    root: webRoot,
    prefix: "/",
    wildcard: false,
    index: false,
  });
  const page = async () =>
    (await readFile(`${webRoot}/index.html`, "utf8")).replace(
      "__TRACKTOOL_TOKEN__",
      token,
    );
  for (const route of [
    "/",
    "/map",
    "/settings",
    "/archive",
    "/tracks",
    "/media",
    "/tasks",
  ])
    app.get(route, async (_request, reply) =>
      reply.type("text/html; charset=utf-8").send(await page()),
    );
  app.get("/render", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(
        (await readFile(`${webRoot}/render.html`, "utf8")).replace(
          "__TRACKTOOL_TOKEN__",
          token,
        ),
      ),
  );
  return app;
}
