import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
const backend = "http://127.0.0.1:8766";
const webRoot = resolve("src/web");
const backendProxy: ProxyOptions = {
  target: backend,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (proxyRequest, request) => {
      if (request.headers.origin) proxyRequest.setHeader("origin", backend);
    });
  },
};

function injectDevelopmentToken(): Plugin {
  return {
    name: "tracktool-development-token",
    apply: "serve",
    async transformIndexHtml(html) {
      const response = await fetch(`${backend}/`);
      if (!response.ok)
        throw new Error(`后台返回 ${response.status}，无法读取网页令牌`);
      const backendHtml = await response.text();
      const token = backendHtml.match(
        /<meta\s+name="tracktool-token"\s+content="([^"]+)"\s*\/>/,
      )?.[1];
      if (!token) throw new Error("后台页面中没有找到网页令牌");
      return html.replace("__TRACKTOOL_TOKEN__", token);
    },
  };
}

export default defineConfig({
  root: webRoot,
  plugins: [react(), injectDevelopmentToken()],
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
    },
  },
});
