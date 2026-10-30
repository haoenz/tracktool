import { Worker } from "node:worker_threads";
import { AppError, checkCancelled } from "../../domain/errors.js";
import type { ErrorInfo } from "../../shared/contracts.js";
import type { XmlOperation, XmlPort, XmlResult } from "../../services/ports.js";

type Job = {
  id: number;
  bytes: Uint8Array;
  operation: XmlOperation;
  signal?: AbortSignal;
  resolve: (value: XmlResult) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
type Busy = { job: Job; timer: ReturnType<typeof setTimeout> };
/** Bounded, long-lived workers: parsing state is per message, so threads are reused. */
export class XmlWorkers implements XmlPort {
  private queue: Job[] = [];
  private idle: Worker[] = [];
  private busy = new Map<Worker, Busy>();
  private workers = new Set<Worker>();
  private stopping = new Map<Worker, Promise<number>>();
  private retired = new WeakSet<Worker>();
  private serial = 0;
  private closed = false;
  private closing?: Promise<void>;
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
      throw new Error("XML 工作线程数量无效");
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
        throw new AppError("USER_INPUT", "组合输入超过 128 MiB");
      if (
        this.workers.size - this.idle.length >= this.concurrency &&
        this.queue.length >= this.queueLimit
      )
        throw new AppError("TOOL", "XML 工作队列已满");
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.serial,
        // The caller may reuse its buffer; the worker owns this copy.
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
          return;
        }
        for (const [worker, value] of this.busy)
          if (value.job === job) {
            this.retire(worker, new AppError("CANCELLED", "操作已取消"));
            return;
          }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  private spawn(): Worker {
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      execArgv: [],
    });
    this.workers.add(worker);
    worker.on(
      "message",
      (message: { id?: number; result?: unknown; error?: ErrorInfo }) => {
        // Node watch mode forwards dependency notifications through this port.
        if (typeof message?.id !== "number") return;
        const value = this.busy.get(worker);
        if (!value || value.job.id !== message.id) return;
        this.release(worker);
        this.idle.push(worker);
        if (message.error)
          value.job.reject(
            new AppError(message.error.code, message.error.message),
          );
        else value.job.resolve(message.result as XmlResult);
        this.drain();
      },
    );
    worker.once("error", (error) =>
      this.retire(
        worker,
        new AppError("TOOL", "XML worker 执行失败", { cause: error }),
      ),
    );
    worker.once("exit", () => {
      this.workers.delete(worker);
      if (!this.retired.has(worker))
        this.retire(worker, new AppError("TOOL", "XML worker 意外退出"));
      this.drain();
    });
    // An idle worker must not keep a short-lived CLI process alive; it is
    // referenced again while it owns a job.
    worker.unref();
    return worker;
  }
  /** Detach a busy worker, fail its job and replace it on the next drain. */
  private retire(worker: Worker, error: unknown) {
    if (this.retired.has(worker)) return;
    const value = this.busy.get(worker);
    this.retired.add(worker);
    if (value) {
      this.release(worker);
      value.job.reject(error);
    }
    const index = this.idle.indexOf(worker);
    if (index >= 0) this.idle.splice(index, 1);
    const stopping = worker.terminate();
    this.stopping.set(worker, stopping);
    const stopped = () => {
      this.stopping.delete(worker);
      this.workers.delete(worker);
      this.drain();
    };
    void stopping.then(stopped, stopped);
    this.drain();
  }
  private release(worker: Worker) {
    const value = this.busy.get(worker);
    if (!value) return;
    clearTimeout(value.timer);
    value.job.signal?.removeEventListener("abort", value.job.abort);
    this.busy.delete(worker);
    worker.unref();
  }
  private drain(): void {
    while (
      !this.closed &&
      this.busy.size < this.concurrency &&
      this.queue.length
    ) {
      // Retiring threads still count until they exit; cancellation must not
      // temporarily exceed the pool's thread/wasm memory budget.
      if (!this.idle.length && this.workers.size >= this.concurrency) return;
      const job = this.queue.shift()!;
      if (job.signal?.aborted) {
        job.signal.removeEventListener("abort", job.abort);
        job.reject(new AppError("CANCELLED", "操作已取消"));
        continue;
      }
      job.signal?.removeEventListener("abort", job.abort);
      const worker = this.idle.pop() ?? this.spawn();
      const timer = setTimeout(
        () => this.retire(worker, new AppError("TOOL", "XML 处理超时")),
        this.timeoutMs,
      );
      worker.ref();
      this.busy.set(worker, { job, timer });
      try {
        worker.postMessage(
          { id: job.id, bytes: job.bytes, operation: job.operation },
          [job.bytes.buffer as ArrayBuffer],
        );
      } catch (error) {
        this.retire(
          worker,
          new AppError("TOOL", "无法启动 XML worker", { cause: error }),
        );
        continue;
      }
      job.abort = () =>
        this.retire(worker, new AppError("CANCELLED", "操作已取消"));
      job.signal?.addEventListener("abort", job.abort, { once: true });
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of [...this.queue]) job.abort();
    for (const worker of this.workers)
      this.retire(worker, new AppError("CANCELLED", "XML 服务已关闭"));
    this.closing = Promise.all(this.stopping.values()).then(() => {});
    return this.closing;
  }
}
