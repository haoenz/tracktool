import {
  ConfigResponseSchema,
  ErrorResponseSchema,
} from "../shared/contracts.js";
import { WorkTaskSchema } from "../shared/work.js";
import { downloadBlob } from "./lib/download.js";
export async function request(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const token =
    document.querySelector<HTMLMetaElement>('meta[name="tracktool-token"]')
      ?.content ?? "";
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Tracktool-Token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  }).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    throw new Error("无法连接服务器，请检查网络连接及服务是否仍在运行。", {
      cause: error,
    });
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const parsed = ErrorResponseSchema.safeParse(await response.json());
      if (parsed.success) message = parsed.data.error.message;
    } catch {
      /* Preserve HTTP error. */
    }
    throw new Error(message);
  }
  return response;
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return (await request(path, body, signal)).json() as Promise<T>;
}
export async function requestWorkTask(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const parsed = WorkTaskSchema.safeParse(
    await api<unknown>(path, body, signal),
  );
  if (!parsed.success) throw new Error("任务响应格式无效，请刷新后重试");
  return parsed.data;
}
export async function readConfig(signal?: AbortSignal) {
  const response = await request("/api/config", undefined, signal);
  const body: unknown = await response.json();
  return ConfigResponseSchema.parse(body).data;
}

/** Wait for a user-requested operation without exposing its internal phases. */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
export async function waitForWorkTask(id: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = new Error("等待任务超时，请刷新任务状态后重试");
  const timer = setTimeout(() => controller.abort(timeout), 30 * 60_000);
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      const task = await requestWorkTask(
        `/api/work/tasks/${id}`,
        undefined,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!["queued", "running"].includes(task.status)) {
        if (task.status !== "succeeded")
          throw new Error(
            task.error?.message ?? "操作未完成，请检查结果后重试",
          );
        return task;
      }
      await pause(300, controller.signal);
    }
  } catch (error) {
    // Fetch and response-body reads may report their own AbortError. Preserve
    // the deadline message or caller's cancellation reason consistently.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function downloadWorkFiles(
  task: import("../shared/work.js").WorkTask,
) {
  for (const [index, file] of (task.output?.paths ?? []).entries()) {
    if (!task.downloadedFiles?.includes(index))
      await downloadWorkFile(task, index, file.split(/[\\/]/).at(-1)!);
  }
}

export async function downloadWorkFile(
  task: import("../shared/work.js").WorkTask,
  index: number,
  name: string,
) {
  const response = await request(
    `/api/work/tasks/${task.id}/download?index=${index}`,
  );
  downloadBlob(await response.blob(), name);
  // A successful response header alone does not mean the browser received the entire file.
  if (task.output?.temporary)
    await api(`/api/work/tasks/${task.id}/download-complete`, { index });
}
