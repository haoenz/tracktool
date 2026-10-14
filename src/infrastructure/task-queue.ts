import { randomUUID } from "node:crypto";
import { AppError, checkCancelled, errorInfo } from "../domain/errors.js";
import type { WorkRunner } from "../services/work-ports.js";
import type { WorkRequest, WorkTask } from "../shared/work.js";
import { READ_OPERATIONS } from "../shared/work.js";
import { SqliteTasks } from "./task-store.js";
export class TaskQueue {
  private owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private abort?: AbortController;
  private closed = false;
  constructor(
    readonly store: SqliteTasks,
    readonly runner: WorkRunner,
  ) {}
  start() {
    this.store.recover();
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
    this.tick();
  }
  async preview(request: WorkRequest): Promise<WorkTask> {
    const normalized = await this.runner.normalize(request);
    const task = this.store.enqueue(normalized);
    this.tick();
    return this.store.public(task);
  }
  async apply(id: string): Promise<WorkTask> {
    const preview = this.store.read(id);
    if (!preview || READ_OPERATIONS.includes(preview.request.operation))
      throw new AppError("USER_INPUT", "此任务不能提交执行");
    if (
      preview.status !== "succeeded" ||
      preview.mode !== "plan" ||
      !preview.fingerprint
    )
      throw new AppError("USER_INPUT", "请先完成无错误的预览");
    const current = await this.runner.fingerprint(
      preview.request,
      new AbortController().signal,
    );
    if (current !== preview.fingerprint)
      throw new AppError(
        "USER_INPUT",
        "文件、输出目录、配置或归档已变化，请重新预览",
      );
    const task = this.store.enqueue(preview.request, preview);
    this.tick();
    return this.store.public(task);
  }
  async retry(id: string): Promise<WorkTask> {
    const task = this.store.read(id);
    if (!task || ["queued", "running"].includes(task.status))
      throw new AppError("USER_INPUT", "任务尚未结束");
    return this.preview(task.request);
  }
  private tick() {
    if (this.closed || this.active) return;
    try {
      const task = this.store.claim(this.owner);
      if (!task) return;
      this.abort = new AbortController();
      this.active = this.execute(task.id, this.abort).finally(() => {
        this.active = undefined;
        this.abort = undefined;
        if (!this.closed) this.tick();
      });
    } catch {
      /* A competing writer may briefly hold SQLite; next tick retries. */
    }
  }
  private async execute(id: string, controller: AbortController) {
    const heartbeat = setInterval(() => {
      try {
        if (!this.store.heartbeat(id, this.owner)) controller.abort();
      } catch {
        controller.abort();
      }
    }, 500);
    heartbeat.unref();
    const task = this.store.read(id)!;
    try {
      const before = await this.runner.fingerprint(
        task.request,
        controller.signal,
      );
      if (task.mode === "apply") {
        const preview = this.store.read(task.previewId!);
        if (
          !preview?.expiresAt ||
          Date.parse(preview.expiresAt) < Date.now() ||
          before !== task.fingerprint
        )
          throw new AppError(
            "USER_INPUT",
            "排队期间计划已过期或输入已变化，请重新预览",
          );
        // Re-run all business checks immediately before any writes, with paid calls disabled.
        const checked = await this.runner.run(
          task.request,
          "plan",
          controller.signal,
          () => {},
        );
        if (checked.result?.exitCode)
          throw new AppError("USER_INPUT", "执行前检查发现冲突，请重新预览");
        if (
          before !==
          (await this.runner.fingerprint(task.request, controller.signal))
        )
          throw new AppError("USER_INPUT", "执行前文件已变化，请重新预览");
      }
      const result = await this.runner.run(
        task.request,
        task.mode,
        controller.signal,
        (event) => {
          checkCancelled(controller.signal);
          this.store.change(
            id,
            (current) => {
              if (event.type === "progress")
                current.progress = {
                  completed: event.completed,
                  total: event.total,
                };
            },
            [
              {
                ...event,
                ...(event.type === "log"
                  ? { message: event.message.slice(0, 4000) }
                  : {}),
              },
            ],
            this.owner,
          );
        },
      );
      checkCancelled(controller.signal);
      if (
        task.mode === "plan" &&
        before !==
          (await this.runner.fingerprint(task.request, controller.signal))
      )
        throw new AppError("USER_INPUT", "预览期间输入发生变化，请重新预览");
      this.store.finish(
        id,
        this.owner,
        result.result?.exitCode ? "partial" : "succeeded",
        { ...result, ...(task.mode === "plan" ? { fingerprint: before } : {}) },
      );
    } catch (error) {
      try {
        this.store.finish(
          id,
          this.owner,
          this.closed
            ? "interrupted"
            : controller.signal.aborted
              ? "cancelled"
              : "failed",
          {
            error: errorInfo(
              error instanceof AppError
                ? error
                : new AppError(
                    "TOOL",
                    error instanceof Error ? error.message : String(error),
                  ),
            ),
          },
        );
      } catch {
        /* Lost lease: the owning process/recovery controls state. */
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.abort?.abort();
    await this.active;
    this.store.close();
  }
}
