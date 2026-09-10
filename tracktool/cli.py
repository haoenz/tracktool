"""Typer CLI application wiring every subsystem command."""

import json
from pathlib import Path
from typing import Annotated

import typer
from rich import box
from rich.table import Table

from . import __version__, dedup, log
from .config import LEVELS, config
from .exif import google as exif_google
from .exif import media as exif_media
from .exif import position as exif_position
from .exif import resolve as exif_resolve
from .exif import write as exif_write
from .kml import archive as kml_archive
from .kml import edit as kml_edit
from .kml import kmlfile
from .progress import DEFAULT_WORKERS

app = typer.Typer(
    name="tracktool",
    help="Travel media geodata toolkit: KML track management and photo/video EXIF geotagging.",
    no_args_is_help=True,
    add_completion=False,
)
kml_app = typer.Typer(help="KML track management", no_args_is_help=True)
exif_app = typer.Typer(help="EXIF geotagging and media repair", no_args_is_help=True)
google_app = typer.Typer(help="Google Maps API queries", no_args_is_help=True)
hash_app = typer.Typer(help="MD5 hash log, duplicates, directory comparison", no_args_is_help=True)
config_app = typer.Typer(help="Configuration", no_args_is_help=True)
app.add_typer(kml_app, name="kml")
app.add_typer(exif_app, name="exif")
app.add_typer(google_app, name="google")
app.add_typer(hash_app, name="hash")
app.add_typer(config_app, name="config")

ParallelOpt = Annotated[bool, typer.Option("--parallel", help=f"Process in parallel ({DEFAULT_WORKERS} threads)")]
QuietOpt = Annotated[bool, typer.Option("--quiet", "-q", help="Only warnings and errors")]


def _version_callback(value: bool) -> None:
    if value:
        print(f"tracktool {__version__}")
        raise typer.Exit


@app.callback()
def main(
    version: Annotated[bool | None, typer.Option("--version", callback=_version_callback,
                                                    is_eager=True, help="Show version and exit")] = None,
    verbose: Annotated[int, typer.Option("--verbose", "-v", count=True, help="-v VERBOSE, -vv DEBUG")] = 0,
    quiet: QuietOpt = False,
) -> None:
    config.load()
    if verbose == 1:
        log.set_level("VERBOSE")
    elif verbose >= 2:
        log.set_level("DEBUG")
    elif quiet:
        log.set_level("WARNING")
    else:
        log.set_level(config.log_level)


def _resolve_path(path: Path, must_exist: bool = True) -> Path:
    path = path.expanduser().resolve()
    if must_exist and not path.exists():
        log.error(f"Path does not exist: {path}")
        raise typer.Exit(code=1)
    return path


# ── kml ─────────────────────────────────────────────────────────────────────


@kml_app.command("type")
def kml_type(
    path: Annotated[Path, typer.Argument(help="KML file")],
    set: Annotated[str | None, typer.Option("--set", help="Set track type (Default/Train/Flight)")] = None,
) -> None:
    """Get or set the track type (TrackTags)."""
    path = _resolve_path(path)
    if set:
        kmlfile.set_kml_type(path, set)
    else:
        print(kmlfile.get_kml_type(path))


@kml_app.command("push")
def kml_push(
    path: Annotated[Path, typer.Argument(help="KML file to archive")],
    type: Annotated[str | None, typer.Option("--type", help="Track type (Default/Train/Flight)")] = None,
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    no_archive: Annotated[bool, typer.Option("--no-archive", help="Skip adding to ZIP")] = False,
) -> None:
    """Archive a KML: add to both collections, compress into ZIP, move to backup."""
    path = _resolve_path(path)
    kml_archive.push_kml_archive(path, zip_path, type, no_archive)


@kml_app.command("pop")
def kml_pop(
    kml_name: Annotated[str, typer.Argument(help="Track name to restore")],
    type: Annotated[str, typer.Option("--type", help="Track type")] = "Default",
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
) -> None:
    """Restore a KML from the archive: extract from ZIP, remove from collections."""
    kml_archive.pop_kml_archive(kml_name, type, zip_path)


@kml_app.command("split")
def kml_split(
    path: Annotated[Path, typer.Argument(help="KML file to split")],
    split_points: Annotated[list[str], typer.Argument(help="Timestamps or coordinates to split at")],
) -> None:
    """Split a track at the given timestamps/coordinates."""
    path = _resolve_path(path)
    kml_edit.split_kml(path, split_points)


@kml_app.command("remove-bad")
def kml_remove_bad(
    path: Annotated[Path, typer.Argument(help="KML file")],
    bad_points: Annotated[list[str], typer.Argument(help="One point, or two points as a range (max 2)")],
) -> None:
    """Remove bad points (or the range between two) from a track."""
    path = _resolve_path(path)
    kml_edit.remove_bad_points(path, bad_points)


@kml_app.command("merge")
def kml_merge(
    paths: Annotated[list[Path], typer.Argument(help="KML files to merge")],
    output_path: Annotated[Path, typer.Option("--output", "-o", help="Output KML path")],
    connected: Annotated[bool, typer.Option("--connected", help="Concatenate into one LineString")] = False,
    no_archive: Annotated[bool, typer.Option("--no-archive", help="Skip archiving source files")] = False,
) -> None:
    """Merge multiple KMLs into one file."""
    paths = [_resolve_path(p) for p in paths]
    kml_edit.merge_kml(paths, output_path.expanduser().resolve(), connected, no_archive)


@kml_app.command("to-multigeom")
def kml_to_multigeom(
    path: Annotated[Path, typer.Argument(help="Source KML file")],
    output_path: Annotated[Path | None, typer.Option("--output", "-o", help="Output path")] = None,
) -> None:
    """Rewrap all LineStrings into a single MultiGeometry Placemark."""
    path = _resolve_path(path)
    kml_edit.convert_kml_to_multigeometry(path, output_path)


@kml_app.command("set-altitude")
def kml_set_altitude(
    path: Annotated[Path, typer.Argument(help="KML file to update in place")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
) -> None:
    """Fill altitude for every LineString coordinate via Google Elevation."""
    path = _resolve_path(path)
    kml_edit.set_kml_altitude_from_google(path, api_key)


# ── exif ────────────────────────────────────────────────────────────────────


@exif_app.command("set")
def exif_set(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    position: Annotated[str | None, typer.Option("--position", "-p", help="GPS position (4 formats)")] = None,
    altitude: Annotated[float | None, typer.Option("--altitude", "-a", help="GPS altitude")] = None,
    make: Annotated[str | None, typer.Option("--make", help="Camera make")] = None,
    model: Annotated[str | None, typer.Option("--model", help="Camera model")] = None,
    tags: Annotated[list[str] | None, typer.Option("--tag", "-t", help="Extra tags NAME=VALUE")] = None,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite original files")] = False,
    parallel: ParallelOpt = False,
) -> None:
    """Write EXIF tags (GPS position/altitude, Make/Model, arbitrary tags)."""
    path = _resolve_path(path)
    tag_dict = dict(tag.split("=", 1) for tag in (tags or []))
    options = exif_write.SetExifOptions(position=position, altitude=altitude, make=make,
                                        model=model, tags=tag_dict, overwrite=overwrite)
    exif_write.set_exif(path, options, parallel)


@exif_app.command("info")
def exif_info(
    path: Annotated[Path, typer.Argument(help="Media file")],
) -> None:
    """Print GPS position, altitude, and timestamp."""
    path = _resolve_path(path)
    exif_write.write_media_info(path)


@exif_app.command("find-missing")
def exif_find_missing(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    tags: Annotated[list[str], typer.Argument(help="Tags to check, e.g. GPSPosition GPSAltitude")],
    parallel: ParallelOpt = False,
) -> None:
    """List files missing the given tags (zero altitude counts as missing)."""
    path = _resolve_path(path)
    results = exif_write.find_missing_tag(path, tags, parallel)
    table = Table(box=box.SIMPLE)
    table.add_column("File")
    table.add_column("Missing")
    for result in results:
        table.add_row(str(result.file), ", ".join(result.missing_tags))
    log.console().print(table)
    if not results:
        log.info("No files missing the requested tags")


@exif_app.command("set-position")
def exif_set_position(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    max_time_diff: Annotated[int, typer.Option("--max-time-diff", help="Max seconds outside track duration")] = 60,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    force: Annotated[bool, typer.Option("--force", help="Update even when GPS exists")] = False,
    verify: Annotated[bool, typer.Option("--verify", help="Verify existing GPS against KML")] = False,
    max_distance: Annotated[int, typer.Option("--max-distance", help="Verification threshold in meters")] = 100,
    multiday: Annotated[bool, typer.Option("--multiday", help="Also check ±1 day tracks")] = False,
    failed_folder: Annotated[str | None, typer.Option("--failed-folder", help="Move failures here")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Geotag media from the KML archive by timestamp matching."""
    path = _resolve_path(path)
    options = exif_position.SetPositionOptions(
        max_time_diff_seconds=max_time_diff, overwrite=overwrite, force=force,
        verify_existing_gps=verify, max_distance_meters=max_distance,
        multiday=multiday, failed_folder_name=failed_folder)
    exif_position.set_position_from_kml(path, zip_path, options, parallel)


@exif_app.command("set-altitude")
def exif_set_altitude(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    failed_folder: Annotated[str | None, typer.Option("--failed-folder", help="Move failures here")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Fill missing GPSAltitude from Google Elevation."""
    path = _resolve_path(path)
    exif_google.set_altitude_from_google(path, overwrite, failed_folder, parallel, api_key)


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
    exif_google.set_location_from_google(path, overwrite, failed_folder, parallel, api_key, language)


@exif_app.command("move-time")
def exif_move_time(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    time_diff: Annotated[str | None, typer.Option("--time-diff", help="Shift like +1h30m, -2d")] = None,
    offset_time: Annotated[str | None, typer.Option("--offset-time", help="New timezone offset (SONY only)")] = None,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    parallel: ParallelOpt = False,
) -> None:
    """Shift EXIF timestamps; Insta360 files are renamed too."""
    path = _resolve_path(path)
    if not time_diff and not offset_time:
        log.error("At least one of --time-diff or --offset-time must be provided")
        raise typer.Exit(code=1)
    exif_media.move_exif_time(path, time_diff or "", offset_time or "", overwrite, parallel)


@exif_app.command("move-altitude")
def exif_move_altitude(
    path: Annotated[Path, typer.Argument(help="File or directory")],
    offset: Annotated[float, typer.Argument(help="Altitude offset in meters")],
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Overwrite originals")] = False,
    parallel: ParallelOpt = False,
) -> None:
    """Shift GPSAltitude by a fixed offset."""
    path = _resolve_path(path)
    exif_media.move_altitude(path, offset, overwrite, parallel)


@exif_app.command("to-mp4")
def exif_to_mp4(
    path: Annotated[Path, typer.Argument(help="File or directory with videos")],
    output_directory: Annotated[Path | None, typer.Option("--output", "-o", help="Output directory")] = None,
    make: Annotated[str | None, typer.Option("--make", help="Camera make to write")] = None,
    model: Annotated[str | None, typer.Option("--model", help="Camera model to write")] = None,
    offset_time: Annotated[str, typer.Option("--offset-time", help="Default timezone offset")] = "+08:00",
    parallel: ParallelOpt = False,
) -> None:
    """Remux videos to MP4 with creation_time + XMP tags (ffmpeg)."""
    path = _resolve_path(path)
    output_dir = _resolve_path(output_directory) if output_directory else None
    exif_media.convert_to_mp4(path, make, model, output_dir, offset_time, parallel)


@exif_app.command("group")
def exif_group(
    path: Annotated[Path, typer.Argument(help="Directory to organize")],
) -> None:
    """Sort files into VID/RAW/IMG subdirectories by extension."""
    path = _resolve_path(path)
    exif_media.group_media_files(path)


@exif_app.command("resolve-missing")
def exif_resolve_missing(
    path: Annotated[Path, typer.Argument(help="Directory of media files")],
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Repair files missing GPSPosition/GPSAltitude (Google altitude, then KML position)."""
    path = _resolve_path(path)
    exif_resolve.resolve_missing_gps(path, parallel, zip_path)


@exif_app.command("resolve-vid")
def exif_resolve_vid(
    path: Annotated[Path, typer.Argument(help="Directory containing a VID subdirectory")],
    make: Annotated[str | None, typer.Option("--make", help="Camera make to write")] = None,
    model: Annotated[str | None, typer.Option("--model", help="Camera model to write")] = None,
    offset_time: Annotated[str, typer.Option("--offset-time", help="Default timezone offset")] = "+08:00",
    zip_path: Annotated[str | None, typer.Option("--zip", help="KML ZIP archive path")] = None,
    parallel: ParallelOpt = False,
) -> None:
    """Video pipeline: VID -> VID_original, convert to MP4, then repair GPS."""
    path = _resolve_path(path)
    exif_resolve.resolve_vid_exif(path, make, model, offset_time, parallel, zip_path)


# ── google ──────────────────────────────────────────────────────────────────


@google_app.command("altitude")
def google_altitude(
    coordinates: Annotated[list[str], typer.Argument(help="Coordinates (decimal 'lat,lon' or DMS)")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
) -> None:
    """Query elevations (auto-batched)."""
    from . import googleapi

    elevations = googleapi.get_altitudes(coordinates, api_key)
    for coord, elevation in zip(coordinates, elevations, strict=False):
        print(f"{coord}\t{elevation}")


@google_app.command("location")
def google_location(
    coordinate: Annotated[str, typer.Argument(help="Coordinate (decimal 'lat,lon' or DMS)")],
    api_key: Annotated[str | None, typer.Option("--api-key", help="Google Maps API key")] = None,
    language: Annotated[str, typer.Option("--language", help="Geocoding language")] = "en",
) -> None:
    """Reverse geocode a coordinate."""
    from . import googleapi

    location = googleapi.get_location(coordinate, api_key, language=language)
    print(json.dumps(location.__dict__, ensure_ascii=False, indent=2))


# ── hash ────────────────────────────────────────────────────────────────────


@hash_app.command("dirs")
def hash_dirs(
    directories: Annotated[list[Path], typer.Argument(help="Directories to hash")],
    include: Annotated[str, typer.Option("--include", help="Include regex on full path")] = ".*",
    exclude: Annotated[str, typer.Option("--exclude", help="Exclude regex on full path")] = "^$",
    hash_log: Annotated[Path | None, typer.Option("--log", help="Hash log JSON path")] = None,
    clear_invalid: Annotated[bool, typer.Option("--clear-invalid", help="Drop entries for deleted files")] = False,
) -> None:
    """Compute/update MD5 hashes for directory contents."""
    directories = [_resolve_path(d) for d in directories]
    results = dedup.get_directories_hash(directories, include, exclude, hash_log, clear_invalid)
    for result in results:
        print(f"{result.directory} ({len(result.hashes)} files)")


@hash_app.command("compare")
def hash_compare(
    directories: Annotated[list[Path], typer.Argument(help="Directories to compare")],
    unique: Annotated[bool, typer.Option("--unique", help="Files not in ANY other directory")] = False,
    include: Annotated[str, typer.Option("--include", help="Include regex")] = ".*",
    exclude: Annotated[str, typer.Option("--exclude", help="Exclude regex")] = "^$",
    hash_log: Annotated[Path | None, typer.Option("--log", help="Hash log JSON path")] = None,
) -> None:
    """Compare directories by MD5 (default: missing from at least one other)."""
    directories = [_resolve_path(d) for d in directories]
    result = dedup.compare_directories(directories, include, exclude, unique, hash_log)
    for directory, files in result.items():
        print(f"{directory}: {len(files)} file(s)")
        for file in files:
            print(f"  {file}")


@hash_app.command("dupes")
def hash_dupes(
    directory: Annotated[Path, typer.Argument(help="Directory to scan")],
    hash_log: Annotated[Path | None, typer.Option("--log", help="Hash log JSON path")] = None,
) -> None:
    """Find duplicate files by MD5."""
    directory = _resolve_path(directory)
    groups = dedup.find_duplicate_files(directory, hash_log)
    if not groups:
        log.info("No duplicate files found")
        return
    for group in groups:
        print(f"{group.md5}:")
        for file in group.files:
            print(f"  {file}")


@hash_app.command("clear-log")
def hash_clear_log(
    hash_log: Annotated[Path, typer.Argument(help="Hash log JSON path")],
) -> None:
    """Remove entries for deleted files from the hash log."""
    hash_log = _resolve_path(hash_log)
    dedup.clear_hash_log(hash_log)


# ── config ──────────────────────────────────────────────────────────────────


@config_app.command("show")
def config_show() -> None:
    """Print the current configuration."""
    print(json.dumps({k: v for k, v in config._data.items()}, ensure_ascii=False, indent=2))


@config_app.command("set")
def config_set(
    key: Annotated[str, typer.Argument(help="Config key")],
    value: Annotated[str, typer.Argument(help="Config value")],
) -> None:
    """Set a configuration value (e.g. googleMapApiKey, kmlCompressedFilePath)."""
    if key not in config._data:
        log.warning(f"Unknown key '{key}' (adding anyway)")
    config[key] = value
    config.save()
    log.info(f"{key} = {value}")


@config_app.command("log-level")
def config_log_level(
    level: Annotated[str, typer.Argument(help=f"One of {LEVELS}")],
) -> None:
    """Set the persisted log level."""
    log.set_level(level)
    config["trackToolLogLevel"] = level.upper()
    config.save()
    log.info(f"Log level set to {level.upper()}")


@config_app.command("set-zip-path")
def config_set_zip_path(
    path: Annotated[Path, typer.Argument(help="KML ZIP archive path")],
) -> None:
    """Set the KML compressed file path."""
    absolute = str(path.expanduser().resolve())
    config["kmlCompressedFilePath"] = absolute
    config.save()
    log.info(f"KML compressed file path set to {absolute}")


@config_app.command("import")
def config_import(
    legacy_path: Annotated[Path, typer.Argument(help="Original PowerShell config.json path")],
) -> None:
    """Import the original PowerShell module's config.json."""
    legacy_path = _resolve_path(legacy_path)
    config.import_legacy(legacy_path)
    log.info(f"Imported configuration from {legacy_path}", target=str(config.path))


if __name__ == "__main__":
    app()
