"""Undoing a recorded archive change.

`archive undo` reads the change log backwards and reverses the newest record
that still stands: it removes the entries the change added, puts back the ones
it removed, restores the files it carried into the backup folder, and rebuilds
the views. The views are never reversed directly — they are derived from the
ZIP (E2), so a single rebuild puts them back in step with a truth that just
moved.

Every premise is checked before anything is touched, because undoing half of a
change is how data is lost. A premise that has gone — the archive has moved
on, a file the change carried is no longer there — refuses the whole undo;
--force downgrades the per-file premises and skips them. One rule holds the
line when it does: **nothing is deleted until a copy of it exists somewhere
else**, so a file whose way back is blocked keeps its entry in the ZIP and is
written to the tombstone as not undone. The same rule sets the order: files
are restored *before* any entry is dropped, so a process that dies in between
leaves one copy too many rather than one too few.

What this is not: a backup. It reverses operations that were meant, and needs
the truth they produced to still be there. An archive whose ZIP or backup
folder is gone is a job for the backups of the archive directory itself.
"""

import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from .. import log
from ..context import ctx
from ..errors import UserInputError
from ..fileutil import restore_file
from ..paths import display_path
from ..workspace import resolve_archive
from . import archive, history


@dataclass(frozen=True)
class UndoOutcome:
    """What one `archive undo` did: the records reversed, and what it left.

    `not_undone` is deliberately not empty on a partial undo: the record is
    consumed either way, or it would keep standing in front of older ones
    forever, so what could not be reversed has to be said out loud.
    """

    undone: list[int] = field(default_factory=list)
    not_undone: list[str] = field(default_factory=list)
    mismatched: bool = False

    @property
    def ok(self) -> bool:
        """Whether the archive came all the way back."""
        return not self.not_undone and not self.mismatched


@dataclass
class _Inverse:
    """The steps that reverse one record, and what of it cannot be reversed.

    Built in full before anything is touched: a premise that has gone has to
    refuse the undo, and it can only do that if it is known before the first
    file moves.
    """

    change: history.Change
    restore_moves: list[history.BackupMove] = field(default_factory=list)
    remove_entries: list[str] = field(default_factory=list)
    put_back: list[tuple[str, Path]] = field(default_factory=list)
    kept_entries: list[str] = field(default_factory=list)
    drop_extracted: Path | None = None
    drop_output: Path | None = None
    not_undone: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def undo_last(zip_path: str | None = None, steps: int = 1, force: bool = False) -> UndoOutcome:
    """Reverse the last `steps` recorded changes, newest first.

    The order matters: each record starts where the one before it ended, so
    walking back from the newest is the only order in which the archive passes
    through states it actually had.
    """
    archive_dir, zip_file = resolve_archive(zip_path)
    if not zip_file.is_file():
        # 不能指望 archive_hash 报错：它直接开文件，抛的是裸 FileNotFoundError
        raise UserInputError(f"KML compressed file does not exist: {display_path(zip_file)}")

    targets = _targets(archive_dir, steps)
    if not targets:
        log.info("Nothing to undo")
        return UndoOutcome()

    zip_hash_before = _readable_hash(zip_file)
    _check_chain(targets, zip_hash_before)

    inverses = [_plan(change, zip_file) for change in targets]
    _keep_what_cannot_be_deleted(inverses)
    for inverse in inverses:
        _plan_output(inverse)
    problems = [problem for inverse in inverses for problem in inverse.problems]
    if problems and not force:
        raise UserInputError(
            "Cannot undo: "
            + "; ".join(problems)
            + ". Put what is listed back and run this again, or pass --force to skip those items"
        )
    for problem in problems:
        log.warning(f"{problem} (forced)")

    # rebuild 会把积压的视图改动一并应用；那些改动不属于这次撤回，值得先说一句
    if archive.read_views_hash(zip_file) != zip_hash_before:
        log.warning("The views were already out of date; rebuilding will also apply those changes")

    for inverse in inverses:
        _apply(inverse, zip_file)

    archive.rebuild(str(zip_file), tag_map=ctx.config.track_tag_map)

    zip_hash_after = archive.current_hash(zip_file)
    for inverse in inverses:
        # tombstone 是每一步的反向：它从被撤记录的「之后」回到那条记录的「之前」
        tombstone = history.start(history.UNDO, zip_hash_before=inverse.change.zip_hash_after)
        tombstone.undo_of = inverse.change.id
        tombstone.not_undone = list(inverse.not_undone)
        history.commit(archive_dir, tombstone, zip_hash_after=inverse.change.zip_hash_before)

    # 预演里一个字节都没动，拿它自校验只会凭空报不符
    mismatched = not ctx.is_plan and zip_hash_after != targets[-1].zip_hash_before
    if mismatched:
        log.error(
            f"The archive did not come back to what it was before {targets[-1].command} #{targets[-1].id} "
            f"({zip_hash_after}, expected {targets[-1].zip_hash_before}). The changes already made stand; the history "
            "is marked, so a retry refuses instead of undoing the wrong thing"
        )
    undone = [inverse.change.id for inverse in inverses]
    log.info(f"Undid {len(undone)} change(s): " + ", ".join(f"#{change_id}" for change_id in undone))
    return UndoOutcome(
        undone=undone,
        not_undone=[item for inverse in inverses for item in inverse.not_undone],
        mismatched=mismatched,
    )


def _readable_hash(zip_file: Path) -> str:
    """The ZIP's hash, with an unreadable archive reported as user input.

    archive_hash opens the file itself, so a ZIP that is not a ZIP surfaces as
    a bare BadZipFile — and a bare exception is a traceback, not an answer.
    """
    try:
        return archive.current_hash(zip_file)
    except (zipfile.BadZipFile, OSError) as exc:
        raise UserInputError(f"Cannot read the archive {display_path(zip_file)}: {exc}") from exc


def _targets(archive_dir: Path, steps: int) -> list[history.Change]:
    """The records to reverse, newest first."""
    pending = history.pending(archive_dir)
    if steps > len(pending):
        log.warning(f"Only {len(pending)} recorded change(s) left to undo")
    return list(reversed(pending[-steps:]))


def _check_chain(targets: list[history.Change], zip_hash_now: str) -> None:
    """Refuse — before touching anything — when the archive has moved on.

    Both checks are fatal even under --force: acting on a record that does not
    describe the archive as it stands may delete entries that belong to a
    later one.
    """
    for change in targets:
        if change.version != history.VERSION:
            raise UserInputError(
                f"Cannot undo #{change.id}: it was written in history format v{change.version}, which this version "
                "does not know"
            )
    newest = targets[0]
    if zip_hash_now != newest.zip_hash_after:
        raise UserInputError(
            f"Cannot undo {newest.command} #{newest.id}: the archive has changed since it was recorded "
            f"({zip_hash_now}, expected {newest.zip_hash_after}). Run `tracktool archive log` to see what came after"
        )
    # 成对比较时差一条：targets[1:] 比 targets 短一项，strict 在这里必然不成立
    for newer, older in zip(targets, targets[1:], strict=False):
        if newer.zip_hash_before != older.zip_hash_after:
            raise UserInputError(
                f"Cannot undo back to #{older.id}: record #{newer.id} does not start where #{older.id} ended"
            )


def _plan(change: history.Change, zip_file: Path) -> _Inverse:
    """Work out what reversing one record involves, and what stands in the way.

    Nothing is touched here: the whole batch is planned first, so a premise
    that has gone refuses the undo before the first file is moved. Whether an
    entry may be dropped is not decided here either — that depends on every
    record in the batch (see _keep_what_cannot_be_deleted).
    """
    inverse = _Inverse(change=change)

    for move in change.backup_moves:
        original, backup = Path(move.original_path), Path(move.backup_path)
        if not backup.is_file():
            inverse.problems.append(f"the file this change carried away is gone: {display_path(backup)}")
        elif original.exists() or original.is_symlink():
            inverse.problems.append(f"something occupies where it came from: {display_path(original)}")
        elif not original.parent.is_dir():
            inverse.problems.append(f"the directory it came from is gone: {display_path(original.parent)}")
        else:
            inverse.restore_moves.append(move)
            continue
        inverse.not_undone.append(display_path(backup))

    inverse.remove_entries = list(change.added_entries)
    _plan_restore(inverse)
    _warn_about_missing_sources(change)
    return inverse


def _keep_what_cannot_be_deleted(inverses: list[_Inverse]) -> None:
    """Hold back every entry whose copy elsewhere could not be put back.

    Nothing is deleted until a copy of it exists somewhere else, so an entry
    whose file cannot be restored has to stay in the ZIP — it is then the last
    copy of that track. The match is by file name and across the whole batch,
    not within one record: the record that added an entry and the record whose
    restore failed may be two different records, and it is the entry that
    becomes the only copy either way.
    """
    blocked: dict[str, str] = {}
    for inverse in inverses:
        restored = {move.backup_path for move in inverse.restore_moves}
        for move in inverse.change.backup_moves:
            if move.backup_path not in restored:
                blocked[Path(move.backup_path).name] = display_path(Path(move.backup_path))
    if not blocked:
        return
    for inverse in inverses:
        kept = [entry for entry in inverse.remove_entries if Path(entry).name in blocked]
        if not kept:
            continue
        inverse.remove_entries = [entry for entry in inverse.remove_entries if Path(entry).name not in blocked]
        inverse.kept_entries.extend(kept)
        inverse.not_undone.extend(kept)
        for entry in kept:
            log.warning(f"Keeping {entry}: {blocked[Path(entry).name]} could not be put back")


def _plan_restore(inverse: _Inverse) -> None:
    """Plan putting a restored file back into the ZIP — its only remaining copy."""
    change = inverse.change
    if not change.removed_entries:
        return
    extracted = change.extracted_file
    if extracted is None:
        inverse.problems.append(f"#{change.id} names removed entries but no file they were written to")
        inverse.not_undone.extend(change.removed_entries)
        return
    source = Path(extracted.file_path)
    if problem := _file_problem(source, extracted.size_bytes, extracted.crc32):
        inverse.problems.append(problem)
        inverse.not_undone.append(extracted.entry_path)
        return
    inverse.put_back = [(entry, source) for entry in change.removed_entries]
    inverse.drop_extracted = source


def _plan_output(inverse: _Inverse) -> None:
    """Plan removing a merge's output, unless it is the last copy of the result.

    A missing output is harmless — there is nothing to delete. A changed one
    is left alone with a warning: the user's own edit to it is not ours to
    delete. What must never happen is deleting it when the entries it was
    merged from could not all be restored, because then it is the only copy.
    """
    change = inverse.change
    if change.output_file is None:
        return
    output = Path(change.output_file.file_path)
    if not output.is_file():
        log.verbose(f"Merge output already gone: {display_path(output)}")
        return
    if problem := _file_problem(output, change.output_file.size_bytes, change.output_file.crc32):
        log.warning(f"Keeping the merge output, it is no longer the file that merge wrote ({problem})")
        return
    if inverse.kept_entries:
        log.warning(f"Keeping the merge output, it is the only copy of the merged track: {display_path(output)}")
        return
    inverse.drop_output = output


def _warn_about_missing_sources(change: history.Change) -> None:
    """Say so when a source file is gone, though the undo still goes ahead.

    A file the user deleted themselves is their business, not grounds for a
    refusal — but once the entry goes, nothing holds the track at all, so it is
    worth saying before that happens. A file this change carried into the
    backup folder is not one of those: leaving its old place was the point of
    --move, and the restore step is what brings it back.
    """
    carried = {move.original_path for move in change.backup_moves}
    gone = [Path(path).name for path in change.source_paths if path not in carried and not Path(path).is_file()]
    if gone:
        log.warning(
            f"Source file(s) already gone: {', '.join(gone)} — the ZIP holds the only copy, and undoing removes it"
        )


def _apply(inverse: _Inverse, zip_file: Path) -> None:
    """Reverse one record: the files first, then the entries they are copies of."""
    failed: set[str] = set()
    for move in inverse.restore_moves:
        if not restore_file(Path(move.original_path), Path(move.backup_path)) and not ctx.is_plan:
            # 校验时还在、动手时没了：原件没还回去，条目就得留下
            failed.add(Path(move.backup_path).name)
    if failed:
        kept = [entry for entry in inverse.remove_entries if Path(entry).name in failed]
        inverse.remove_entries = [entry for entry in inverse.remove_entries if Path(entry).name not in failed]
        inverse.kept_entries.extend(kept)
        inverse.not_undone.extend(kept)

    archive.remove_zip_entries(inverse.remove_entries, zip_file)
    for entry, source in inverse.put_back:
        archive.push_zip_entry(source, entry, zip_file)
    for path in (inverse.drop_extracted, inverse.drop_output):
        if path is not None:
            _drop(path)


def _drop(path: Path) -> None:
    """Delete a file the archive now holds a copy of. PLAN reports instead."""
    if ctx.is_plan:
        log.info(f"Would delete {display_path(path)}")
        return
    try:
        path.unlink()
    except OSError as exc:
        # 删不掉只是多留一份副本，不是撤回失败
        log.warning(f"Cannot delete {display_path(path)}: {exc}")
        return
    log.verbose(f"Deleted {display_path(path)}")


def _file_problem(path: Path, size_bytes: int, crc32: int) -> str | None:
    """Why this file cannot pass for the recorded one, or None when it can."""
    if not path.is_file():
        return f"the file it was written to is gone: {display_path(path)}"
    actual_size, actual_crc = history.file_metadata(path)
    if actual_size != size_bytes:
        return f"the file it was written to changed size: {display_path(path)}"
    if actual_crc != crc32:
        return f"the file it was written to changed content: {display_path(path)}"
    return None
