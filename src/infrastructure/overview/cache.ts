import { mkdir, readFile, readdir, rm, stat, open } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AppError } from "../../domain/errors.js";
import {
  atomic,
  boundedRead,
  digest,
  generation,
  readManifest,
} from "./files.js";
import { LIMITS, type Manifest } from "./types.js";
import type { OverviewCrs } from "../../shared/overview.js";

interface CachedFile {
  file: string;
  size: number;
  mtime: number;
}
async function files(root: string): Promise<CachedFile[]> {
  const result: CachedFile[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, e.name);
    if (e.isDirectory()) result.push(...(await files(file)));
    else if (e.isFile()) {
      const s = await stat(file).catch(() => undefined);
      if (s) result.push({ file, size: s.size, mtime: s.mtimeMs });
    }
  }
  return result;
}
/** One server owns a cache namespace. Atomic pointers publish immutable generations. */
export class OverviewCache {
  readonly manifests = new Map<string, Manifest>();
  readonly current = new Map<OverviewCrs, Manifest>();
  reserved = 0;
  private owner = randomBytes(16).toString("hex");
  private locked = false;
  private gate: Promise<unknown> = Promise.resolve();
  private memory = new Map<string, Buffer>();
  private memorySize = 0;
  private inventory?: { files: Map<string, CachedFile>; bytes: number };
  constructor(
    readonly root: string,
    readonly diskBytes = LIMITS.diskBytes,
  ) {}
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const p = this.gate.then(run);
    this.gate = p.catch(() => {});
    return p;
  }
  async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = path.join(this.root, "owner.json");
    try {
      const f = await open(lock, "wx", 0o600);
      await f.writeFile(
        JSON.stringify({ pid: process.pid, owner: this.owner }),
      );
      await f.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let old: { pid?: number };
      try {
        old = JSON.parse(await readFile(lock, "utf8"));
      } catch {
        throw new AppError(
          "TOOL",
          "地图缓存锁损坏，请停止相关服务后清理概览缓存目录",
        );
      }
      if (!Number.isInteger(old.pid) || old.pid! <= 0)
        throw new AppError("TOOL", "地图缓存锁无效");
      try {
        process.kill(old.pid!, 0);
        throw new AppError("TOOL", "该轨迹库的概览缓存正被另一个服务使用");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await rm(lock);
      return this.prepare();
    }
    this.locked = true;
    await mkdir(path.join(this.root, "generations"), { recursive: true });
    await mkdir(path.join(this.root, "objects"), { recursive: true });
    for (const name of await readdir(this.root))
      if (name.startsWith("staging-") || name.endsWith(".tmp"))
        await rm(path.join(this.root, name), { recursive: true, force: true });
    for (const f of await files(this.root))
      if (f.file.endsWith(".tmp")) await rm(f.file, { force: true });
    for (const crs of ["wgs84", "gcj02"] as const) {
      try {
        const pointer = JSON.parse(
          await readFile(path.join(this.root, `${crs}.json`), "utf8"),
        ) as { version: string };
        if (!/^[a-f0-9]{32}$/.test(pointer.version)) continue;
        const m = await readManifest(this.root, pointer.version);
        if (m.crs === crs) this.current.set(crs, m);
      } catch {
        /* Missing or corrupt pointer: build again, never publish a staging directory. */
      }
    }
    for (const name of await readdir(path.join(this.root, "generations"))) {
      try {
        if (!/^[a-f0-9]{32}$/.test(name)) continue;
        const m = await readManifest(this.root, name);
        this.manifests.set(name, m);
      } catch {
        await rm(generation(this.root, name), { recursive: true, force: true });
      }
    }
    await this.prune();
  }
  async publish(manifest: Manifest) {
    await this.exclusive(async () => {
      this.reserved = 0;
      this.inventory = undefined;
      await atomic(
        path.join(this.root, `${manifest.crs}.json`),
        JSON.stringify({ version: manifest.version }),
      );
      this.manifests.set(manifest.version, manifest);
      this.current.set(manifest.crs, manifest);
      await this.prune();
    });
  }
  async prune() {
    this.inventory = undefined;
    const revisions = [
      ...new Set(
        [
          ...this.current.values(),
          ...[...this.manifests.values()].sort(
            (a, b) => b.createdAt - a.createdAt,
          ),
        ].map((m) => `${m.archiveId}/${m.revision}`),
      ),
    ].slice(0, 2);
    const latest = new Set<string>();
    for (const m of [...this.manifests.values()].sort(
      (a, b) => b.createdAt - a.createdAt,
    )) {
      const group = `${m.archiveId}/${m.revision}/${m.crs}`;
      const pinned = this.current.get(m.crs)?.version === m.version;
      if (
        !pinned &&
        (!revisions.includes(`${m.archiveId}/${m.revision}`) ||
          latest.has(group))
      ) {
        await rm(generation(this.root, m.version), {
          recursive: true,
          force: true,
        });
        this.manifests.delete(m.version);
      } else latest.add(group);
    }
    const referenced = new Set(
      [...this.manifests.values()].flatMap((m) =>
        m.entries.filter((e) => !e.error).map((e) => `${e.sha256}.gz`),
      ),
    );
    // Only prune objects when there is no builder writing the next snapshot.
    if (!this.reserved)
      for (const name of await readdir(path.join(this.root, "objects")))
        if (!referenced.has(name))
          await rm(path.join(this.root, "objects", name), { force: true });
    await this.room(0);
  }
  async room(bytes: number) {
    if (!this.inventory) {
      const all = await files(this.root);
      this.inventory = {
        files: new Map(all.map((f) => [f.file, f])),
        bytes: all.reduce((n, f) => n + f.size, 0),
      };
    }
    const inventory = this.inventory;
    for (const f of [...inventory.files.values()]
      .filter((f) => f.file.endsWith(".pbf.gz"))
      .sort((a, b) => a.mtime - b.mtime)) {
      if (inventory.bytes + bytes + this.reserved <= this.diskBytes) break;
      await rm(f.file, { force: true });
      inventory.bytes -= f.size;
      inventory.files.delete(f.file);
    }
    // Two revisions is a retention ceiling, not a reservation that blocks updates.
    for (const m of [...this.manifests.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    )) {
      if (inventory.bytes + bytes + this.reserved <= this.diskBytes) break;
      if (this.current.get(m.crs)?.version === m.version) continue;
      const dir = generation(this.root, m.version);
      await rm(dir, { recursive: true, force: true });
      this.manifests.delete(m.version);
      for (const [file, f] of inventory.files)
        if (file.startsWith(dir + path.sep)) {
          inventory.bytes -= f.size;
          inventory.files.delete(file);
        }
      for (const [key, buffer] of this.memory)
        if (key.startsWith(m.version + "/")) {
          this.memorySize -= buffer.length;
          this.memory.delete(key);
        }
      if (!this.reserved) {
        const referenced = new Set(
          [...this.manifests.values()].flatMap((item) =>
            item.entries.filter((e) => !e.error).map((e) => `${e.sha256}.gz`),
          ),
        );
        const objects = path.join(this.root, "objects") + path.sep;
        for (const [file, f] of inventory.files)
          if (
            file.startsWith(objects) &&
            !referenced.has(path.basename(file))
          ) {
            await rm(file, { force: true });
            inventory.bytes -= f.size;
            inventory.files.delete(file);
          }
      }
    }
    if (inventory.bytes + bytes + this.reserved > this.diskBytes)
      throw new AppError(
        "TOOL",
        "概览缓存空间不足，保留上一版；请在后台清理缓存或调整容量",
      );
  }
  private tileKey(version: string, z: number, x: number, y: number) {
    return `${version}/${z}-${x}-${y}`;
  }
  private tilePath(key: string) {
    const [v, t] = key.split("/");
    return path.join(generation(this.root, v!), "tiles", `${t}.pbf.gz`);
  }
  private remember(key: string, bytes: Buffer) {
    const old = this.memory.get(key);
    if (old) this.memorySize -= old.length;
    this.memory.delete(key);
    this.memory.set(key, bytes);
    this.memorySize += bytes.length;
    while (
      this.memory.size > LIMITS.memoryTiles ||
      this.memorySize > LIMITS.memoryBytes
    ) {
      const first = this.memory.keys().next().value!;
      this.memorySize -= this.memory.get(first)!.length;
      this.memory.delete(first);
    }
  }
  async tile(version: string, z: number, x: number, y: number) {
    const key = this.tileKey(version, z, x, y),
      cached = this.memory.get(key);
    if (cached) {
      this.remember(key, cached);
      return cached;
    }
    try {
      const stored = await boundedRead(
          this.tilePath(key),
          LIMITS.tileBytes + 32,
        ),
        bytes = stored.subarray(32);
      if (stored.subarray(0, 32).toString("hex") !== digest(bytes))
        return undefined;
      this.remember(key, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  }
  async saveTile(
    version: string,
    z: number,
    x: number,
    y: number,
    bytes: Buffer,
  ) {
    const key = this.tileKey(version, z, x, y);
    this.remember(key, bytes);
    await this.exclusive(async () => {
      if (!this.manifests.has(version)) return;
      await this.room(bytes.length + 32);
      const file = this.tilePath(key);
      await mkdir(path.dirname(file), { recursive: true });
      await atomic(
        file,
        Buffer.concat([Buffer.from(digest(bytes), "hex"), bytes]),
      );
      if (this.inventory) {
        this.inventory.bytes +=
          bytes.length + 32 - (this.inventory.files.get(file)?.size ?? 0);
        this.inventory.files.set(file, {
          file,
          size: bytes.length + 32,
          mtime: Date.now(),
        });
      }
    });
  }
  async close() {
    await this.gate;
    if (this.locked) {
      const file = path.join(this.root, "owner.json");
      const lock = JSON.parse(
        await readFile(file, "utf8").catch(() => "{}"),
      ) as { owner?: string };
      if (lock.owner === this.owner) await rm(file, { force: true });
      this.locked = false;
    }
    this.memory.clear();
    this.memorySize = 0;
  }
}
