"""One-click media repair orchestration.

Resolve-missing repairs files lacking GPSPosition/GPSAltitude — altitude via
Google first, position from the KML archive second — and files that got their
altitude land in a GoogleAltOK folder. Resolve-vid turns a VID directory into
VID_original, converts its videos into a fresh VID, then repairs those.

A dry run goes through the same stages and stops at the same places, so the
steps it cannot preview are the ones whose inputs the earlier steps produce —
the rename of VID, the folder the repaired files land in — and it says so
instead of pretending to know.
"""

from pathlib import Path

from .. import log, mediatime
from ..actions import Action
from ..errors import UserInputError
from ..fileutil import BatchResult, move_to_folder
from ..paths import display_path
from .google import set_altitude_from_google
from .media import convert_to_mp4
from .position import SetPositionOptions, set_position_from_kml
from .write import find_missing_tag

REPAIRED_FOLDER = "GoogleAltOK"


def _organize_repaired(files: list[Path]) -> None:
    """Move successfully repaired files into the GoogleAltOK folder."""
    for file in files:
        if file.exists():
            move_to_folder(file, REPAIRED_FOLDER)


def resolve_missing_gps(path: Path, parallel: bool = False, kml_zip_path: str | None = None,
                        dry_run: bool = False) -> BatchResult[list[Action]]:
    """修复缺失 GPSPosition/GPSAltitude 的媒体文件：先补海拔，再补位置；
    补好海拔的文件移入 GoogleAltOK 目录。

    两个阶段都整表交给各自的批量入口：海拔一次 API 请求覆盖全部文件（客户端
    按 512 点分批），位置一次加载并解析 KML 归档，逐文件循环会把两者都废掉。
    """
    result: BatchResult[list[Action]] = BatchResult()

    log.info("Finding media files missing GPSPosition and GPSAltitude")
    missing = find_missing_tag(path, ["GPSPosition", "GPSAltitude"], parallel=parallel)
    # 探针给出的是「哪些文件缺标签」，不是计划；只有它的失败属于本次结果
    result.failed += missing.failed

    if not missing.succeeded:
        log.info("No files missing GPS data")
        return result

    for entry in missing.succeeded:
        log.verbose(f"File: {display_path(entry.file)}, Missing: {', '.join(entry.missing_tags)}")

    # 仅缺失海拔的文件
    missing_alt_only = [r for r in missing.succeeded
                        if "GPSAltitude" in r.missing_tags and "GPSPosition" not in r.missing_tags]
    if missing_alt_only:
        log.info(f"Processing {len(missing_alt_only)} files missing only GPSAltitude")
        files = [r.file for r in missing_alt_only]
        result.merge(set_altitude_from_google(files, overwrite=True,
                                              failed_folder_name="GoogleAltFailed",
                                              parallel=parallel, dry_run=dry_run))
        if dry_run:
            # 谁最终补好要真跑才知道，预演只能说明「补好的那些会被归档」
            log.info(f"would then move the repaired file(s) to {REPAIRED_FOLDER}")
        else:
            _organize_repaired(files)

    # 缺失位置的文件
    missing_pos = [r for r in missing.succeeded if "GPSPosition" in r.missing_tags]
    if missing_pos:
        log.info(f"Processing {len(missing_pos)} files missing GPSPosition")
        result.merge(set_position_from_kml([r.file for r in missing_pos], kml_zip_path,
                                           options=SetPositionOptions(overwrite=True,
                                                                      failed_folder_name="TrackPosFailed"),
                                           parallel=parallel, dry_run=dry_run))
    return result


def resolve_vid_exif(path: Path, make: str | None = None, model: str | None = None,
                     offset_time: str = mediatime.DEFAULT_TZ_OFFSET, parallel: bool = False,
                     kml_zip_path: str | None = None,
                     dry_run: bool = False) -> BatchResult[list[Action]]:
    """VID → VID_original，转换 MP4 到新 VID，再补全 GPS。"""
    path = path.resolve()
    vid_path = path / "VID"
    if not vid_path.is_dir():
        log.info("VID subdirectory not found")
        return BatchResult()

    vid_original_path = path / "VID_original"
    if vid_original_path.exists():
        raise UserInputError(f"{display_path(vid_original_path)} already exists; remove or rename it before re-running")

    if dry_run:
        # 预演不动目录：待处理的文件此刻还在 VID 里
        source = vid_path
        log.info(f"would rename {vid_path.name} to {vid_original_path.name} "
                 f"and create a new {vid_path.name}")
    else:
        vid_path.rename(vid_original_path)
        log.info("Renamed VID to VID_original")
        vid_path.mkdir()
        log.info("Created new VID directory")
        source = vid_original_path

    log.info(f"Processing media files from {display_path(source)}")
    result: BatchResult[list[Action]] = BatchResult()
    result.merge(convert_to_mp4(source, make=make, model=model, output_directory=vid_path,
                                offset_time=offset_time, parallel=parallel, dry_run=dry_run))

    if dry_run:
        # 补 GPS 的对象要等上一步产出，预演只能说明会做这一步
        log.info(f"would then repair GPS on the videos produced in {display_path(vid_path)}")
        return result

    result.merge(resolve_missing_gps(vid_path, parallel=parallel, kml_zip_path=kml_zip_path))
    return result
