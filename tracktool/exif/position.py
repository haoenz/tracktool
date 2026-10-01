"""Geotag media from KML tracks by timestamp matching.

The archive's tracks are read and parsed per month on first demand — layered
entries carry their month in the entry path, so a batch whose media spans two
weeks touches two months' entries instead of decompressing the whole ZIP —
and each media file's timestamp is matched against the tracks whose name
carries the date (±1 day with -Multiday). A match strictly inside a track's
duration wins immediately, otherwise the smallest outside-diff is used when
it is within MaxTimeDiffSeconds (default 60s).

`decide_position` holds that whole rule as a function of one file's metadata
and a track lookup, returning the steps to take; the batch only replays them.
"""

import re
import threading
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zipfile import BadZipFile

from .. import coords, log, mediatime
from ..actions import Action, Failed, Skip, WriteTags, run
from ..context import ctx
from ..discover import list_files
from ..errors import UserInputError
from ..fileutil import BatchResult, run_per_file
from ..kml import xmlutil
from ..kml.track import Track, TrackMatch
from ..metadata import MediaMetadata
from ..paths import display_path
from ..tags import POSITION_TAGS
from ..workspace import resolve_archive
from .write import SetExifOptions, build_tags


class _TrackLibrary:
    """The archive's tracks, read and parsed per month on first demand.

    Layered entries carry their month in the path (`<Kind>/<YYYY-MM>/<name>`),
    so a batch whose media spans two weeks touches two months' entries instead
    of decompressing the whole ZIP. Entries without a month segment — legacy
    flat names, merge outputs with odd names — belong to no month and stay
    available to every lookup. A month is parsed once per batch; a broken KML
    is skipped with a warning, not fatal.
    """

    _MONTH = re.compile(r"^\d{4}-\d{2}$")

    def __init__(self, zip_path: Path) -> None:
        self._zip_path = zip_path
        self._zf = zipfile.ZipFile(zip_path)
        self._by_month: dict[str, list[zipfile.ZipInfo]] = {}
        self._unlayered: list[zipfile.ZipInfo] = []
        total = 0
        for info in self._zf.infolist():
            if not info.filename.lower().endswith(".kml"):
                continue
            total += 1
            parts = info.filename.split("/")
            month = parts[1] if len(parts) >= 3 and self._MONTH.match(parts[1]) else None
            if month is None:
                self._unlayered.append(info)
            else:
                self._by_month.setdefault(month, []).append(info)
        self._cache: dict[str, list[Track]] = {}
        self._unlayered_tracks: list[Track] | None = None
        self._lock = threading.Lock()
        log.info(f"Archive holds {total} KML entries in {len(self._by_month)} months: {display_path(zip_path)}")

    def tracks_for(self, dates: list[str]) -> list[Track]:
        """Every track the candidate dates could match, parsed once per month."""
        tracks: list[Track] = []
        for month in sorted({date[:7] for date in dates}):
            tracks.extend(self._month_tracks(month))
        if self._unlayered:
            tracks.extend(self._always_tracks())
        return tracks

    def _month_tracks(self, month: str) -> list[Track]:
        cached = self._cache.get(month)
        if cached is not None:
            return cached
        with self._lock:
            cached = self._cache.get(month)
            if cached is None:
                infos = self._by_month.get(month, [])
                cached = [track for info in infos if (track := self._parse(info)) is not None]
                self._cache[month] = cached
                log.debug(f"Loaded {len(cached)} tracks for {month} from ZIP: {display_path(self._zip_path)}")
        return cached

    def _always_tracks(self) -> list[Track]:
        with self._lock:
            if self._unlayered_tracks is None:
                self._unlayered_tracks = [track for info in self._unlayered if (track := self._parse(info)) is not None]
            return self._unlayered_tracks

    def _parse(self, info: zipfile.ZipInfo) -> Track | None:
        """Read and parse one entry; the caller holds the lock, since zipfile's
        one shared file object does not take kindly to concurrent reads."""
        name = Path(info.filename).name
        try:
            text = self._zf.read(info.filename).decode("utf-8")
            return Track.from_kml(xmlutil.parse_string(text), name)
        except (UserInputError, BadZipFile, UnicodeDecodeError) as exc:
            log.warning(f"Skipping broken KML track: {exc}")
            return None


MAX_TIME_DIFF_SECONDS = 60
MAX_DISTANCE_METERS = 100


@dataclass
class GeotagOptions:
    max_time_diff_seconds: int = MAX_TIME_DIFF_SECONDS
    overwrite: bool = False
    force: bool = False
    verify_existing_gps: bool = False
    max_distance_meters: int = MAX_DISTANCE_METERS
    multiday: bool = False
    failed_folder_name: str | None = None


FindBestTrack = Callable[[datetime], "TrackMatch | None"]


def _candidate_dates(media_time: datetime, multiday: bool) -> list[str]:
    """The track-name dates one media time can match: its own, ±1 day with multiday."""
    dates = [media_time.strftime("%Y-%m-%d")]
    if multiday:
        dates.append((media_time - timedelta(days=1)).strftime("%Y-%m-%d"))
        dates.append((media_time + timedelta(days=1)).strftime("%Y-%m-%d"))
    return dates


def _find_best_track(
    tracks: list[Track], media_time: datetime, multiday: bool, target_file: str | None = None
) -> TrackMatch | None:
    """Nearest point among KMLs whose name contains the media date (±1 day
    with multiday): an in-duration match wins immediately, otherwise the
    closest out-of-duration point is kept."""
    dates = _candidate_dates(media_time, multiday)

    best: TrackMatch | None = None
    for candidate in tracks:
        if not any(date in candidate.name for date in dates):
            continue
        pos = candidate.nearest(media_time.astimezone(UTC))
        if pos is None:
            continue
        log.verbose(
            f"Found GPS coordinate in {candidate.name} (lon/lat/alt): "
            f"{pos.point.longitude} {pos.point.latitude} {pos.point.altitude}",
            target=target_file,
        )
        if pos.inside_duration:
            return pos
        if best is None or pos.seconds_from_nearest < best.seconds_from_nearest:
            best = pos
    return best


def _verify_or_skip(
    latitude: float, longitude: float, best: TrackMatch, options: GeotagOptions, target_file: str | None = None
) -> bool:
    """Distance check of existing GPS against the KML match; False = skip the
    file (mismatch beyond threshold and no force)."""
    distance = coords.geo_distance(latitude, longitude, best.point.latitude, best.point.longitude)
    if distance > options.max_distance_meters:
        log.warning(
            f"Existing GPS and KML GPS differ by {round(distance, 2)} meters "
            f"(Threshold: {options.max_distance_meters}m)",
            target=target_file,
        )
        return options.force
    log.debug(f"Existing GPS and KML GPS match within threshold ({round(distance, 2)} meters).", target=target_file)
    return True


def decide_position(meta: MediaMetadata, find_best: FindBestTrack, options: GeotagOptions) -> list[Action]:
    """What to do with one file, as a value: nothing here reads or writes.

    `find_best` is the track lookup, handed over so a file that already has
    everything is skipped without searching the archive at all — the archive
    holds thousands of points and most files in a library are already tagged.
    """
    if meta.has_position and meta.has_altitude and not options.force and not options.verify_existing_gps:
        log.debug(
            f"GPSPosition already exists: {meta.get('GPSLatitude')} {meta.get('GPSLongitude')}", target=str(meta.path)
        )
        log.debug(f"GPSAltitude already exists: {meta.get('GPSAltitude')}", target=str(meta.path))
        return [Skip(meta.path, "GPS data already exists")]

    media_time = mediatime.parse_media_time(meta.tags, target=str(meta.path))
    if media_time is None:
        return [Failed(meta.path, "no valid timestamp")]

    best = find_best(media_time)
    if best is None:
        return [Failed(meta.path, "no matching GPS data in the KML archive")]
    if best.seconds_from_nearest > options.max_time_diff_seconds:
        return [
            Failed(
                meta.path,
                f"best match {round(best.seconds_from_nearest, 2)}s outside the {options.max_time_diff_seconds}s limit",
            )
        ]

    position = meta.position
    if options.verify_existing_gps and position is not None:
        if not _verify_or_skip(position[0], position[1], best, options, str(meta.path)):
            # 校验不符：文件保持原位（用户要的是核对结果，不是搬运）
            return [Failed(meta.path, "existing GPS disagrees with the KML", quarantine=False)]
        if meta.has_altitude and not options.force:
            return [Skip(meta.path, "existing GPS agrees with the KML match")]

    # KML 没带海拔时沿用文件里已有的值
    new_altitude = best.point.altitude or meta.altitude
    return [
        WriteTags(
            meta.path,
            build_tags(SetExifOptions(position=f"{best.point.latitude} {best.point.longitude}", altitude=new_altitude)),
            options.overwrite,
        )
    ]


def geotag_from_kml(
    path: Path | list[Path],
    kml_zip_path: str | None = None,
    options: GeotagOptions | None = None,
    parallel: bool = False,
) -> BatchResult[list[Action]]:
    """Set GPS position/altitude on media files from the KML ZIP archive.

    A file list is accepted so one call can cover a whole selection: the
    archive's relevant months are read and parsed once for the batch, not
    once per file.
    """
    options = options or GeotagOptions()

    archive_dir, zip_path = resolve_archive(kml_zip_path)

    try:
        library = _TrackLibrary(zip_path)
    except (OSError, BadZipFile) as exc:
        raise UserInputError(f"Failed to read KML archive file: {display_path(zip_path)}") from exc

    files = list_files(path)

    def process(file: Path) -> list[Action]:
        # 时间标签与 GPS 标签一次读齐，每个文件只往返 exiftool 一次
        meta = MediaMetadata.of(file, ctx.backend.read_tags(file, POSITION_TAGS))
        return run(
            decide_position(
                meta,
                lambda media_time: _find_best_track(
                    library.tracks_for(_candidate_dates(media_time, options.multiday)),
                    media_time,
                    options.multiday,
                    str(file),
                ),
                options,
            )
        )

    return run_per_file(
        files,
        process,
        activity="Setting GPS info from KML",
        failed_folder_name=options.failed_folder_name,
        parallel=parallel,
    )
