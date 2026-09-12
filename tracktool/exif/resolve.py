"""One-click media repair orchestration.

Ports Resolve-MissingGPS (find files missing GPSPosition/GPSAltitude, fill
altitude via Google, then position from KML) and Resolve-VIDExif (VID ->
VID_original, ConvertTo-Mp4 into a fresh VID, then Resolve-MissingGPS).
"""

from pathlib import Path

from .. import log, mediatime
from ..fileutil import BatchResult, move_to_folder
from .google import set_altitude_from_google
from .media import convert_to_mp4
from .position import SetPositionOptions, set_position_from_kml
from .write import find_missing_tag


def _organize_repaired(files: list[Path]) -> None:
    """Move successfully repaired files into the GoogleAltOK folder."""
    for file in files:
        if file.exists():
            move_to_folder(file, "GoogleAltOK")


def resolve_missing_gps(path: Path, parallel: bool = False,
                        kml_zip_path: str | None = None) -> BatchResult[None]:
    """修复缺失 GPSPosition/GPSAltitude 的媒体文件：先补海拔，再补位置；
    补好海拔的文件移入 GoogleAltOK 目录。

    两个阶段都整表交给各自的批量入口：海拔一次 API 请求覆盖全部文件（客户端
    按 512 点分批），位置一次加载并解析 KML 归档，逐文件循环会把两者都废掉。
    """
    result: BatchResult[None] = BatchResult()

    log.info("Finding media files missing GPSPosition and GPSAltitude")
    missing = find_missing_tag(path, ["GPSPosition", "GPSAltitude"], parallel=parallel)
    result.merge(missing)

    if not missing.succeeded:
        log.info("No files missing GPS data")
        return result

    for entry in missing.succeeded:
        log.verbose(f"File: {entry.file}, Missing: {', '.join(entry.missing_tags)}")

    # 仅缺失海拔的文件
    missing_alt_only = [r for r in missing.succeeded
                        if "GPSAltitude" in r.missing_tags and "GPSPosition" not in r.missing_tags]
    if missing_alt_only:
        log.info(f"Processing {len(missing_alt_only)} files missing only GPSAltitude")
        files = [r.file for r in missing_alt_only]
        result.merge(set_altitude_from_google(files, overwrite=True,
                                              failed_folder_name="GoogleAltFailed",
                                              parallel=parallel))
        _organize_repaired(files)

    # 缺失位置的文件
    missing_pos = [r for r in missing.succeeded if "GPSPosition" in r.missing_tags]
    if missing_pos:
        log.info(f"Processing {len(missing_pos)} files missing GPSPosition")
        result.merge(set_position_from_kml([r.file for r in missing_pos], kml_zip_path,
                                           options=SetPositionOptions(overwrite=True,
                                                                      failed_folder_name="TrackPosFailed"),
                                           parallel=parallel))
    return result


def resolve_vid_exif(path: Path, make: str | None = None, model: str | None = None,
                     offset_time: str = mediatime.DEFAULT_TZ_OFFSET, parallel: bool = False,
                     kml_zip_path: str | None = None) -> BatchResult[None]:
    """VID → VID_original，转换 MP4 到新 VID，再补全 GPS。"""
    path = path.resolve()
    vid_path = path / "VID"
    if not vid_path.is_dir():
        log.info("VID subdirectory not found")
        return BatchResult()

    vid_original_path = path / "VID_original"
    if vid_original_path.exists():
        raise FileExistsError(f"{vid_original_path} already exists; remove or rename it before re-running")

    vid_path.rename(vid_original_path)
    log.info("Renamed VID to VID_original")
    vid_path.mkdir()
    log.info("Created new VID directory")

    log.info(f"Processing media files from {vid_original_path}")
    result: BatchResult[None] = BatchResult()
    result.merge(convert_to_mp4(vid_original_path, make=make, model=model, output_directory=vid_path,
                                offset_time=offset_time, parallel=parallel))

    result.merge(resolve_missing_gps(vid_path, parallel=parallel, kml_zip_path=kml_zip_path))
    return result
