"""Geotag media from KML tracks by timestamp matching.

Ports Set-PositionFromKml / Get-PositionFromKml: load every KML from the ZIP
archive into memory, match each media file's timestamp against candidate
tracks (filename contains the date; ±1 day with -Multiday) via binary search
on the when[] array, keep the nearest point; a match strictly inside a track's
duration wins immediately, otherwise the smallest outside-diff is used when it
is within MaxTimeDiffSeconds (default 60s).
"""

import zipfile
from bisect import bisect_left
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .. import coords, log, mediatime
from ..context import ctx
from ..fileutil import BatchResult, FileFailure, run_per_file
from ..kml import archive, xmlutil
from .write import SetExifOptions, is_missing_altitude, list_files, write_exif_tags


@dataclass
class TrackPoint:
    latitude: float
    longitude: float
    altitude: float
    seconds_from_nearest: float
    inside_duration: bool


def get_position_from_kml(tree: xmlutil.etree._ElementTree, time: datetime,
                          target_file: str | None = None) -> TrackPoint | None:
    """Binary-search the track's when[] for `time`, return the nearest point."""
    kml_name_node = xmlutil.find(tree, "/kml:kml/kml:Document/kml:name")
    kml_name = xmlutil.element_text(kml_name_node) or "Unknown KML"

    coord_nodes = xmlutil.findall(tree, "//gx:coord")
    when_nodes = xmlutil.findall(tree, "//kml:when")
    if not coord_nodes or not when_nodes:
        log.debug(f"No GPS info found in {kml_name}", target=target_file)
        return None

    whens: list[datetime] = []
    for node in when_nodes:
        text = (node.text or "").strip()
        whens.append(datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC))

    # 等价于 [Array]::BinarySearch：找到第一个 >= time 的位置
    insert_index = bisect_left(whens, time)
    is_inside = whens[0] <= time <= whens[-1]
    if insert_index == len(whens):
        index = len(whens) - 1
    elif insert_index > 0 and time - whens[insert_index - 1] < whens[insert_index] - time:
        index = insert_index - 1
    else:
        index = insert_index

    seconds_from_nearest = abs((time - whens[index]).total_seconds())

    raw_coord = (coord_nodes[index].text or "").strip()
    log.verbose(f"Found GPS coordinate in {kml_name} (lon/lat/alt): {raw_coord}", target=target_file)
    log.debug(f"KML timestamp: {whens[index]}", target=target_file)
    log.debug(f"Time difference (inside: {is_inside}): {seconds_from_nearest} seconds", target=target_file)

    # gx:coord 是 "lon lat alt"，第三段（海拔）可能缺省
    parts = raw_coord.split()
    longitude, latitude = float(parts[0]), float(parts[1])
    altitude = float(parts[2]) if len(parts) > 2 else 0.0
    return TrackPoint(latitude=latitude, longitude=longitude, altitude=altitude,
                      seconds_from_nearest=seconds_from_nearest, inside_duration=is_inside)


def _load_kml_cache(zip_path: Path) -> dict[str, str]:
    cache: dict[str, str] = {}
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.filename.lower().endswith(".kml"):
                cache[Path(info.filename).name] = zf.read(info.filename).decode("utf-8")
    log.info(f"Loaded {len(cache)} KML files into memory from ZIP: {zip_path}")
    return cache


MAX_TIME_DIFF_SECONDS = 60
MAX_DISTANCE_METERS = 100


@dataclass
class SetPositionOptions:
    max_time_diff_seconds: int = MAX_TIME_DIFF_SECONDS
    overwrite: bool = False
    force: bool = False
    verify_existing_gps: bool = False
    max_distance_meters: int = MAX_DISTANCE_METERS
    multiday: bool = False
    failed_folder_name: str | None = None


def _find_best_track(parsed_cache: dict[str, xmlutil.etree._ElementTree],
                     media_time: datetime, multiday: bool,
                     target_file: str | None = None) -> TrackPoint | None:
    """Nearest point among KMLs whose name contains the media date (±1 day
    with multiday): an in-duration match wins immediately, otherwise the
    closest out-of-duration point is kept."""
    dates = [media_time.strftime("%Y-%m-%d")]
    if multiday:
        dates.append((media_time - timedelta(days=1)).strftime("%Y-%m-%d"))
        dates.append((media_time + timedelta(days=1)).strftime("%Y-%m-%d"))

    best: TrackPoint | None = None
    for kml_name, tree in parsed_cache.items():
        if not any(date in kml_name for date in dates):
            continue
        pos = get_position_from_kml(tree, media_time.astimezone(UTC), target_file=target_file)
        if pos is None:
            continue
        if pos.inside_duration:
            return pos
        if best is None or pos.seconds_from_nearest < best.seconds_from_nearest:
            best = pos
    return best


def _verify_or_skip(latitude: float, longitude: float, best: TrackPoint,
                    options: SetPositionOptions, target_file: str | None = None) -> bool:
    """Distance check of existing GPS against the KML match; False = skip the
    file (mismatch beyond threshold and no force)."""
    distance = coords.geo_distance(latitude, longitude, best.latitude, best.longitude)
    if distance > options.max_distance_meters:
        log.warning(f"Existing GPS and KML GPS differ by {round(distance, 2)} meters "
                    f"(Threshold: {options.max_distance_meters}m)", target=target_file)
        return options.force
    log.debug(f"Existing GPS and KML GPS match within threshold ({round(distance, 2)} meters).",
              target=target_file)
    return True


def set_position_from_kml(path: Path | list[Path], kml_zip_path: str | None = None,
                          options: SetPositionOptions | None = None,
                          parallel: bool = False) -> BatchResult[None]:
    """Set GPS position/altitude on media files from the KML ZIP archive.

    A file list is accepted so one call can cover a whole selection: the archive
    is read and parsed once for the batch, not once per file.
    """
    options = options or SetPositionOptions()

    zip_path = archive.resolve_zip_path(kml_zip_path)

    try:
        kml_cache = _load_kml_cache(zip_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise OSError(f"Failed to read KML archive file: {zip_path}") from exc

    # 预解析 XML，避免在并行工作线程里重复解析
    parsed_cache = {name: xmlutil.parse_string(text) for name, text in kml_cache.items()}

    files = list_files(path)

    def process(file: Path) -> None:
        # 时间标签与 GPS 标签一次读齐，每个文件只往返 exiftool 一次
        tags = ctx.backend.read_tags(
            file, [*mediatime.TIME_TAGS, "GPSLatitude", "GPSLongitude", "GPSAltitude"])

        latitude_text, longitude_text = tags.get("GPSLatitude"), tags.get("GPSLongitude")
        latitude = float(latitude_text) if latitude_text is not None else None
        longitude = float(longitude_text) if longitude_text is not None else None
        if latitude is not None and longitude is not None:
            log.debug(f"GPSPosition already exists: {latitude} {longitude}", target=str(file))

        altitude_text = tags.get("GPSAltitude", "")
        # 零海拔同样算没有海拔，否则 0 会被当成可信高度而跳过补全
        has_altitude = not is_missing_altitude(altitude_text)
        if has_altitude:
            log.debug(f"GPSAltitude already exists: {altitude_text}", target=str(file))

        # 如果已有数据，并且用户没有开启 Force 也没开启 Verify，直接跳过当前文件
        if (latitude is not None and longitude is not None and has_altitude
                and not options.force and not options.verify_existing_gps):
            log.verbose("Skipping (GPS data already exists)", target=str(file))
            return

        media_time = mediatime.parse_media_time(tags, target=str(file))
        if media_time is None:
            log.error("No valid timestamp found; skipping", target=str(file))
            raise FileFailure("no valid timestamp")

        best = _find_best_track(parsed_cache, media_time, options.multiday, str(file))
        if best is None:
            log.warning("No matching GPS data found in KML archive", target=str(file))
            raise FileFailure("no matching GPS data in the KML archive")
        if best.seconds_from_nearest > options.max_time_diff_seconds:
            log.warning(
                f"Best matched KML is outside duration by {round(best.seconds_from_nearest, 2)} seconds, "
                f"which exceeds the {options.max_time_diff_seconds}s limit", target=str(file))
            raise FileFailure(f"best match {round(best.seconds_from_nearest, 2)}s outside the time limit")

        if options.verify_existing_gps and latitude is not None and longitude is not None:
            if not _verify_or_skip(latitude, longitude, best, options, str(file)):
                # 校验不符：文件保持原位（用户要的是核对结果，不是搬运）
                raise FileFailure("existing GPS disagrees with the KML", quarantine=False)

        if best.latitude is not None and best.longitude is not None:
            # 如果文件缺失位置或高度，或者用户开启了 Force，则同时打包更新
            if latitude is None or longitude is None or not has_altitude or options.force:
                new_position = f"{best.latitude} {best.longitude}"
                # KML 没带海拔时沿用文件里已有的值
                file_altitude = float(altitude_text) if not is_missing_altitude(altitude_text) else None
                new_altitude = best.altitude or file_altitude
                display_alt = f"{new_altitude} m" if new_altitude else "None"
                log.verbose(f"Setting GPS position: {new_position}, altitude: {display_alt}", target=str(file))
                write_exif_tags(file, SetExifOptions(position=new_position, altitude=new_altitude,
                                                     overwrite=options.overwrite))
        else:
            log.warning("No matching GPS data found in KML archive", target=str(file))
            raise FileFailure("matched KML point carries no coordinates")

    return run_per_file(files, process, activity="Setting GPS info from KML",
                        failed_folder_name=options.failed_folder_name, parallel=parallel)
