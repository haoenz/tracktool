"""Google-powered EXIF completion: altitude fill and reverse-geocoded IPTC tags.

Both commands are a billable query wrapped in file work, so both plan the query
as a `Lookup`: a dry run then names the points that would be queried instead of
spending quota to find out, and the stage that owns the call reads the query
back off the plan and re-plans with the answer.
"""

from pathlib import Path

from .. import googleapi, log
from ..actions import Action, Failed, Lookup, Skip, WriteTags, run
from ..context import ctx
from ..discover import list_files
from ..fileutil import BatchResult, run_per_file
from ..metadata import MediaMetadata
from .write import SetExifOptions, build_tags

ALTITUDE_TAGS = ["GPSAltitude", "GPSLatitude", "GPSLongitude"]
LOCATION_TAGS = ["GPSLatitude", "GPSLongitude"]

ELEVATION_PROVIDER = "Google Elevation"
GEOCODING_PROVIDER = "Google Geocoding"


def decide_altitude(meta: MediaMetadata) -> list[Action]:
    """Whether this file needs an elevation, and what to query for it."""
    if meta.has_altitude:
        log.debug(f"GPSAltitude already exists: {meta.get('GPSAltitude')}", target=str(meta.path))
        return [Skip(meta.path, "GPSAltitude already exists")]
    if meta.get("GPSAltitude"):
        log.debug(f"GPSAltitude is zero: {meta.get('GPSAltitude')}", target=str(meta.path))
    else:
        log.debug("No GPSAltitude found", target=str(meta.path))

    position = meta.position
    if position is None:
        return [Failed(meta.path, "no GPS position to query an elevation for")]
    latitude, longitude = position
    return [Lookup(meta.path, ELEVATION_PROVIDER, f"{latitude},{longitude}", point=position)]


def decide_location(meta: MediaMetadata) -> Lookup | Failed:
    """The coordinate to reverse geocode, or why this file cannot be geocoded."""
    position = meta.position
    if position is None:
        return Failed(meta.path, "no GPS position to reverse geocode")
    latitude, longitude = position
    return Lookup(meta.path, GEOCODING_PROVIDER, f"{latitude},{longitude}", point=position)


def _location_tags(lookup: Lookup, api_key: str | None, language: str,
                   overwrite: bool) -> list[Action]:
    """Run the reverse-geocoding lookup and plan the tags it implies."""
    latitude, longitude = lookup.point
    location = googleapi.get_location(latitude, longitude, api_key, language=language)

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
        return [Failed(lookup.file, "no location fields returned by the API")]
    return [WriteTags(lookup.file, tags, overwrite)]


def set_altitude_from_google(path: Path | list[Path], overwrite: bool = False,
                             failed_folder_name: str | None = None,
                             parallel: bool = False, api_key: str | None = None,
                             dry_run: bool = False) -> BatchResult[list[Action]]:
    """Fill GPSAltitude for files missing it (zero counts as missing).

    An explicit file list is accepted so one call covers the whole selection:
    every needing file's coordinate goes into a single batched Elevation
    request, which is why a caller repairing many files must hand over the
    list instead of looping per file.
    """
    files = list_files(path)
    result: BatchResult[list[Action]] = BatchResult()

    # Step 1: 找出需要补海拔的文件（读取阶段可并行）
    def check_altitude(file: Path) -> list[Action]:
        return run(decide_altitude(MediaMetadata.of(
            file, ctx.backend.read_tags(file, ALTITUDE_TAGS))), dry_run=dry_run)

    checked = run_per_file(files, check_altitude, activity="Checking altitude data",
                           failed_folder_name=failed_folder_name, parallel=parallel,
                           dry_run=dry_run)
    result.merge(checked)
    queries = [action for plan in checked.succeeded for action in plan
               if isinstance(action, Lookup)]
    if not queries:
        log.info("No files require altitude updates")
        return result

    log.info(f"Found {len(queries)} file(s) requiring altitude data")
    if dry_run:
        return result  # 计划里已经写明会查哪些点，不为此花掉配额

    # Step 2: 查询 Google 高程 API（客户端按 512 点 / URL 长度分批，一次调用覆盖全部文件）
    elevations = googleapi.get_altitudes([query.point for query in queries], api_key=api_key)

    # Step 3: 写回海拔（按文件路径对齐：一个文件的判定至多产出一次查询）
    elevation_by_file = dict(zip((query.file for query in queries), elevations, strict=True))

    def update(file: Path) -> list[Action]:
        altitude = elevation_by_file[file]
        if altitude is None:
            return run([Failed(file, "no elevation data returned by the API")])
        return run([WriteTags(file, build_tags(SetExifOptions(altitude=altitude)),
                              overwrite=overwrite)])

    result.merge(run_per_file(list(elevation_by_file), update,
                              activity="Updating altitude",
                              failed_folder_name=failed_folder_name, parallel=parallel))
    log.info(f"Altitude update completed for {len(queries)} file(s)")
    return result


def set_location_from_google(path: Path | list[Path], overwrite: bool = False,
                             failed_folder_name: str | None = None,
                             parallel: bool = False, api_key: str | None = None,
                             language: str = "en",
                             dry_run: bool = False) -> BatchResult[list[Action]]:
    """Reverse geocode GPS position into IPTC City/State/Country tags."""
    files = list_files(path)

    def process(file: Path) -> list[Action]:
        decision = decide_location(MediaMetadata.of(
            file, ctx.backend.read_tags(file, LOCATION_TAGS)))
        if isinstance(decision, Failed):
            return run([decision], dry_run=dry_run)
        if dry_run:
            return run([decision], dry_run=True)
        return run(_location_tags(decision, api_key, language, overwrite))

    return run_per_file(files, process, activity="Setting EXIF location from Google",
                        failed_folder_name=failed_folder_name, parallel=parallel,
                        dry_run=dry_run)
