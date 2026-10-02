"""Planned file operations: a decision is a value, not a side effect.

Each media command reads a file, decides what should happen to it, and does it.
Keeping the decision separate from the doing is what lets a preview exist:
`decide()` takes metadata and returns a plan — a list of Action values — and
`run()` is the only thing that touches a file. The rules are then ordinary
functions over values, exercisable from a dict of tags with no exiftool, no
ffmpeg, and no directory to clean up afterwards.

The vocabulary is deliberately small and domain-level. A plan says "assign
these tags" or "move these timestamps by this much", never `-Tag=value` or
`-=0:0:1 2:30:00`; how a backend spells that stays behind the metadata seam.

`run()` reads the run mode off the context rather than taking it as an
argument: a preview that has to be threaded down by hand is one a command can
forget, and the forgetting is silent — the run simply happens.
"""

import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from . import log
from .context import ctx
from .fileutil import FileFailure


@dataclass(frozen=True)
class WriteTags:
    """Assign tags, keeping a backup of the original unless told not to."""

    file: Path
    tags: Mapping[str, str]
    overwrite: bool = False


@dataclass(frozen=True)
class ShiftTags:
    """Move the named timestamp tags by delta, leaving every other tag alone."""

    file: Path
    tags: Sequence[str]
    delta: timedelta
    overwrite: bool = False


@dataclass(frozen=True)
class Rename:
    """Rename the file within its own directory (an Insta360 name carries the time)."""

    file: Path
    new_name: str


@dataclass(frozen=True)
class RemuxVideo:
    """Rewrap a video into MP4 through ffmpeg, at the given creation time.

    Output is prepared in a temporary file. MP4 sources retain their first
    `<name>_original` backup before replacement; an existing QuickTime:CreateDate
    permits copying instead of rewrapping. Subsequent WriteTags normalizes dates.
    """

    file: Path
    output: Path
    create_time_utc: str
    source_is_mp4: bool
    has_quicktime_create_date: bool


@dataclass(frozen=True)
class Lookup:
    """A billable query whose result the plan cannot know yet.

    A dry run reports the lookup where the real run would report the write it
    leads to, which is the point of previewing a command that costs quota: the
    plan names the points that would be queried. The stage that owns the query
    performs it and re-plans with the answer, so no plan handed to `run()` ever
    carries one.
    """

    file: Path
    provider: str
    detail: str
    point: tuple[float, float]


@dataclass(frozen=True)
class Skip:
    """Nothing to do here, and why — a deliberate no-op, not a failure."""

    file: Path
    reason: str


@dataclass(frozen=True)
class Failed:
    """The file cannot be processed; the batch counts it as failed.

    `quarantine=False` keeps the file where it is: a file that failed a check
    is the user's evidence, not rubbish to be filed away.
    """

    file: Path
    reason: str
    quarantine: bool = True


@dataclass(frozen=True)
class Step:
    """One move the orchestration makes itself rather than through a backend.

    The other actions are decisions over metadata, spelled from a small
    domain vocabulary; this one carries its own effect, because only the
    workflow that assembled the plan knows what filing a track into an archive
    or rolling a VID directory involves. `kind` and `detail` are the two
    columns the plan prints, and both must be knowable *before* the step runs —
    a preview cannot wait for the answer.

    A step is also the unit a batch happens in: `workflows.push_tracks` gives
    one step every track it is filing into a collection, so the work of the
    step is the loop over the batch rather than a run per track.
    """

    file: Path
    kind: str
    detail: str
    effect: Callable[[], None]


Action = WriteTags | ShiftTags | Rename | RemuxVideo | Lookup | Skip | Failed | Step


def describe(action: Action) -> tuple[str, str]:
    """(what kind of step, what it does) — the dry-run report's two columns."""
    match action:
        case WriteTags(tags=tags):
            return "write tags", ", ".join(f"{tag}={value}" for tag, value in tags.items())
        case ShiftTags(tags=tags, delta=delta):
            return "shift time", f"{len(tags)} timestamp tag(s) by {_signed(delta)}"
        case Rename(new_name=new_name):
            return "rename", f"-> {new_name}"
        case RemuxVideo(output=output, source_is_mp4=is_mp4, has_quicktime_create_date=has_create_date):
            if is_mp4 and has_create_date:
                # 源已是 MP4 且带创建时间：搬走原件后直接复制，不必过 ffmpeg
                return "copy", f"-> {output.name} (keeping an _original)"
            return ("rewrap" if is_mp4 else "convert"), f"-> {output.name} (ffmpeg)"
        case Lookup(provider=provider, detail=detail):
            return "query", f"{provider}: {detail}"
        case Skip(reason=reason):
            return "skip", reason
        case Failed(reason=reason):
            return "fail", reason
        case Step(kind=kind, detail=detail):
            return kind, detail
    raise AssertionError(f"unhandled action: {action!r}")  # pragma: no cover


def _signed(delta: timedelta) -> str:
    return f"{'-' if delta < timedelta(0) else '+'}{abs(delta)}"


def _path_key(path: Path) -> Path:
    """Compare directory entries without following the final symlink."""
    return Path(os.path.normcase(str(path.parent.resolve() / path.name)))


def _occupied(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def _backup_path(path: Path) -> Path:
    return path.with_name(path.name + "_original")


def _plan_paths(plan: list[Action]) -> set[Path]:
    """Reserve inputs, outputs and backups together for a whole file's plan."""
    paths: set[Path] = set()
    for action in plan:
        if isinstance(action, WriteTags | ShiftTags | Rename | RemuxVideo):
            paths.add(_path_key(action.file))
            paths.add(_path_key(action.file.resolve()))
        if isinstance(action, Rename):
            paths.add(_path_key(action.file.with_name(action.new_name)))
        if isinstance(action, RemuxVideo):
            paths.add(_path_key(action.output))
            if action.source_is_mp4:
                paths.add(_path_key(_backup_path(action.file)))
        if isinstance(action, WriteTags | ShiftTags) and not action.overwrite:
            paths.add(_path_key(_backup_path(action.file)))
    return paths


def _path_problem(plan: list[Action], skip_existing_outputs: bool = False) -> Failed | Skip | None:
    for action in plan:
        target = None
        backup = None
        if isinstance(action, Rename):
            target = action.file.with_name(action.new_name)
        elif isinstance(action, RemuxVideo):
            target = action.output
            if action.source_is_mp4:
                backup = _backup_path(action.file)
        elif isinstance(action, WriteTags | ShiftTags) and not action.overwrite:
            backup = _backup_path(action.file)
        if target is not None:
            if _path_key(target) != _path_key(action.file) and _occupied(target):
                if (
                    isinstance(action, RemuxVideo)
                    and skip_existing_outputs
                    and target.is_file()
                    and not target.is_symlink()
                ):
                    return Skip(action.file, f"output already exists: {target}")
                return Failed(action.file, f"Output already exists: {target}", quarantine=False)
            if isinstance(action, RemuxVideo) and target.is_symlink():
                return Failed(action.file, f"Output is a symbolic link: {target}", quarantine=False)
            for parent in target.parents:
                if _occupied(parent) and not parent.is_dir():
                    return Failed(action.file, f"Output directory is blocked: {parent}", quarantine=False)
        if backup is not None and _occupied(backup) and (backup.is_symlink() or not backup.is_file()):
            return Failed(action.file, f"Backup path is occupied: {backup}", quarantine=False)
    return None


def preflight(plans: list[list[Action]], *, skip_existing_outputs: bool = False) -> list[list[Action]]:
    """Check every plan against the initial filesystem and all other plans.

    Conflicting files stay in place. A destination used as another source is
    also a conflict: execution order must not decide which file survives.
    """
    checked = list(plans)
    owners: dict[Path, set[int]] = {}
    for index, plan in enumerate(plans):
        if not plan or any(isinstance(action, Failed) for action in plan):
            continue
        try:
            for path in _plan_paths(plan):
                owners.setdefault(path, set()).add(index)
            if problem := _path_problem(plan, skip_existing_outputs):
                checked[index] = [problem]
        except OSError as exc:
            checked[index] = [Failed(plan[0].file, f"Cannot check file paths: {exc}", quarantine=False)]
    conflicts: dict[int, list[str]] = {}
    for path, indices in owners.items():
        if len(indices) > 1:
            for index in indices:
                conflicts.setdefault(index, []).append(str(path))
    for index, paths in conflicts.items():
        checked[index] = [
            Failed(plans[index][0].file, f"Batch path conflict: {', '.join(sorted(paths))}", quarantine=False)
        ]
    return checked


def _move_without_overwrite(source: Path, target: Path) -> None:
    """Publish an existing file without copying bytes or replacing a target.

    Hard-link creation exclusively claims the target name. If linking is not
    supported, fail safely; if unlinking fails, both names retain the data.
    """
    if _path_key(source) == _path_key(target):
        return
    try:
        os.link(source, target, follow_symlinks=False)
        source.unlink()
    except OSError as exc:
        reason = f"Cannot move {source} to {target} without overwriting: {exc}"
        log.error(reason, target=str(source))
        raise FileFailure(reason, quarantine=False) from exc


def apply(action: Action) -> None:
    """Perform one planned step. Only run() calls this."""
    match action:
        case WriteTags(file=file, tags=tags, overwrite=overwrite):
            ctx.backend.write_tags(file, tags, overwrite=overwrite)
        case ShiftTags(file=file, tags=tags, delta=delta, overwrite=overwrite):
            ctx.backend.shift_tags(file, tags, delta, overwrite=overwrite)
        case Rename(file=file, new_name=new_name):
            _move_without_overwrite(file, file.with_name(new_name))
        case RemuxVideo():
            _remux(action)
        case Step(effect=effect):
            effect()
        case Skip() | Lookup():
            pass  # 无事可做：跳过是决定，查询由发起它的阶段完成
        case Failed(reason=reason, quarantine=quarantine):
            # 不在这里记日志：run() 负责让每个失败原因恰好可见一次
            raise FileFailure(reason, quarantine=quarantine)
        case _:  # pragma: no cover
            raise AssertionError(f"unhandled action: {action!r}")


def _remux(action: RemuxVideo) -> None:
    """The ffmpeg branch of RemuxVideo, including the original-file shuffle."""
    file, output = action.file, action.output
    if problem := _path_problem([action]):
        log.error(problem.reason, target=str(file))
        raise FileFailure(problem.reason, quarantine=False)
    # Prepare output before touching the source. Reruns preserve the first
    # backup rather than replacing it with an already corrected version.
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".mp4", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        if action.source_is_mp4 and action.has_quicktime_create_date:
            shutil.copy2(file, temporary)
        else:
            _ffmpeg(
                [
                    "-i",
                    str(file),
                    "-c",
                    "copy",
                    *(["-map", "0"] if action.source_is_mp4 else []),
                    "-metadata",
                    f"creation_time={action.create_time_utc}",
                    str(temporary),
                ],
                file,
            )
        if action.source_is_mp4:
            original = file.with_name(file.name + "_original")
            try:
                backup = original.open("xb")
            except FileExistsError:
                log.verbose("Keeping the existing original backup", target=str(original))
            else:
                try:
                    with backup as dst, file.open("rb") as src:
                        shutil.copyfileobj(src, dst)
                    shutil.copystat(file, original)
                except BaseException:
                    original.unlink(missing_ok=True)
                    raise
        if _path_key(output) == _path_key(file):
            temporary.replace(output)
        else:
            _move_without_overwrite(temporary, output)
        if action.source_is_mp4 and _path_key(file) != _path_key(output):
            file.unlink()
    finally:
        temporary.unlink(missing_ok=True)


def _ffmpeg(args: list[str], source: Path) -> None:
    if subprocess.run(["ffmpeg", "-y", *args], capture_output=True).returncode != 0:
        log.error("Failed to convert to MP4", target=str(source))
        raise FileFailure("ffmpeg failed to convert to MP4")


def run(actions: list[Action]) -> list[Action]:
    """Carry out a plan — or, in PLAN mode, say what it would do and stop.

    Returns the plan so the caller can report it. A `Failed` entry raises the
    batch's FileFailure in either mode, so a preview's exit code tells the same
    story as the run it previews instead of always looking healthy.
    """
    actions = preflight([actions])[0]
    for action in actions:
        if isinstance(action, Failed):
            log.warning(action.reason, target=str(action.file))
            raise FileFailure(action.reason, quarantine=action.quarantine)
        kind, detail = describe(action)
        if ctx.is_plan:
            log.info(f"{kind}: {detail}", target=str(action.file))
        else:
            log.verbose(f"{kind}: {detail}", target=str(action.file))
            apply(action)
    return actions
