"""Archive business rules. SQLite owns content; ZIP/collections are exports."""

import hashlib
import os
import tempfile
import zlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from .. import log
from ..context import ctx
from ..errors import UserInputError
from ..workspace import DEFAULT_ZIP_NAME, resolve_archive
from . import collections, kmlfile, storage, xmlutil
from .kmlfile import TrackKind

UNCLASSIFIED = "_unclassified"
EMPTY_ZIP_HASH = hashlib.sha256().hexdigest()


@dataclass(frozen=True)
class ZipEntry:
    """Historical API name: now an exact SQLite member identity."""

    path: str
    kind: TrackKind | None

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[-1]


def entry_kind_from_path(entry_name: str) -> TrackKind | None:
    if "/" not in entry_name:
        return None
    try:
        return TrackKind(entry_name.split("/", 1)[0])
    except ValueError:
        return None


def init_archive(directory: Path, zip_name: str = DEFAULT_ZIP_NAME) -> None:
    directory = directory.expanduser().resolve()
    if (directory / zip_name).exists() or (directory / "archive.json").exists():
        raise UserInputError("Legacy archive exists; use `archive import-zip ZIP DIRECTORY`; no files were changed")
    if ctx.is_plan:
        log.info("Would create SQLite archive", target=directory)
        return
    storage.create_database(directory / storage.DB_NAME, zip_name=zip_name)
    log.info("Created SQLite archive; generate backup with `archive backup`", target=directory)


def ensure_archive_directory(archive_dir: Path) -> None:
    if not ctx.is_plan:
        archive_dir.mkdir(parents=True, exist_ok=True)


def require_zip_file(zip_file: Path) -> None:
    with storage.connect(storage.database_path(zip_file)):
        pass


def ensure_zip_file(zip_file: Path) -> None:
    require_zip_file(zip_file)


def zip_entry_name(kml_path: Path, kind: str) -> str:
    try:
        _, yyyymm = collections.desktop_date(kml_path)
    except UserInputError:
        return f"{kind}/{kml_path.name}"
    return f"{kind}/{yyyymm[:4]}-{yyyymm[4:]}/{kml_path.name}"


def push_compressed_kmls(
    entries: Sequence[tuple[Path, str]],
    zip_path: Path,
    *,
    on_entry: Callable[[], None] | None = None,
    move: bool = False,
) -> list[str]:
    """Insert a batch and durable move intents atomically; then finish moves."""
    path = storage.database_path(zip_path)
    added: list[str] = []
    if ctx.is_plan:
        log.info(f"Would insert {len(entries)} KML(s) into SQLite; move sources={move}")
        return added
    storage.recover(path)
    with storage.connect(path, write=True) as db:
        for source, kind in dict.fromkeys(entries):
            source = source.absolute()
            if source.is_symlink():
                raise UserInputError(f"Source symlinks are not consumed: {source}")
            name = zip_entry_name(source, kind)
            raw = source.read_bytes()
            identity, digest, inserted = storage.add_entry(db, name, raw, None if kind == UNCLASSIFIED else kind)
            if inserted:
                added.append(name)
            else:
                log.warning(f"Identical archive member already exists: {name}")
            if move:
                target = path.parent / ctx.config.kml_backup_dir_name / source.name
                if target.resolve() != source.resolve():
                    # Preserve the established backup conflict behavior: leave source.
                    if target.exists() and (target.is_symlink() or target.read_bytes() != raw):
                        log.warning(f"Backup conflict; source retained: {source}")
                    elif (
                        db.execute(
                            "SELECT 1 FROM file_operations WHERE entry_id=? AND source=?",
                            (identity, str(source.resolve())),
                        ).fetchone()
                        is None
                    ):
                        storage.queue_operation(db, "push", identity, digest, target, source)
            if on_entry:
                on_entry()
    storage.recover(path)
    log.info("SQLite updated. ZIP/collections are exports; run `archive backup` / `archive rebuild`.")
    return added


def push_compressed_kml(kml_path: Path, zip_path: Path, *, tag_map: Mapping[str, str] | None = None) -> None:
    kind = kmlfile.get_kml_type(kml_path, tag_map=tag_map)
    push_compressed_kmls([(kml_path, kind.value if kind else UNCLASSIFIED)], zip_path)


def find_zip_entry(
    kml_name: str, zip_path: Path, type_: TrackKind | None = None, *, tag_map: Mapping[str, str] | None = None
) -> ZipEntry | None:
    if not kml_name or "/" in kml_name or "\\" in kml_name:
        raise UserInputError("Use a complete track filename or stem, without directories")
    with storage.connect(storage.database_path(zip_path)) as db:
        matches = [
            ZipEntry(r["path"], TrackKind(r["category"]) if r["category"] else None)
            for r in db.execute("SELECT path,category FROM archive_entries ORDER BY path")
            if kml_name in (Path(r["path"]).name, Path(r["path"]).stem)
            and (type_ is None or r["category"] == type_.value)
        ]
    if len(matches) > 1:
        raise UserInputError(f"Ambiguous track {kml_name!r}: " + ", ".join(e.path for e in matches) + " (use --type)")
    return matches[0] if matches else None


def pop_zip_entry(entry_name: str, zip_path: Path, output_directory: Path = Path(".")) -> Path | None:
    path = storage.database_path(zip_path)
    target = output_directory.absolute() / Path(entry_name).name
    if ctx.is_plan:
        if target.exists() or target.is_symlink():
            raise UserInputError(f"Output already exists at destination: {target}")
        log.info(f"Would restore {entry_name} from SQLite into {output_directory}")
        return None
    storage.recover(path)
    with storage.connect(path, write=True) as db:
        row = db.execute("SELECT id,sha256 FROM archive_entries WHERE path=?", (entry_name,)).fetchone()
        if row is None:
            raise UserInputError(f"KML entry not found: {entry_name}")
        if target.exists() or target.is_symlink():
            raise UserInputError(f"Output already exists; move it aside before pop: {target}")
        storage.queue_operation(db, "pop", row["id"], row["sha256"], target)
    storage.recover(path)
    log.info("Restored exact KML bytes; backup ZIP and collections may be stale", target=target)
    return target


def pop_compressed_kml(kml_name: str, zip_path: Path, output_directory: Path = Path(".")) -> None:
    entry = find_zip_entry(kml_name, zip_path)
    if entry is None:
        raise UserInputError(f"KML entry not found: {kml_name}")
    pop_zip_entry(entry.path, zip_path, output_directory)


def pop_kml_archive(
    kml_name: str,
    type_: TrackKind | None = None,
    zip_path: str | None = None,
    force: bool = False,
    *,
    tag_map: Mapping[str, str] | None = None,
) -> None:
    zip_file = resolve_archive(zip_path)[1]
    if force:
        log.warning("--force is no longer needed for derived collections; output conflicts are never overwritten")
    entry = find_zip_entry(kml_name, zip_file, type_)
    if entry is None:
        raise UserInputError(f"KML entry not found: {kml_name}")
    pop_zip_entry(entry.path, zip_file)


def current_hash(zip_file: Path) -> str:
    return archive_hash(zip_file)


def archive_hash(zip_file: Path) -> str:
    with storage.connect(storage.database_path(zip_file)) as db:
        digest = hashlib.sha256()
        for row in db.execute("SELECT path,sha256 FROM archive_entries ORDER BY path"):
            digest.update(row["path"].encode() + b"\0" + row["sha256"].encode() + b"\0")
        return digest.hexdigest()


def entry_metadata(entry_name: str, zip_path: Path) -> tuple[int, int]:
    with storage.connect(storage.database_path(zip_path)) as db:
        row = db.execute("SELECT sha256 FROM archive_entries WHERE path=?", (entry_name,)).fetchone()
        if row is None:
            raise UserInputError(f"KML entry not found: {entry_name}")
        raw = storage.read_object(db, row[0])
        return len(raw), zlib.crc32(raw)


def status(zip_path: str | None, *, tag_map: Mapping[str, str] | None = None) -> None:
    directory, _ = resolve_archive(zip_path)
    with storage.connect(directory / storage.DB_NAME) as db:
        meta = db.execute("SELECT * FROM archive_meta").fetchone()
        count = db.execute("SELECT count(*) FROM archive_entries").fetchone()[0]
        pending = db.execute("SELECT count(*) FROM file_operations").fetchone()[0]
        fresh = meta["revision"] == meta["zip_revision"] and meta["zip_target"] and Path(meta["zip_target"]).is_file()
        log.info(f"SQLite: {count} KML entries; revision {meta['revision']}")
        log.info(
            f"ZIP {'current' if fresh else 'STALE / missing'}; last exported revision {meta['zip_revision']}; "
            "generate backup: tracktool archive backup"
        )
        log.info(f"Collections revision: {meta['views_revision']}; pending file operations: {pending}")
        if pending:
            log.warning("Run `archive recover` to complete interrupted source moves / pop")
        log.info("History/undo retired; use pop to retrieve, push to rearchive, or import backup into a new directory")


def rebuild(zip_path: str | None, *, tag_map: Mapping[str, str] | None = None, output: Path | None = None) -> None:
    """Stage all aggregate views from one snapshot before publishing any files."""
    directory, _ = resolve_archive(zip_path)
    path = directory / storage.DB_NAME
    output = output or directory
    if ctx.is_plan:
        log.info("Would export aggregate KML from SQLite", target=output)
        return
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".collections-", dir=output) as name:
        stage = Path(name)
        with storage.connect(path) as db:
            revision = db.execute("SELECT revision FROM archive_meta").fetchone()[0]
            for kind in TrackKind:
                desktop_path, mobile_path = collections.collection_paths(kind, stage)
                desktop = collections.DesktopCollection(desktop_path, collections.new_empty_kml(kind))
                mobile = collections.MobileCollection(mobile_path, collections.new_empty_mobile_kml())
                for row in db.execute("SELECT * FROM archive_entries WHERE category=? ORDER BY path", (kind.value,)):
                    entry = Path(row["path"])
                    try:
                        collections.desktop_date(entry)
                        tree = xmlutil.parse_string(storage.read_object(db, row["sha256"]))
                        content = kmlfile.content_from_tree(tree, row["path"])
                        if not content.line_string:
                            raise UserInputError("No supported line geometry")
                        desktop.add(entry, content)
                        mobile.add(entry, content)
                    except UserInputError as exc:
                        log.warning(f"Not representable in aggregate (raw KML remains archived): {row['path']}: {exc}")
                desktop.save()
                mobile.save()
            unknown = db.execute("SELECT count(*) FROM archive_entries WHERE category IS NULL").fetchone()[0]
            if unknown:
                log.warning(f"{unknown} unclassified members omitted from aggregate; preserved in ZIP")
        # Each file atomic; a crash across files leaves the old revision marker.
        with storage.connect(path, write=True) as db:
            for file in sorted(stage.iterdir()):
                xmlutil.parse_file(file)
                with file.open("rb") as handle:
                    os.fsync(handle.fileno())
                os.replace(file, output / file.name)
            storage.sync_directory(output)
            if output.resolve() == directory:
                db.execute("UPDATE archive_meta SET views_revision=?", (revision,))
    log.info(f"Exported aggregate KML snapshot revision {revision}", target=output)
