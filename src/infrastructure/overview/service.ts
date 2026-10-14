import { rm } from "node:fs/promises";
import { AppError, checkCancelled } from "../../domain/errors.js";
import { OVERVIEW_TILING } from "../../domain/overview.js";
import type {
  OverviewCrs,
  OverviewProgress,
  OverviewStatus,
} from "../../shared/overview.js";
import { OverviewCache } from "./cache.js";
import { OverviewWorker } from "./rpc.js";
import { fingerprint, generation, readStamp } from "./files.js";
import { LIMITS, type Manifest, type SourceStamp } from "./types.js";

const message = (e: unknown) =>
  e instanceof AppError
    ? e.message
    : "无法准备轨迹库概览，请检查后台配置或重试";
export class OverviewService {
  readonly cache: OverviewCache;
  private renderer = new OverviewWorker();
  private builder?: OverviewWorker;
  private initialized: Promise<void>;
  private wanted = new Set<OverviewCrs>();
  private failures = new Map<
    OverviewCrs,
    { fingerprint: string; message: string }
  >();
  private forced = new Set<OverviewCrs>();
  private pending = new Map<string, Promise<Buffer>>();
  private building?: {
    crs: OverviewCrs;
    fingerprint: string;
    abort: AbortController;
    progress?: OverviewProgress;
    done: Promise<void>;
  };
  private stamp?: SourceStamp;
  private sourceError?: string;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    readonly source: string,
    root: string,
    private options: {
      pollMs?: number;
      diskBytes?: number;
      buildBytes?: number;
      indexTiles?: number;
    } = {},
  ) {
    this.cache = new OverviewCache(root, options.diskBytes);
    this.initialized = this.cache.prepare();
    void this.initialized.catch(() => {});
    this.timer = setInterval(() => {
      void this.sync().catch(() => {});
    }, options.pollMs ?? 2000);
    this.timer.unref();
  }
  private async sync() {
    await this.initialized;
    if (this.closed) return;
    try {
      this.stamp = readStamp(this.source);
      this.sourceError = undefined;
    } catch (e) {
      this.sourceError = message(e);
      this.building?.abort.abort();
      return;
    }
    if (
      this.building &&
      this.building.fingerprint !== fingerprint(this.stamp, this.building.crs)
    )
      this.building.abort.abort();
    if (this.building) return;
    for (const crs of this.wanted) {
      const fp = fingerprint(this.stamp, crs);
      if (
        (!this.forced.has(crs) &&
          this.cache.current.get(crs)?.fingerprint === fp) ||
        this.failures.get(crs)?.fingerprint === fp
      )
        continue;
      const job = {
        crs,
        fingerprint: fp,
        abort: new AbortController(),
        done: Promise.resolve(),
      };
      this.failures.delete(crs);
      this.building = job;
      job.done = this.build(crs, this.stamp, fp, job.abort.signal).finally(
        () => {
          if (this.building === job) this.building = undefined;
          if (!this.closed) void this.sync().catch(() => {});
        },
      );
      break;
    }
  }
  private async build(
    crs: OverviewCrs,
    stamp: SourceStamp,
    fp: string,
    signal: AbortSignal,
  ) {
    let manifest: Manifest | undefined;
    try {
      const budget = this.options.buildBytes ?? LIMITS.buildBytes;
      await this.cache.exclusive(async () => {
        await this.cache.prune();
        await this.cache.room(budget);
        this.cache.reserved = budget;
      });
      checkCancelled(signal);
      const worker = new OverviewWorker((p) => {
        if (this.building?.fingerprint === fp) this.building.progress = p;
      });
      this.builder = worker;
      manifest = await worker.call<Manifest>(
        {
          op: "build",
          request: {
            source: this.source,
            root: this.cache.root,
            crs,
            fingerprint: fp,
            stamp,
            budget,
          },
        },
        signal,
      );
      await worker.close();
      this.builder = undefined;
      // Validate the persisted geometry and actual tile index before publishing ready.
      const first = await this.renderer.call<{ bytes: Uint8Array }>(
        {
          op: "tile",
          root: this.cache.root,
          version: manifest.version,
          z: 0,
          x: 0,
          y: 0,
          indexTiles: this.options.indexTiles ?? LIMITS.indexTiles,
        },
        signal,
      );
      checkCancelled(signal);
      if (fingerprint(readStamp(this.source), crs) !== fp)
        throw new AppError("CANCELLED", "轨迹库已更新");
      await this.cache.publish(manifest);
      await this.cache.saveTile(
        manifest.version,
        0,
        0,
        0,
        Buffer.from(first.bytes),
      );
      this.failures.delete(crs);
      this.forced.delete(crs);
    } catch (e) {
      if (!(e instanceof AppError && e.code === "CANCELLED"))
        this.failures.set(crs, { fingerprint: fp, message: message(e) });
      if (manifest && this.cache.current.get(crs)?.version !== manifest.version)
        await rm(generation(this.cache.root, manifest.version), {
          recursive: true,
          force: true,
        });
    } finally {
      await this.builder?.close();
      this.builder = undefined;
      await this.cache
        .exclusive(async () => {
          this.cache.reserved = 0;
          const { readdir } = await import("node:fs/promises");
          const { default: path } = await import("node:path");
          for (const name of await readdir(this.cache.root))
            if (name.startsWith("staging-"))
              await rm(path.join(this.cache.root, name), {
                recursive: true,
                force: true,
              });
          await this.cache.prune();
        })
        .catch(() => {});
    }
  }
  async status(crs: OverviewCrs): Promise<OverviewStatus> {
    this.wanted.add(crs);
    try {
      await this.sync();
    } catch (e) {
      this.sourceError = message(e);
    }
    const current = this.cache.current.get(crs);
    const usable =
      current && (!this.stamp || current.archiveId === this.stamp.archiveId)
        ? current
        : undefined;
    const error = this.sourceError ?? this.failures.get(crs)?.message;
    return {
      state: error ? "error" : usable ? "ready" : "building",
      crs,
      updating:
        !!this.building ||
        (!!this.stamp &&
          usable?.fingerprint !== fingerprint(this.stamp, crs) &&
          !error),
      version: usable?.version ?? null,
      revision: usable?.revision,
      bounds: usable?.bounds,
      summary: usable?.summary,
      progress: this.building?.crs === crs ? this.building.progress : undefined,
      error,
      tiles: usable
        ? `/api/overview/tiles/${usable.version}/{z}/{x}/{y}.pbf`
        : undefined,
      maxZoom: OVERVIEW_TILING.maxZoom,
    };
  }
  async retry(crs: OverviewCrs) {
    await this.initialized;
    this.failures.delete(crs);
    // A retry also repairs corrupt artifacts even when the library revision is unchanged.
    this.forced.add(crs);
    return this.status(crs);
  }
  async manifest(version: string) {
    await this.initialized;
    // Tile URLs can be requested immediately after restart, before status polling.
    this.stamp = readStamp(this.source);
    const m = this.cache.manifests.get(version);
    if (!m || (this.stamp && m.archiveId !== this.stamp.archiveId))
      throw new AppError("USER_INPUT", "概览版本已过期，请刷新概览状态");
    return m;
  }
  async tile(
    version: string,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ) {
    checkCancelled(signal);
    const manifest = await this.manifest(version);
    const cached = await this.cache.tile(version, z, x, y);
    if (cached) return cached;
    const key = `${version}/${z}/${x}/${y}`;
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 64)
        throw new AppError("TOOL", "地图请求过多，请稍后重试");
      pending = (async () => {
        const r = await this.renderer.call<{
          bytes: Uint8Array;
          recycle: boolean;
        }>({
          op: "tile",
          root: this.cache.root,
          version,
          z,
          x,
          y,
          indexTiles: this.options.indexTiles ?? LIMITS.indexTiles,
        });
        const bytes = Buffer.from(r.bytes);
        await this.cache.saveTile(version, z, x, y, bytes);
        if (r.recycle)
          void this.renderer
            .call({
              op: "tile",
              root: this.cache.root,
              version,
              z: 0,
              x: 0,
              y: 0,
              indexTiles: this.options.indexTiles ?? LIMITS.indexTiles,
            })
            .catch(() => {});
        return bytes;
      })()
        .catch((error: unknown) => {
          if (this.cache.current.get(manifest.crs)?.version === version)
            this.failures.set(manifest.crs, {
              fingerprint: manifest.fingerprint,
              message: message(error),
            });
          throw error;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    // One disconnected viewer must not cancel another viewer's identical tile.
    if (!signal) return pending;
    return new Promise<Buffer>((resolve, reject) => {
      const abort = () => reject(new AppError("CANCELLED", "地图请求已取消"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void pending
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async detail(version: string, id: string, signal?: AbortSignal) {
    await this.manifest(version);
    return this.renderer.call(
      { op: "detail", root: this.cache.root, version, id },
      signal,
    );
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.building?.abort.abort();
    await this.building?.done;
    await this.renderer.close();
    await this.builder?.close();
    await Promise.allSettled(this.pending.values());
    await this.initialized.catch(() => {});
    await this.cache.close();
  }
}
