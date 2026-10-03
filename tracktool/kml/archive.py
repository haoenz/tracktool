"""The KML archive's own storage: the ZIP, and what a restore checks first.

The ZIP is the archive's truth, and its entries are layered —
`<Kind>/<YYYY-MM>/<name>.kml`, with anything unrecognizable under
`_unclassified/` — so a reader can take one month or one kind without
touching the rest, and two kinds sharing a file name are two entries instead
of one hiding the other. It is rewritten wholesale on removal, since zipfile
has no entry-delete API. Restoring creates nothing and refuses to run on an
archive that disagrees with itself, so half a track cannot be restored;
`--force` turns those refusals into warnings and skips only the step they
belong to. The desktop and mobile collections next to the ZIP are views:
derived from the truth, checked against it by fingerprint, regenerable with
`archive rebuild`.

Filing a track in — which collections, the ZIP, the backup folder, in what
order — is a sequence of domain steps rather than a property of any one of
them, and lives in workflows.push_tracks. What stays here are the pieces that
sequence is built from: making the archive exist, appending to it, and reading
it back.
"""

import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from .. import log
from ..context import ctx
from ..errors import UserInputError
from ..paths import display_path
from ..workspace import DEFAULT_ZIP_NAME, manifest_path, resolve_archive
from . import collections, kmlfile, xmlutil
from .kmlfile import KmlContent, TrackKind

# Entries no view holds: their TrackTags say nothing, so there is no kind to file them under.
UNCLASSIFIED = "_unclassified"

# What archive_fingerprint returns for a ZIP with no entries: the identity that
# makes a virgin archive (empty ZIP, no views yet) count as already in sync.
EMPTY_ZIP_FINGERPRINT = hashlib.sha256().hexdigest()


def init_archive(directory: Path, zip_name: str = DEFAULT_ZIP_NAME) -> None:
    """Declare a directory as the track archive; the only thing that creates one.

    The manifest is the archive's identity — a directory without one is not an
    archive, and every other command refuses it. The ZIP is created only when
    missing, so running init on a directory that already holds an archive's
    files adopts them instead of starting a second archive beside them.
    """
    directory = directory.expanduser().resolve()
    if manifest_path(directory).is_file():
        raise UserInputError(f"Already a tracktool archive: {display_path(directory)}")
    ensure_archive_directory(directory)
    if ctx.is_plan:
        log.info("Would write archive manifest", target=str(manifest_path(directory)))
        return
    manifest = {"version": 2, "zip": zip_name, "views": None}
    try:
        manifest_path(directory).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        raise UserInputError(f"Cannot write archive manifest {display_path(manifest_path(directory))}: {exc}") from exc
    log.info("Created archive manifest", target=str(manifest_path(directory)))
    zip_file = directory / zip_name
    if not zip_file.is_file():
        ensure_zip_file(zip_file)


def ensure_archive_directory(archive_dir: Path) -> None:
    """Create the archive directory; a location that cannot be made is user input."""
    if ctx.is_plan:
        log.info("Would create archive directory", target=str(archive_dir))
        return
    try:
        archive_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise UserInputError(f"Cannot create archive directory {display_path(archive_dir)}: {exc}") from exc


def ensure_zip_file(zip_file: Path) -> None:
    """Create the archive (and its directory) when they are not there yet.

    An empty archive is written rather than a zero-byte placeholder: the
    latter is not a ZIP at all (zipfile rejects it), so readers would trip
    over an archive that only looks like one.
    """
    if zip_file.is_file():
        return
    if ctx.is_plan:
        log.info("Would create a new ZIP archive", target=str(zip_file))
        return
    ensure_archive_directory(zip_file.parent)
    try:
        with zipfile.ZipFile(zip_file, "w", zipfile.ZIP_DEFLATED):
            pass
    except OSError as exc:
        raise UserInputError(f"Cannot create KML compressed file {display_path(zip_file)}: {exc}") from exc
    log.info("Created new ZIP archive", target=str(zip_file))


def find_zip_entry(
    kml_name: str, zip_path: Path, type_: TrackKind | None = None, *, tag_map: Mapping[str, str] | None = None
) -> str | None:
    """Resolve a full filename or stem, refusing ambiguous archive identities.

    Layered entries take their type from the folder, just as rebuild does.
    Legacy flat entries must carry recognizable TrackTags for a typed lookup.
    """
    if not kml_name or "/" in kml_name or "\\" in kml_name:
        raise UserInputError("Use a complete track filename or stem, without directories")
    matches = []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            path = Path(info.filename)
            if info.is_dir() or kml_name not in (path.name, path.stem):
                continue
            if type_ is not None:
                if "/" in info.filename:
                    if info.filename.split("/", 1)[0] != type_.value:
                        continue
                else:
                    tree = xmlutil.parse_string(zf.read(info).decode("utf-8"))
                    if kmlfile.kind_from_tree(tree, tag_map=tag_map) != type_:
                        continue
            matches.append(info.filename)
    if len(matches) > 1:
        raise UserInputError(f"Ambiguous track {kml_name!r}: {', '.join(sorted(matches))}")
    return matches[0] if matches else None


def zip_entry_name(kml_path: Path, kind: str) -> str:
    """The layered entry path a KML files under: `<Kind>/<YYYY-MM>/<name>`.

    The month comes from the file name — the same date the desktop collection
    files the track under. A name without a date falls back to the kind root,
    which is where merge outputs with odd names land.
    """
    try:
        _, yyyymm = collections.desktop_date(kml_path)
    except UserInputError:
        return f"{kind}/{kml_path.name}"
    return f"{kind}/{yyyymm[:4]}-{yyyymm[4:]}/{kml_path.name}"


def push_compressed_kml(kml_path: Path, zip_path: Path, *, tag_map: Mapping[str, str] | None = None) -> None:
    """Add a KML to the ZIP archive if not already present.

    Single-file callers have not recognized the track; its kind comes from the
    file's own TrackTags, defaulting to _unclassified rather than guessed.
    """
    kind = kmlfile.get_kml_type(kml_path, tag_map=tag_map)
    push_compressed_kmls([(kml_path, kind.value if kind else UNCLASSIFIED)], zip_path)


def push_compressed_kmls(entries: Sequence[tuple[Path, str]], zip_path: Path) -> None:
    """Stage a whole batch beside the ZIP, then atomically publish it.

    The caller recognizes the tracks and hands in each kind, so nothing is
    parsed twice. Dedup is per entry path, not per file name: the same name
    under two kinds are two tracks, and one of them filing over the other was
    exactly the silent skip this layering exists to prevent.
    """
    if ctx.is_plan:
        # 提前返回还有一层理由：ZipFile 的 "a" 模式会把不存在的压缩包建出来
        for kml_path, _ in entries:
            log.info(f"Would add to ZIP: {kml_path.name}", target=str(zip_path))
        return
    exists = zip_path.is_file()
    names: set[str] = set()
    if exists:
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
    pending = []
    for kml_path, kind in entries:
        entry = zip_entry_name(kml_path, kind)
        if entry in names:
            log.warning(f"Already exists in ZIP: {entry}", target=str(zip_path))
            continue
        pending.append((kml_path, entry))
        names.add(entry)
    if not pending:
        return

    # Copy compressed bytes, preserving entry metadata without recompression.
    # An abrupt process exit can leave this scratch file, but never alters the
    # old ZIP. Each retry uses a fresh file rather than trusting unfinished work.
    with tempfile.NamedTemporaryFile(
        dir=zip_path.parent, prefix=f".{zip_path.name}.", suffix=".tmp", delete_on_close=False
    ) as temporary:
        if exists:
            with zip_path.open("rb") as source:
                shutil.copyfileobj(source, temporary)
        with zipfile.ZipFile(temporary, "a", zipfile.ZIP_DEFLATED) as replacement:
            for kml_path, entry in pending:
                replacement.write(kml_path, entry)
        temporary.flush()
        with zipfile.ZipFile(temporary) as replacement:
            bad_entry = replacement.testzip()
            if bad_entry is not None:
                raise zipfile.BadZipFile(f"Corrupt entry in replacement archive: {bad_entry}")
        if exists:
            shutil.copymode(zip_path, temporary.name)
        os.fsync(temporary.fileno())
        temporary.close()
        os.replace(temporary.name, zip_path)
    for _, entry in pending:
        log.info(f"Added to ZIP: {entry}", target=str(zip_path))


def archive_fingerprint(zip_file: Path) -> str:
    """A digest of what the ZIP holds: every entry's path, size and CRC, sorted.

    Metadata only, no decompression. Equal fingerprints mean equal entries —
    the one fact "do the views match the truth" compares.
    """
    with zipfile.ZipFile(zip_file) as zf:
        digest = hashlib.sha256()
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            digest.update(f"{info.filename}|{info.file_size}|{info.CRC}\n".encode())
        return digest.hexdigest()


def read_views_fingerprint(zip_file: Path) -> str | None:
    """The fingerprint the views last matched, None when never recorded."""
    try:
        data = json.loads(manifest_path(zip_file.parent).read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    return data.get("views")


def record_views_fingerprint(zip_file: Path, fingerprint: str | None) -> None:
    """Write the views fingerprint into the manifest, bumping it to version 2."""
    manifest = manifest_path(zip_file.parent)
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["version"] = 2
        data["views"] = fingerprint
        manifest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError) as exc:
        raise UserInputError(f"Cannot write archive manifest {display_path(manifest)}: {exc}") from exc


def pop_compressed_kml(kml_name: str, zip_path: Path, output_directory: Path = Path(".")) -> None:
    """Extract an entry matching kml_name from the ZIP, then delete the entry.

    Extraction and entry removal go together: an entry that was not written
    out stays in the archive, since deleting it would take the track's only
    copy with it.
    """
    entry_name = find_zip_entry(kml_name, zip_path)
    if entry_name is None:
        log.warning(f"Entry not found in ZIP: {kml_name}", target=str(zip_path))
        return
    log.debug(f"Found entry in ZIP: {entry_name}", target=str(zip_path))
    pop_zip_entry(entry_name, zip_path, output_directory)


def pop_zip_entry(entry_name: str, zip_path: Path, output_directory: Path = Path(".")) -> None:
    """Extract one exact entry and remove it — what a restore's found entry feeds.

    Matching and removal stay two functions on purpose: a restore looks the
    track up once (by file name, in _inspect_archive) and acts on that exact
    entry, so search and delete can never disagree about what was found.
    If rebuilding fails, the extracted file and original ZIP both remain.
    """
    target_path = output_directory / Path(entry_name).name
    if target_path.exists():
        raise UserInputError(f"File already exists at destination: {display_path(target_path)}")

    if ctx.is_plan:
        log.info(f"Would extract {entry_name} and remove it from the ZIP", target=str(zip_path))
        return

    with zipfile.ZipFile(zip_path) as zf, zf.open(entry_name) as src, open(target_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())
    log.info(f"Extracted from ZIP: {entry_name}", target=str(zip_path))

    # Keep the original intact until the replacement is complete and durable.
    # A sibling temporary file permits an atomic replacement on the same filesystem.
    with tempfile.NamedTemporaryFile(
        dir=zip_path.parent, prefix=f".{zip_path.name}.", suffix=".tmp", delete_on_close=False
    ) as temporary:
        with zipfile.ZipFile(zip_path) as source, zipfile.ZipFile(temporary, "w") as replacement:
            replacement.comment = source.comment
            for info in source.infolist():
                if info.filename != entry_name:
                    replacement.writestr(info, source.read(info))
        temporary.flush()
        with zipfile.ZipFile(temporary) as replacement:
            bad_entry = replacement.testzip()
            if bad_entry is not None:
                raise zipfile.BadZipFile(f"Corrupt entry in replacement archive: {bad_entry}")
        shutil.copymode(zip_path, temporary.name)
        os.fsync(temporary.fileno())
        temporary.close()
        os.replace(temporary.name, zip_path)
    log.debug(f"Removed from ZIP: {entry_name}", target=str(zip_path))


def _unrecognized_tags(entries: Sequence[str], zip_file: Path, tag_map: Mapping[str, str] | None) -> Counter[str]:
    """Count, by TrackTags value, the entries whose kind cannot be read off the path.

    Only flat (pre-layering) entries need this. The values come back unmapped so
    the caller can report them as they stand: a track no table can classify has
    no kind to fall back on, and naming the value is what tells the user which
    word to add.
    """
    counts: Counter[str] = Counter()
    with zipfile.ZipFile(zip_file) as zf:
        for name in entries:
            tree = xmlutil.parse_string(zf.read(name).decode("utf-8"))
            if kmlfile.kind_from_tree(tree, tag_map=tag_map) is None:
                counts[kmlfile.track_tags_from_tree(tree)] += 1
    return counts


def status(zip_path: str | None, *, tag_map: Mapping[str, str] | None = None) -> None:
    """Report whether the desktop and mobile views match the ZIP, the truth.

    One comparison answers it: the manifest records the ZIP's fingerprint as of
    the last time the views were regenerated, and status holds it against the
    ZIP's fingerprint now. Missing view files are reported per kind, and
    _unclassified entries are counted because no view will ever hold them.

    Nothing is decompressed unless the ZIP still holds flat entries: their kind
    lives in their TrackTags, and the ones no table can classify are reported by
    value, so the fix — one `config set` — is named in the report itself.
    """
    archive_dir, zip_file = resolve_archive(zip_path)

    counts: dict[str, int] = {}
    unlayered: list[str] = []
    with zipfile.ZipFile(zip_file) as zf:
        for info in zf.infolist():
            if "/" in info.filename:
                kind = info.filename.split("/", 1)[0]
            else:
                kind = "(unlayered)"
                unlayered.append(info.filename)
            counts[kind] = counts.get(kind, 0) + 1
    summary = ", ".join(f"{kind} {count}" for kind, count in sorted(counts.items()))
    log.info(f"ZIP holds {sum(counts.values())} entries ({summary})", target=str(archive_dir))
    if unlayered:
        unknown = _unrecognized_tags(unlayered, zip_file, tag_map)
        if unknown:
            log.warning(kmlfile.summarize_unknown_tags(unknown), target=str(archive_dir))

    # 只对真值里有条目的类型要求视图文件：没有条目的类型从来没有过视图
    missing = [
        path.name
        for kind in TrackKind
        if counts.get(kind.value, 0)
        for path in collections.collection_paths(kind, archive_dir)
        if not path.is_file()
    ]
    if missing:
        log.warning(f"Missing view files: {', '.join(missing)}", target=str(archive_dir))

    current, stored = archive_fingerprint(zip_file), read_views_fingerprint(zip_file)
    if stored == current:
        log.info("Views are in sync with the ZIP", target=str(archive_dir))
    elif stored is None:
        log.warning(
            "Views have never been synced with this ZIP (run `tracktool archive rebuild`)", target=str(archive_dir)
        )
    else:
        log.warning("Views are out of date with the ZIP (run `tracktool archive rebuild`)", target=str(archive_dir))


def rebuild(zip_path: str | None, *, tag_map: Mapping[str, str] | None = None) -> None:
    """Regenerate the desktop and mobile collections from the ZIP, the truth.

    Every view is built the way a push builds it — an empty collection plus the
    same add() per track — replayed over the ZIP's entries in name order, so a
    rebuild and incremental pushes land in the same shape. What the manifest's
    old views fingerprint said is irrelevant: the ZIP wins, and the fingerprint
    is refreshed to the ZIP as rebuilt.
    """
    archive_dir, zip_file = resolve_archive(zip_path)
    if ctx.is_plan:
        log.info("Would rebuild both collections from the ZIP", target=str(zip_file))
        return

    filed: dict[TrackKind, list[tuple[Path, KmlContent]]] = {}
    skipped = 0
    unknown: Counter[str] = Counter()
    with zipfile.ZipFile(zip_file) as zf:
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            tree = xmlutil.parse_string(zf.read(info.filename).decode("utf-8"))
            kind = _entry_kind(info.filename, tree, tag_map=tag_map)
            if kind is None:
                skipped += 1
                if "/" not in info.filename:
                    unknown[kmlfile.track_tags_from_tree(tree)] += 1
                continue
            content = kmlfile.content_from_tree(tree, info.filename)
            filed.setdefault(kind, []).append((Path(info.filename), content))

    for kind, tracks in filed.items():
        desktop_path, mobile_path = collections.collection_paths(kind, archive_dir)
        desktop = collections.DesktopCollection(desktop_path, collections.new_empty_kml(kind))
        mobile = collections.MobileCollection(mobile_path, collections.new_empty_mobile_kml())
        for entry, content in tracks:
            desktop.add(entry, content)
            mobile.add(entry, content)
        desktop.save()
        mobile.save()
        log.info(f"Rebuilt collections with {len(tracks)} tracks", target=str(desktop_path))
    if skipped:
        log.info(f"Left out of the views: {skipped} {UNCLASSIFIED} entries", target=str(archive_dir))
    if unknown:
        # 逐条刷一行会把一条发现变成一堵墙，按值汇总一次说清
        log.warning(kmlfile.summarize_unknown_tags(unknown), target=str(archive_dir))

    record_views_fingerprint(zip_file, archive_fingerprint(zip_file))
    log.info("Views are in sync with the ZIP", target=str(archive_dir))


def _entry_kind(
    entry_name: str, tree: xmlutil.etree._ElementTree, *, tag_map: Mapping[str, str] | None = None
) -> TrackKind | None:
    """The kind an entry belongs to: its folder when layered, its TrackTags when flat.

    None — never guessed — for _unclassified entries and for anything a legacy
    flat name carries no recognizable tags for; they stay out of every view.
    """
    if "/" in entry_name:
        try:
            return TrackKind(entry_name.split("/", 1)[0])
        except ValueError:
            return None
    return kmlfile.kind_from_tree(tree, tag_map=tag_map)


@dataclass(frozen=True)
class _ArchiveState:
    """What the archive holds for one track, plus every disagreement found."""

    zip_entry: str | None
    track_name: str
    in_desktop: bool
    in_mobile: bool
    problems: list[str]


def _inspect_archive(
    kml_name: str,
    zip_file: Path,
    desktop_collection: Path,
    mobile_collection: Path,
    type_: TrackKind,
    tag_map: Mapping[str, str] | None = None,
) -> _ArchiveState:
    """Look the track up in the archive's three records, collecting disagreements.

    Listed as a restore consumes them: the ZIP, then the desktop collection
    (the primary record, always expected), then the mobile one, which is
    optional as a file but must hold the track once it exists.
    """
    zip_exists = zip_file.is_file()
    zip_entry = find_zip_entry(kml_name, zip_file, type_, tag_map=tag_map) if zip_exists else None
    track_name = Path(zip_entry).stem if zip_entry else kml_name
    if zip_entry is None and track_name.lower().endswith(".kml"):
        track_name = track_name[:-4]
    desktop_exists = desktop_collection.is_file()
    in_desktop = desktop_exists and collections.has_desktop_track(track_name, desktop_collection)
    mobile_exists = mobile_collection.is_file()
    in_mobile = mobile_exists and collections.has_mobile_track(track_name, mobile_collection)

    problems: list[str] = []
    if not zip_exists:
        problems.append(f"KML compressed file does not exist: {display_path(zip_file)}")
    elif zip_entry is None:
        problems.append(f"Track not found in ZIP: {kml_name}")
    if not desktop_exists:
        problems.append(f"Collection KML file does not exist: {display_path(desktop_collection)}")
    elif not in_desktop:
        problems.append(f"Track not found in collection: {kml_name}")
    if mobile_exists and not in_mobile:
        problems.append(f"Track not found in mobile collection: {kml_name}")
    return _ArchiveState(zip_entry, track_name, in_desktop, in_mobile, problems)


def pop_kml_archive(
    kml_name: str,
    type_: TrackKind = TrackKind.DEFAULT,
    zip_path: str | None = None,
    force: bool = False,
    *,
    tag_map: Mapping[str, str] | None = None,
) -> None:
    """Restore a KML track: extract from ZIP and remove from both collections.

    Nothing is touched before the archive agrees with itself on this track, so
    a track cannot be restored out of one record while another keeps it.
    --force warns about each disagreement instead of stopping, and skips only
    the step whose record is missing.
    """
    zip_file = resolve_archive(zip_path)[1]
    archive_dir = zip_file.parent
    desktop_collection, mobile_collection = collections.collection_paths(type_, archive_dir)

    state = _inspect_archive(kml_name, zip_file, desktop_collection, mobile_collection, type_, tag_map)
    if state.problems:
        if not force:
            raise UserInputError(f"Cannot restore {kml_name}: " + "; ".join(state.problems))
        for problem in state.problems:
            log.warning(f"{problem} (forced)", target=str(archive_dir))

    if state.zip_entry is not None:
        pop_zip_entry(state.zip_entry, zip_file)
    if state.in_desktop:
        collections.remove_track_from_desktop_collection(state.track_name, desktop_collection)
    if state.in_mobile:
        collections.remove_track_from_mobile_collection(state.track_name, mobile_collection)
