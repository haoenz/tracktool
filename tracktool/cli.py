"""Typer CLI application wiring every subsystem command."""

import difflib
import json
from pathlib import Path
from typing import Annotated, Any

import typer
from rich import box
from rich.table import Table

from . import __version__, coords, googleapi, log, mediatime, workflows
from .actions import describe
from .config import DEFAULTS, TRACK_KIND_NAMES, TRACK_TAG_PREFIX, describe_keys, normalize
from .context import RunMode, ctx
from .errors import EXIT_PARTIAL, EXIT_USER_ERROR, AppError, UserInputError
from .exif import google as exif_google
from .exif import media as exif_media
from .exif import position as exif_position
from .exif import write as exif_write
from .exif.position import MAX_DISTANCE_METERS, MAX_TIME_DIFF_SECONDS
from .fileutil import BatchResult
from .kml import archive as kml_archive
from .kml import edit as kml_edit
from .kml import kmlfile
from .kml.kmlfile import TrackKind
from .paths import display_path
from .progress import DEFAULT_WORKERS

# typer/_click 给用法错误（UsageError：命令名打错、选项不认识、缺必填参数）
# 留的保留码。它和我们的表无关，但值恰好与 EXIT_TOOL_ERROR（见 errors.py）相同，
# 所以 cli_main 必须把这一来源归一成 EXIT_USER_ERROR——否则调用方分不清「参数
# 拼错」和「exiftool 挂了」。
USAGE_ERROR_CODE = 2

app = typer.Typer(
    name="tracktool",
    help="Travel media geodata toolkit: KML track management and photo/video EXIF geotagging.",
    no_args_is_help=True,
)
kml_app = typer.Typer(help="KML track management", no_args_is_help=True)
archive_app = typer.Typer(help="Track archive: declare and inspect the archive directory", no_args_is_help=True)
exif_app = typer.Typer(help="EXIF geotagging and media repair", no_args_is_help=True)
google_app = typer.Typer(help="Google Maps API queries", no_args_is_help=True)
config_app = typer.Typer(help="Configuration", no_args_is_help=True)
app.add_typer(kml_app, name="kml")
app.add_typer(archive_app, name="archive")
app.add_typer(exif_app, name="exif")
app.add_typer(google_app, name="google")
app.add_typer(config_app, name="config")

ParallelOpt = Annotated[bool, typer.Option("--parallel", help=f"Process in parallel ({DEFAULT_WORKERS} threads)")]
QuietOpt = Annotated[bool, typer.Option("--quiet", "-q", help="Only warnings and errors")]
OffsetTimeOpt = Annotated[
    str, typer.Option("--offset-time", help="Fallback/forced capture timezone; preserves the wall clock")
]
TimezonePolicyOpt = Annotated[
    mediatime.TimezonePolicy,
    typer.Option("--timezone-policy", help="Existing timezone: auto skips, keep preserves, force replaces the zone"),
]
TimeSourceOpt = Annotated[
    str | None,
    typer.Option(
        "--time-source", help="Capture timestamp tag to use when values conflict (e.g. XMP-exif:DateTimeOriginal)"
    ),
]


def _version_callback(value: bool) -> None:
    if value:
        print(f"tracktool {__version__}")
        raise typer.Exit


@app.callback()
def main(
    version: Annotated[
        bool | None, typer.Option("--version", callback=_version_callback, is_eager=True, help="Show version and exit")
    ] = None,
    verbose: Annotated[int, typer.Option("--verbose", "-v", count=True, help="-v VERBOSE, -vv DEBUG")] = 0,
    quiet: QuietOpt = False,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Show what would be done without writing any file")
    ] = False,
) -> None:
    # --dry-run 是整次运行的模式，不是某个命令的开关：声明一次，所有写命令自动
    # 生效（写入集中在少数几个原语上，见 context.RunMode）。代价是它必须写在
    # 子命令之前——`tracktool --dry-run kml push a.kml`。
    ctx.mode = RunMode.PLAN if dry_run else RunMode.APPLY
    ctx.config.load(persist_migration=not ctx.is_plan)
    if verbose == 1:
        log.set_level("VERBOSE")
    elif verbose >= 2:
        log.set_level("DEBUG")
    elif quiet:
        log.set_level("WARNING")
    else:
        log.set_level(ctx.config.log_level)


def _resolve_path(path: Path, must_exist: bool = True) -> Path:
    path = path.expanduser().resolve()
    if must_exist and not path.exists():
        log.error(f"Path does not exist: {display_path(path)}")
        raise typer.Exit(code=EXIT_USER_ERROR)
    return path


GLOB_CHARS = "*?["


def _expand_paths(paths: list[Path]) -> list[Path]:
    """Expand a wildcard in the last path segment into the matching files, sorted.

    Windows forbids `*?[` in file names, so a name carrying one can only be a
    pattern and never a literal. Expansion happens here — before the whole
    list is handed to the batch entries — so the batch still sees every file
    at once, `--dry-run` previews the expanded set, and the sorted order makes
    the archive's shape reproducible (rebuild replays in name order too).
    """
    expanded: list[Path] = []
    for path in paths:
        pattern = path.expanduser()
        if not any(c in pattern.name for c in GLOB_CHARS):
            expanded.append(_resolve_path(path))
            continue
        matches = sorted(p.resolve() for p in pattern.parent.glob(pattern.name) if p.is_file())
        if not matches:
            log.error(f"No files match pattern: {display_path(path)}")
            raise typer.Exit(code=EXIT_USER_ERROR)
        expanded.extend(matches)
    return expanded


def _finish(result: BatchResult[Any]) -> None:
    """Report a dry run's plan, then exit 3 when files were left unprocessed.

    Showing what a command would do and reporting what it could not do are one
    call on purpose: a command that shows a plan owes the same exit code, and
    keeping the two apart is how one of them gets dropped after an edit.
    """
    if ctx.is_plan:
        _print_plan(result)
    if result.failed:
        raise typer.Exit(code=EXIT_PARTIAL)


def _print_plan(result: BatchResult[Any]) -> None:
    """Print the steps a dry run would take, one row per step.

    A file that cannot be processed has no step to show: its reason is in the
    log right above, and the exit code still reports how many files failed.
    Entries that are not plans (a read-only command's findings) have nothing to
    preview — that command has already printed its own answer.
    """
    if result.succeeded and not any(isinstance(entry, list) for entry in result.succeeded):
        return
    table = Table(box=box.SIMPLE)
    table.add_column("File")
    table.add_column("Action")
    table.add_column("Detail")
    for plan in result.succeeded:
        for action in plan if isinstance(plan, list) else ():
            kind, detail = describe(action)
            table.add_row(display_path(action.file), kind, detail)
    if table.row_count:
        log.console().print(table)
    else:
        log.info("Nothing to do")
    if result.failed:
        log.warning(f"{len(result.failed)} file(s) would fail (see the log above)")


# ── kml ─────────────────────────────────────────────────────────────────────


@archive_app.command("init")
def archive_init(
    directory: Annotated[
        Path | None, typer.Argument(help="Archive directory (default: the configured archive_path)")
    ] = None,
) -> None:
    """Declare a directory as the track archive (manifest + ZIP).

    The only command that creates an archive; everything else refuses an
    undeclared directory instead of silently starting a second one.
    """
    if directory is None:
        configured = str(ctx.config["archive_path"] or "")
        if not configured:
            raise UserInputError("No directory given and archive_path is not configured (set archive_path first)")
        directory = Path(configured)
    kml_archive.init_archive(directory)


@archive_app.command("status")
def archive_status(
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
) -> None:
    """Report whether the collections match the ZIP (the archive's truth)."""
    kml_archive.status(zip_path, tag_map=ctx.config.track_tag_map)


@archive_app.command("rebuild")
def archive_rebuild(
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
) -> None:
    """Regenerate the desktop and mobile collections from the ZIP."""
    kml_archive.rebuild(zip_path, tag_map=ctx.config.track_tag_map)


@kml_app.command("type")
def kml_type(
    path: Annotated[Path, typer.Argument(help="KML file")],
) -> None:
    """Print the track type (TrackTags)."""
    path = _resolve_path(path)
    kind = kmlfile.get_kml_type(path, tag_map=ctx.config.track_tag_map)
    print(kind if kind is not None else "Unknown")


@kml_app.command("set-type")
def kml_set_type(
    paths: Annotated[list[Path], typer.Argument(help="KML file(s) to retype, wildcards allowed")],
    track_type: Annotated[TrackKind, typer.Option("--type", help="Track type (Default/Train/Flight)")],
    create_tag: Annotated[
        bool, typer.Option("--create-tag", help="Add a TrackTags node to files that have none")
    ] = False,
) -> None:
    """Set the track type (TrackTags) of one or more KMLs."""
    _finish(kmlfile.set_kml_types(_expand_paths(paths), track_type, create_tag))


@kml_app.command("push")
def kml_push(
    paths: Annotated[list[Path], typer.Argument(help="KML file(s) to archive, wildcards allowed")],
    track_type: Annotated[TrackKind | None, typer.Option("--type", help="Track type (Default/Train/Flight)")] = None,
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    move: Annotated[bool, typer.Option("--move", help="Also move the source files into the backup folder")] = False,
) -> None:
    """Archive KMLs: add to both collections, compress into ZIP; sources stay put unless --move."""
    files = _expand_paths(paths)
    _finish(workflows.push_tracks(files, zip_path, track_type, move, tag_map=ctx.config.track_tag_map))


@kml_app.command("pop")
def kml_pop(
    kml_name: Annotated[str, typer.Argument(help="Exact track filename or stem to restore")],
    track_type: Annotated[TrackKind, typer.Option("--type", help="Track type")] = TrackKind.DEFAULT,
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    force: Annotated[bool, typer.Option("--force", help="Warn instead of stopping when the archive disagrees")] = False,
) -> None:
    """Restore a KML from the archive: extract into the current directory, remove from collections."""
    kml_archive.pop_kml_archive(kml_name, track_type, zip_path, force, tag_map=ctx.config.track_tag_map)


@kml_app.command("split")
def kml_split(
    path: Annotated[Path, typer.Argument(help="KML file to split")],
    split_points: Annotated[
        list[str] | None, typer.Argument(help="Timestamps or coordinates to split at (omit with --auto)")
    ] = None,
    auto: Annotated[
        bool, typer.Option("--auto", help="Split at detected recording gaps instead of given points")
    ] = False,
    gap_seconds: Annotated[float, typer.Option(min=0, help="--auto: minimum time jump (seconds)")] = 300.0,
    gap_meters: Annotated[float, typer.Option(min=0, help="--auto: minimum distance jump (meters)")] = 500.0,
) -> None:
    """Split a track at the given timestamps/coordinates, or at recording gaps with --auto."""
    path = _resolve_path(path)
    if auto and split_points:
        raise UserInputError("Pass either split points or --auto, not both")
    if not auto and not split_points:
        raise UserInputError("No split points given; use --auto to detect recording gaps")
    if auto:
        split_points = kml_edit.detect_gap_points(path, gap_seconds, gap_meters)
        if not split_points:
            log.info("No recording gap detected, nothing to split", target=str(path))
            return
    else:
        assert split_points is not None  # 守卫已保证非 auto 时必带切分点，mypy 需要显式收窄
    kml_edit.split_kml(path, split_points)


@kml_app.command("prune")
def kml_prune(
    path: Annotated[Path, typer.Argument(help="KML file")],
    bad_points: Annotated[
        list[str] | None, typer.Argument(help="One point, or two points as a range (max 2; omit with --auto)")
    ] = None,
    auto: Annotated[bool, typer.Option("--auto", help="Remove detected drift bursts instead of given points")] = False,
    speed_mps: Annotated[
        float, typer.Option(min=0, help="--auto: implausible speed that triggers a burst (m/s)")
    ] = 30.0,
    jump_meters: Annotated[
        float, typer.Option(min=0, help="--auto: implausible single-step distance (meters)")
    ] = 100.0,
    return_meters: Annotated[
        float, typer.Option(min=0, help="--auto: coming back this close to the anchor ends a burst")
    ] = 30.0,
    max_seconds: Annotated[
        float, typer.Option(min=0, help="--auto: a burst must return within this window (seconds)")
    ] = 120.0,
) -> None:
    """Remove bad points (or the range between two), or drift bursts with --auto."""
    path = _resolve_path(path)
    if auto and bad_points:
        raise UserInputError("Pass either bad points or --auto, not both")
    if not auto and not bad_points:
        raise UserInputError("No bad points given; use --auto to detect drift bursts")
    if auto:
        if not kml_edit.prune_drift_points(path, speed_mps, jump_meters, return_meters, max_seconds):
            log.info("No drift burst detected, nothing to prune", target=str(path))
        return
    assert bad_points is not None  # 守卫已保证非 auto 时必带点位，mypy 需要显式收窄
    kml_edit.prune_points(path, bad_points)


@kml_app.command("merge")
def kml_merge(
    paths: Annotated[list[Path], typer.Argument(help="KML files to merge, wildcards allowed")],
    output_path: Annotated[Path, typer.Option("--output", "-o", help="New output KML path (must not exist)")],
    connected: Annotated[bool, typer.Option("--connected", help="Concatenate into one LineString")] = False,
    move: Annotated[bool, typer.Option("--move", help="Also move the source files into the backup folder")] = False,
) -> None:
    """Merge multiple KMLs into one file."""
    paths = _expand_paths(paths)
    kml_edit.merge_kml(paths, output_path.expanduser().absolute(), connected, move, tag_map=ctx.config.track_tag_map)


@kml_app.command("to-multigeom")
def kml_to_multigeom(
    path: Annotated[Path, typer.Argument(help="Source KML file")],
    output_path: Annotated[Path | None, typer.Option("--output", "-o", help="Output path")] = None,
) -> None:
    """Rewrap all LineStrings into a single MultiGeometry Placemark."""
    path = _resolve_path(path)
    kml_edit.convert_kml_to_multigeometry(path, output_path)


@kml_app.command("fill-altitude")
def kml_fill_altitude(
    path: Annotated[Path, typer.Argument(help="KML file to update in place")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
) -> None:
    """Fill altitude for the tracks that carry none (Google Elevation)."""
    path = _resolve_path(path)
    kml_edit.fill_kml_altitude_from_google(path, api_key)


# ── exif ────────────────────────────────────────────────────────────────────


@exif_app.command("set")
def exif_set(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    position: Annotated[str | None, typer.Option("--position", "-p", help="GPS position (decimal or DMS)")] = None,
    altitude: Annotated[float | None, typer.Option("--altitude", "-a", help="GPS altitude")] = None,
    make: Annotated[str | None, typer.Option("--make", help="Camera make")] = None,
    model: Annotated[str | None, typer.Option("--model", help="Camera model")] = None,
    tags: Annotated[list[str] | None, typer.Option("--tag", "-t", help="Extra tags NAME=VALUE")] = None,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite original files")] = False,
    parallel: ParallelOpt = False,
) -> None:
    """Write EXIF tags (GPS position/altitude, Make/Model, arbitrary tags)."""
    path = _resolve_path(path)
    tag_dict: dict[str, str] = {}
    for tag in tags or []:
        if "=" not in tag:
            raise UserInputError(f"Invalid tag format (expected NAME=VALUE): {tag}")
        name, value = tag.split("=", 1)
        tag_dict[name] = value
    options = exif_write.SetExifOptions(
        position=position, altitude=altitude, make=make, model=model, tags=tag_dict, overwrite=overwrite
    )
    result = exif_write.set_exif(path, options, parallel)
    _finish(result)


@exif_app.command("info")
def exif_info(
    path: Annotated[Path, typer.Argument(help="Media file")],
) -> None:
    """Print GPS position, altitude, and timestamp."""
    path = _resolve_path(path)
    exif_write.print_media_info(path)


@exif_app.command("show-missing")
def exif_show_missing(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    tags: Annotated[list[str], typer.Argument(help="Tags to check, e.g. GPSPosition GPSAltitude")],
    parallel: ParallelOpt = False,
) -> None:
    """List files missing the given tags (zero altitude counts as missing)."""
    path = _resolve_path(path)
    batch = exif_write.find_missing_tag(path, tags, parallel)
    table = Table(box=box.SIMPLE)
    table.add_column("File")
    table.add_column("Missing")
    for result in batch.succeeded:
        table.add_row(display_path(result.file), ", ".join(result.missing_tags))
    log.console().print(table)
    if not batch.succeeded:
        log.info("No files missing the requested tags")
    _finish(batch)


@exif_app.command("geotag")
def exif_geotag(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    max_time_diff: Annotated[
        int, typer.Option("--max-time-diff", help="Max seconds from the nearest recorded track point")
    ] = MAX_TIME_DIFF_SECONDS,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    force: Annotated[bool, typer.Option("--force", help="Update even when GPS exists")] = False,
    verify: Annotated[bool, typer.Option("--verify", help="Verify existing GPS against KML")] = False,
    max_distance: Annotated[
        int, typer.Option("--max-distance", help="Verification threshold in meters")
    ] = MAX_DISTANCE_METERS,
    multiday: Annotated[bool, typer.Option("--multiday", help="Also check ±1 day tracks")] = False,
    failed_folder: Annotated[str | None, typer.Option("--failed-folder", help="Move failures here")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Geotag media from the KML archive by timestamp matching."""
    path = _resolve_path(path)
    options = exif_position.GeotagOptions(
        max_time_diff_seconds=max_time_diff,
        overwrite=overwrite,
        force=force,
        verify_existing_gps=verify,
        max_distance_meters=max_distance,
        multiday=multiday,
        failed_folder_name=failed_folder,
    )
    result = exif_position.geotag_from_kml(path, zip_path, options, parallel)
    _finish(result)


@exif_app.command("fill-altitude")
def exif_fill_altitude(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    failed_folder: Annotated[str | None, typer.Option("--failed-folder", help="Move failures here")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Fill missing GPSAltitude from Google Elevation."""
    path = _resolve_path(path)
    result = exif_google.fill_altitude_from_google(path, overwrite, failed_folder, parallel, api_key)
    _finish(result)


@exif_app.command("set-location")
def exif_set_location(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
    language: Annotated[str, typer.Option("--language", help="Geocoding language")] = "en",
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    failed_folder: Annotated[str | None, typer.Option("--failed-folder", help="Move failures here")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Reverse geocode GPSPosition into IPTC City/State/Country tags."""
    path = _resolve_path(path)
    result = exif_google.set_location_from_google(path, overwrite, failed_folder, parallel, api_key, language)
    _finish(result)


@exif_app.command("shift-time")
def exif_shift_time(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    time_diff: Annotated[str | None, typer.Option("--by", help="Integer d/h/m/s in order, e.g. +1h30m, -2d")] = None,
    offset_time: Annotated[str | None, typer.Option("--offset-time", help="New timezone offset (SONY only)")] = None,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    parallel: ParallelOpt = False,
) -> None:
    """Shift EXIF timestamps; Insta360 files are renamed too."""
    path = _resolve_path(path)
    if time_diff == "":
        raise UserInputError("--by must not be empty; use a shift such as +1h30m or -2d.")
    if not time_diff and not offset_time:
        log.error("At least one of --by or --offset-time must be provided")
        raise typer.Exit(code=EXIT_USER_ERROR)
    result = exif_media.shift_exif_time(path, time_diff or "", offset_time or "", overwrite, parallel)
    _finish(result)


@exif_app.command("shift-altitude")
def exif_shift_altitude(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    offset: Annotated[float, typer.Argument(help="Altitude offset in meters")],
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    parallel: ParallelOpt = False,
) -> None:
    """Shift GPSAltitude by a fixed offset."""
    path = _resolve_path(path)
    result = exif_media.shift_altitude(path, offset, overwrite, parallel)
    _finish(result)


@exif_app.command("to-mp4")
def exif_to_mp4(
    path: Annotated[Path, typer.Argument(help="File or directory with videos")],
    output_directory: Annotated[Path | None, typer.Option("--output", "-o", help="Output directory")] = None,
    make: Annotated[str | None, typer.Option("--make", help="Camera make to write")] = None,
    model: Annotated[str | None, typer.Option("--model", help="Camera model to write")] = None,
    offset_time: OffsetTimeOpt = mediatime.DEFAULT_TZ_OFFSET,
    parallel: ParallelOpt = False,
    timezone_policy: TimezonePolicyOpt = mediatime.TimezonePolicy.AUTO,
    time_source: TimeSourceOpt = None,
) -> None:
    """Remux videos to MP4 with creation_time + XMP tags (ffmpeg)."""
    path = _resolve_path(path)
    output_dir = _resolve_path(output_directory) if output_directory else None
    result = exif_media.convert_to_mp4(
        path, make, model, output_dir, offset_time, parallel, timezone_policy, time_source
    )
    _finish(result)


@exif_app.command("group")
def exif_group(
    path: Annotated[Path, typer.Argument(help="Directory to organize")],
) -> None:
    """Sort files into VID/RAW/IMG subdirectories by extension."""
    path = _resolve_path(path)
    exif_media.group_media_files(path)


@exif_app.command("repair")
def exif_repair(
    path: Annotated[Path, typer.Argument(help="Directory of media files")],
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Repair files missing GPSPosition/GPSAltitude (Google altitude, then KML position)."""
    path = _resolve_path(path)
    result = workflows.resolve_missing_gps(path, parallel, zip_path)
    _finish(result)


@exif_app.command("repair-vid")
def exif_repair_vid(
    path: Annotated[Path, typer.Argument(help="Directory containing a VID subdirectory")],
    make: Annotated[str | None, typer.Option("--make", help="Camera make to write")] = None,
    model: Annotated[str | None, typer.Option("--model", help="Camera model to write")] = None,
    offset_time: OffsetTimeOpt = mediatime.DEFAULT_TZ_OFFSET,
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    parallel: ParallelOpt = False,
    timezone_policy: TimezonePolicyOpt = mediatime.TimezonePolicy.AUTO,
    time_source: TimeSourceOpt = None,
) -> None:
    """Video pipeline: VID -> VID_original, convert to MP4, then repair GPS."""
    path = _resolve_path(path)
    result = workflows.resolve_vid_exif(
        path, make, model, offset_time, parallel, zip_path, timezone_policy, time_source
    )
    _finish(result)


# ── google ──────────────────────────────────────────────────────────────────


@google_app.command("altitude")
def google_altitude(
    coordinates: Annotated[list[str], typer.Argument(help="Coordinates (decimal 'lat,lon' or DMS)")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
) -> None:
    """Query elevations (auto-batched)."""
    points: list[tuple[float, float]] = []
    for coordinate in coordinates:
        point = coords.parse_coordinate(coordinate)
        if point is None:
            raise UserInputError(f"Unrecognized coordinate: {coordinate}")
        points.append(point)

    elevations = googleapi.get_altitudes(points, api_key)
    for coord, elevation in zip(coordinates, elevations, strict=False):
        print(f"{coord}\t{elevation}")


@google_app.command("location")
def google_location(
    coordinate: Annotated[str, typer.Argument(help="Coordinate (decimal 'lat,lon' or DMS)")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
    language: Annotated[str, typer.Option("--language", help="Geocoding language")] = "en",
) -> None:
    """Reverse geocode a coordinate."""
    point = coords.parse_coordinate(coordinate)
    if point is None:
        raise UserInputError(f"Unrecognized coordinate: {coordinate}")

    location = googleapi.get_location(point[0], point[1], api_key, language=language)
    print(json.dumps(location.as_dict(), ensure_ascii=False, indent=2))


# ── config ──────────────────────────────────────────────────────────────────


@config_app.command("show")
def config_show() -> None:
    """Print the current configuration."""
    print(json.dumps(ctx.config.as_dict(), ensure_ascii=False, indent=2))


# ignore_unknown_options 是为了让值本身可以以 `-` 开头：`-散步` 从活动名表里删掉一个词，
# 而 click 默认会把任何以 `-` 起头的 token 当成选项。这条命令自己一个选项都没有，
# 所以放行未知选项不会吃掉任何东西；`--help` 仍是已知选项，照常工作。
@config_app.command("set", context_settings={"ignore_unknown_options": True})
def config_set(
    key: Annotated[str | None, typer.Argument(help="Config key")] = None,
    value: Annotated[str | None, typer.Argument(help="Config value")] = None,
) -> None:
    """Set a configuration value (e.g. google_api_key, archive_path, log_level)."""
    available = describe_keys()
    if key is None:
        raise UserInputError(f"Usage: tracktool config set <key> <value>. Available keys: {available}")
    if key.startswith(TRACK_TAG_PREFIX) and key not in DEFAULTS:
        # 表里的键长而多，拼错时给的是「哪一类」而不是 difflib 猜出来的最近键
        raise UserInputError(
            f"Unknown track category: {key}. Categories: {', '.join(TRACK_KIND_NAMES)}; add an activity with "
            f'tracktool config set "{TRACK_TAG_PREFIX}Default" "+<activity>"'
        )
    if key not in DEFAULTS:
        close = difflib.get_close_matches(key, DEFAULTS, n=1)
        hint = f" (closest: {close[0]})" if close else ""
        raise UserInputError(f"Unknown config key: {key}. Available keys: {available}{hint}")
    if value is None:
        raise UserInputError(f"Missing value for {key}. Available keys: {available}")
    value = normalize(key, value)
    if ctx.is_plan:
        # 配置不走那些文件原语（config 在最底层，读不到运行模式），
        # 所以这条命令自己声明；写一行配置本来也就是它的全部工作
        log.info(f"Would set {key} = {value}")
        return
    if key.startswith(TRACK_TAG_PREFIX):
        # 活动名表由 Config 落地（+ / - / 整类替换，以及跨类别互斥），
        # 报出来的是这一类改完之后的样子，而不是敲进去的那段 spec
        listed = ctx.config.set_tag_list(key, value)
        ctx.config.save()
        log.info(f"{key} = {', '.join(listed)}")
        return
    ctx.config[key] = value
    ctx.config.save()
    if key == "log_level":
        log.set_level(value)
    log.info(f"{key} = {value}")


def cli_main() -> None:
    """Console-script entry point: expected failures become exit codes.

    Anything deriving from AppError is expected — a bad path, bad
    coordinates, broken config, malformed KML, a missing API key, exiftool
    failing — and becomes one log line plus that error's own exit code (1
    for user input, 2 for an external tool or API). Anything else is a bug
    and keeps its traceback. A batch that left files unprocessed exits 3
    through _finish, which the command itself raises.
    """
    try:
        app()
    except SystemExit as exc:
        # typer 的用法错误与我们的表共用 2，这里归一成 1（详见
        # USAGE_ERROR_CODE）；其余退出码（0 的 --help/--version、3 的部分
        # 失败）原样透传。
        if exc.code == USAGE_ERROR_CODE:
            raise SystemExit(EXIT_USER_ERROR) from exc
        raise
    except AppError as exc:
        log.error(f"Command failed: {exc}")
        raise SystemExit(exc.exit_code) from exc


if __name__ == "__main__":
    cli_main()
