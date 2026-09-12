"""Google-powered EXIF completion: altitude fill and reverse-geocoded IPTC tags.

Ports Set-ExifAltitudeFromGoogle and Set-ExifLocationFromGoogle.
"""

from pathlib import Path

from .. import googleapi, log
from ..context import ctx
from ..fileutil import BatchResult, FileFailure, run_per_file
from .write import SetExifOptions, is_missing_altitude, list_files, write_exif_tags


def set_altitude_from_google(path: Path | list[Path], overwrite: bool = False,
                             failed_folder_name: str | None = None,
                             parallel: bool = False,
                             api_key: str | None = None) -> BatchResult[None]:
    """Fill GPSAltitude for files missing it (zero counts as missing).

    An explicit file list is accepted so one call covers the whole selection:
    every needing file's coordinate goes into a single batched Elevation
    request, which is why a caller repairing many files must hand over the
    list instead of looping per file.
    """
    files = list_files(path)
    result: BatchResult[None] = BatchResult()

    # Step 1: 找出需要补海拔的文件（读取阶段可并行）
    def check_altitude(file: Path) -> tuple[Path, tuple[float, float]] | None:
        tags = ctx.backend.read_tags(file, ["GPSAltitude", "GPSLatitude", "GPSLongitude"])
        altitude = tags.get("GPSAltitude", "")
        if not is_missing_altitude(altitude):
            log.debug(f"GPSAltitude already exists: {altitude}", target=str(file))
            return None
        if altitude:
            log.debug(f"GPSAltitude is zero: {altitude}", target=str(file))
        else:
            log.debug("No GPSAltitude found", target=str(file))

        latitude, longitude = tags.get("GPSLatitude"), tags.get("GPSLongitude")
        if latitude is not None and longitude is not None:
            return (file, (float(latitude), float(longitude)))
        log.warning("No GPS position found", target=str(file))
        raise FileFailure("no GPS position to query an elevation for")

    checked = run_per_file(files, check_altitude, activity="Checking altitude data",
                           failed_folder_name=failed_folder_name, parallel=parallel)
    result.merge(checked)
    need_altitude = [r for r in checked.succeeded if r is not None]
    if not need_altitude:
        log.info("No files require altitude updates")
        return result

    log.info(f"Found {len(need_altitude)} file(s) requiring altitude data")

    # Step 2: 查询 Google 高程 API（客户端按 512 点 / URL 长度分批，一次调用覆盖全部文件）
    points = [point for _, point in need_altitude]
    elevations = googleapi.get_altitudes(points, api_key=api_key)

    # Step 3: 写回海拔
    def update(item: tuple[tuple[Path, tuple[float, float]], float | None]) -> None:
        (file, _), altitude = item
        if altitude is None:
            log.warning("No elevation data returned from API", target=str(file))
            raise FileFailure("no elevation data returned by the API")
        log.verbose(f"Setting altitude: {altitude} m", target=str(file))
        write_exif_tags(file, SetExifOptions(altitude=altitude, overwrite=overwrite))

    result.merge(run_per_file(list(zip(need_altitude, elevations, strict=True)),
                              update, activity="Updating altitude",
                              failed_folder_name=failed_folder_name, parallel=parallel))
    log.info(f"Altitude update completed for {len(need_altitude)} file(s)")
    return result


def set_location_from_google(path: Path | list[Path], overwrite: bool = False,
                             failed_folder_name: str | None = None,
                             parallel: bool = False, api_key: str | None = None,
                             language: str = "en") -> BatchResult[None]:
    """Reverse geocode GPS position into IPTC City/State/Country tags."""
    files = list_files(path)

    def process(file: Path) -> None:
        tags = ctx.backend.read_tags(file, ["GPSLatitude", "GPSLongitude"])
        latitude, longitude = tags.get("GPSLatitude"), tags.get("GPSLongitude")
        if latitude is None or longitude is None:
            log.warning("No GPS position found", target=str(file))
            raise FileFailure("no GPS position to reverse geocode")

        location = googleapi.get_location(float(latitude), float(longitude),
                                          api_key=api_key, language=language)

        location_tags: dict[str, str] = {}
        if location.city:
            location_tags["IPTC:City"] = location.city
        if location.state:
            location_tags["IPTC:Province-State"] = location.state
        if location.country_code_iso:
            location_tags["IPTC:Country-PrimaryLocationCode"] = location.country_code_iso
        if location.country:
            location_tags["IPTC:Country-PrimaryLocationName"] = location.country

        if not location_tags:
            log.warning("No location fields returned from reverse geocoding", target=str(file))
            raise FileFailure("no location fields returned by the API")

        write_exif_tags(file, SetExifOptions(tags=location_tags, overwrite=overwrite))
        location_str = " ".join(part for part in (location.country, location.state, location.city) if part)
        log.verbose(f"IPTC location tags updated: {location_str}", target=str(file))

    return run_per_file(files, process, activity="Setting EXIF location from Google",
                        failed_folder_name=failed_folder_name, parallel=parallel)
