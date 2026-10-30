import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkTaskSchema,
  WorkTasksResponseSchema,
  WorkRequestSchema,
  type WorkTask,
} from "../../src/shared/work.js";
import { waitForWorkTask, requestWorkTask } from "../../src/web/api.js";

const task: WorkTask = {
  schema: 1,
  id: "task-1",
  operation: "archive:backup",
  mode: "apply",
  status: "succeeded",
  revision: 2,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:01:00.000Z",
  progress: { completed: 1, total: 1 },
  request: { operation: "archive:backup", inputs: [], options: {} },
  output: {
    paths: ["/tmp/export.zip"],
    temporary: true,
    data: { arbitrary: ["value", 1, null] },
    committed: true,
  },
  events: [
    { sequence: 1, event: { type: "log", level: "INFO", message: "完成" } },
    { sequence: 2, event: { type: "progress", completed: 1, total: 1 } },
  ],
  cancelRequested: false,
  downloadedFiles: [0],
  exportsCleaned: false,
  uploadsCleaned: true,
  previewId: "preview-1",
  expiresAt: "2026-10-30T01:00:00.000Z",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("work response contracts", () => {
  it.each([
    "queued",
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "interrupted",
  ] as const)("accepts %s tasks and preserves output payloads", (status) => {
    const value = { ...task, status };
    expect(WorkTaskSchema.parse(value)).toEqual(value);
    expect(WorkTasksResponseSchema.parse({ tasks: [value] }).tasks).toEqual([
      value,
    ]);
  });
  it("keeps historical operations readable without allowing them to execute", () => {
    const value = {
      ...task,
      operation: "archive:pop",
      request: {
        ...task.request,
        operation: "archive:pop",
        options: { retiredOption: true },
      },
    };
    expect(WorkTaskSchema.parse(value)).toEqual(value);
    expect(WorkRequestSchema.safeParse(value.request).success).toBe(false);
  });
  it.each([
    { progress: { completed: 2, total: 1 } },
    { events: [{ sequence: -1, event: task.events[0]!.event }] },
    {
      events: [
        { sequence: 1, event: { type: "progress", completed: 2, total: 1 } },
      ],
    },
    { output: { paths: [1] } },
    { downloadedFiles: [0.5] },
    { cancelRequested: "false" },
    { request: { operation: "archive:backup", options: {} } },
    { request: { operation: "archive:backup", inputs: [] } },
    { expiresAt: "yesterday" },
    { lease: 123, fingerprint: "private" },
  ])(
    "rejects malformed responses instead of filling request defaults",
    (invalid) => {
      expect(WorkTaskSchema.safeParse({ ...task, ...invalid }).success).toBe(
        false,
      );
    },
  );
});

function mockResponse(value: unknown) {
  vi.stubGlobal("document", { querySelector: () => null });
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(value)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("work response boundary", () => {
  it("validates preview/action responses and forwards cancellation", async () => {
    const fetch = mockResponse(task);
    const signal = new AbortController().signal;
    await expect(
      requestWorkTask(
        "/api/work/preview",
        { operation: "archive:backup" },
        signal,
      ),
    ).resolves.toEqual(task);
    expect(fetch).toHaveBeenCalledWith(
      "/api/work/preview",
      expect.objectContaining({ method: "POST", signal }),
    );
  });
  it("rejects a malformed response with a readable message", async () => {
    mockResponse({ id: "task-1", status: "succeeded" });
    await expect(requestWorkTask("/api/work/tasks/task-1")).rejects.toThrow(
      "任务响应格式无效",
    );
  });
  it("stops polling after a terminal response", async () => {
    const fetch = mockResponse(task);
    await expect(waitForWorkTask(task.id)).resolves.toEqual(task);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("cancels an in-flight task read", async () => {
    vi.stubGlobal("document", { querySelector: () => null });
    const fetch = vi.fn(
      (_path: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const result = waitForWorkTask(task.id, controller.signal);
    const assertion = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("cancels between polls without issuing another request", async () => {
    vi.useFakeTimers();
    const fetch = mockResponse({ ...task, status: "running" });
    const controller = new AbortController();
    const result = waitForWorkTask(task.id, controller.signal);
    const assertion = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
