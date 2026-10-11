"""Public archive reads: exact selection, lazy parsing, ownership, and no writes."""

import struct
import zipfile
from array import array
from dataclasses import fields
from math import isnan

import pytest
from conftest import TRACK_KML, make_archive

from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml import archive as archive_ops
from tracktool.kml import trackdata, xmlutil
from tracktool.kml.archive import ZipEntry
from tracktool.kml.archive_reader import open_archive
from tracktool.kml.kmlfile import TrackKind


def make_zip(tmp_path, entries):
    path = make_archive(tmp_path / "archive")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return path


def assert_data_equal(left, right):
    """Compare independent array-backed results, treating missing altitudes as NaN."""
    for field in fields(left):
        if field.name not in ("source", "tracks"):
            assert getattr(left, field.name) == getattr(right, field.name)
    assert len(left.tracks) == len(right.tracks)
    for a, b in zip(left.tracks, right.tracks, strict=True):
        assert (a.index, a.name, a.placemark_id) == (b.index, b.name, b.placemark_id)
        assert len(a.segments) == len(b.segments)
        for x, y in zip(a.segments, b.segments, strict=True):
            assert (x.kind, x.geometry_id) == (y.kind, y.geometry_id)
            for field in ("longitude", "latitude", "altitude", "time_us"):
                values, expected = getattr(x, field), getattr(y, field)
                if expected is None:
                    assert values is None
                else:
                    assert isinstance(values, array) and values.typecode == expected.typecode
                    assert len(values) == len(expected)
                    assert all(v == e or (isnan(v) and isnan(e)) for v, e in zip(values, expected, strict=True))


def test_list_uses_only_directory_and_sorts_exact_paths(tmp_path, monkeypatch):
    names = [
        "Train/2026-05/shared.KML",
        "legacy.kml",
        "Default/2026-05/shared.kml",
        "Mystery/2026-05/unknown.kMl",
        "_unclassified/no-tag.kml",
        "Flight/custom.kml",
        "Default/",
        "directory.kml/",
        "note.txt",
        "picture.jpg",
    ]
    path = make_zip(tmp_path, [(name, b"broken XML") for name in names])

    def no_content(*args, **kwargs):
        pytest.fail("listing must not read ZIP members or parse KML")

    monkeypatch.setattr(zipfile.ZipFile, "read", no_content)
    monkeypatch.setattr(zipfile.ZipFile, "open", no_content)
    monkeypatch.setattr(xmlutil, "parse_string", no_content)
    monkeypatch.setattr(trackdata, "track_data_from_tree", no_content)
    with open_archive(path) as archive:
        entries = archive.list_entries()
        assert entries == archive.list_entries()
    assert all(isinstance(entry, ZipEntry) for entry in entries)
    assert [entry.path for entry in entries] == sorted(names[:6])
    assert [(entry.name, entry.kind) for entry in entries] == [
        ("shared.kml", TrackKind.DEFAULT),
        ("custom.kml", TrackKind.FLIGHT),
        ("unknown.kMl", None),
        ("shared.KML", TrackKind.TRAIN),
        ("no-tag.kml", None),
        ("legacy.kml", None),
    ]


def test_exact_paths_distinguish_same_filename_and_ignore_unselected_bad_kml(tmp_path, monkeypatch):
    first = "Default/2026-05/shared.kml"
    second = "Train/2026-05/shared.kml"
    path = make_zip(
        tmp_path, [(first, TRACK_KML), (second, TRACK_KML.replace("116.0", "117.0")), ("broken.kml", "<broken>")]
    )
    original_read = zipfile.ZipFile.read
    selected = []

    def read_selected(self, name, *args, **kwargs):
        selected.append(name.filename)
        return original_read(self, name, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "read", read_selected)
    with open_archive(path) as archive:
        assert len(archive.list_entries()) == 3
        a, b = archive.read_track_data(first), archive.read_track_data(second)
        assert a.tracks[0].segments[0].longitude[0] == 116
        assert b.tracks[0].segments[0].longitude[0] == 117
        for query in ("shared.kml", "shared", first.lower(), "./" + first, "absent.kml"):
            with pytest.raises(UserInputError, match="KML entry not found") as error:
                archive.read_track_data(query)
            assert str(path) in str(error.value) and query in str(error.value)
    assert selected == [first, second]
    assert a.source == f"{path}!/{first}"
    assert b.source == f"{path}!/{second}"


@pytest.mark.parametrize(
    "entry", ["Default/2026-05/旅行.kml", "旧轨迹.KML", "Unknown/trip.kml", "_unclassified/trip.kml"]
)
def test_selected_data_matches_local_file_including_nan_and_metadata(tmp_path, entry):
    content = (
        TRACK_KML.replace(
            "<Folder>",
            '<ExtendedData><Data name="TrackTags"><value>自定义活动</value></Data>'
            '<Data name="PosStartName"><value>出发</value></Data>'
            '<Data name="PosEndName"><value>到达</value></Data></ExtendedData><Folder>',
        )
        .replace("116.0 39.0 100", "116.0 39.0")
        .replace("116.1 39.1 110", "116.1 39.1 0")
    )
    content = content.replace(
        "</gx:Track>",
        "</gx:Track><MultiGeometry><LineString>"
        "<coordinates>120,30 121,31,0</coordinates></LineString>"
        "<gx:MultiTrack><gx:Track><gx:coord>1 2</gx:coord></gx:Track>"
        "</gx:MultiTrack></MultiGeometry>",
    )
    local = tmp_path / "local.kml"
    local.write_text(content, encoding="utf-8")
    path = make_zip(tmp_path, [(entry, content)])
    expected = trackdata.read_track_data(local)
    with open_archive(path) as archive:
        actual = archive.read_track_data(archive.list_entries()[0].path)
    assert actual.source == f"{path}!/{entry}"
    assert_data_equal(actual, expected)
    assert actual.track_tags == "自定义活动"
    assert isnan(actual.tracks[0].segments[0].altitude[0])


def test_xml_bytes_keep_declared_encoding(tmp_path):
    content = TRACK_KML.replace("UTF-8", "UTF-16").replace("<name>track</name>", "<name>中文路线</name>")
    raw = content.encode("utf-16")
    path = make_zip(tmp_path, [("legacy.kml", raw)])
    local = tmp_path / "local.kml"
    local.write_bytes(raw)
    with open_archive(path) as archive:
        actual = archive.read_track_data("legacy.kml")
    assert actual.tracks[0].name == "中文路线"
    assert_data_equal(actual, trackdata.read_track_data(local))


def test_no_activity_and_no_geometry_cache_or_array_copy(tmp_path, monkeypatch):
    path = make_zip(tmp_path, [("Mystery/no-tag.kml", TRACK_KML)])
    original_extract = trackdata.track_data_from_tree
    returned = []

    def extract(tree, *, source):
        result = original_extract(tree, source=source)
        returned.append(result)
        return result

    monkeypatch.setattr(trackdata, "track_data_from_tree", extract)
    with open_archive(path) as archive:
        entry = archive.list_entries()[0]
        assert entry.kind is None
        a = archive.read_track_data(entry.path)
        a.tracks[0].segments[0].longitude[0] = 0
        b = archive.read_track_data(entry.path)
    assert a is returned[0] and b is returned[1]
    assert a.track_tags == b.track_tags == ""
    assert b.tracks[0].segments[0].longitude[0] == 116


def test_duplicate_complete_paths_are_ambiguous(tmp_path):
    entry = "Default/2026-05/duplicate.kml"
    with pytest.warns(UserWarning, match="Duplicate name"):
        path = make_zip(tmp_path, [(entry, TRACK_KML), (entry, "<broken>"), ("unique.kml", TRACK_KML)])
    with open_archive(path) as archive:
        for operation in (archive.list_entries, lambda: archive.read_track_data(entry)):
            with pytest.raises(UserInputError, match="Ambiguous KML entry") as error:
                operation()
            assert str(path) in str(error.value) and entry in str(error.value)
        assert archive.read_track_data("unique.kml").tracks


@pytest.mark.parametrize("entries", [[], [("folder.kml/", b""), ("notes.txt", TRACK_KML)]])
def test_empty_or_no_kml_archive(tmp_path, entries):
    path = make_zip(tmp_path, entries)
    with open_archive(path) as archive:
        assert archive.list_entries() == []
        for query in ("folder.kml/", "notes.txt", "missing.kml"):
            with pytest.raises(UserInputError, match="KML entry not found"):
                archive.read_track_data(query)


@pytest.mark.parametrize(
    "failure", ["missing_manifest", "missing_zip", "invalid_zip", "directory", "missing_directory"]
)
def test_invalid_archive_paths_are_clear_and_read_only(tmp_path, failure):
    path = make_zip(tmp_path, [])
    if failure == "missing_manifest":
        (path.parent / "archive.json").unlink()
    elif failure == "missing_zip":
        path.unlink()
    elif failure == "invalid_zip":
        path.write_bytes(b"not a ZIP")
    elif failure == "directory":
        path = path.parent
    else:
        path = tmp_path / "absent" / "Archive.zip"
    before = snapshot(tmp_path)
    with pytest.raises(UserInputError) as error:
        with open_archive(path):
            pytest.fail("invalid archive must not open")
    assert str(path.parent if failure in ("missing_manifest", "missing_directory") else path) in str(error.value)
    assert snapshot(tmp_path) == before


def test_explicit_custom_zip_path_uses_existing_identity_rules_without_config(tmp_path, monkeypatch):
    path = make_zip(tmp_path, [("trip.kml", TRACK_KML)])
    custom = path.with_name("Custom.zip")
    path.rename(custom)

    class NoConfig:
        def __getitem__(self, key):
            pytest.fail("explicit ZIP access must not consult config")

    monkeypatch.setattr(ctx, "config", NoConfig())
    monkeypatch.chdir(tmp_path)
    # Explicit --zip paths already override the ZIP name in archive.json.
    with open_archive("archive/Custom.zip") as archive:
        assert archive.read_track_data("trip.kml").source == f"{custom}!/trip.kml"
    with pytest.raises(UserInputError, match="explicit archive ZIP file path"):
        with open_archive(""):
            pass


@pytest.mark.parametrize(
    "content, expected",
    [
        (b"<broken>", "Cannot parse KML"),
        (b"\xff\xfe invalid", "Cannot parse KML"),
        (TRACK_KML.replace("116.0 39.0 100", "invalid 39 100"), "point 1: Invalid longitude"),
    ],
)
def test_bad_selected_content_reports_source_and_caller_can_continue(tmp_path, content, expected):
    entry = "Default/bad.kml"
    path = make_zip(tmp_path, [(entry, content), ("good.kml", TRACK_KML)])
    with open_archive(path) as archive:
        with pytest.raises(UserInputError, match=expected) as error:
            archive.read_track_data(entry)
        assert f"{path}!/{entry}" in str(error.value)
        assert archive.read_track_data("good.kml").tracks


@pytest.mark.parametrize(
    "compression",
    [
        zipfile.ZIP_STORED,
        zipfile.ZIP_DEFLATED,
        zipfile.ZIP_BZIP2,
        zipfile.ZIP_LZMA,
        zipfile.ZIP_ZSTANDARD,
    ],
)
def test_crc_or_compressed_data_damage_is_reported_only_for_selected_entry(tmp_path, compression):
    path = make_archive(tmp_path / "archive")
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        archive.writestr("bad.kml", TRACK_KML)
        archive.writestr("good.kml", TRACK_KML)
        offset = archive.getinfo("bad.kml").header_offset
        size = archive.getinfo("bad.kml").compress_size
    raw = bytearray(path.read_bytes())
    name_length, extra_length = struct.unpack_from("<HH", raw, offset + 26)
    start = offset + 30 + name_length + extra_length
    raw[start : start + size] = bytes(size)
    path.write_bytes(raw)
    with open_archive(path) as archive:
        assert len(archive.list_entries()) == 2
        assert archive.read_track_data("good.kml").tracks
        with pytest.raises(UserInputError, match="Cannot read KML entry") as error:
            archive.read_track_data("bad.kml")
        assert f"{path}!/bad.kml" in str(error.value)


@pytest.mark.parametrize(
    "error",
    [
        OSError("cannot read"),
        EOFError("truncated"),
        RuntimeError("encrypted"),
        NotImplementedError("compression unavailable"),
    ],
)
def test_zip_read_errors_are_wrapped_with_source(tmp_path, monkeypatch, error):
    path = make_zip(tmp_path, [("trip.kml", TRACK_KML)])

    def fail(*args, **kwargs):
        raise error

    with open_archive(path) as archive:
        monkeypatch.setattr(zipfile.ZipFile, "read", fail)
        with pytest.raises(UserInputError, match="Cannot read KML entry") as caught:
            archive.read_track_data("trip.kml")
        assert f"{path}!/trip.kml" in str(caught.value)
        assert caught.value.__cause__ is error


@pytest.mark.parametrize("exit_mode", ["normal", "caller_exception", "parse_error"])
def test_context_closes_zip_on_every_exit(tmp_path, monkeypatch, exit_mode):
    path = make_zip(tmp_path, [("bad.kml", "<broken>")])
    original_zip = zipfile.ZipFile
    handles = []

    def capture(*args, **kwargs):
        handle = original_zip(*args, **kwargs)
        assert handle.mode == "r"
        handles.append(handle)
        return handle

    monkeypatch.setattr(zipfile, "ZipFile", capture)
    caller_error = OSError("caller failure")
    caught = None
    try:
        with open_archive(path) as archive:
            assert not archive.closed
            if exit_mode == "caller_exception":
                raise caller_error
            if exit_mode == "parse_error":
                archive.read_track_data("bad.kml")
    except (OSError, UserInputError) as error:
        caught = error
    assert (
        caught is caller_error
        if exit_mode == "caller_exception"
        else (isinstance(caught, UserInputError) if exit_mode == "parse_error" else caught is None)
    )
    assert len(handles) == 1 and handles[0].fp is None
    assert archive.closed
    for operation in (archive.list_entries, lambda: archive.read_track_data("bad.kml")):
        with pytest.raises(UserInputError, match="Archive is closed"):
            operation()


def snapshot(root):
    return {
        str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns) if path.is_file() else None
        for path in root.rglob("*")
    }


def test_archive_and_surroundings_unchanged_without_write_workflows(tmp_path, monkeypatch, config_in_tmp):
    path = make_zip(tmp_path, [("trip.kml", TRACK_KML), ("bad.kml", "<broken>")])
    for name in ("Default.kml", "Default.Mobile.kml", "history.jsonl", "Backup/source.kml"):
        sibling = path.parent / name
        sibling.parent.mkdir(exist_ok=True)
        sibling.write_bytes(b"must stay unchanged")
    config_in_tmp.parent.mkdir(parents=True, exist_ok=True)
    config_in_tmp.write_bytes(b"config must not be loaded or migrated")
    local = tmp_path / "local.kml"
    local.write_text(TRACK_KML)
    before = snapshot(tmp_path)

    def no_write(*args, **kwargs):
        pytest.fail("read access must not call a write workflow")

    for name in ("init_archive", "pop_kml_archive", "push_compressed_kmls", "rebuild", "ensure_zip_file"):
        monkeypatch.setattr(archive_ops, name, no_write)
    monkeypatch.setattr(xmlutil, "save", no_write)
    with open_archive(path) as archive:
        archive.list_entries()
        archive.read_track_data("trip.kml")
        with pytest.raises(UserInputError):
            archive.read_track_data("bad.kml")
    assert snapshot(tmp_path) == before
