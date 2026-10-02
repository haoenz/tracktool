"""Multi-step commands: what a command does, in the order it does it.

Filing a track into the archive is not one action but a short sequence of
them — file it into each collection, append it to the ZIP, move it to the
backup folder — and repairing a folder of videos is a longer one. Written as
statements inside a function, that order exists only while it runs: a reader
has to follow the calls, and a preview has nothing to show. Written as a list
of steps, the same sequence *is* the command's plan — `--dry-run` prints it as
a table — and a step is where a batch happens as one thing.

That last part is why the steps are shaped the way they are. Each step of a
push works on the batch, not on one track: one collection is opened once and
every track it receives is appended to it, and the ZIP is opened once for all
of them. Putting the loop inside the step instead of the step inside the loop
is the difference between one read and one write of a 40 MiB archive and one
per track.

The commands that live here are the ones that are a sequence rather than an
action: filing tracks into the archive, and the two repairs — repair
fills GPSAltitude from Google before GPSPosition from the KML archive, and
marks what it fixed in a GoogleAltOK folder; repair-vid turns a VID directory
into VID_original, converts its videos into a fresh VID, and repairs those. A
preview goes through the same steps and stops at the same places, so the steps
it cannot show are the ones whose *inputs* the earlier steps produce — the
rename of VID, the folder the repaired files land in — and it says so instead
of pretending to know.

A step is not a decision the backend can carry out; the workflow owns its
effect (see actions.Step). Whether that effect writes is decided below it, by
the primitives it calls, so nothing here consults the run mode except where a
step's inputs only exist once an earlier step has written.
"""

from collections import defaultdict
from dataclasses import dataclass
from functools import partial
from pathlib import Path

from . import log, mediatime
from .actions import Action, Step, run
from .context import ctx
from .errors import UserInputError
from .exif.google import fill_altitude_from_google
from .exif.media import convert_to_mp4, validate_conversion_options
from .exif.position import GeotagOptions, geotag_from_kml
from .exif.write import find_missing_tag
from .fileutil import BatchResult, move_to_folder
from .kml import archive, collections, kmlfile
from .kml.kmlfile import KmlContent, TrackKind
from .paths import display_path
from .tags import ALTITUDE, POSITION
from .workspace import resolve_archive

REPAIRED_FOLDER = "GoogleAltOK"


@dataclass(frozen=True)
class _Track:
    """A track on its way into the archive: read once, filed once."""

    path: Path
    type_: TrackKind
    content: KmlContent


def _read_track(path: Path, type_: TrackKind | None) -> _Track | None:
    """Read what the archive needs from a track; None — logged — when it cannot be filed.

    Reading happens while the plan is built, so a track that cannot be filed
    is a failure the preview reports too, and the contents are carried into
    the steps instead of being read again per collection.
    """
    try:
        kind = type_ if type_ is not None else kmlfile.get_kml_type(path)
        collections.desktop_date(path)  # 桌面聚合按文件名里的日期归档
        content = kmlfile.get_kml_content(path)
    except UserInputError as exc:
        log.error(str(exc), target=str(path))
        return None
    if kind is None:
        # 识别不出不是一种类型：报错让人指定，而不是归进一个 Unknown 类目
        log.error("Cannot recognize the track type (set one with `kml set-type` or pass --type)", target=str(path))
        return None
    return _Track(path=path, type_=kind, content=content)


def _names(tracks: list[_Track]) -> str:
    return ", ".join(track.path.stem for track in tracks)


def _file_desktop(collection_path: Path, type_: TrackKind, tracks: list[_Track]) -> None:
    """File the batch's tracks of one type into their desktop collection."""
    archive.ensure_archive_directory(collection_path.parent)
    collection = collections.DesktopCollection.open(collection_path, type_)
    for track in tracks:
        collection.add(track.path, track.content)
    collection.save()


def _file_mobile(collection_path: Path, tracks: list[_Track]) -> None:
    """File the batch's tracks of one type into their mobile collection."""
    archive.ensure_archive_directory(collection_path.parent)
    collection = collections.MobileCollection.open(collection_path)
    for track in tracks:
        collection.add(track.path, track.content)
    collection.save()


def _append_to_zip(tracks: list[_Track], zip_file: Path) -> None:
    archive.ensure_zip_file(zip_file)
    before = archive.archive_fingerprint(zip_file)
    stored = archive.read_views_fingerprint(zip_file)
    archive.push_compressed_kmls([(track.path, track.type_.value) for track in tracks], zip_file)
    # 视图指纹只在「推之前视图与真值一致」时前移。全新归档两边皆空，也算一致；
    # 本来就落后的视图不能因为补了一条就谎报同步——那要 rebuild 来认账。
    in_sync_before = stored == before or (stored is None and before == archive.EMPTY_ZIP_FINGERPRINT)
    if in_sync_before:
        archive.record_views_fingerprint(zip_file, archive.archive_fingerprint(zip_file))


def _move_to_backup(tracks: list[_Track], archive_dir: Path) -> None:
    archive.ensure_archive_directory(archive_dir)
    for track in tracks:
        move_to_folder(track.path, ctx.config.kml_backup_dir_name, archive_dir)


def push_tracks(
    paths: list[Path], zip_path: str | None = None, type_: TrackKind | None = None, move: bool = False
) -> BatchResult[list[Action]]:
    """File tracks into the archive: both collections, then the ZIP.

    The steps are where the batch happens: each collection is opened once for
    every track of the batch that belongs in it, and the archive once for all
    of them, so N tracks are one read and one write of the archive rather than
    N. A track that cannot be filed (unreadable, undated, unknown type) is
    counted as failed and the rest of the batch goes on. Source files stay
    where they are unless `move` is set — then every track the batch filed is
    moved into the backup folder, the ones the archive already held included:
    all three stores skip a duplicate by name, so a second filing of a track
    touches nothing, and --move turns the same run into a sweep that also
    collects the stray copy.
    """
    archive_dir, zip_file = resolve_archive(zip_path)
    result: BatchResult[list[Action]] = BatchResult()

    pending: list[_Track] = []
    for path in paths:
        track = _read_track(path, type_)
        if track is None:
            result.failed.append(path)
        else:
            pending.append(track)

    by_type: dict[TrackKind, list[_Track]] = defaultdict(list)
    for track in pending:
        by_type[track.type_].append(track)

    steps: list[Action] = []
    for type_, tracks in by_type.items():
        desktop_path, mobile_path = collections.collection_paths(type_, archive_dir)
        steps.append(
            Step(
                file=desktop_path,
                kind="add to collection",
                detail=_names(tracks),
                effect=partial(_file_desktop, desktop_path, type_, tracks),
            )
        )
        steps.append(
            Step(
                file=mobile_path,
                kind="add to mobile collection",
                detail=_names(tracks),
                effect=partial(_file_mobile, mobile_path, tracks),
            )
        )
    if pending:
        steps.append(
            Step(
                file=zip_file,
                kind="append to ZIP",
                detail=_names(pending),
                effect=partial(_append_to_zip, pending, zip_file),
            )
        )
    if pending and move:
        steps.append(
            Step(
                file=archive_dir / ctx.config.kml_backup_dir_name,
                kind="move to backup folder",
                detail=_names(pending),
                effect=partial(_move_to_backup, pending, archive_dir),
            )
        )

    result.succeeded.append(run(steps))
    return result


def _organize_repaired(files: list[Path]) -> None:
    """Move successfully repaired files into the GoogleAltOK folder."""
    for file in files:
        if file.exists():
            move_to_folder(file, REPAIRED_FOLDER)


def resolve_missing_gps(
    path: Path, parallel: bool = False, kml_zip_path: str | None = None
) -> BatchResult[list[Action]]:
    """修复缺失 GPSPosition/GPSAltitude 的媒体文件：先补海拔，再补位置；
    补好海拔的文件移入 GoogleAltOK 目录。

    两个阶段都整表交给各自的批量入口：海拔一次 API 请求覆盖全部文件（客户端
    按 512 点分批），位置一次加载并解析 KML 归档，逐文件循环会把两者都废掉。
    """
    result: BatchResult[list[Action]] = BatchResult()

    log.info("Finding media files missing GPSPosition and GPSAltitude")
    missing = find_missing_tag(path, [POSITION, ALTITUDE], parallel=parallel)
    # 探针给出的是「哪些文件缺标签」，不是计划；只有它的失败属于本次结果
    result.failed += missing.failed

    if not missing.succeeded:
        log.info("No files missing GPS data")
        return result

    for entry in missing.succeeded:
        log.verbose(f"File: {display_path(entry.file)}, Missing: {', '.join(entry.missing_tags)}")

    # 仅缺失海拔的文件
    missing_alt_only = [r for r in missing.succeeded if ALTITUDE in r.missing_tags and POSITION not in r.missing_tags]
    if missing_alt_only:
        log.info(f"Processing {len(missing_alt_only)} files missing only GPSAltitude")
        files = [r.file for r in missing_alt_only]
        result.merge(
            fill_altitude_from_google(files, overwrite=True, failed_folder_name="GoogleAltFailed", parallel=parallel)
        )
        # 预演时这步由 move_to_folder 自己拒绝执行并说明
        _organize_repaired(files)

    # 缺失位置的文件
    missing_pos = [r for r in missing.succeeded if POSITION in r.missing_tags]
    if missing_pos:
        log.info(f"Processing {len(missing_pos)} files missing GPSPosition")
        result.merge(
            geotag_from_kml(
                [r.file for r in missing_pos],
                kml_zip_path,
                options=GeotagOptions(overwrite=True, failed_folder_name="TrackPosFailed"),
                parallel=parallel,
            )
        )
    return result


def resolve_vid_exif(
    path: Path,
    make: str | None = None,
    model: str | None = None,
    offset_time: str = mediatime.DEFAULT_TZ_OFFSET,
    parallel: bool = False,
    kml_zip_path: str | None = None,
    timezone_policy: mediatime.TimezonePolicy = mediatime.TimezonePolicy.AUTO,
    time_source: str | None = None,
) -> BatchResult[list[Action]]:
    """VID → VID_original，转换 MP4 到新 VID，再补全 GPS；重跑从断点继续。

    每一步做没做过，由磁盘上的现状说明：VID_original 在就是改过名了，新 VID 在
    就是建过了，VID_original 里剩下的视频接着转，转好的接着补 GPS。中断（含
    Ctrl-C）之后重跑会接着做完，而不是被「VID_original 已存在」挡住、让用户手工
    收拾半个目录。
    """
    validate_conversion_options(offset_time, timezone_policy, time_source)
    path = path.resolve()
    vid_path = path / "VID"
    vid_original_path = path / "VID_original"
    result: BatchResult[list[Action]] = BatchResult()

    if vid_original_path.exists() and not vid_original_path.is_dir():
        raise UserInputError(f"{display_path(vid_original_path)} is in the way; move it aside before re-running")

    # Moving VID relocates every file, so obtain all timezone decisions before
    # that directory-wide operation. Pending files must remain at their paths.
    source = vid_original_path if vid_original_path.is_dir() else vid_path
    if source.is_dir():
        checked = convert_to_mp4(
            source,
            output_directory=vid_path,
            offset_time=offset_time,
            timezone_policy=timezone_policy,
            time_source=time_source,
            parallel=parallel,
            check_only=True,
        )
        if not checked.ok:
            log.warning("Video repair paused before directory changes; resolve the timestamp decisions and retry")
            return BatchResult(failed=checked.failed)

    # 第一步：VID → VID_original。已经改过名（包括上次中断留下的一半）就跳过
    if vid_original_path.is_dir():
        log.info(f"Continuing from {display_path(vid_original_path)}", target=str(path))
    elif not vid_path.is_dir():
        log.info("VID subdirectory not found")
        return result
    elif ctx.is_plan:
        # 预演不动目录：待转换的文件此刻还在 VID 里
        log.info(f"would rename {vid_path.name} to {vid_original_path.name} and create a new {vid_path.name}")
    else:
        vid_path.rename(vid_original_path)
        log.info("Renamed VID to VID_original")

    # 第二步：新的 VID 目录。改名之后才谈得上；预演只说明，不建
    if not vid_path.is_dir():
        if ctx.is_plan:
            log.info(f"would create a new {vid_path.name}")
        else:
            vid_path.mkdir()
            log.info("Created new VID directory")

    # 第三步：转换。源目录是文件此刻真正所在的那个：改过名就是 VID_original，
    # 还没改（预演）就是 VID
    source = vid_original_path if vid_original_path.is_dir() else vid_path
    log.info(f"Processing media files from {display_path(source)}")
    result.merge(
        convert_to_mp4(
            source,
            make=make,
            model=model,
            output_directory=vid_path,
            offset_time=offset_time,
            parallel=parallel,
            timezone_policy=timezone_policy,
            time_source=time_source,
        )
    )

    # 第四步：补 GPS——它的输入是上一步的产物。两个目录都在，才说明产物已落盘；
    # 预演里新 VID 还没建出来，所以说一句会做这一步，然后到此为止
    if not (vid_path.is_dir() and vid_original_path.is_dir()):
        log.info(f"would then repair GPS on the videos produced in {display_path(vid_path)}")
        return result
    result.merge(resolve_missing_gps(vid_path, parallel=parallel, kml_zip_path=kml_zip_path))
    return result
