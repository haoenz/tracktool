import type { ErrorInfo } from "../shared/contracts.js";

export class AppError extends Error {
  readonly code: ErrorInfo["code"];
  constructor(
    code: ErrorInfo["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
  }
}
export function errorInfo(error: unknown): ErrorInfo {
  if (!(error instanceof AppError))
    return {
      code: "INTERNAL",
      message: "内部错误。",
      exitCode: 1,
    };
  const exitCode =
    error.code === "TOOL"
      ? 2
      : error.code === "PARTIAL"
        ? 3
        : error.code === "CANCELLED"
          ? 130
          : 1;
  return { code: error.code, message: error.message, exitCode };
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("CANCELLED", "操作已取消");
}
