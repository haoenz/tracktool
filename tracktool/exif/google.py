"""Google-powered EXIF completion: altitude fill and reverse-geocoded IPTC tags.

Ports Set-ExifAltitudeFromGoogle and Set-ExifLocationFromGoogle.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from .. import exiftool, googleapi, log
from ..progress import DEFAULT_WORKERS, run_parallel
from .write import SetExifOptions, list_files, set_exif


def _move_to_folder(path: Path, folder_name: str) -> None:
    target_dir = path.parent / folder_name
    if not target_dir.is_dir():
        target_dir.mkdir()
        log.info(f"Created folder: {folder_name}", target=str(target_dir))
    target_path = target_dir / path.name
    if target_path.exists():
        log.warning(f"File already exists in {folder_name} folder", target=str(target_path))
        return
    shutil.move(str(path), str(target_path))
    log.info(f"Moved to {folder_name} folder", target=str(target_path))


def set_altitude_from_google(path: Path, overwrite: bool = False,
                             failed_folder_name: str | None = None,
                             parallel: bool = False, api_key: str | None = None) -> None:
    """Fill GPSAltitude for files missing it (zero counts as missing)."""
    files = list_files(path)

    # Step 1: 找出需要补海拔的文件（读取阶段可并行）
    def check(file: Path) -> tuple[Path, str] | None:
        altitude = exiftool.get_media_tag(file, "GPSAltitude")
        needs_update = False
        if not altitude:
            log.debug("No altitude data found", target=str(file))
            needs_update = True
        elif altitude in ("0 m Above Sea Level", "0 m Below Sea Level"):
            log.debug(f"Altitude is zero: {altitude}", target=str(file))
            needs_update = True
        else:
            log.debug(f"Altitude already exists: {altitude}", target=str(file))

        if needs_update:
            position = exiftool.get_media_tag(file, "GPSPosition")
            if position:
                return (file, position)
            log.warning("No GPS position found", target=str(file))
            if failed_folder_name:
                _move_to_folder(file, failed_folder_name)
        return None

    checked = run_parallel(files, check, activity="Checking altitude data",
                           workers=DEFAULT_WORKERS if parallel else 1)
    need_altitude = [r for r in checked if r is not None]
    if not need_altitude:
        log.info("No files require altitude updates")
        return

    log.info(f"Found {len(need_altitude)} file(s) requiring altitude data")

    # Step 2: 查询 Google 高程 API（分批由 googleapi 内部处理）
    positions = [position for _, position in need_altitude]
    try:
        elevations = googleapi.get_altitudes(positions, api_key=api_key)
    except googleapi.GoogleApiError as exc:
        log.error(f"Failed to query Google Elevation API: {exc}")
        raise

    # Step 3: 写回海拔
    def update(item: tuple[tuple[Path, str], float | None]) -> None:
        (file, _), altitude = item
        if altitude is not None:
            log.info(f"Setting altitude: {altitude} m", target=str(file))
            try:
                set_exif(file, SetExifOptions(altitude=altitude, overwrite=overwrite))
            except Exception as exc:  # noqa: BLE001 - mirrors original per-file catch
                log.error(f"Failed to set altitude: {exc}", target=str(file))
                if failed_folder_name:
                    _move_to_folder(file, failed_folder_name)
        else:
            log.warning("No elevation data returned from API", target=str(file))
            if failed_folder_name:
                _move_to_folder(file, failed_folder_name)

    run_parallel(list(zip(need_altitude, elevations, strict=False)), update, activity="Updating altitude",
                 workers=DEFAULT_WORKERS if parallel else 1)
    log.info(f"Altitude update completed for {len(need_altitude)} file(s)")


def set_location_from_google(path: Path, overwrite: bool = False,
                             failed_folder_name: str | None = None,
                             parallel: bool = False, api_key: str | None = None,
                             language: str = "en") -> None:
    """Reverse geocode GPSPosition into IPTC City/State/Country tags."""
    files = list_files(path)

    def process(file: Path) -> None:
        gps_position = exiftool.get_media_tag(file, "GPSPosition")
        if not gps_position:
            log.warning("No GPSPosition found", target=str(file))
            if failed_folder_name:
                _move_to_folder(file, failed_folder_name)
            return

        try:
            location = googleapi.get_location(gps_position, api_key=api_key, language=language)
        except googleapi.GoogleApiError as exc:
            log.error(f"Reverse geocoding failed: {exc}", target=str(file))
            if failed_folder_name:
                _move_to_folder(file, failed_folder_name)
            return

        tags: dict[str, str] = {}
        if location.city:
            tags["IPTC:City"] = location.city
        if location.state:
            tags["IPTC:Province-State"] = location.state
        if location.country_code_iso:
            tags["IPTC:Country-PrimaryLocationCode"] = location.country_code_iso
        if location.country:
            tags["IPTC:Country-PrimaryLocationName"] = location.country

        if not tags:
            log.warning("No location fields returned from reverse geocoding", target=str(file))
            if failed_folder_name:
                _move_to_folder(file, failed_folder_name)
            return

        try:
            set_exif(file, SetExifOptions(tags=tags, overwrite=overwrite))
            location_str = " ".join(part for part in (location.country, location.state, location.city) if part)
            log.info(f"IPTC location tags updated: {location_str}", target=str(file))
        except Exception as exc:  # noqa: BLE001
            log.error(f"Failed to write IPTC tags: {exc}", target=str(file))
            if failed_folder_name:
                _move_to_folder(file, failed_folder_name)

    run_parallel(files, process, activity="Setting EXIF location from Google",
                 workers=DEFAULT_WORKERS if parallel else 1)
