import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AppError } from "../domain/errors.js";
import { assertTransition } from "../domain/tasks.js";
import type { TaskStore } from "../services/ports.js";
import type { Task, TaskEvent, TaskState } from "../shared/contracts.js";
import type { WorkOutput, WorkRequest, WorkTask } from "../shared/work.js";
export type StoredTask = WorkTask & {
  fingerprint?: string;
  owner?: string;
  lease: number;
};
const terminal = (state: TaskState) => !["queued", "running"].includes(state);
type TaskRow = {
  body: string;
  owner: string | null;
  lease: number;
  progress: string | null;
  updated_at: string;
};
// Both task reads and summaries must overlay the same independently written columns.
function decodeTask(row: TaskRow): StoredTask {
  const task = JSON.parse(row.body) as StoredTask;
  task.owner = row.owner ?? undefined;
  task.lease = row.lease;
  task.events = [];
  if (row.progress) task.progress = JSON.parse(row.progress);
  task.updatedAt = row.updated_at;
  return task;
}
const EVENT_LIMIT = 1000;
export class SqliteTasks implements TaskStore {
  readonly db: Database.Database;
  private appended = new Map<string, number>();
  private lastRecover = 0;
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
      `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,revision INTEGER NOT NULL,owner TEXT,lease INTEGER NOT NULL DEFAULT 0,preview_id TEXT UNIQUE,body TEXT NOT NULL,progress TEXT,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,event TEXT NOT NULL); CREATE INDEX IF NOT EXISTS event_task ON task_events(task_id,sequence); CREATE INDEX IF NOT EXISTS task_status ON tasks(status);`,
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS task_retention ON tasks(status,updated_at)",
    );
  }

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }
  private readCore(id: string): StoredTask | undefined {
    const row = this.db
      .prepare(
        "SELECT body,owner,lease,progress,updated_at FROM tasks WHERE id=?",
      )
      .get(id) as TaskRow | undefined;
    return row && decodeTask(row);
  }

  private withEvents(task: StoredTask): StoredTask {
    task.events = (
      this.db
        .prepare(
          "SELECT sequence,event FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 500",
        )
        .all(task.id) as { sequence: number; event: string }[]
    )
      .reverse()
      .map((row) => ({
        sequence: row.sequence,
        event: JSON.parse(row.event) as TaskEvent,
      }));
    return task;
  }
  read(id: string): StoredTask | undefined {
    const task = this.readCore(id);
    return task && this.withEvents(task);
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
    // One scan instead of one read + 500 events per task.
    return (
      this.db
        .prepare(
          "SELECT body,owner,lease,progress,updated_at FROM tasks ORDER BY rowid DESC LIMIT 200",
        )
        .all() as TaskRow[]
    ).map((row) => this.public(decodeTask(row)));
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
        const current = this.readCore(preview.id);
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
          "INSERT INTO tasks(id,status,revision,preview_id,body,progress,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          task.id,
          task.status,
          0,
          preview?.id ?? null,
          JSON.stringify(task),
          JSON.stringify(task.progress),
          now,
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
        "UPDATE tasks SET status=?,revision=?,owner=?,lease=?,body=?,progress=?,updated_at=? WHERE id=? AND revision=?",
      )
      .run(
        task.status,
        task.revision,
        task.owner ?? null,
        task.lease,
        JSON.stringify(clean),
        JSON.stringify(task.progress),
        task.updatedAt,
        task.id,
        revision,
      );
    if (!result.changes)
      throw new AppError("USER_INPUT", "任务已变化，请刷新后重试");
    if (!events.length) return;
    const append = this.db.prepare(
      "INSERT INTO task_events(task_id,event) VALUES (?,?)",
    );
    for (const event of events) append.run(task.id, JSON.stringify(event));
    const appended = (this.appended.get(task.id) ?? 0) + events.length;
    this.appended.set(task.id, appended);
    // Keep the newest EVENT_LIMIT rows without rewriting the whole table.
    if (appended >= 64) {
      this.appended.delete(task.id);
      this.db
        .prepare(
          "DELETE FROM task_events WHERE task_id=? AND sequence <= (SELECT sequence FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 1 OFFSET ?)",
        )
        .run(task.id, task.id, EVENT_LIMIT);
    }
  }
  change(
    id: string,
    fn: (task: StoredTask) => void,
    events: readonly TaskEvent[] = [],
    owner?: string,
    expected?: number,
  ): StoredTask {
    return this.transaction(() => {
      const task = this.readCore(id);
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
  /** Progress-only writes touch a small column and never parse the event log. */
  progress(id: string, owner: string, completed: number, total: number): void {
    this.db
      .prepare(
        "UPDATE tasks SET progress=?,updated_at=? WHERE id=? AND owner=? AND status='running'",
      )
      .run(
        JSON.stringify({ completed, total }),
        new Date(this.now()).toISOString(),
        id,
        owner,
      );
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
      // Lease recovery does not need to run twice a second.
      if (this.now() - this.lastRecover > 5000) {
        this.lastRecover = this.now();
        this.recover();
      }
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
    const now = this.now();
    const row = this.db
      .prepare(
        "UPDATE tasks SET lease=? WHERE id=? AND owner=? AND status='running' AND lease>=? RETURNING body",
      )
      .get(now + 15_000, id, owner, now) as { body: string } | undefined;
    if (!row) return false;
    return !(JSON.parse(row.body) as StoredTask).cancelRequested;
  }
  cancel(id: string, revision: number): StoredTask {
    const task = this.change(
      id,
      (value) => {
        if (terminal(value.status))
          throw new AppError("USER_INPUT", "任务已经结束");
        value.cancelRequested = true;
        if (value.status === "queued") value.status = "cancelled";
      },
      [],
      undefined,
      revision,
    );
    return this.withEvents(task);
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
    this.appended.delete(id);
  }
  async create(task: Task): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO tasks(id,status,revision,body,progress,updated_at) VALUES (?,?,?,?,?,?)",
      )
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
        JSON.stringify(task.progress),
        task.updatedAt,
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
  /** Drop finished tasks past their retention so table scans stay bounded. */
  retain(days = 7): number {
    const cutoff = new Date(this.now() - days * 86400_000).toISOString();
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM tasks WHERE status NOT IN ('queued','running') AND updated_at IS NOT NULL AND updated_at<? LIMIT 500",
        )
        .all(cutoff) as { id: string }[];
      const removeEvents = this.db.prepare(
        "DELETE FROM task_events WHERE task_id=?",
      );
      const removeTask = this.db.prepare("DELETE FROM tasks WHERE id=?");
      for (const row of rows) {
        removeEvents.run(row.id);
        removeTask.run(row.id);
        this.appended.delete(row.id);
      }
      return rows.length;
    });
  }
  close() {
    this.db.close();
  }
}
