"""Shared file-moving helpers and the per-file batch failure contract.

A batch owes its caller two answers: which files succeeded, and which did not.
run_per_file layers that contract on top of run_parallel — one file's failure is
logged with that file as target and never aborts the rest of the batch, and it
is counted in the returned BatchResult so the CLI can turn it into an exit code.

Quarantining covers the whole per-file operation, not only the EXIF write —
failures also arise from tag reads, media-time parsing, API calls and renames.
"""

import shutil
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


def move_to_folder(path: Path, folder_name: str, parent_directory: Path | None = None) -> None:
    """Move file into folder_name, creating it if needed."""
    target_parent = parent_directory if parent_directory is not None else path.parent
    target_dir = target_parent / folder_name
    if not target_dir.is_dir():
        target_dir.mkdir()
        log.info(f"Created folder: {folder_name}", target=str(target_dir))
    target_path = target_dir / path.name
    if target_path.exists():
        log.warning(f"File already exists in {folder_name} folder", target=str(target_path))
        return
    shutil.move(str(path), str(target_path))
    log.verbose(f"Moved to {folder_name} folder", target=str(target_path))


def quarantine(path: Path, folder_name: str | None) -> None:
    """Move a failed file into the failure folder; no-op without one."""
    if folder_name:
        move_to_folder(path, folder_name)


def _quarantine(path: Path, folder_name: str | None, dry_run: bool) -> None:
    """Count a failed file, moving it aside only when the run is for real.

    A dry run still classifies the file as failed — the exit code has to match
    the run it previews — but moving it would make the preview the very thing
    it was meant to avoid.
    """
    if dry_run and folder_name:
        log.info(f"would move to {folder_name} (failed file)", target=str(path))
        return
    quarantine(path, folder_name)


def run_per_file[T, R](
    files: list[Path],
    process: Callable[[Path], R],
    *,
    activity: str = "Processing",
    failed_folder_name: str | None = None,
    parallel: bool = False,
    dry_run: bool = False,
) -> BatchResult[R]:
    """Apply process to every file; a per-file failure never aborts the batch.

    A FileFailure is the expected kind: the file was readable but could not be
    processed, its reason is already logged at the raising site, and only the
    counting happens here. Any other exception is unexpected and gets one
    entry of its own in the log. Both kinds end up in BatchResult.failed (in
    input order) and, unless there is no failed folder, are quarantined.

    Catching broadly is the point: a systemic failure (missing exiftool, bad
    API key) repeats the error per file instead of silently dropping the rest
    of the batch, and the failure count is what tells the caller nothing worked.

    `dry_run` changes nothing about the contract — the same files are counted —
    it only stops the quarantine move, since a preview must not rearrange the
    directory it is previewing.
    """

    def guarded(file: Path) -> R:
        try:
            return process(file)
        except FileFailure as exc:
            log.debug(f"{activity} failed: {exc}", target=str(file))
            if exc.quarantine:
                _quarantine(file, failed_folder_name, dry_run)
            return _FAILED
        except Exception as exc:  # per-file isolation is the whole contract
            log.error(f"{activity} failed: {exc}", target=str(file))
            _quarantine(file, failed_folder_name, dry_run)
            return _FAILED

    raw = run_parallel(files, guarded, parallel=parallel,
                       on_progress=ctx.reporter(activity))

    # 并行执行的结果仍按输入顺序返回，失败清单也据此保持稳定
    result: BatchResult[R] = BatchResult()
    for file, outcome in zip(files, raw, strict=True):
        if outcome is _FAILED:
            result.failed.append(file)
        else:
            result.succeeded.append(outcome)

    if result.failed:
        message = f"{activity}: {len(result.failed)} file(s) failed"
        if failed_folder_name:
            message += f", moved to {failed_folder_name}"
        log.warning(message)
    return result
