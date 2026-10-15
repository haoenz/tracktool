import { Worker } from "node:worker_threads";
import { AppError, checkCancelled } from "../../domain/errors.js";
import type { ErrorInfo } from "../../shared/contracts.js";
import type { XmlOperation, XmlPort, XmlResult } from "../../services/ports.js";

type Job = {
  bytes: Uint8Array;
  operation: XmlOperation;
  signal?: AbortSignal;
  resolve: (value: XmlResult) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
/** Bounded, disposable workers: CPU work never blocks HTTP or the CLI event loop. */
export class XmlWorkers implements XmlPort {
  private queue: Job[] = [];
  private active = new Map<Job, Worker>();
  private closed = false;
  constructor(
    private readonly concurrency = 2,
    private readonly queueLimit = 8,
    private readonly timeoutMs = 60_000,
  ) {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isInteger(queueLimit) ||
      queueLimit < 0 ||
      timeoutMs <= 0
    )
      throw new Error("Invalid worker limits");
  }
  run(
    bytes: Uint8Array,
    operation: XmlOperation,
    signal?: AbortSignal,
  ): Promise<XmlResult> {
    try {
      checkCancelled(signal);
      if (this.closed) throw new AppError("CANCELLED", "XML 服务已关闭");
      if (bytes.byteLength > 128 * 1024 * 1024)
        throw new AppError("USER_INPUT", "XML 超过 128 MiB");
      if (
        operation.kind === "segment-edit" &&
        bytes.byteLength +
          operation.additional.reduce((n, s) => n + s.raw.byteLength, 0) >
          128 * 1024 * 1024
      )
        throw new AppError("USER_INPUT", "Composition inputs exceed 128 MiB");
      if (
        this.active.size >= this.concurrency &&
        this.queue.length >= this.queueLimit
      )
        throw new AppError("TOOL", "XML 工作队列已满");
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        bytes: new Uint8Array(bytes),
        operation: structuredClone(operation),
        signal,
        resolve,
        reject,
        abort: () => {},
      };
      job.abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          signal?.removeEventListener("abort", job.abort);
          reject(new AppError("CANCELLED", "操作已取消"));
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  private drain(): void {
    while (
      !this.closed &&
      this.active.size < this.concurrency &&
      this.queue.length
    ) {
      const job = this.queue.shift()!;
      job.signal?.removeEventListener("abort", job.abort);
      let worker: Worker;
      try {
        worker = new Worker(new URL("./worker.js", import.meta.url), {
          execArgv: [],
          workerData: { bytes: job.bytes, operation: job.operation },
          transferList: [job.bytes.buffer as ArrayBuffer],
        });
      } catch (error) {
        job.reject(
          new AppError("TOOL", "无法启动 XML worker", { cause: error }),
        );
        continue;
      }
      this.active.set(job, worker);
      let settled = false;
      const finish = (error?: unknown, result?: XmlResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.signal?.removeEventListener("abort", job.abort);
        // Release the slot only after termination; cancellation cannot exceed the concurrency bound.
        void worker.terminate().then(() => {
          this.active.delete(job);
          if (error) job.reject(error);
          else job.resolve(result!);
          this.drain();
        });
      };
      const timer = setTimeout(
        () => finish(new AppError("TOOL", "XML 处理超时")),
        this.timeoutMs,
      );
      job.abort = () => finish(new AppError("CANCELLED", "操作已取消"));
      job.signal?.addEventListener("abort", job.abort, { once: true });
      worker.once(
        "message",
        (message: { result?: XmlResult; error?: ErrorInfo }) => {
          if (message.error)
            finish(new AppError(message.error.code, message.error.message));
          else if (message.result) finish(undefined, message.result);
          else finish(new AppError("TOOL", "XML worker 返回无效结果"));
        },
      );
      worker.once("error", (error) =>
        finish(new AppError("TOOL", "XML worker 执行失败", { cause: error })),
      );
      worker.once("exit", () =>
        finish(new AppError("TOOL", "XML worker 意外退出")),
      );
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue]) job.abort();
    const workers = [...this.active.values()];
    for (const job of this.active.keys()) job.abort();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
