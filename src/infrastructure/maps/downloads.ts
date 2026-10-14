import { AppError, checkCancelled } from "../../domain/errors.js";
interface Waiter {
  export: boolean;
  resolve: (data: Buffer) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}
interface Flight {
  key: string;
  provider: string;
  run: () => Promise<Buffer>;
  waiters: Set<Waiter>;
  running: boolean;
}
/** Shared downloads have independent waiters; cancelling a preview never cancels an export. */
export class Downloads {
  private tasks = new Map<string, Flight>();
  private active = new Map<string, number>();
  private running = 0;
  private exportTurn = true;
  private closed = false;
  readonly stats = { started: 0, shared: 0, skipped: 0 };
  constructor(
    private workers = 8,
    private limits: Record<string, number> = { custom: 4 },
    private maxPending = 512,
  ) {}
  load(
    key: string,
    provider: string,
    run: () => Promise<Buffer>,
    signal?: AbortSignal,
    exporting = false,
  ): Promise<Buffer> {
    try {
      checkCancelled(signal);
      if (this.closed) throw new AppError("CANCELLED", "地图下载服务已关闭");
    } catch (error) {
      return Promise.reject(error);
    }
    let task = this.tasks.get(key);
    if (!task) {
      if (this.tasks.size >= this.maxPending)
        return Promise.reject(
          new AppError("USER_INPUT", "地图下载队列已满，请稍后重试"),
        );
      task = { key, provider, run, waiters: new Set(), running: false };
      this.tasks.set(key, task);
    } else this.stats.shared++;
    const flight = task;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        export: exporting,
        resolve,
        reject,
        cleanup: () => {},
      };
      const cancel = () => {
        flight.waiters.delete(waiter);
        waiter.cleanup();
        reject(new AppError("CANCELLED", "操作已取消"));
        this.pump();
      };
      const timer = setTimeout(() => {
        flight.waiters.delete(waiter);
        waiter.cleanup();
        reject(new AppError("USER_INPUT", "地图下载等待超时，请重试"));
        this.pump();
      }, 90_000);
      waiter.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      flight.waiters.add(waiter);
      this.pump();
    });
  }
  private pump() {
    for (const [key, t] of this.tasks)
      if (!t.running && !t.waiters.size) {
        this.tasks.delete(key);
        this.stats.skipped++;
      }
    while (!this.closed && this.running < this.workers) {
      const candidates = [...this.tasks.values()].filter(
        (t) =>
          !t.running &&
          (this.active.get(t.provider) ?? 0) <
            (this.limits[t.provider] ?? this.limits.custom ?? 4),
      );
      const task =
        candidates.find(
          (t) => [...t.waiters].some((w) => w.export) === this.exportTurn,
        ) ?? candidates[0];
      if (!task) return;
      this.exportTurn = !this.exportTurn;
      task.running = true;
      this.running++;
      this.active.set(task.provider, (this.active.get(task.provider) ?? 0) + 1);
      this.stats.started++;
      void task
        .run()
        .then(
          (value) => {
            for (const w of task.waiters) {
              w.cleanup();
              w.resolve(value);
            }
          },
          (error) => {
            for (const w of task.waiters) {
              w.cleanup();
              w.reject(error);
            }
          },
        )
        .finally(() => {
          this.tasks.delete(task.key);
          this.running--;
          this.active.set(task.provider, this.active.get(task.provider)! - 1);
          this.pump();
        });
    }
  }
  async close() {
    this.closed = true;
    for (const t of this.tasks.values())
      for (const w of t.waiters) {
        w.cleanup();
        w.reject(new AppError("CANCELLED", "地图服务已关闭"));
      }
    while (this.running) await new Promise((r) => setTimeout(r, 10));
    this.tasks.clear();
  }
}
