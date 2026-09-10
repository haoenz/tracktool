"""File deduplication: MD5 hash log, duplicate detection, directory comparison.

Ports Get-DirectoriesHash / Compare-Directories / Find-DuplicateFiles /
Clear-HashLog. The hash log is a JSON file mapping absolute paths to
{"MD5": ..., "LastWriteTime": ...}; hashing is skipped when the stored
LastWriteTime matches the file's mtime.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import log
from .progress import run_parallel


def get_leaf_files(path: Path, include: str = ".*", exclude: str = "^$") -> list[Path]:
    """Recursively scan a directory, filtering by regex on the full path."""
    include_re = re.compile(include, re.IGNORECASE)
    exclude_re = re.compile(exclude, re.IGNORECASE)
    log.debug("Scanning directory for files...", target=str(path))
    return [f for f in sorted(path.rglob("*"))
            if f.is_file() and include_re.search(str(f)) and not exclude_re.search(str(f))]


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
            log.debug("Adding file...", target=file_name)
            counters["add"] += 1
        elif "MD5" not in entry:
            log.debug("Creating hash...", target=file_name)
            counters["add"] += 1
        elif entry.get("LastWriteTime", 0) < file_time:
            log.debug("Updating hash...", target=file_name)
            counters["update"] += 1
        elif entry.get("LastWriteTime", 0) == file_time:
            return
        else:
            log.warning("File LWT earlier than log", target=file_name)
            return

        hash_log[file_name] = {"MD5": _md5(file), "LastWriteTime": file_time}

    run_parallel(files, process, activity="Hashing files")
    return counters["add"], counters["update"]


def get_directories_hash(directories: list[Path], include: str = ".*", exclude: str = "^$",
                         hash_log_path: Path | None = None, clear_invalid: bool = False) -> list[DirectoryHash]:
    """Compute/update MD5 hashes for files in directories, optionally persisted."""
    hash_log: dict = {}
    if hash_log_path is not None:
        log.debug("Loading hash log from file", target=str(hash_log_path))
        if clear_invalid:
            log.info("Clearing invalid entries from hash log", target=str(hash_log_path))
            clear_hash_log(hash_log_path)
        hash_log = _load_hash_log(hash_log_path)

    target_files: dict[Path, list[Path]] = {}
    for directory in directories:
        target_files[directory] = get_leaf_files(directory, include, exclude)

    add_count = update_count = 0
    for directory, files in target_files.items():
        log.info("Computing hashes for directory", target=str(directory))
        added, updated = _update_files_hash_log(files, hash_log)
        add_count += added
        update_count += updated

    if hash_log_path is not None:
        if add_count == 0 and update_count == 0:
            log.debug("No changes to hash log", target=str(hash_log_path))
        else:
            log.info(f"Hash log updated: {add_count} added, {update_count} updated", target=str(hash_log_path))
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

    result: dict[Path, list[Path]] = {}
    if unique:
        for current in dir_hashes:
            other_md5s = {h.md5 for other in dir_hashes if other is not current for h in other.hashes}
            result[current.directory] = [h.path for h in current.hashes if h.md5 not in other_md5s]
    else:
        for current in dir_hashes:
            others = [other for other in dir_hashes if other is not current]
            files = []
            for h in current.hashes:
                if any(h.md5 not in {o.md5 for o in other.hashes} for other in others):
                    files.append(h.path)
            result[current.directory] = files
    return result


@dataclass
class DuplicateGroup:
    md5: str
    files: list[Path]


def find_duplicate_files(directory: Path, hash_log_path: Path | None = None) -> list[DuplicateGroup]:
    """Group files with identical MD5; returns groups with more than one file."""
    hashes = get_directories_hash([directory], clear_invalid=True, hash_log_path=hash_log_path)

    log.info("Searching for duplicate files by MD5 hash", target=str(directory))
    groups: dict[str, list[Path]] = {}
    for entry in hashes[0].hashes:
        groups.setdefault(entry.md5, []).append(entry.path)

    duplicates = [DuplicateGroup(md5=md5, files=files) for md5, files in sorted(groups.items()) if len(files) > 1]
    log.info(f"Found {len(duplicates)} duplicate file groups", target=str(directory))
    return duplicates


def clear_hash_log(hash_log_path: Path) -> None:
    """Drop entries whose files no longer exist."""
    hash_log = _load_hash_log(hash_log_path)

    def check(path_str: str) -> bool:
        if not Path(path_str).is_file():
            log.debug("File no longer exists", target=path_str)
            return False
        return True

    kept = run_parallel(list(hash_log.keys()), check, activity="Clearing hash log")
    removed_count = len(hash_log) - sum(1 for keep in kept if keep)

    if removed_count:
        log.info(f"Removed {removed_count} obsolete entries", target=str(hash_log_path))
        new_log = {path: hash_log[path] for path, keep in zip(list(hash_log), kept, strict=False) if keep}
        hash_log_path.write_text(json.dumps(new_log, indent=2), encoding="utf-8")
    else:
        log.debug("No obsolete entries", target=str(hash_log_path))
