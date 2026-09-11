"""Google-powered EXIF completion: altitude fill and reverse-geocoded IPTC tags.

Ports Set-ExifAltitudeFromGoogle and Set-ExifLocationFromGoogle.
"""

from pathlib import Path

from .. import exiftool, googleapi, log
from ..fileutil import quarantine, run_per_file
from .write import SetExifOptions, is_missing_altitude, list_files, set_exif


def set_altitude_from_google(path: Path, overwrite: bool = False,
                             failed_folder_name: str | None = None,
                             parallel: bool = False, api_key: str | None = None) -> None:
    """Fill GPSAltitude for files missing it (zero counts as missing)."""
    files = list_files(path)

    # Step 1: 找出需要补海拔的文件（读取阶段可并行）
    def check(file: Path) -> tuple[Path, str] | None:
        altitude = exiftool.get_media_tag(file, "GPSAltitude")
        if not is_missing_altitude(altitude):
            log.debug(f"GPSAltitude already exists: {altitude}", target=str(file))
            return None
        if altitude:
            log.debug(f"GPSAltitude is zero: {altitude}", target=str(file))
        else:
            log.debug("No GPSAltitude found", target=str(file))

        position = exiftool.get_media_tag(file, "GPSPosition")
        if position:
            return (file, position)
        log.warning("No GPSPosition found", target=str(file))
        quarantine(file, failed_folder_name)
        return None

    checked = run_per_file(files, check, activity="Checking altitude data",
                           failed_folder_name=failed_folder_name, parallel=parallel)
    need_altitude = [r for r in checked if r is not None]
    if not need_altitude:
        log.info("No files require altitude updates")
        return

    log.info(f"Found {len(need_altitude)} file(s) requiring altitude data")

    # Step 2: 查询 Google 高程 API（分批由 googleapi 内部处理）
    positions = [position for _, position in need_altitude]
    elevations = googleapi.get_altitudes(positions, api_key=api_key)

    # Step 3: 写回海拔
    def update(item: tuple[tuple[Path, str], float | None]) -> None:
        (file, _), altitude = item
        if altitude is not None:
            log.verbose(f"Setting altitude: {altitude} m", target=str(file))
            set_exif(file, SetExifOptions(altitude=altitude, overwrite=overwrite))
        else:
            log.warning("No elevation data returned from API", target=str(file))
            quarantine(file, failed_folder_name)

    run_per_file([item for item in zip(need_altitude, elevations, strict=False)],
                 update, activity="Updating altitude",
                 failed_folder_name=failed_folder_name, parallel=parallel)
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
            quarantine(file, failed_folder_name)
            return

        location = googleapi.get_location(gps_position, api_key=api_key, language=language)

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
            quarantine(file, failed_folder_name)
            return

        set_exif(file, SetExifOptions(tags=tags, overwrite=overwrite))
        location_str = " ".join(part for part in (location.country, location.state, location.city) if part)
        log.verbose(f"IPTC location tags updated: {location_str}", target=str(file))

    run_per_file(files, process, activity="Setting EXIF location from Google",
                 failed_folder_name=failed_folder_name, parallel=parallel)
