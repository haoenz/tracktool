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

from .. import coords, exiftool, log, mediatime
from ..fileutil import quarantine, run_per_file
from ..kml import archive, xmlutil
from .write import SetExifOptions, list_files, set_exif


@dataclass
class TrackPoint:
    latitude: str
    longitude: str
    altitude: str
    time_diff: float  # 正=在轨迹持续时间内，负=持续时间内最近点距离


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
    is_inside = True

    if insert_index == 0:
        if time < whens[0]:
            is_inside = False
            index = 0
        else:
            index = 0
    elif insert_index == len(whens):
        is_inside = False
        index = len(whens) - 1
    else:
        index = insert_index
        # 只有在不是起点的情况下才需要向前比较
        if time - whens[index - 1] < whens[index] - time:
            index -= 1

    if whens[index] == time:
        is_inside = True

    abs_time_diff = abs((time - whens[index]).total_seconds())
    # 如果在KML记录的持续时间内，时间差为正；如果在持续时间外（采用了最前/最后的点），时间差为负
    reported_time_diff = abs_time_diff if is_inside else -abs_time_diff

    log.info(f"Found GPS coordinate: {(coord_nodes[index].text or '').strip()} in {kml_name}", target=target_file)
    log.debug(f"KML timestamp: {whens[index]}", target=target_file)
    log.debug(f"Reported Time difference (Inside: {is_inside}): {abs_time_diff} seconds", target=target_file)

    lon, lat, alt = (coord_nodes[index].text or "").split(" ")[:3]
    return TrackPoint(latitude=lat, longitude=lon, altitude=alt, time_diff=reported_time_diff)


def _load_kml_cache(zip_path: Path) -> dict[str, str]:
    cache: dict[str, str] = {}
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.filename.lower().endswith(".kml"):
                cache[Path(info.filename).name] = zf.read(info.filename).decode("utf-8")
    log.info(f"Loaded {len(cache)} KML files into memory from ZIP: {zip_path}")
    return cache


@dataclass
class SetPositionOptions:
    max_time_diff_seconds: int = 60
    overwrite: bool = False
    force: bool = False
    verify_existing_gps: bool = False
    max_distance_meters: int = 100
    multiday: bool = False
    failed_folder_name: str | None = None


def set_position_from_kml(path: Path, kml_zip_path: str | None = None,
                          options: SetPositionOptions | None = None,
                          parallel: bool = False, cfg=None) -> None:
    """Set GPS position/altitude on media files from the KML ZIP archive."""
    from ..config import config

    cfg = cfg or config
    options = options or SetPositionOptions()

    zip_path = archive.resolve_zip_path(kml_zip_path, cfg)

    try:
        kml_cache = _load_kml_cache(zip_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise OSError(f"Failed to read KML archive file: {zip_path}") from exc

    # 预解析 XML，避免在并行工作线程里重复解析
    parsed_cache = {name: xmlutil.parse_string(text) for name, text in kml_cache.items()}

    files = list_files(path)

    def process(file: Path) -> None:
        existing_position = exiftool.get_media_tag(file, "GPSPosition")
        if existing_position:
            log.debug(f"GPS position already exists: {existing_position}", target=str(file))
        existing_altitude = exiftool.get_media_tag(file, "GPSAltitude")
        if existing_altitude:
            log.debug(f"GPS altitude already exists: {existing_altitude}", target=str(file))

        # 如果已有数据，并且用户没有开启 Force 也没开启 Verify，直接跳过当前文件
        if existing_position and existing_altitude and not options.force and not options.verify_existing_gps:
            log.info("Skipping (GPS data already exists)", target=str(file))
            return

        media_time = mediatime.get_media_time(file)
        if media_time is None:
            log.error("Failed to get media timestamp", target=str(file))
            if options.failed_folder_name:
                quarantine(file, options.failed_folder_name)
            return

        date_str = media_time.strftime("%Y-%m-%d")
        matching_keys: list[str] = []
        for key in parsed_cache:
            if date_str in key:
                matching_keys.append(key)
            elif options.multiday:
                prev = (media_time - timedelta(days=1)).strftime("%Y-%m-%d")
                nxt = (media_time + timedelta(days=1)).strftime("%Y-%m-%d")
                if prev in key or nxt in key:
                    matching_keys.append(key)

        best: TrackPoint | None = None
        best_abs_diff = float("inf")
        if matching_keys:
            for kml_name in matching_keys:
                pos = get_position_from_kml(parsed_cache[kml_name], media_time.astimezone(UTC),
                                            target_file=str(file))
                if pos is None:
                    continue
                is_inside = pos.time_diff >= 0
                abs_diff = abs(pos.time_diff)
                if is_inside:
                    # 找到了在持续时间内匹配的KML，表明必定拍自此期间，直接采用它
                    best, best_abs_diff = pos, abs_diff
                    break
                if abs_diff < best_abs_diff:
                    best, best_abs_diff = pos, abs_diff

        lat = lon = alt = None
        if best is not None and best_abs_diff <= options.max_time_diff_seconds:
            lat, lon, alt = best.latitude, best.longitude, best.altitude

            if options.verify_existing_gps and existing_position:
                existing_dec = coords.decimal_coord(existing_position)
                if existing_dec:
                    ex_lat, ex_lon = existing_dec.split(",")
                    distance = coords.geo_distance(float(ex_lat), float(ex_lon), float(lat), float(lon))
                    if distance > options.max_distance_meters:
                        log.warning(
                            f"Existing GPS and KML GPS differ by {round(distance, 2)} meters "
                            f"(Threshold: {options.max_distance_meters}m).", target=str(file))
                        if not options.force:
                            return
                    else:
                        log.debug(
                            f"Existing GPS and KML GPS match within threshold ({round(distance, 2)} meters).",
                            target=str(file))
        elif best is not None:
            log.warning(
                f"Best matched KML is outside duration by {best_abs_diff} seconds, "
                f"which exceeds the {options.max_time_diff_seconds}s limit", target=str(file))
            if options.failed_folder_name:
                quarantine(file, options.failed_folder_name)
            return

        if lat and lon:
            # 如果文件缺失位置或高度，或者用户开启了 Force，则同时打包更新
            if not existing_position or not existing_altitude or options.force:
                new_position = f"{lat} {lon}"
                new_altitude = alt if alt else existing_altitude
                display_alt = f"{new_altitude} m" if new_altitude else "None"
                log.info(f"Setting GPS position: {new_position}, altitude: {display_alt}", target=str(file))
                set_exif(file, SetExifOptions(position=new_position, altitude=float(new_altitude)
                                              if new_altitude else None, overwrite=options.overwrite))
        else:
            log.warning("No matching GPS data found in KML archive", target=str(file))
            if options.failed_folder_name:
                quarantine(file, options.failed_folder_name)

    run_per_file(files, process, activity="Setting GPS info from KML",
                 failed_folder_name=options.failed_folder_name, parallel=parallel)
