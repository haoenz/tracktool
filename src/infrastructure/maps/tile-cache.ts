import Database from "better-sqlite3";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
export class TileCache {
  private db: Database.Database;
  private readonly select;
  private readonly touch;
  private readonly remove;
  private readonly insert;
  private readonly account;
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private scheduledFlush?: ReturnType<typeof setTimeout>;
  private dirty = new Map<string, number>();
  private writes = 0;
  constructor(
    directory: string,
    private capacity: number,
  ) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(path.join(directory, "tiles.sqlite3"), {
      timeout: 10000,
    });
    this.db.pragma("auto_vacuum=INCREMENTAL");
    this.db.pragma("journal_mode=WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tiles(key TEXT PRIMARY KEY,data BLOB NOT NULL,size INTEGER NOT NULL,accessed REAL NOT NULL);CREATE INDEX IF NOT EXISTS tile_lru ON tiles(accessed);CREATE TABLE IF NOT EXISTS accounting(id INTEGER PRIMARY KEY,size INTEGER NOT NULL);INSERT OR IGNORE INTO accounting VALUES(1,0);CREATE TRIGGER IF NOT EXISTS tile_insert AFTER INSERT ON tiles BEGIN UPDATE accounting SET size=size+NEW.size WHERE id=1;END;CREATE TRIGGER IF NOT EXISTS tile_delete AFTER DELETE ON tiles BEGIN UPDATE accounting SET size=size-OLD.size WHERE id=1;END;`,
    );
    this.select = this.db.prepare("SELECT data FROM tiles WHERE key=?");
    this.touch = this.db.prepare("UPDATE tiles SET accessed=? WHERE key=?");
    this.remove = this.db.prepare("DELETE FROM tiles WHERE key=?");
    this.insert = this.db.prepare("INSERT INTO tiles VALUES(?,?,?,?)");
    this.account = this.db.prepare("SELECT size FROM accounting WHERE id=1");
    this.db.transaction(() => this.evict()).immediate();
    for (const name of readdirSync(directory))
      if (/^[0-9a-f]{64}\.tile$/.test(name)) {
        const p = path.join(directory, name);
        try {
          this.put(
            `legacy:${name.slice(0, 64)}`,
            readFileSync(p),
            statSync(p).mtimeMs / 1000,
          );
          unlinkSync(p);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    // Tile reads outnumber writes by orders of magnitude; keep recency in
    // memory and fold it into the LRU index in batches.
    this.flushTimer = setInterval(() => this.tryFlush(), 15_000);
    this.flushTimer.unref();
  }
  get(key: string): Buffer | undefined {
    const row = this.select.get(key) as { data: Buffer } | undefined;
    if (row) {
      this.dirty.delete(key);
      this.dirty.set(key, Date.now() / 1000);
      if (this.dirty.size >= 512 && !this.scheduledFlush) {
        this.scheduledFlush = setTimeout(() => {
          this.scheduledFlush = undefined;
          this.tryFlush();
        }, 0);
        this.scheduledFlush.unref();
      }
    }
    return row?.data;
  }
  flush() {
    if (!this.dirty.size) return;
    // Recency is optional metadata: never stall the event loop behind another
    // writer. Keep pending touches until COMMIT so the timer can retry.
    this.db.pragma("busy_timeout=0");
    try {
      this.db.transaction(() => {
        for (const [key, accessed] of this.dirty) this.touch.run(accessed, key);
      })();
      this.dirty.clear();
    } finally {
      this.db.pragma("busy_timeout=10000");
    }
  }
  private tryFlush() {
    try {
      this.flush();
    } catch {
      /* A competing writer or temporary failure retries on the next flush. */
    }
  }
  delete(key: string) {
    this.dirty.delete(key);
    this.remove.run(key);
  }
  put(key: string, data: Buffer, accessed = Date.now() / 1000) {
    if (data.length > this.capacity) return;
    // Let eviction see recent reads before it picks victims.
    this.flush();
    this.db
      .transaction(() => {
        this.remove.run(key);
        this.insert.run(key, data, data.length, accessed);
        this.evict();
      })
      .immediate();
    // Reclaiming per insert costs more than the space it saves; amortize it.
    if (++this.writes % 256 === 0) this.db.pragma("incremental_vacuum(64)");
  }
  private evict() {
    let total = (this.account.get() as { size: number }).size;
    while (total > this.capacity) {
      const rows = this.db
        .prepare("SELECT key,size FROM tiles ORDER BY accessed LIMIT 32")
        .all() as { key: string; size: number }[];
      if (!rows.length) break;
      for (const row of rows) {
        if (total <= this.capacity) break;
        this.delete(row.key);
        total -= row.size;
      }
    }
  }
  close() {
    clearInterval(this.flushTimer);
    clearTimeout(this.scheduledFlush);
    try {
      this.flush();
      this.db.pragma("incremental_vacuum");
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      this.db.close();
    }
  }
}
