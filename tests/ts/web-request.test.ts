import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfig, request } from "../../src/web/api.js";

beforeEach(() => {
  vi.stubGlobal("document", {
    querySelector: () => ({ content: "test-token" }),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("explains connection failures for API and configuration requests without replaying them", async () => {
  const failure = new TypeError("Failed to fetch");
  const fetch = vi.fn().mockRejectedValue(failure);
  vi.stubGlobal("fetch", fetch);
  await expect(
    request("/api/archive", { path: "/fixture" }),
  ).rejects.toMatchObject({
    message: "无法连接服务器，请检查网络连接及服务是否仍在运行。",
    cause: failure,
  });
  await expect(readConfig()).rejects.toThrow("无法连接服务器");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("preserves cancellation instead of reporting a connection failure", async () => {
  const controller = new AbortController();
  const failure = new DOMException("Aborted", "AbortError");
  controller.abort();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  await expect(
    request("/api/archive", undefined, controller.signal),
  ).rejects.toBe(failure);
});

it("preserves server errors and HTTP status failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "本地会话已过期，请刷新页面",
              exitCode: 1,
            },
          }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 })),
  );
  await expect(request("/api/archive")).rejects.toThrow(
    "本地会话已过期，请刷新页面",
  );
  await expect(request("/api/archive")).rejects.toThrow("请求失败（503）");
});
