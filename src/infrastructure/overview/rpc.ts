import { Worker } from "node:worker_threads";
import { AppError, checkCancelled } from "../../domain/errors.js";
import type { ErrorInfo } from "../../shared/contracts.js";
import type { OverviewProgress } from "../../shared/overview.js";
import type { OverviewCommand } from "./types.js";
type Job = {
  command: OverviewCommand;
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
  id: number;
};
export class OverviewWorker {
  private worker?: Worker;
  private active?: Job;
  private queue: Job[] = [];
  private serial = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private stopping?: Promise<number>;
  constructor(private progress?: (p: OverviewProgress) => void) {}
  call<T>(command: OverviewCommand, signal?: AbortSignal): Promise<T> {
    try {
      checkCancelled(signal);
      if (this.closed) throw new AppError("CANCELLED", "概览服务已关闭");
      if (this.queue.length >= 64)
        throw new AppError("TOOL", "地图请求过多，请稍后重试");
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        command,
        signal,
        id: ++this.serial,
        resolve: (r) => resolve(r as T),
        reject,
        abort: () => {},
      };
      job.abort = () => {
        if (this.active === job)
          this.fail(new AppError("CANCELLED", "概览操作已取消"));
        else {
          this.queue = this.queue.filter((j) => j !== job);
          signal?.removeEventListener("abort", job.abort);
          reject(new AppError("CANCELLED", "概览操作已取消"));
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  private drain() {
    if (this.closed || this.active || this.stopping || !this.queue.length)
      return;
    if (!this.worker) {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 32,
        },
      });
      this.worker = worker;
      worker.on(
        "message",
        (m: {
          id?: number;
          result?: unknown;
          error?: ErrorInfo;
          progress?: OverviewProgress;
        }) => {
          if (this.worker !== worker) return;
          if (m.progress) {
            this.progress?.(m.progress);
            return;
          }
          if (m.id !== this.active?.id) return;
          if (m.error) this.finish(new AppError(m.error.code, m.error.message));
          else this.finish(undefined, m.result);
        },
      );
      worker.on("error", () => {
        if (this.worker === worker)
          this.fail(new AppError("TOOL", "地图构建线程失败或超过内存限制"));
      });
      worker.on("exit", () => {
        if (this.worker === worker)
          this.fail(new AppError("TOOL", "地图构建线程已退出"));
      });
    }
    this.active = this.queue.shift()!;
    this.timer = setTimeout(
      () => this.fail(new AppError("TOOL", "地图处理超时")),
      120000,
    );
    this.worker.postMessage({
      id: this.active.id,
      command: this.active.command,
    });
  }
  private finish(error?: unknown, result?: unknown, drain = true) {
    clearTimeout(this.timer);
    const job = this.active;
    this.active = undefined;
    if (job) {
      job.signal?.removeEventListener("abort", job.abort);
      if (error) job.reject(error);
      else job.resolve(result);
    }
    if (drain) this.drain();
  }
  private fail(error: unknown) {
    const worker = this.worker;
    this.worker = undefined;
    this.finish(error, undefined, false);
    if (worker) {
      const stopping = worker.terminate();
      this.stopping = stopping;
      void stopping.finally(() => {
        if (this.stopping === stopping) this.stopping = undefined;
        this.drain();
      });
    } else if (!this.stopping) this.drain();
  }
  async close() {
    this.closed = true;
    for (const job of [...this.queue]) job.abort();
    this.fail(new AppError("CANCELLED", "概览服务已关闭"));
    await this.stopping;
  }
}
