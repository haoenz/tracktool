"""The KML archive's own storage: the ZIP, and what a restore checks first.

The ZIP is the archive's truth, and its entries are layered —
`<Kind>/<YYYY-MM>/<name>.kml`, with anything unrecognizable under
`_unclassified/` — so a reader can take one month or one kind without
touching the rest, and two kinds sharing a file name are two entries instead
of one hiding the other. It is rewritten wholesale on removal, since zipfile
has no entry-delete API. Restoring creates nothing and refuses to run on an
archive that disagrees with itself, so half a track cannot be restored;
`--force` turns those refusals into warnings and skips only the step they
belong to. A restore resolves an entry's kind with the entry itself, so a
restore that names no kind searches them all and still acts on the views that
kind owns rather than on a default. The desktop and mobile collections next to
the ZIP are views: derived from the truth, checked against it by hash,
regenerable with `archive rebuild`.

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
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from .. import log
from ..context import ctx
from ..errors import UserInputError
from ..paths import display_path
from ..workspace import DEFAULT_ZIP_NAME, manifest_path, resolve_archive
from . import collections, history, kmlfile, xmlutil
from .kmlfile import KmlContent, TrackKind

# Entries no view holds: their TrackTags say nothing, so there is no kind to file them under.
UNCLASSIFIED = "_unclassified"

# What archive_hash returns for a ZIP with no entries: the identity that
# makes a virgin archive (empty ZIP, no views yet) count as already in sync.
EMPTY_ZIP_HASH = hashlib.sha256().hexdigest()


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


def require_zip_file(zip_file: Path) -> None:
    """Refuse an archive whose ZIP is not there, or is not a ZIP, as user input.

    resolve_archive proves the directory is an archive — the manifest is its
    identity — and says nothing about the ZIP inside it, which every reader
    opens directly. Going through here is what turns a deleted or truncated
    archive into one log line instead of a bare FileNotFoundError or
    BadZipFile.
    """
    if not zip_file.is_file():
        raise UserInputError(f"KML compressed file does not exist: {display_path(zip_file)}")
    try:
        with zipfile.ZipFile(zip_file):
            pass
    except (zipfile.BadZipFile, OSError) as exc:
        raise UserInputError(f"Cannot read the archive {display_path(zip_file)}: {exc}") from exc


@dataclass(frozen=True)
class ZipEntry:
    """One resolved archive identity: the entry's path, and the kind it files under.

    kind is None when unclassified or unknown. A directory-only listing leaves
    legacy flat entries unknown; restore may resolve them from their TrackTags.
    """

    path: str
    kind: TrackKind | None

    @property
    def name(self) -> str:
        """Display filename; path remains the complete, exact selection key."""
        return self.path.rsplit("/", 1)[-1]


def entry_kind_from_path(entry_name: str) -> TrackKind | None:
    """Directory category only; flat/unknown/_unclassified paths return None."""
    if "/" not in entry_name:
        return None
    try:
        return TrackKind(entry_name.split("/", 1)[0])
    except ValueError:
        return None


def find_zip_entry(
    kml_name: str, zip_path: Path, type_: TrackKind | None = None, *, tag_map: Mapping[str, str] | None = None
) -> ZipEntry | None:
    """Resolve a full filename or stem to one archive entry, refusing ambiguous identities.

    The entry's kind is resolved with it, from the same place rebuild reads it:
    the folder for layered entries, TrackTags for flat ones. A caller that got
    an entry therefore also knows which views hold it. Naming a kind keeps the
    entries filed under it, so one name under two kinds is two answers and
    naming one picks it; omitting the kind looks through every entry —
    `_unclassified` ones included — and leaves the ambiguity to be refused.
    """
    if not kml_name or "/" in kml_name or "\\" in kml_name:
        raise UserInputError("Use a complete track filename or stem, without directories")
    matches: list[ZipEntry] = []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            path = Path(info.filename)
            if info.is_dir() or kml_name not in (path.name, path.stem):
                continue
            # 分层条目看目录段，不必解压；扁平条目的类别只在 TrackTags 里，才要读出来
            tree = None if "/" in info.filename else xmlutil.parse_string(zf.read(info).decode("utf-8"))
            kind = _entry_kind(info.filename, tree, tag_map=tag_map)
            if type_ is not None and kind != type_:
                continue
            matches.append(ZipEntry(info.filename, kind))
    if len(matches) > 1:
        names = ", ".join(sorted(match.path for match in matches))
        hint = " (use --type to choose one)" if type_ is None else ""
        raise UserInputError(f"Ambiguous track {kml_name!r}: {names}{hint}")
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


def push_compressed_kmls(
    entries: Sequence[tuple[Path, str]], zip_path: Path, *, on_entry: Callable[[], None] | None = None
) -> list[str]:
    """Stage a whole batch beside the ZIP, then atomically publish it.

    The caller recognizes the tracks and hands in each kind, so nothing is
    parsed twice. Dedup is per entry path, not per file name: the same name
    under two kinds are two tracks, and one of them filing over the other was
    exactly the silent skip this layering exists to prevent.

    Returns the entries that were added, in the order they landed — the
    entries, never the command line: a name already filed is skipped, and the
    change log has to record what happened rather than what was asked for.
    `on_entry` reports each staged or skipped input; publication and validation
    still follow, so only a successful return means the batch is committed.
    """
    exists = zip_path.is_file()
    names: set[str] = set()
    if exists:
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
    pending: list[tuple[Path, str]] = []
    for kml_path, kind in entries:
        entry = zip_entry_name(kml_path, kind)
        if entry in names:
            log.warning(f"Already exists in ZIP: {entry}", target=str(zip_path))
            if on_entry is not None:
                on_entry()
            continue
        pending.append((kml_path, entry))
        names.add(entry)
    if ctx.is_plan:
        # 提前返回还有一层理由：ZipFile 的 "a" 模式会把不存在的压缩包建出来
        for _, entry in pending:
            log.info(f"Would add to ZIP: {entry}", target=str(zip_path))
            if on_entry is not None:
                on_entry()
        return [entry for _, entry in pending]
    if pending:
        _publish_appended(pending, zip_path, on_entry=on_entry)
    return [entry for _, entry in pending]


def push_zip_entry(source: Path, entry: str, zip_path: Path) -> bool:
    """Add one file under an exact entry path; False when the entry is taken.

    An undo needs this rather than push_compressed_kmls: the entry has to go
    back exactly where it was, so the path is given instead of derived from
    the file's own name and kind.
    """
    with zipfile.ZipFile(zip_path) as zf:
        if entry in zf.namelist():
            log.warning(f"Already exists in ZIP: {entry}", target=str(zip_path))
            return False
    if ctx.is_plan:
        log.info(f"Would add to ZIP: {entry}", target=str(zip_path))
        return True
    _publish_appended([(source, entry)], zip_path)
    return True


def _publish_appended(
    pending: Sequence[tuple[Path, str]], zip_path: Path, *, on_entry: Callable[[], None] | None = None
) -> None:
    """Publish staged entries: copy the ZIP, append them, replace atomically.

    Copy compressed bytes, preserving entry metadata without recompression.
    An abrupt process exit can leave this scratch file, but never alters the
    old ZIP. Each retry uses a fresh file rather than trusting unfinished work.
    """
    exists = zip_path.is_file()
    with tempfile.NamedTemporaryFile(
        dir=zip_path.parent, prefix=f".{zip_path.name}.", suffix=".tmp", delete_on_close=False
    ) as temporary:
        if exists:
            with zip_path.open("rb") as source:
                shutil.copyfileobj(source, temporary)
        with zipfile.ZipFile(temporary, "a", zipfile.ZIP_DEFLATED) as replacement:
            for kml_path, entry in pending:
                replacement.write(kml_path, entry)
                if on_entry is not None:
                    on_entry()
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


def current_hash(zip_file: Path) -> str:
    """The ZIP's hash now; EMPTY_ZIP_HASH when there is no ZIP yet.

    A missing archive is the empty archive as far as "did the truth move" is
    concerned: ensure_zip_file creates exactly the empty ZIP this names, so a
    change that is about to bring one into being starts from here.
    """
    return archive_hash(zip_file) if zip_file.is_file() else EMPTY_ZIP_HASH


def archive_hash(zip_file: Path) -> str:
    """A digest of what the ZIP holds: every entry's path, size and CRC, sorted.

    Metadata only, no decompression. Equal hashes mean equal entries —
    the one fact "do the views match the truth" compares.
    """
    with zipfile.ZipFile(zip_file) as zf:
        digest = hashlib.sha256()
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            digest.update(f"{info.filename}|{info.file_size}|{info.CRC}\n".encode())
        return digest.hexdigest()


def read_views_hash(zip_file: Path) -> str | None:
    """The hash the views last matched, None when never recorded."""
    try:
        data = json.loads(manifest_path(zip_file.parent).read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    return data.get("views")


def record_views_hash(zip_file: Path, views_hash: str | None) -> None:
    """Write the views hash into the manifest, bumping it to version 2."""
    manifest = manifest_path(zip_file.parent)
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["version"] = 2
        data["views"] = views_hash
        manifest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError) as exc:
        raise UserInputError(f"Cannot write archive manifest {display_path(manifest)}: {exc}") from exc


def advance_views_hash(zip_file: Path, *, zip_hash_before: str, stored_views_hash: str | None) -> bool:
    """Mark the views as in sync, but only when they were in sync before the change.

    A push or a restore moves the truth and the views by the same track, so the
    two stay in step — unless the views were already behind, where recording the
    new hash would claim a sync that never happened. Only `archive rebuild` can
    make that claim true. A virgin archive (empty ZIP, no views yet) counts as in
    sync: the first filing creates the ZIP and the views together.

    Returns whether the manifest was advanced.
    """
    in_sync_before = stored_views_hash == zip_hash_before or (
        stored_views_hash is None and zip_hash_before == EMPTY_ZIP_HASH
    )
    if not in_sync_before:
        return False
    if ctx.is_plan:
        log.info("Would mark the views as in sync with the ZIP", target=str(zip_file))
        return True
    record_views_hash(zip_file, archive_hash(zip_file))
    return True


def pop_compressed_kml(kml_name: str, zip_path: Path, output_directory: Path = Path(".")) -> None:
    """Extract an entry matching kml_name from the ZIP, then delete the entry.

    Extraction and entry removal go together: an entry that was not written
    out stays in the archive, since deleting it would take the track's only
    copy with it.
    """
    entry = find_zip_entry(kml_name, zip_path)
    if entry is None:
        log.warning(f"Entry not found in ZIP: {kml_name}", target=str(zip_path))
        return
    log.debug(f"Found entry in ZIP: {entry.path}", target=str(zip_path))
    pop_zip_entry(entry.path, zip_path, output_directory)


def pop_zip_entry(entry_name: str, zip_path: Path, output_directory: Path = Path(".")) -> Path | None:
    """Extract one exact entry and remove it — what a restore's found entry feeds.

    Matching and removal stay two functions on purpose: a restore looks the
    track up once (by file name, in _inspect_archive) and acts on that exact
    entry, so search and delete can never disagree about what was found.
    If rebuilding fails, the extracted file and original ZIP both remain.

    Returns where the entry was written, or None in PLAN mode. The absolute
    path matters to the caller that records the restore: undoing it runs in
    another process, whose working directory is not this one.
    """
    target_path = output_directory / Path(entry_name).name
    if target_path.exists():
        raise UserInputError(f"File already exists at destination: {display_path(target_path)}")

    if ctx.is_plan:
        log.info(f"Would extract {entry_name} and remove it from the ZIP", target=str(zip_path))
        return None

    extract_entry(entry_name, zip_path, target_path)
    log.info(f"Extracted from ZIP: {entry_name}", target=str(zip_path))
    remove_zip_entries([entry_name], zip_path)
    return target_path.resolve()


def entry_metadata(entry_name: str, zip_path: Path) -> tuple[int, int]:
    """One entry's own size and CRC-32, straight from the ZIP's directory.

    No decompression. A recorded restore holds these against the file it wrote
    out, to tell "still that track" from "changed since the entry it came from".
    """
    with zipfile.ZipFile(zip_path) as zf:
        info = zf.getinfo(entry_name)
        return info.file_size, info.CRC


def extract_entry(entry_name: str, zip_path: Path, target_path: Path) -> None:
    """Write one entry out durably, before anything removes it from the ZIP.

    Two readers hand it the entry and then go on to consume it: a restore
    extracts and removes, and an undo whose backup copy has been cleared
    extracts the entry to where the file was carried away from — it holds the
    very bytes that push filed.
    """
    with zipfile.ZipFile(zip_path) as zf, zf.open(entry_name) as src, open(target_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())


def remove_zip_entries(entries: Sequence[str], zip_path: Path) -> None:
    """Delete entries from the ZIP in one atomic rewrite; a name not held is skipped.

    zipfile has no entry-delete API, so the archive is rewritten wholesale —
    once per batch rather than once per entry: an undo that drops the five
    entries a push added pays for one rewrite. The original ZIP stays intact
    until the replacement is complete and durable.
    """
    wanted = set(entries)
    if not wanted:
        return
    if ctx.is_plan:
        for entry in sorted(wanted):
            log.info(f"Would remove from ZIP: {entry}", target=str(zip_path))
        return

    removed: list[str] = []
    with tempfile.NamedTemporaryFile(
        dir=zip_path.parent, prefix=f".{zip_path.name}.", suffix=".tmp", delete_on_close=False
    ) as temporary:
        with zipfile.ZipFile(zip_path) as source, zipfile.ZipFile(temporary, "w") as replacement:
            replacement.comment = source.comment
            for info in source.infolist():
                if info.filename in wanted:
                    removed.append(info.filename)
                else:
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
    for entry in sorted(wanted - set(removed)):
        log.warning(f"Not in ZIP: {entry}", target=str(zip_path))
    for entry in removed:
        log.verbose(f"Removed from ZIP: {entry}", target=str(zip_path))


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

    One comparison answers it: the manifest records the ZIP's hash as of
    the last time the views were regenerated, and status holds it against the
    ZIP's hash now. Missing view files are reported per kind, and
    _unclassified entries are counted because no view will ever hold them.

    Nothing is decompressed unless the ZIP still holds flat entries: their kind
    lives in their TrackTags, and the ones no table can classify are reported by
    value, so the fix — one `config set` — is named in the report itself.
    """
    archive_dir, zip_file = resolve_archive(zip_path)
    require_zip_file(zip_file)

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

    current, stored = archive_hash(zip_file), read_views_hash(zip_file)
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
    old views hash said is irrelevant: the ZIP wins, and the hash
    is refreshed to the ZIP as rebuilt.

    A kind the ZIP holds no entry of is emptied, not skipped: a view that outlives
    its last entry still lists a track the truth does not have, and skipping the
    kind was how undoing a push left one behind while the hash said in sync. A
    kind with neither entries nor view files stays without them — rebuild never
    brings a view into being that never existed.
    """
    archive_dir, zip_file = resolve_archive(zip_path)
    require_zip_file(zip_file)
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

    for kind in TrackKind:
        tracks = filed.get(kind, [])
        desktop_path, mobile_path = collections.collection_paths(kind, archive_dir)
        if not tracks and not (desktop_path.is_file() or mobile_path.is_file()):
            continue
        desktop = collections.DesktopCollection(desktop_path, collections.new_empty_kml(kind))
        mobile = collections.MobileCollection(mobile_path, collections.new_empty_mobile_kml())
        for entry, content in tracks:
            desktop.add(entry, content)
            mobile.add(entry, content)
        desktop.save()
        mobile.save()
        if tracks:
            log.info(f"Rebuilt collections with {len(tracks)} tracks", target=str(desktop_path))
        else:
            log.info("Emptied collections: no tracks of this type left in the ZIP", target=str(desktop_path))
    if skipped:
        log.info(f"Left out of the views: {skipped} {UNCLASSIFIED} entries", target=str(archive_dir))
    if unknown:
        # 逐条刷一行会把一条发现变成一堵墙，按值汇总一次说清
        log.warning(kmlfile.summarize_unknown_tags(unknown), target=str(archive_dir))

    record_views_hash(zip_file, archive_hash(zip_file))
    log.info("Views are in sync with the ZIP", target=str(archive_dir))


def _entry_kind(
    entry_name: str, tree: xmlutil.etree._ElementTree | None, *, tag_map: Mapping[str, str] | None = None
) -> TrackKind | None:
    """The kind an entry belongs to: its folder when layered, its TrackTags when flat.

    None — never guessed — for _unclassified entries and for anything a legacy
    flat name carries no recognizable tags for; they stay out of every view.
    tree is what a flat entry's tags are read from, and is None for a layered
    one, whose folder settles the kind before anything is decompressed.
    """
    if "/" in entry_name:
        return entry_kind_from_path(entry_name)
    assert tree is not None  # 扁平条目的类别只在 TrackTags 里，调用方必须先解压解析
    return kmlfile.kind_from_tree(tree, tag_map=tag_map)


@dataclass(frozen=True)
class _ArchiveState:
    """What the archive holds for one track, plus every disagreement found."""

    zip_entry: str | None
    track_name: str
    kind: TrackKind | None
    in_desktop: bool
    in_mobile: bool
    problems: list[str]


def _kind_holding_track(track_name: str, archive_dir: Path) -> TrackKind | None:
    """Which kind's views still list a track the ZIP no longer holds.

    A restore with no kind named finds the views itself, and a name two kinds
    hold is exactly as ambiguous as two ZIP entries: it raises before anything
    is touched, the same as a doubled record inside one view.
    """
    holders: list[TrackKind] = []
    for kind in TrackKind:
        desktop, mobile = collections.collection_paths(kind, archive_dir)
        if desktop.is_file() and collections.has_desktop_track(track_name, desktop):
            holders.append(kind)
        elif mobile.is_file() and collections.has_mobile_track(track_name, mobile):
            holders.append(kind)
    if len(holders) > 1:
        names = ", ".join(kind.value for kind in holders)
        raise UserInputError(f"Ambiguous track {track_name!r}: held by the {names} collections")
    return holders[0] if holders else None


def _inspect_archive(
    kml_name: str,
    zip_file: Path,
    archive_dir: Path,
    type_: TrackKind | None,
    tag_map: Mapping[str, str] | None = None,
) -> _ArchiveState:
    """Look the track up in the archive's three records, collecting disagreements.

    Listed as a restore consumes them: the ZIP, then the desktop collection
    (the primary record, always expected), then the mobile one, which is
    optional as a file but must hold the track once it exists. All three are
    scoped to one kind — the found entry's own, or the named one — because the
    same name under two kinds is two tracks, each living in its own views.
    Only a restore that found no entry in the ZIP at all falls back to looking
    for the name in every kind's views, which is what a --force cleanup needs.
    """
    zip_exists = zip_file.is_file()
    entry = find_zip_entry(kml_name, zip_file, type_, tag_map=tag_map) if zip_exists else None
    track_name = Path(entry.path).stem if entry else kml_name
    if entry is None and track_name.lower().endswith(".kml"):
        track_name = track_name[:-4]

    kind = entry.kind if entry else type_
    if entry is None and kind is None and zip_exists:
        kind = _kind_holding_track(track_name, archive_dir)

    problems: list[str] = []
    if not zip_exists:
        problems.append(f"KML compressed file does not exist: {display_path(zip_file)}")
    elif entry is None:
        problems.append(f"Track not found in ZIP: {kml_name}")

    in_desktop = in_mobile = False
    if kind is not None:
        desktop_collection, mobile_collection = collections.collection_paths(kind, archive_dir)
        in_desktop = desktop_collection.is_file() and collections.has_desktop_track(track_name, desktop_collection)
        in_mobile = mobile_collection.is_file() and collections.has_mobile_track(track_name, mobile_collection)
        if not desktop_collection.is_file():
            problems.append(f"Collection KML file does not exist: {display_path(desktop_collection)}")
        elif not in_desktop:
            problems.append(f"Track not found in collection: {kml_name}")
        if mobile_collection.is_file() and not in_mobile:
            problems.append(f"Track not found in mobile collection: {kml_name}")

    return _ArchiveState(entry.path if entry else None, track_name, kind, in_desktop, in_mobile, problems)


def pop_kml_archive(
    kml_name: str,
    type_: TrackKind | None = None,
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

    Naming a kind keeps the restore inside it. Omitting one searches every
    entry in the ZIP and lets the entry that was found name its own kind, so
    the views acted on are that kind's rather than a guess — one name under two
    kinds is two tracks, and only the kind picks one. An entry no view holds
    (under `_unclassified`, or a flat name no table classifies) is extracted on
    its own.

    Removing the track moves the truth and the views by the same track, so a
    restore that finds them in sync leaves them in sync — advance_views_hash
    says so, on the same judgement a push uses. Skipping that left every
    restore reported as out of date until the next rebuild.

    The restore is recorded as it happens: an extracted entry is the track's
    only copy until it is filed again, so the log is where that file is named
    and how a later `archive undo` finds its way back.
    """
    zip_file = resolve_archive(zip_path)[1]
    archive_dir = zip_file.parent

    state = _inspect_archive(kml_name, zip_file, archive_dir, type_, tag_map)
    if state.problems:
        if not force:
            raise UserInputError(f"Cannot restore {kml_name}: " + "; ".join(state.problems))
        for problem in state.problems:
            log.warning(f"{problem} (forced)", target=str(archive_dir))
    if state.zip_entry is not None and state.kind is None:
        # 认不出类型就是没有任何视图持有它：解压是唯一动作，不去猜一个类型
        log.info(f"No collection holds this entry: {state.zip_entry}", target=str(archive_dir))

    # 只在真的删得掉条目时才取哈希：没有条目可删，真值就没动过，也没什么可前移的
    change: history.Change | None = None
    zip_hash_before: str | None = None
    if state.zip_entry is not None:
        zip_hash_before = archive_hash(zip_file)
        stored_views_hash = read_views_hash(zip_file)
        size_bytes, crc32 = entry_metadata(state.zip_entry, zip_file)
        change = history.start(history.POP, zip_hash_before=zip_hash_before)
        change.removed_entries = [state.zip_entry]
        extracted = pop_zip_entry(state.zip_entry, zip_file)
        if extracted is not None:
            change.extracted_file = history.ExtractedFile(
                entry_path=state.zip_entry, file_path=str(extracted), size_bytes=size_bytes, crc32=crc32
            )
    if state.kind is not None:
        # 视图按类型分家：同名轨迹在别的类型下是另一条，不该在这里被动到
        desktop_collection, mobile_collection = collections.collection_paths(state.kind, archive_dir)
        if state.in_desktop:
            collections.remove_track_from_desktop_collection(state.track_name, desktop_collection)
        if state.in_mobile:
            collections.remove_track_from_mobile_collection(state.track_name, mobile_collection)
    if zip_hash_before is not None:
        advance_views_hash(zip_file, zip_hash_before=zip_hash_before, stored_views_hash=stored_views_hash)
        assert change is not None  # 有条目可删时上面才建得出这笔账，两者同生同灭
        history.commit(archive_dir, change, zip_hash_after=current_hash(zip_file))
