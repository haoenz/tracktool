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
  }
  get(key: string): Buffer | undefined {
    const row = this.db
      .prepare("SELECT data FROM tiles WHERE key=?")
      .get(key) as { data: Buffer } | undefined;
    if (row)
      this.db
        .prepare("UPDATE tiles SET accessed=? WHERE key=?")
        .run(Date.now() / 1000, key);
    return row?.data;
  }
  delete(key: string) {
    this.db.prepare("DELETE FROM tiles WHERE key=?").run(key);
  }
  put(key: string, data: Buffer, accessed = Date.now() / 1000) {
    if (data.length > this.capacity) return;
    this.db
      .transaction(() => {
        this.db.prepare("DELETE FROM tiles WHERE key=?").run(key);
        this.db
          .prepare("INSERT INTO tiles VALUES(?,?,?,?)")
          .run(key, data, data.length, accessed);
        this.evict();
      })
      .immediate();
    this.db.pragma("incremental_vacuum(64)");
  }
  private evict() {
    let total = (
      this.db.prepare("SELECT size FROM accounting WHERE id=1").get() as {
        size: number;
      }
    ).size;
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
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
