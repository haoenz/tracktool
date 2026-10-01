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

import shutil
import subprocess
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

    An MP4 source is first preserved next to itself as `<name>_original`, then
    either rewrapped or copied depending on whether it already carries
    QuickTime:CreateDate; a non-MP4 source is rewrapped straight to the output.
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


def apply(action: Action) -> None:
    """Perform one planned step. Only run() calls this."""
    match action:
        case WriteTags(file=file, tags=tags, overwrite=overwrite):
            ctx.backend.write_tags(file, tags, overwrite=overwrite)
        case ShiftTags(file=file, tags=tags, delta=delta, overwrite=overwrite):
            ctx.backend.shift_tags(file, tags, delta, overwrite=overwrite)
        case Rename(file=file, new_name=new_name):
            file.rename(file.with_name(new_name))
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
    if not action.source_is_mp4:
        _ffmpeg(
            ["-i", str(file), "-c", "copy", "-metadata", f"creation_time={action.create_time_utc}", str(output)], file
        )
        return

    original = file.with_name(file.name + "_original")
    shutil.move(str(file), str(original))
    if action.has_quicktime_create_date:
        shutil.copy2(original, output)
        return
    _ffmpeg(
        [
            "-i",
            str(original),
            "-metadata",
            f"creation_time={action.create_time_utc}",
            "-c",
            "copy",
            "-map",
            "0",
            str(output),
        ],
        file,
    )


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
