import {
  ConfigResponseSchema,
  ErrorResponseSchema,
} from "../shared/contracts.js";
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
export async function readConfig(signal?: AbortSignal) {
  const token =
    document.querySelector<HTMLMetaElement>('meta[name="tracktool-token"]')
      ?.content ?? "";
  const response = await fetch("/api/config", {
    headers: { "X-Tracktool-Token": token },
    signal,
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(body);
    throw new Error(
      parsed.success ? parsed.data.error.message : "读取配置失败",
    );
  }
  return ConfigResponseSchema.parse(body).data;
}
