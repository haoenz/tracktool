"""File deduplication: MD5 hash log, duplicate detection, directory comparison.

The hash log is a JSON file mapping absolute paths to
{"MD5": ..., "LastWriteTime": ...}; hashing is skipped when the stored
LastWriteTime matches the file's mtime, so unchanged trees re-hash nothing.
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from . import log
from .context import ctx
from .discover import leaf_files
from .progress import run_parallel


def _load_hash_log(hash_log_path: Path) -> dict:
    if not hash_log_path.is_file():
        return {}
    return json.loads(hash_log_path.read_text(encoding="utf-8"))


def _md5(path: Path) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


@dataclass
class FileHash:
    path: Path
    md5: str
    last_write_time: str


@dataclass
class DirectoryHash:
    directory: Path
    hashes: list[FileHash]


def _update_files_hash_log(files: list[Path], hash_log: dict) -> tuple[int, int]:
    """Compute hashes for new/modified files in place; returns (added, updated)."""
    counters = {"add": 0, "update": 0}

    def process(file: Path) -> None:
        file_name = str(file)
        file_time = file.stat().st_mtime
        entry = hash_log.get(file_name)

        if entry is None:
            log.debug("New file; hashing", target=file_name)
            counters["add"] += 1
        elif "MD5" not in entry:
            log.debug("Cached entry has no MD5; hashing", target=file_name)
            counters["add"] += 1
        elif entry.get("LastWriteTime", 0) < file_time:
            log.debug("File changed since last run; rehashing", target=file_name)
            counters["update"] += 1
        elif entry.get("LastWriteTime", 0) == file_time:
            return
        else:
            log.warning("File last-write time is older than hash log entry; keeping existing hash", target=file_name)
            return

        hash_log[file_name] = {"MD5": _md5(file), "LastWriteTime": file_time}

    # I/O 密集且无 --parallel 旗标：哈希始终走线程池
    run_parallel(files, process, parallel=True, on_progress=ctx.reporter("Hashing files"))
    return counters["add"], counters["update"]


def get_directories_hash(directories: list[Path], include: str = ".*", exclude: str = "^$",
                         hash_log_path: Path | None = None, prune: bool = False) -> list[DirectoryHash]:
    """Compute/update MD5 hashes for files in directories, optionally persisted."""
    hash_log: dict = {}
    if hash_log_path is not None:
        log.debug("Loading hash log from file", target=str(hash_log_path))
        if prune:
            log.info("Pruning obsolete entries from hash log", target=str(hash_log_path))
            prune_hash_log(hash_log_path)
        hash_log = _load_hash_log(hash_log_path)

    target_files: dict[Path, list[Path]] = {}
    for directory in directories:
        target_files[directory] = leaf_files(directory, include, exclude)

    add_count = update_count = 0
    for directory, files in target_files.items():
        log.info("Computing hashes for directory", target=str(directory))
        added, updated = _update_files_hash_log(files, hash_log)
        add_count += added
        update_count += updated

    if hash_log_path is not None:
        if ctx.is_plan:
            # 哈希本身是只读的，只有日志落盘这一步属于预演该拦下的
            log.info(f"Would update the hash log: {add_count} added, {update_count} updated",
                     target=str(hash_log_path))
        else:
            if add_count == 0 and update_count == 0:
                log.debug("No changes to hash log", target=str(hash_log_path))
            else:
                log.info(f"Hash log updated: {add_count} added, {update_count} updated",
                         target=str(hash_log_path))
            hash_log_path.write_text(json.dumps(hash_log, indent=2), encoding="utf-8")

    return [
        DirectoryHash(
            directory=directory,
            hashes=[
                FileHash(
                    path=file,
                    md5=hash_log.get(str(file), {}).get("MD5", ""),
                    last_write_time=hash_log.get(str(file), {}).get("LastWriteTime", 0),
                )
                for file in files
            ],
        )
        for directory, files in target_files.items()
    ]


def compare_directories(directories: list[Path], include: str = ".*", exclude: str = "^$",
                        unique: bool = False, hash_log_path: Path | None = None) -> dict[Path, list[Path]]:
    """Compare directories by MD5.

    unique=True: files not present in ANY other directory.
    unique=False (default): files missing from AT LEAST ONE other directory.
    """
    dir_hashes = get_directories_hash(directories, include, exclude, hash_log_path)
    log.info(f"Comparing {len(directories)} directories")

    md5_sets = [{h.md5 for h in d.hashes} for d in dir_hashes]

    result: dict[Path, list[Path]] = {}
    for current in dir_hashes:
        others = [s for d, s in zip(dir_hashes, md5_sets, strict=True) if d is not current]
        if unique:
            result[current.directory] = [h.path for h in current.hashes
                                         if not any(h.md5 in s for s in others)]
        else:
            result[current.directory] = [h.path for h in current.hashes
                                         if any(h.md5 not in s for s in others)]
    return result


@dataclass
class DuplicateGroup:
    md5: str
    files: list[Path]


def find_duplicate_files(directory: Path, hash_log_path: Path | None = None) -> list[DuplicateGroup]:
    """Group files with identical MD5; returns groups with more than one file."""
    hashes = get_directories_hash([directory], prune=True, hash_log_path=hash_log_path)

    log.info("Searching for duplicate files by MD5 hash", target=str(directory))
    groups: dict[str, list[Path]] = {}
    for entry in hashes[0].hashes:
        groups.setdefault(entry.md5, []).append(entry.path)

    duplicates = [DuplicateGroup(md5=md5, files=files) for md5, files in sorted(groups.items()) if len(files) > 1]
    log.info(f"Found {len(duplicates)} duplicate file groups", target=str(directory))
    return duplicates


def prune_hash_log(hash_log_path: Path) -> None:
    """Drop entries whose files no longer exist."""
    hash_log = _load_hash_log(hash_log_path)

    def file_still_exists(path_str: str) -> bool:
        if not Path(path_str).is_file():
            log.debug("File no longer exists", target=path_str)
            return False
        return True

    kept = run_parallel(list(hash_log.keys()), file_still_exists, parallel=True,
                        on_progress=ctx.reporter("Clearing hash log"))
    removed_count = len(hash_log) - sum(1 for keep in kept if keep)

    if removed_count:
        new_log = {path: hash_log[path] for path, keep in zip(list(hash_log), kept, strict=False) if keep}
        if ctx.is_plan:
            log.info(f"Would remove {removed_count} obsolete entries", target=str(hash_log_path))
            return
        log.info(f"Removed {removed_count} obsolete entries", target=str(hash_log_path))
        hash_log_path.write_text(json.dumps(new_log, indent=2), encoding="utf-8")
    else:
        log.debug("No obsolete entries", target=str(hash_log_path))
