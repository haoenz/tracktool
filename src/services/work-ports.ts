import type { WorkRequest, WorkOutput, WorkTask } from "../shared/work.js";
import type { TaskEvent } from "../shared/contracts.js";
export interface WorkRunner {
  normalize(request: WorkRequest): Promise<WorkRequest>;
  fingerprint(request: WorkRequest, signal: AbortSignal): Promise<string>;
  run(
    request: WorkRequest,
    mode: "plan" | "apply",
    signal: AbortSignal,
    report: (event: TaskEvent) => void,
  ): Promise<{ output: WorkOutput; result?: NonNullable<WorkTask["result"]> }>;
}
