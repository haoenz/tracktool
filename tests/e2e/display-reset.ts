import type { APIRequestContext } from "@playwright/test";

/** Drop persisted browse-map settings between tests that share one E2E server. */
export async function resetDisplay(request: APIRequestContext) {
  const response = await request.post("/api/test/reset-display", {
    headers: { "X-Tracktool-Token": "e2e" },
  });
  if (!response.ok()) throw new Error(`重置地图设置失败：${response.status()}`);
}
