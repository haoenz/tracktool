import type { BatchResult, TaskState } from "../shared/contracts.js";
import { BatchResultSchema } from "../shared/contracts.js";
import { AppError } from "./errors.js";
const transitions: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["succeeded", "partial", "failed", "cancelled", "interrupted"],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!transitions[from].includes(to))
    throw new AppError(
      "USER_INPUT",
      `Invalid task transition: ${from} -> ${to}`,
    );
}
export function batchResult(items: BatchResult["items"]): BatchResult {
  return BatchResultSchema.parse({
    items,
    exitCode: items.some((i) => i.status === "failed") ? 3 : 0,
  });
}
