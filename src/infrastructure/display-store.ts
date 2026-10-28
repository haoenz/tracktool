import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { MapStyleSchema, type MapStyle } from "../shared/map-state.js";
import { AppError } from "../domain/errors.js";
import { replace } from "./durable-files.js";

const schema = 1;
type StoredDisplay = { schema: number; style: unknown };

/** Persists browse-map appearance preferences independently of archive/project data. */
export class DisplayStore {
  readonly path: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<MapStyle | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AppError("USER_INPUT", `无法读取地图设置：${this.path}`, {
        cause: error,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    if ((value as StoredDisplay).schema !== schema) return undefined;
    const parsed = MapStyleSchema.safeParse((value as StoredDisplay).style);
    return parsed.success ? parsed.data : undefined;
  }

  save(style: MapStyle): Promise<void> {
    const bytes = Buffer.from(
      JSON.stringify({ schema, style }, null, 2) + "\n",
    );
    const write = async () => {
      await mkdir(path.dirname(this.path), { recursive: true });
      replace(this.path, bytes);
    };
    const task = this.pending.then(write, write);
    // A failed write must not poison later saves.
    this.pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Test/support hook: wait for queued writes, then drop the persisted style. */
  async clear(): Promise<void> {
    await this.pending.catch(() => {});
    await rm(this.path, { force: true });
  }
}
