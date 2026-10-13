"""Command orchestration: SQLite archiving and media repair workflows.

Push validates/classifies source files, then commits raw content and durable file
intents in one storage transaction. Exports are separate commands.
"""

from collections.abc import Mapping
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
from .kml import archive, collections, kmlfile, xmlutil
from .kml.kmlfile import TrackKind
from .paths import display_path
from .progress import batch_progress
from .tags import ALTITUDE, POSITION
from .workspace import resolve_archive

REPAIRED_FOLDER = "GoogleAltOK"


def push_tracks(
    paths: list[Path],
    zip_path: str | None = None,
    type_: TrackKind | None = None,
    move: bool = True,
    *,
    tag_map: Mapping[str, str] | None = None,
) -> BatchResult[list[Action]]:
    """Validate per-file classification, then commit raw KML and move intents."""
    _, zip_file = resolve_archive(zip_path)
    result: BatchResult[list[Action]] = BatchResult()
    pending: list[tuple[Path, str]] = []
    with batch_progress(len(paths), ctx.reporter("Reading KMLs")) as advance:
        for path in dict.fromkeys(paths):
            try:
                xmlutil.parse_file(path)
                kind = type_ if type_ is not None else kmlfile.get_kml_type(path, tag_map=tag_map)
                collections.desktop_date(path)
                if kind is None:
                    raise UserInputError(kmlfile.explain_unknown_tags(kmlfile.get_track_tags(path)))
                pending.append((path, kind.value))
            except UserInputError as exc:
                log.error(str(exc), target=path)
                result.failed.append(path)
            advance()

    def commit() -> None:
        with batch_progress(len(pending), ctx.reporter("Writing SQLite")) as advance:
            archive.push_compressed_kmls(pending, zip_file, move=move, on_entry=advance)

    if pending:
        result.succeeded.append(
            run(
                [
                    Step(
                        file=zip_file.parent / "archive.sqlite3",
                        kind="archive in SQLite",
                        detail=f"{len(pending)} KML(s); move sources={move}; ZIP exported separately",
                        effect=commit,
                    )
                ]
            )
        )
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
        repaired = fill_altitude_from_google(
            files, overwrite=True, failed_folder_name="GoogleAltFailed", parallel=parallel
        )
        result.merge(repaired)
        # 预演时这步由 move_to_folder 自己拒绝执行并说明
        # A failed file can remain in place when automatic failure moves are
        # unavailable; its presence must not be mistaken for a repair success.
        failed = set(repaired.failed)
        _organize_repaired([file for file in files if file not in failed])

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
        # On a first run VID will become empty. Check against the currently
        # vacant sibling to model that destination without moving any files.
        check_output = vid_path if source == vid_original_path else vid_original_path
        checked = convert_to_mp4(
            source,
            output_directory=check_output,
            offset_time=offset_time,
            timezone_policy=timezone_policy,
            time_source=time_source,
            parallel=parallel,
            check_only=True,
            skip_existing_outputs=True,
        )
        if not checked.ok:
            log.warning("Video repair paused before directory changes; resolve timestamp or path conflicts and retry")
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
            skip_existing_outputs=True,
        )
    )

    # 第四步：补 GPS——它的输入是上一步的产物。两个目录都在，才说明产物已落盘；
    # 预演里新 VID 还没建出来，所以说一句会做这一步，然后到此为止
    if not (vid_path.is_dir() and vid_original_path.is_dir()):
        log.info(f"would then repair GPS on the videos produced in {display_path(vid_path)}")
        return result
    result.merge(resolve_missing_gps(vid_path, parallel=parallel, kml_zip_path=kml_zip_path))
    return result
