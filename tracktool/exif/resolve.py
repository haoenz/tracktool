"""One-click media repair orchestration.

Ports Resolve-MissingGPS (find files missing GPSPosition/GPSAltitude, fill
altitude via Google, then position from KML) and Resolve-VIDExif (VID ->
VID_original, ConvertTo-Mp4 into a fresh VID, then Resolve-MissingGPS).
"""

from pathlib import Path

from .. import log
from ..fileutil import move_to_folder
from .google import set_altitude_from_google
from .media import convert_to_mp4
from .position import SetPositionOptions, set_position_from_kml
from .write import find_missing_tag


def resolve_missing_gps(path: Path, parallel: bool = False, kml_zip_path: str | None = None) -> None:
    """修复缺失 GPSPosition/GPSAltitude 的媒体文件：先补海拔，再补位置。"""
    log.info("Finding media files missing GPSPosition and GPSAltitude")
    missing = find_missing_tag(path, ["GPSPosition", "GPSAltitude"], parallel=parallel)

    if not missing:
        log.info("No media files are missing GPS data.")
        return

    for result in missing:
        log.debug(f"File: {result.file}, Missing: {', '.join(result.missing_tags)}")

    # 仅缺失海拔的文件
    missing_alt_only = [r for r in missing
                        if "GPSAltitude" in r.missing_tags and "GPSPosition" not in r.missing_tags]
    if missing_alt_only:
        log.info(f"Processing {len(missing_alt_only)} files missing only GPSAltitude")
        files = [r.file for r in missing_alt_only]
        # Set-ExifAltitudeFromGoogle 接受目录或单文件列表入口；逐文件目录化处理
        for file in files:
            set_altitude_from_google(file, overwrite=True, failed_folder_name="GoogleAltFailed",
                                     parallel=parallel)
        for file in files:
            if file.exists():
                move_to_folder(file, "GoogleAltOK")

    # 缺失位置的文件
    missing_pos = [r for r in missing if "GPSPosition" in r.missing_tags]
    if missing_pos:
        log.info(f"Processing {len(missing_pos)} files missing GPSPosition")
        for result in missing_pos:
            set_position_from_kml(result.file, kml_zip_path,
                                  options=SetPositionOptions(overwrite=True,
                                                             failed_folder_name="TrackPosFailed"),
                                  parallel=parallel)


def resolve_vid_exif(path: Path, make: str | None = None, model: str | None = None,
                     offset_time: str = "+08:00", parallel: bool = False,
                     kml_zip_path: str | None = None) -> None:
    """VID → VID_original，转换 MP4 到新 VID，再补全 GPS。"""
    path = path.resolve()
    vid_path = path / "VID"
    if not vid_path.is_dir():
        log.info("VID subdirectory not found")
        return

    vid_original_path = path / "VID_original"
    if vid_original_path.exists():
        log.error("VID_original already exists, please check")
        return

    vid_path.rename(vid_original_path)
    log.info("Renamed VID to VID_original")
    vid_path.mkdir()
    log.info("Created new VID directory")

    log.info(f"Processing media files from {vid_original_path}")
    convert_to_mp4(vid_original_path, make=make, model=model, output_directory=vid_path,
                   offset_time=offset_time, parallel=parallel)

    resolve_missing_gps(vid_path, parallel=parallel, kml_zip_path=kml_zip_path)
