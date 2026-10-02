"""Shared file-moving helpers and the per-file batch failure contract.

A batch owes its caller two answers: which files succeeded, and which did not.
run_per_file layers that contract on top of run_parallel — one file's failure is
logged with that file as target and never aborts the rest of the batch, and it
is counted in the returned BatchResult so the CLI can turn it into an exit code.

Quarantining covers the whole per-file operation, not only the EXIF write —
failures also arise from tag reads, media-time parsing, API calls and renames.
"""

import os
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import log
from .context import ctx
from .progress import run_parallel

# Sentinel marking a failed item inside run_per_file; unreachable by callers.
_FAILED: Any = object()


class FileFailure(Exception):
    """One file the batch was asked to process and could not.

    Raise it — after logging the reason with that file as target — instead of
    returning early: an early return leaves nothing behind but a log line, and
    the batch then reports success even when it processed nothing. The runner
    counts the file in BatchResult.failed and moves it into the failed folder,
    unless quarantine=False for a file that failed a check but should stay put.
    """

    def __init__(self, reason: str, *, quarantine: bool = True) -> None:
        super().__init__(reason)
        self.quarantine = quarantine


@dataclass
class BatchResult[R]:
    """One batch's outcome: each processed file's result in input order, plus
    the files that failed.

    `succeeded` holds one entry per file that was processed without error,
    `None` included — "processed and decided to skip" is still a success.
    `failed` is what the CLI turns into an exit code, so any file the batch
    could not process must land there.
    """

    succeeded: list[R] = field(default_factory=list)
    failed: list[Path] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failed

    def merge(self, other: BatchResult[Any]) -> None:
        """Absorb a nested batch's outcome (the stages of one command)."""
        self.succeeded += other.succeeded
        self.failed += other.failed


def move_to_folder(path: Path, folder_name: str, parent_directory: Path | None = None) -> bool:
    """Move file into folder_name, creating it if needed.

    Under PLAN mode the move is reported rather than made: a preview must not
    rearrange the directory it is previewing, and this is the one place every
    move of a file goes through. Returns True only when the file was moved.
    """
    target_parent = parent_directory if parent_directory is not None else path.parent
    target_dir = target_parent / folder_name
    target_path = target_dir / path.name
    if target_path.exists() or target_path.is_symlink():
        log.warning(f"File already exists in {folder_name} folder; not moved", target=str(target_path))
        return False
    if ctx.is_plan:
        log.info(f"Would move into {folder_name}", target=str(target_path))
        return False
    if not target_dir.is_dir():
        target_dir.mkdir(exist_ok=True)
        log.info(f"Created folder: {folder_name}", target=str(target_dir))
    shutil.move(str(path), str(target_path))
    log.verbose(f"Moved to {folder_name} folder", target=str(target_path))
    return True


def quarantine(path: Path, folder_name: str | None) -> None:
    """Move a failed file into the failure folder; no-op without one."""
    if folder_name and move_to_folder(path, folder_name):
        log.info(f"Failed file moved to {path.parent / folder_name / path.name}", target=str(path))


def _preflight_quarantine(files: list[Path], folder_name: str | None) -> set[Path]:
    """Return files eligible for automatic failure moves, before processing starts.

    An unusable directory disables automatic moves for this batch. Individual
    name conflicts only disable the affected moves. PLAN never creates a
    directory or write probe; APPLY prepares each directory once before workers.
    """
    if not folder_name or not files:
        return set()
    directories = list(dict.fromkeys(file.parent / folder_name for file in files))
    eligible = set(files)
    try:
        for directory in directories:
            ancestor = directory
            while not (ancestor.exists() or ancestor.is_symlink()):
                ancestor = ancestor.parent
            if not ancestor.is_dir():
                raise NotADirectoryError(f"Not a directory: {ancestor}")
            if not os.access(ancestor, os.W_OK | os.X_OK):
                raise PermissionError(f"Directory is not writable/searchable: {ancestor}")
        if not ctx.is_plan:
            for directory in directories:
                directory.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=directory, prefix=".tracktool-write-check-"):
                    pass

        owners: dict[str, list[Path]] = {}
        for file in files:
            target = file.parent / folder_name / file.name
            key = os.path.normcase(str(target.parent.resolve() / target.name))
            owners.setdefault(key, []).append(file)
            if target.exists() or target.is_symlink():
                eligible.discard(file)
                log.warning(f"Failure destination already exists; file will not be moved: {target}", target=str(file))
        for target_name, sources in owners.items():
            if len(sources) > 1:
                eligible.difference_update(sources)
                log.warning(f"Multiple inputs share failure destination; these files will not be moved: {target_name}")
    except (OSError, ValueError) as exc:
        log.warning(f"Automatic failure-file moves disabled for this batch: {exc}; processing will continue")
        return set()
    return eligible


def run_per_file[T, R](
    files: list[Path],
    process: Callable[[Path], R],
    *,
    activity: str = "Processing",
    failed_folder_name: str | None = None,
    parallel: bool = False,
) -> BatchResult[R]:
    """Apply process to every file; a per-file failure never aborts the batch.

    A FileFailure is the expected kind: the file was readable but could not be
    processed, its reason is already logged at the raising site, and only the
    counting happens here. Any other exception is unexpected and gets one
    entry of its own in the log. Both kinds end up in BatchResult.failed (in
    input order). Automatic moves are preflighted and best-effort: a directory
    or move failure must never interrupt processing of other files.

    Catching broadly is the point: a systemic failure (missing exiftool, bad
    API key) repeats the error per file instead of silently dropping the rest
    of the batch, and the failure count is what tells the caller nothing worked.

    The run mode changes nothing about the contract — the same files are
    counted — because a preview has to report the exit code of the run it
    previews; it only stops the quarantine move, which move_to_folder does.
    """

    eligible = _preflight_quarantine(files, failed_folder_name)

    def organize_failure(file: Path, reason: Exception) -> None:
        if file not in eligible:
            return
        try:
            quarantine(file, failed_folder_name)
        except Exception as exc:
            log.error(
                f"Processing failed: {reason}; could not move failed file: {exc}. Continuing the batch",
                target=str(file),
            )

    def guarded(file: Path) -> R:
        try:
            return process(file)
        except FileFailure as exc:
            log.debug(f"{activity} failed: {exc}", target=str(file))
            if exc.quarantine:
                organize_failure(file, exc)
            return _FAILED
        except Exception as exc:  # per-file isolation is the whole contract
            log.error(f"{activity} failed: {exc}", target=str(file))
            organize_failure(file, exc)
            return _FAILED

    raw = run_parallel(files, guarded, parallel=parallel, on_progress=ctx.reporter(activity))

    # 并行执行的结果仍按输入顺序返回，失败清单也据此保持稳定
    result: BatchResult[R] = BatchResult()
    for file, outcome in zip(files, raw, strict=True):
        if outcome is _FAILED:
            result.failed.append(file)
        else:
            result.succeeded.append(outcome)

    if result.failed:
        log.warning(f"{activity}: {len(result.failed)} file(s) failed")
    return result
