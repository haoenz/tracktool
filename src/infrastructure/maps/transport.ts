import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../../domain/errors.js";
export class Transport {
  private cooldown = 0;
  private failures = 0;
  constructor(private fetcher: typeof fetch = fetch) {}
  async fetch(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:")
      throw new AppError("USER_INPUT", "地图数据源必须使用 HTTPS");
    const railway = parsed.hostname === "tiles.openrailwaymap.org";
    if (railway && Date.now() < this.cooldown)
      throw new AppError("USER_INPUT", "铁路服务冷却中，请稍后重试");
    for (let attempt = 0; attempt < (railway ? 1 : 3); attempt++)
      try {
        const response = await this.fetcher(url, {
          redirect: "manual",
          headers: {
            "User-Agent": "tracktool-map/1.0 (local interactive map editor)",
          },
          signal: AbortSignal.timeout(20_000),
        });
        const status = response.status,
          retry = response.headers.get("retry-after") ?? "";
        if (status >= 300 && status < 400) {
          await response.body?.cancel();
          throw new AppError(
            "USER_INPUT",
            "地图服务要求重定向；为避免转发地图凭据，本次请求已停止",
          );
        }
        if (railway && status === 429) {
          await response.body?.cancel();
          this.cooldown =
            Date.now() +
            Math.max(60, /^\d+$/.test(retry) ? Number(retry) : 60) * 1000;
          throw new AppError(
            "USER_INPUT",
            "铁路服务限流，已停止请求，至少一分钟后重试",
          );
        }
        if (
          !railway &&
          [429, 500, 502, 503, 504].includes(status) &&
          attempt < 2
        ) {
          await response.body?.cancel();
          if (retry && (!/^\d+$/.test(retry) || Number(retry) > 2))
            throw new AppError("USER_INPUT", "地图服务限流，请稍后重试");
          await delay(
            Math.max(Number(retry || 0) * 1000, 200 * 2 ** attempt) +
              Math.random() * 100,
          );
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (railway) this.failed();
          throw new AppError(
            "USER_INPUT",
            `地图服务返回 HTTP ${status}；请重试或更换底图`,
          );
        }
        const reader = response.body?.getReader();
        if (!reader) throw new AppError("USER_INPUT", "地图资源为空");
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16 * 1024 * 1024)
              throw new AppError(
                "USER_INPUT",
                "地图资源超过单文件 16 MiB 限制",
              );
            parts.push(value);
          }
        } finally {
          await reader.cancel();
        }
        if (railway) this.failures = 0;
        return Buffer.concat(parts);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (railway) this.failed();
        if (railway || attempt === 2)
          throw new AppError("USER_INPUT", "地图资源下载失败，检查网络后重试", {
            cause: error,
          });
        await delay(200 * 2 ** attempt);
      }
    throw new Error("Unreachable");
  }
  private failed() {
    if (++this.failures >= 3) this.cooldown = Date.now() + 30_000;
  }
}
