"""Transactional, indexed LRU. The quota counts payload bytes, not SQLite overhead."""

import sqlite3
import threading
import time
from pathlib import Path


class TileCache:
    def __init__(self, directory: Path, capacity: int) -> None:
        self.lock = threading.RLock()
        self.capacity = capacity
        self.db = sqlite3.connect(directory / "tiles.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA auto_vacuum=INCREMENTAL")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=10000")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tiles (
                key TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, accessed REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tile_lru ON tiles(accessed);
            CREATE TABLE IF NOT EXISTS accounting (id INTEGER PRIMARY KEY, size INTEGER NOT NULL);
            INSERT OR IGNORE INTO accounting VALUES (1, 0);
            CREATE TRIGGER IF NOT EXISTS tile_insert AFTER INSERT ON tiles BEGIN
                UPDATE accounting SET size=size+NEW.size WHERE id=1;
            END;
            CREATE TRIGGER IF NOT EXISTS tile_delete AFTER DELETE ON tiles BEGIN
                UPDATE accounting SET size=size-OLD.size WHERE id=1;
            END;
        """)
        # Legacy identities are promoted to current identities on validated hits.
        with self.db:
            self._evict()
        # One legacy scan per process start, never per tile. Each committed import
        # precedes unlink, so interruption leaves either copy available on restart.
        for path in directory.glob("*.tile"):
            if len(path.stem) == 64 and all(c in "0123456789abcdef" for c in path.stem):
                try:
                    accessed = path.stat().st_mtime
                    self.put("legacy:" + path.stem, path.read_bytes(), accessed=accessed)
                    path.unlink(missing_ok=True)
                except FileNotFoundError:  # Another local process migrated it.
                    pass

    def get(self, key: str) -> bytes | None:
        with self.lock, self.db:
            row = self.db.execute("SELECT data FROM tiles WHERE key=?", (key,)).fetchone()
            if row is None:
                return None
            self.db.execute("UPDATE tiles SET accessed=? WHERE key=?", (time.time(), key))
            return bytes(row[0])

    def delete(self, key: str) -> None:
        with self.lock, self.db:
            self.db.execute("DELETE FROM tiles WHERE key=?", (key,))

    def put(self, key: str, data: bytes, *, accessed: float | None = None) -> None:
        if len(data) > self.capacity:
            return
        with self.lock:
            # IMMEDIATE makes quota + eviction atomic across separate editor processes.
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self.db.execute("DELETE FROM tiles WHERE key=?", (key,))
                self.db.execute(
                    "INSERT INTO tiles VALUES (?, ?, ?, ?)",
                    (key, data, len(data), time.time() if accessed is None else accessed),
                )
                self._evict()
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise
            self.db.execute("PRAGMA incremental_vacuum(64)")

    def _evict(self) -> None:
        total = self.db.execute("SELECT size FROM accounting WHERE id=1").fetchone()[0]
        while total > self.capacity:
            rows = self.db.execute("SELECT key, size FROM tiles ORDER BY accessed LIMIT 32").fetchall()
            for key, size in rows:
                if total <= self.capacity:
                    break
                self.db.execute("DELETE FROM tiles WHERE key=?", (key,))
                total -= size

    def close(self) -> None:
        with self.lock:
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.db.close()
