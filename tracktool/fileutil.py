"""Shared file-moving helpers and the per-file batch failure policy.

run_per_file layers the common error contract on top of run_parallel: a
failure while processing one file is logged with that file as target and the
file is quarantined into the caller's failed folder, while the batch always
continues with the remaining files. Quarantining covers the whole per-file
operation, not only the EXIF write — failures also arise from tag reads,
media-time parsing, API calls and file renames.
"""

import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import log
from .progress import run_parallel

# Sentinel marking a failed item inside run_per_file; unreachable by callers.
_FAILED: Any = object()


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


def run_per_file[T, R](
    files: list[Path],
    process: Callable[[Path], R],
    *,
    activity: str = "Processing",
    failed_folder_name: str | None = None,
    parallel: bool = False,
) -> list[R]:
    """Apply process to every file; a per-file failure never aborts the batch.

    Any exception from process() — tag reads, EXIF writes, API calls, renames —
    is logged with the file as target and the file is moved into
    failed_folder_name (when given); its result is omitted. Catching broadly is
    the point: a systemic failure (missing exiftool, bad API key) repeats the
    error per file instead of silently dropping the rest of the batch.
    Returns the successful results in input order.
    """
    failed: list[Path] = []

    def guarded(file: Path) -> R:
        try:
            return process(file)
        except Exception as exc:  # per-file isolation is the whole contract
            log.error(f"{activity} failed: {exc}", target=str(file))
            quarantine(file, failed_folder_name)
            failed.append(file)
            return _FAILED

    raw = run_parallel(files, guarded, activity=activity, parallel=parallel)
    if failed:
        message = f"{activity}: {len(failed)} file(s) failed"
        if failed_folder_name:
            message += f", moved to {failed_folder_name}"
        log.warning(message)
    return [result for result in raw if result is not _FAILED]
