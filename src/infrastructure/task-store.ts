import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors.js";
import { assertTransition } from "../domain/tasks.js";
import type { Task, TaskEvent, TaskState } from "../shared/contracts.js";
import type { WorkTask, WorkRequest, WorkOutput } from "../shared/work.js";
import type { TaskStore } from "../services/ports.js";
export type StoredTask = WorkTask & {
  fingerprint?: string;
  owner?: string;
  lease: number;
};
const terminal = (state: TaskState) => !["queued", "running"].includes(state);
export class SqliteTasks implements TaskStore {
  readonly db: Database.Database;
  constructor(
    file: string,
    private readonly now = () => Date.now(),
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("busy_timeout=5000");
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("synchronous=FULL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,revision INTEGER NOT NULL,owner TEXT,lease INTEGER NOT NULL DEFAULT 0,preview_id TEXT UNIQUE,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,event TEXT NOT NULL); CREATE INDEX IF NOT EXISTS event_task ON task_events(task_id,sequence); CREATE INDEX IF NOT EXISTS task_status ON tasks(status);`,
    );
  }
  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }
  read(id: string): StoredTask | undefined {
    const row = this.db
      .prepare("SELECT body,owner,lease FROM tasks WHERE id=?")
      .get(id) as
      { body: string; owner: string | null; lease: number } | undefined;
    if (!row) return undefined;
    const task = JSON.parse(row.body) as StoredTask;
    task.owner = row.owner ?? undefined;
    task.lease = row.lease;
    task.events = (
      this.db
        .prepare(
          "SELECT sequence,event FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 500",
        )
        .all(id) as { sequence: number; event: string }[]
    )
      .reverse()
      .map((r) => ({
        sequence: r.sequence,
        event: JSON.parse(r.event) as TaskEvent,
      }));
    return task;
  }
  public(task: StoredTask): WorkTask {
    const value = { ...task };
    delete value.fingerprint;
    delete value.owner;
    const { lease, ...result } = value;
    void lease;
    return result;
  }
  list(): WorkTask[] {
    return (
      this.db
        .prepare("SELECT id FROM tasks ORDER BY rowid DESC LIMIT 200")
        .all() as { id: string }[]
    ).map((row) => this.public(this.read(row.id)!));
  }
  enqueue(
    request: WorkRequest,
    preview?: StoredTask,
    directApply = false,
  ): StoredTask {
    return this.transaction(() => {
      const queued = (
        this.db
          .prepare(
            "SELECT count(*) n FROM tasks WHERE status IN ('queued','running')",
          )
          .get() as { n: number }
      ).n;
      if (queued >= 50)
        throw new AppError("USER_INPUT", "任务队列已满，请等待已有任务完成");
      if (preview) {
        const current = this.read(preview.id);
        if (
          !current ||
          current.mode !== "plan" ||
          current.status !== "succeeded" ||
          current.fingerprint !== preview.fingerprint ||
          !current.expiresAt ||
          Date.parse(current.expiresAt) < this.now()
        )
          throw new AppError("USER_INPUT", "预览已过期或不可执行，请重新预览");
        if (
          this.db
            .prepare("SELECT 1 FROM tasks WHERE preview_id=?")
            .get(preview.id)
        )
          throw new AppError("USER_INPUT", "这个预览已经提交执行");
      }
      const now = new Date(this.now()).toISOString();
      const task: StoredTask = {
        schema: 1,
        id: randomUUID(),
        operation: request.operation,
        request,
        mode: preview || directApply ? "apply" : "plan",
        status: "queued",
        revision: 0,
        createdAt: now,
        updatedAt: now,
        progress: { completed: 0, total: 0 },
        events: [],
        cancelRequested: false,
        lease: 0,
        ...(preview
          ? { previewId: preview.id, fingerprint: preview.fingerprint }
          : {}),
      };
      this.db
        .prepare(
          "INSERT INTO tasks(id,status,revision,preview_id,body) VALUES (?,?,?,?,?)",
        )
        .run(
          task.id,
          task.status,
          0,
          preview?.id ?? null,
          JSON.stringify(task),
        );
      return task;
    });
  }
  private save(
    task: StoredTask,
    revision: number,
    events: readonly TaskEvent[] = [],
  ): void {
    const clean = { ...task, events: [] };
    const result = this.db
      .prepare(
        "UPDATE tasks SET status=?,revision=?,owner=?,lease=?,body=? WHERE id=? AND revision=?",
      )
      .run(
        task.status,
        task.revision,
        task.owner ?? null,
        task.lease,
        JSON.stringify(clean),
        task.id,
        revision,
      );
    if (!result.changes)
      throw new AppError("USER_INPUT", "任务已变化，请刷新后重试");
    const append = this.db.prepare(
      "INSERT INTO task_events(task_id,event) VALUES (?,?)",
    );
    for (const event of events) append.run(task.id, JSON.stringify(event));
    this.db
      .prepare(
        "DELETE FROM task_events WHERE task_id=? AND sequence NOT IN (SELECT sequence FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 1000)",
      )
      .run(task.id, task.id);
  }
  change(
    id: string,
    fn: (task: StoredTask) => void,
    events: readonly TaskEvent[] = [],
    owner?: string,
    expected?: number,
  ): StoredTask {
    return this.transaction(() => {
      const task = this.read(id);
      if (!task) throw new AppError("USER_INPUT", "任务不存在");
      if (owner && (task.owner !== owner || task.lease < this.now()))
        throw new AppError("CANCELLED", "任务租约已失效");
      if (expected !== undefined && expected !== task.revision)
        throw new AppError("USER_INPUT", "任务已变化，请刷新后重试");
      const revision = task.revision,
        state = task.status;
      fn(task);
      if (state !== task.status) assertTransition(state, task.status);
      task.revision = revision + 1;
      task.updatedAt = new Date(this.now()).toISOString();
      this.save(task, revision, events);
      return task;
    });
  }
  recover(): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id FROM tasks WHERE status='running' AND lease<?")
        .all(this.now()) as { id: string }[];
      for (const row of rows)
        this.change(
          row.id,
          (task) => {
            task.status = "interrupted";
            task.owner = undefined;
            task.lease = 0;
            task.error = {
              code: "TOOL",
              message:
                "执行进程已中断；检查结果并重新预览。归档文件操作可使用恢复功能。",
              exitCode: 2,
            };
          },
          [
            {
              type: "log",
              level: "WARNING",
              message: "工作进程租约过期，任务标记为中断；不会自动重复写入。",
            },
          ],
        );
      return rows.length;
    });
  }
  claim(owner: string): StoredTask | undefined {
    return this.transaction(() => {
      this.recover();
      if (this.db.prepare("SELECT 1 FROM tasks WHERE status='running'").get())
        return undefined;
      const row = this.db
        .prepare(
          "SELECT id FROM tasks WHERE status='queued' ORDER BY rowid LIMIT 1",
        )
        .get() as { id: string } | undefined;
      if (!row) return undefined;
      return this.change(row.id, (task) => {
        task.status = "running";
        task.owner = owner;
        task.lease = this.now() + 15_000;
      });
    });
  }
  heartbeat(id: string, owner: string): boolean {
    return this.transaction(() => {
      const task = this.read(id);
      if (
        !task ||
        task.owner !== owner ||
        task.status !== "running" ||
        task.lease < this.now()
      )
        return false;
      this.db
        .prepare("UPDATE tasks SET lease=? WHERE id=? AND owner=?")
        .run(this.now() + 15_000, id, owner);
      return !task.cancelRequested;
    });
  }
  cancel(id: string, revision: number): StoredTask {
    return this.change(
      id,
      (task) => {
        if (terminal(task.status))
          throw new AppError("USER_INPUT", "任务已经结束");
        task.cancelRequested = true;
        if (task.status === "queued") task.status = "cancelled";
      },
      [],
      undefined,
      revision,
    );
  }
  finish(
    id: string,
    owner: string,
    status: TaskState,
    values: {
      output?: WorkOutput;
      result?: Task["result"];
      error?: Task["error"];
      fingerprint?: string;
    },
  ): void {
    this.change(
      id,
      (task) => {
        Object.assign(task, values);
        task.status =
          task.cancelRequested && !values.output?.committed
            ? "cancelled"
            : status;
        task.owner = undefined;
        task.lease = 0;
        if (task.mode === "plan" && status === "succeeded")
          task.expiresAt = new Date(
            this.now() +
              (task.request.operation === "track:preview"
                ? 86400000
                : 15 * 60_000),
          ).toISOString();
      },
      [],
      owner,
    );
  }
  async create(task: Task): Promise<void> {
    this.db
      .prepare("INSERT INTO tasks(id,status,revision,body) VALUES (?,?,?,?)")
      .run(
        task.id,
        task.status,
        task.revision,
        JSON.stringify({
          ...task,
          events: [],
          cancelRequested: false,
          request: { operation: task.operation, inputs: [], options: {} },
        }),
      );
  }
  async get(id: string): Promise<Task | undefined> {
    return this.read(id);
  }
  async update(
    task: Task,
    expectedRevision: number,
    events: readonly TaskEvent[],
  ): Promise<void> {
    this.change(
      task.id,
      (current) => Object.assign(current, task),
      events,
      undefined,
      expectedRevision,
    );
  }
  async interruptUnfinished(): Promise<number> {
    return this.recover();
  }
  close() {
    this.db.close();
  }
}
