import type { MediaTime } from "../../domain/media-time.js";
import type { TrackData } from "../../domain/trackdata.js";
import type { TrackMatch } from "../../services/media-ports.js";
import type { ArchiveRequest, ArchiveResult } from "../../domain/archive.js";
import { Worker } from "node:worker_threads";
import type { MapStore } from "../../services/map-service.js";
import type { Catalog, Selection } from "../../shared/map.js";
import type { Project } from "../../shared/project.js";
import type { ErrorInfo } from "../../shared/contracts.js";
import { AppError, checkCancelled } from "../../domain/errors.js";
type Request = {
  op: string;
  time?: MediaTime;
  multiday?: boolean;
  tolerance?: number;
  request?: ArchiveRequest;
  path?: string;
  entries?: string[];
  expected?: Record<string, string>;
  name?: string;
  state?: Project;
};
type Job = {
  id: number;
  request: Request;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
};
export class ArchiveClient implements MapStore {
  private worker?: Worker;
  private stopping?: Promise<number>;
  private active?: Job;
  private queue: Job[] = [];
  private serial = 0;
  private closed = false;
  private call<T>(request: Request, signal?: AbortSignal): Promise<T> {
    try {
      checkCancelled(signal);
      if (this.closed) throw new AppError("CANCELLED", "归档服务已关闭");
      if (this.queue.length >= 16) throw new AppError("TOOL", "归档队列已满");
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: ++this.serial,
        request,
        signal,
        resolve: (v) => resolve(v as T),
        reject,
        abort: () => {},
      };
      job.abort = () => {
        if (this.active === job) {
          const worker = this.worker;
          this.worker = undefined;
          this.finish(
            new AppError("CANCELLED", "操作已取消"),
            undefined,
            false,
          );
          this.stopping = worker?.terminate();
          void this.stopping?.finally(() => {
            this.stopping = undefined;
            this.drain();
          });
        } else {
          this.queue = this.queue.filter((j) => j !== job);
          signal?.removeEventListener("abort", job.abort);
          reject(new AppError("CANCELLED", "操作已取消"));
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }
  private drain() {
    if (this.closed || this.stopping || this.active || !this.queue.length)
      return;
    if (!this.worker) {
      // File workers must not inherit a caller's --input-type/eval/loader flags.
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        execArgv: [],
      });
      this.worker = worker;
      worker.on(
        "message",
        (m: { id: number; result?: unknown; error?: ErrorInfo }) => {
          if (this.worker !== worker || m.id !== this.active?.id) return;
          this.finish(
            m.error ? new AppError(m.error.code, m.error.message) : undefined,
            m.result,
          );
        },
      );
      const failed = () => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        this.finish(new AppError("TOOL", "归档 worker 执行失败"));
      };
      worker.on("error", failed);
      worker.on("exit", failed);
    }
    this.active = this.queue.shift()!;
    const current = this.active;
    current.timer = setTimeout(() => current.abort(), 120_000);
    this.worker.postMessage({ id: current.id, ...current.request });
  }
  private finish(error?: unknown, value?: unknown, drain = true) {
    const job = this.active;
    if (!job) return;
    this.active = undefined;
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error);
    else job.resolve(value);
    if (drain) this.drain();
  }
  execute(request: ArchiveRequest, signal?: AbortSignal) {
    return this.call<ArchiveResult>({ op: "write", request }, signal);
  }
  nearest(
    path: string,
    time: MediaTime,
    multiday: boolean,
    tolerance: number,
    signal: AbortSignal,
  ) {
    return this.call<TrackMatch | undefined>(
      { op: "nearest", path, time, multiday, tolerance },
      signal,
    );
  }
  catalog(path: string) {
    return this.call<Catalog>({ op: "catalog", path });
  }
  readBytes(path: string, name: string, signal?: AbortSignal) {
    return this.call<Uint8Array>({ op: "bytes", path, name }, signal);
  }
  readTrackData(path: string, name: string, signal?: AbortSignal) {
    return this.call<{ data: TrackData; sha256: string }>(
      { op: "track-data", path, name },
      signal,
    );
  }
  selection(
    path: string,
    entries: string[],
    expected?: Record<string, string>,
    signal?: AbortSignal,
  ) {
    return this.call<Selection>(
      { op: "selection", path, entries, expected },
      signal,
    );
  }
  projects(path: string) {
    return this.call<string[]>({ op: "projects", path });
  }
  load(path: string, name: string) {
    return this.call<unknown>({ op: "load", path, name });
  }
  save(path: string, name: string, state: Project) {
    return this.call<void>({ op: "save", path, name, state });
  }
  stats() {
    return this.call<{ xml: number; indexHits: number; memoryHits: number }>({
      op: "stats",
    });
  }
  async close() {
    this.closed = true;
    for (const job of [...this.queue]) job.abort();
    this.finish(new AppError("CANCELLED", "归档服务已关闭"), undefined, false);
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
    await this.stopping;
  }
}
