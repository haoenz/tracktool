import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const backend = process.env.TRACKTOOL_DEV_BACKEND ?? "http://127.0.0.1:8766";
const webRoot = resolve("src/web");
const backendProxy: ProxyOptions = {
  target: backend,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (proxyRequest, request) => {
      if (request.headers.origin) proxyRequest.setHeader("origin", backend);
    });
    proxy.on("error", (_error, _request, response) => {
      if ("writeHead" in response && !response.headersSent) {
        response.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify({
            error: {
              code: "TOOL",
              message:
                "开发后台暂时不可用，请稍后重试；若持续出现，请查看开发服务终端。",
              exitCode: 2,
            },
          }),
        );
      }
    });
  },
};

function injectDevelopmentToken(): Plugin {
  return {
    name: "tracktool-development-token",
    apply: "serve",
    async transformIndexHtml(html) {
      // The session token survives backend restarts without reloading the UI.
      const sessionToken = process.env.TRACKTOOL_DEV_TOKEN;
      if (sessionToken)
        return html.replace("__TRACKTOOL_TOKEN__", sessionToken);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(`${backend}/`, {
            signal: AbortSignal.timeout(1500),
          });
          if (!response.ok) throw new Error("后台未就绪");
          const backendHtml = await response.text();
          const token = backendHtml.match(
            /<meta\s+name="tracktool-token"\s+content="([^"]+)"\s*\/>/,
          )?.[1];
          if (!token) throw new Error("后台页面中没有找到网页令牌");
          return html.replace("__TRACKTOOL_TOKEN__", token);
        } catch {
          if (attempt < 2) await delay(250);
        }
      }
      throw new Error(
        "无法连接开发后台，请使用 pnpm dev 启动完整开发服务，并检查终端错误。",
      );
    },
  };
}

export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss(), injectDevelopmentToken()],
  resolve: { alias: { "@": webRoot } },
  server: {
    host: "0.0.0.0",
    port: 8765,
    strictPort: true,
    proxy: {
      "/api/": backendProxy,
      "/glyphs": backendProxy,
      "^/render(?:\\?.*)?$": backendProxy,
      "/static": backendProxy,
      "/tiles": backendProxy,
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: resolve(webRoot, "index.html"),
        render: resolve(webRoot, "render.html"),
      },
      output: {
        // MapLibre is the bulk of the client bundle and changes with its own
        // version, so keep it in a separately cached chunk.
        manualChunks: (id: string) =>
          id.includes("node_modules/maplibre-gl") ? "maplibre" : undefined,
      },
    },
  },
});
