"""SQLite archive primitives. Connections are short lived and thread confined.

Raw objects are authoritative; index rows are disposable. No config or rendering
code is imported here. File operations use durable intent rows, not undo history.
"""

import hashlib
import json
import lzma
import os
import re
import sqlite3
import tempfile
import uuid
import zipfile
import zlib
from collections.abc import Iterator
from compression.zstd import ZstdError
from contextlib import contextmanager
from pathlib import Path

from ..errors import UserInputError

DB_NAME = "archive.sqlite3"
SCHEMA_VERSION = 2
_SCHEMA = """
CREATE TABLE archive_meta (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, zip_revision INTEGER, zip_target TEXT,
 views_revision INTEGER, zip_name TEXT NOT NULL DEFAULT 'Archive.zip');
CREATE TABLE kml_objects (
 sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64), codec TEXT NOT NULL CHECK(codec='zlib'),
 raw_size INTEGER NOT NULL CHECK(raw_size>=0), payload BLOB NOT NULL);
CREATE TABLE archive_entries (
 id TEXT PRIMARY KEY, path TEXT NOT NULL COLLATE BINARY UNIQUE,
 sha256 TEXT NOT NULL REFERENCES kml_objects(sha256),
 category TEXT CHECK(category IN ('Default','Train','Flight')), filename_date TEXT);
CREATE INDEX entries_content ON archive_entries(sha256);
CREATE INDEX entries_category_date ON archive_entries(category,filename_date);
CREATE TABLE kml_index (
 sha256 TEXT NOT NULL REFERENCES kml_objects(sha256) ON DELETE CASCADE,
 parser_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ok','error')),
 metadata TEXT NOT NULL, geometry BLOB, error TEXT,
 PRIMARY KEY(sha256,parser_version));
CREATE TABLE map_projects (
 name TEXT PRIMARY KEY COLLATE BINARY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE file_operations (
 id TEXT PRIMARY KEY, operation TEXT NOT NULL CHECK(operation IN ('push','pop')),
 entry_id TEXT NOT NULL REFERENCES archive_entries(id), sha256 TEXT NOT NULL REFERENCES kml_objects(sha256),
 source TEXT, target TEXT NOT NULL);
CREATE UNIQUE INDEX operation_entry ON file_operations(entry_id);
CREATE TRIGGER entry_insert AFTER INSERT ON archive_entries BEGIN
 UPDATE archive_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER entry_delete AFTER DELETE ON archive_entries BEGIN
 UPDATE archive_meta SET revision=revision+1 WHERE singleton=1; END;
CREATE TRIGGER entry_update AFTER UPDATE OF path,sha256,category ON archive_entries
 WHEN OLD.path!=NEW.path OR OLD.sha256!=NEW.sha256 OR OLD.category IS NOT NEW.category BEGIN
 UPDATE archive_meta SET revision=revision+1 WHERE singleton=1; END;
"""


# Ordered, explicit transactional migrations. Normal reads never apply these.
_MIGRATIONS = {
    1: [
        "DROP INDEX operation_entry",
        "CREATE INDEX operation_entry ON file_operations(entry_id)",
        "CREATE UNIQUE INDEX operation_source ON file_operations(entry_id,source)",
        "CREATE TABLE export_receipts (target TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
        "INSERT INTO export_receipts SELECT zip_target,zip_revision FROM archive_meta "
        "WHERE zip_target IS NOT NULL AND zip_revision IS NOT NULL",
    ],
}


def _upgrade(db: sqlite3.Connection, version: int) -> None:
    if version < 1 or version > SCHEMA_VERSION:
        raise UserInputError(f"Unsupported database schema {version}; no migration available")
    while version < SCHEMA_VERSION:
        for sql in _MIGRATIONS[version]:
            db.execute(sql)
        version += 1
        db.execute(f"PRAGMA user_version={version}")


def migrate(path: Path) -> None:
    if not path.is_file():
        raise UserInputError(f"Database missing: {path}; use import-zip")
    try:
        db = sqlite3.connect(path, timeout=30, isolation_level=None)
    except sqlite3.Error as exc:
        raise UserInputError(f"Cannot open database for migration: {exc}") from exc
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN EXCLUSIVE")
        _upgrade(db, db.execute("PRAGMA user_version").fetchone()[0])
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise UserInputError("Database foreign key check failed")
        db.commit()
        db.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error as exc:
        db.rollback()
        raise UserInputError(f"Database migration failed and rolled back: {exc}") from exc
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def database_path(path: str | Path) -> Path:
    path = Path(path).expanduser().resolve()
    return path / DB_NAME if path.is_dir() else path if path.suffix == ".sqlite3" else path.parent / DB_NAME


@contextmanager
def connect(path: Path, *, write: bool = False) -> Iterator[sqlite3.Connection]:
    """Existing databases only. WAL readers coexist with one timed writer.

    Readers use a transaction snapshot. Writers acquire their reservation before
    reading, avoiding deferred-transaction upgrade failures. No shared handles.
    """
    if not path.is_file():
        raise UserInputError(f"SQLite archive not found: {path}; run `archive import-zip ZIP DIRECTORY` explicitly")
    try:
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=rw", uri=True, timeout=30, isolation_level=None)
    except sqlite3.Error as exc:
        raise UserInputError(f"Cannot open SQLite archive {path}: {exc}") from exc
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=30000")
        db.execute("PRAGMA synchronous=FULL")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version != SCHEMA_VERSION:
            raise UserInputError(
                f"Unsupported database schema {version}; expected {SCHEMA_VERSION}; run archive migrate"
            )
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield db
        db.commit()
    except sqlite3.Error as exc:
        db.rollback()
        raise UserInputError(f"SQLite archive {path}: {exc}") from exc
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def sync_directory(directory: Path) -> None:
    if os.name != "nt":
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def validate_member(path: str) -> None:
    if (
        not path
        or "\\" in path
        or "\x00" in path
        or ":" in path
        or any(ord(c) < 32 for c in path)
        or any(p in ("", ".", "..") for p in path.split("/"))
    ):
        raise UserInputError(f"Illegal archive member path: {path!r}")


def put_object(db: sqlite3.Connection, raw: bytes) -> str:
    digest = hashlib.sha256(raw).hexdigest()
    db.execute("INSERT OR IGNORE INTO kml_objects VALUES (?,?,?,?)", (digest, "zlib", len(raw), zlib.compress(raw)))
    return digest


def read_object(db: sqlite3.Connection, digest: str) -> bytes:
    row = db.execute("SELECT * FROM kml_objects WHERE sha256=?", (digest,)).fetchone()
    if row is None:
        raise UserInputError(f"Missing KML object: {digest}")
    try:
        raw = zlib.decompress(row["payload"])
    except zlib.error as exc:
        raise UserInputError(f"Corrupt KML object {digest}: {exc}") from exc
    if len(raw) != row["raw_size"] or hashlib.sha256(raw).hexdigest() != digest:
        raise UserInputError(f"KML object integrity check failed: {digest}")
    return raw


def add_entry(db: sqlite3.Connection, path: str, raw: bytes, category: str | None) -> tuple[str, str, bool]:
    validate_member(path)
    if not path.lower().endswith(".kml"):
        raise UserInputError(f"Archive member must have a .kml extension: {path}")
    if category not in (None, "Default", "Train", "Flight"):
        raise UserInputError(f"Unknown archive category: {category}")
    digest = hashlib.sha256(raw).hexdigest()
    existing = db.execute("SELECT id,sha256 FROM archive_entries WHERE path=?", (path,)).fetchone()
    if existing:
        if existing["sha256"] != digest:
            raise UserInputError(f"Archive path conflict (different content): {path}; source retained")
        return existing["id"], digest, False
    put_object(db, raw)
    identity = uuid.uuid4().hex
    date = re.search(r"\d{4}-\d{2}-\d{2}", path.rsplit("/", 1)[-1])
    db.execute(
        "INSERT INTO archive_entries VALUES (?,?,?,?,?)", (identity, path, digest, category, date[0] if date else None)
    )
    return identity, digest, True


def create_database(target: Path, zip_source: Path | None = None, zip_name: str = "Archive.zip") -> None:
    """Validate a staged DELETE-journal database, then publish with no overwrite.

    ZIP reads validate CRC; staging verifies SHA, FKs and SQLite integrity. No
    manifest or machine configuration is needed. Unsupported KML is raw data.
    """
    from . import xmlutil
    from .kmlfile import TrackKind, kind_from_tree

    if target.exists():
        raise UserInputError(f"Database already exists (not overwritten): {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".archive-import-", suffix=".sqlite3", dir=target.parent)
    os.close(fd)
    stage = Path(name)
    try:
        db = sqlite3.connect(stage)
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript(_SCHEMA)
            db.execute(
                "INSERT INTO archive_meta(singleton,archive_id,zip_name) VALUES(1,?,?)", (uuid.uuid4().hex, zip_name)
            )
            if zip_source is not None:
                with zipfile.ZipFile(zip_source) as source:
                    seen: set[str] = set()
                    for info in source.infolist():
                        member = info.filename.rstrip("/") if info.is_dir() else info.filename
                        if info.orig_filename != info.filename:
                            raise UserInputError(f"Truncated/illegal ZIP member path: {info.orig_filename!r}")
                        validate_member(member)
                        if info.filename in seen:
                            raise UserInputError(f"Duplicate ZIP member path: {info.filename}")
                        seen.add(info.filename)
                        if (info.external_attr >> 16) & 0o170000 == 0o120000:
                            raise UserInputError(f"Symlink ZIP member is not supported: {info.filename}")
                        raw = source.read(info)  # CRC-check even non-KML entries.
                        if info.is_dir():
                            continue
                        if not info.filename.lower().endswith(".kml"):
                            raise UserInputError(
                                f"Non-KML ZIP member cannot be restored by this archive: {info.filename}"
                            )
                        first = info.filename.split("/")[0]
                        category = first if "/" in info.filename and first in {k.value for k in TrackKind} else None
                        if "/" not in info.filename:
                            try:
                                tree = xmlutil.parse_string(raw)
                                kind = kind_from_tree(tree) if xmlutil.doc_ns(tree) else None  # fixed built-in mapping
                                category = kind.value if kind else None
                            except UserInputError:
                                pass
                        add_entry(db, info.filename, raw, category)
            db.execute("PRAGMA user_version=1")
            _upgrade(db, 1)
            db.commit()
            db.execute("PRAGMA journal_mode=WAL")
            if (
                db.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                or db.execute("PRAGMA foreign_key_check").fetchall()
            ):
                raise UserInputError("Imported database failed integrity checks")
            for row in db.execute("SELECT sha256 FROM kml_objects"):
                db.row_factory = sqlite3.Row
                read_object(db, row[0])
        finally:
            db.close()
        with stage.open("rb") as handle:
            os.fsync(handle.fileno())
        os.link(stage, target)  # exclusive publish; another initializer cannot be overwritten
        sync_directory(target.parent)
    except (
        OSError,
        zipfile.BadZipFile,
        RuntimeError,
        EOFError,
        UnicodeError,
        zlib.error,
        lzma.LZMAError,
        ZstdError,
        sqlite3.Error,
    ) as exc:
        if target.is_file() and stage.is_file() and os.path.samefile(target, stage):
            target.unlink()  # failure syncing exclusive publication; never remove another initializer's file
        raise UserInputError(f"Archive import failed; existing data retained: {exc}") from exc
    finally:
        stage.unlink(missing_ok=True)


def write_exclusive(target: Path, raw: bytes) -> None:
    """Durable, no-clobber publication. Identical targets make retries idempotent."""
    if target.exists():
        if target.is_symlink() or target.read_bytes() != raw:
            raise UserInputError(f"Output conflict; file retained: {target}")
        with target.open("rb") as handle:
            os.fsync(handle.fileno())
        sync_directory(target.parent)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".tracktool-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(name, target)
        sync_directory(target.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def recover(path: Path) -> int:
    """Finish committed intents. Never delete a source without a durable copy.

    Hold the writer lock over external steps: other push/pop/recover commands
    cannot race the same intent. Crashes leave either the intent or its result.
    """
    completed = 0
    with connect(path, write=True) as db:
        for op in db.execute("SELECT * FROM file_operations ORDER BY rowid").fetchall():
            raw = read_object(db, op["sha256"])
            target = Path(op["target"])
            write_exclusive(target, raw)
            if op["operation"] == "push":
                source = Path(op["source"])
                if source.resolve() != target.resolve() and source.exists():
                    if source.is_symlink() or source.read_bytes() != raw:
                        raise UserInputError(f"Source changed; retained with pending recovery: {source}")
                    source.unlink()
                    sync_directory(source.parent)
            db.execute("DELETE FROM file_operations WHERE id=?", (op["id"],))
            if op["operation"] == "pop":
                db.execute("DELETE FROM archive_entries WHERE id=? AND sha256=?", (op["entry_id"], op["sha256"]))
            completed += 1
        db.execute(
            "DELETE FROM kml_objects WHERE sha256 NOT IN (SELECT sha256 FROM archive_entries) "
            "AND sha256 NOT IN (SELECT sha256 FROM file_operations)"
        )
    return completed


def queue_operation(
    db: sqlite3.Connection, operation: str, entry_id: str, digest: str, target: Path, source: Path | None = None
) -> None:
    db.execute(
        "INSERT INTO file_operations VALUES (?,?,?,?,?,?)",
        (
            uuid.uuid4().hex,
            operation,
            entry_id,
            digest,
            str(source.resolve()) if source else None,
            str(target.absolute()),
        ),
    )


def export_zip(path: Path, target: Path) -> int:
    """Export one snapshot, verify each member, then replace. Mark that revision only."""
    target = target.expanduser().resolve()
    if target == path.resolve() or target.suffix.lower() != ".zip":
        raise UserInputError("ZIP export target must be a .zip file distinct from the database")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".archive-export-", suffix=".zip", dir=target.parent)
    os.close(fd)
    stage = Path(name)
    try:
        with connect(path) as db:
            revision = db.execute("SELECT revision FROM archive_meta").fetchone()[0]
            entries = db.execute("SELECT path,sha256 FROM archive_entries ORDER BY path").fetchall()
            with zipfile.ZipFile(stage, "w", zipfile.ZIP_DEFLATED) as output:
                for entry in entries:
                    output.writestr(entry["path"], read_object(db, entry["sha256"]))
            with zipfile.ZipFile(stage) as output:
                if output.namelist() != [e["path"] for e in entries]:
                    raise UserInputError("Export member set verification failed")
                for entry in entries:
                    if hashlib.sha256(output.read(entry["path"])).hexdigest() != entry["sha256"]:
                        raise UserInputError(f"Export integrity check failed: {entry['path']}")
        with stage.open("rb") as handle:
            os.fsync(handle.fileno())
        # Serialize publication and marker commit. Retain a hard-linked previous
        # export until both directory sync and the database commit have succeeded.
        with connect(path, write=True) as db:
            receipt = db.execute("SELECT revision FROM export_receipts WHERE target=?", (str(target),)).fetchone()
            if receipt is not None and receipt[0] > revision:
                raise UserInputError("A newer ZIP snapshot was already published; retry export")
            previous = stage.with_suffix(".previous")
            had_previous = target.exists()
            published = False
            committed = False
            restored = False
            try:
                if had_previous:
                    os.link(target, previous)
                os.replace(stage, target)
                published = True
                sync_directory(target.parent)
                db.execute("UPDATE archive_meta SET zip_revision=?,zip_target=?", (revision, str(target)))
                db.execute("INSERT OR REPLACE INTO export_receipts VALUES (?,?)", (str(target), revision))
                db.commit()
                committed = True
            except BaseException:
                if published or not stage.exists():
                    published = True
                    if had_previous:
                        os.replace(previous, target)
                    else:
                        target.unlink()
                    restored = True
                    sync_directory(target.parent)
                raise
            finally:
                # If rollback itself failed, leave the previous export recoverable.
                if committed or restored or not published:
                    previous.unlink(missing_ok=True)
        return revision
    finally:
        stage.unlink(missing_ok=True)


def project_names(path: Path) -> list[str]:
    with connect(path) as db:
        return [r[0] for r in db.execute("SELECT name FROM map_projects ORDER BY name")]


def save_project(path: Path, name: str, state: dict) -> None:
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise UserInputError("项目名称需为 1–120 字")
    with connect(path, write=True) as db:
        db.execute(
            "INSERT INTO map_projects VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
            "ON CONFLICT(name) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at",
            (name, json.dumps(state, ensure_ascii=False, allow_nan=False)),
        )


def load_project(path: Path, name: str) -> dict:
    with connect(path) as db:
        row = db.execute("SELECT state FROM map_projects WHERE name=?", (name,)).fetchone()
        if row is None:
            raise UserInputError(f"项目不存在：{name}")
        return json.loads(row[0])
