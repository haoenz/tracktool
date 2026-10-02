"""Regression coverage for interrupted pushes, merge outputs and restore identity."""

import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from conftest import TRACK_KML, make_archive

from tracktool import workflows
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml import archive, collections, edit, kmlfile
from tracktool.kml.kmlfile import TrackKind


def track(directory, name="2024-05-01 trip.kml", kind=TrackKind.DEFAULT):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(
        TRACK_KML.replace(
            "<Document>",
            f'<Document><ExtendedData><Data name="TrackTags"><value>{kind.value}</value></Data></ExtendedData>',
        ),
        encoding="utf-8",
    )
    return path


def test_interrupted_push_keeps_old_zip_and_can_be_retried(tmp_path):
    zip_path = make_archive(tmp_path / "archive")
    old = track(tmp_path / "sources")
    archive.push_compressed_kml(old, zip_path)
    before = zip_path.read_bytes()
    new = track(old.parent, "2024-05-02 new.kml")
    # Exit without unwinding context managers, just after a ZIP entry is written.
    code = """
import os, sys, zipfile
from pathlib import Path
from unittest.mock import patch
from tracktool.kml.archive import push_compressed_kmls
original = zipfile.ZipFile.write
def interrupt(self, *args, **kwargs):
    original(self, *args, **kwargs)
    self.fp.flush()
    os._exit(73)
with patch.object(zipfile.ZipFile, "write", interrupt):
    push_compressed_kmls([(Path(sys.argv[2]), "Default")], Path(sys.argv[1]))
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(zip_path), str(new)],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        timeout=15,
    )
    assert result.returncode == 73, result.stderr
    assert zip_path.read_bytes() == before
    with zipfile.ZipFile(zip_path) as zf:
        assert zf.testzip() is None
        assert zf.read(archive.zip_entry_name(old, "Default")) == old.read_bytes()
    archive.push_compressed_kml(new, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        assert len(zf.namelist()) == 2
        assert zf.testzip() is None


def test_merge_refuses_to_overwrite_source(tmp_path, monkeypatch):
    zip_path = make_archive(tmp_path / "archive")
    config = Config(tmp_path / "config.json")
    config["archive_path"] = str(zip_path.parent)
    monkeypatch.setattr(ctx, "config", config)
    source = track(tmp_path / "sources")
    before, zip_before = source.read_bytes(), zip_path.read_bytes()
    with pytest.raises(UserInputError, match="Output"):
        edit.merge_kml([source], source, move=True)
    assert source.read_bytes() == before
    assert zip_path.read_bytes() == zip_before
    assert not (zip_path.parent / "Backup").exists()


def test_pop_selects_type_and_removes_only_that_tracks_views(tmp_path, monkeypatch):
    zip_path = make_archive(tmp_path / "archive")
    flight = track(tmp_path / "flight", kind=TrackKind.FLIGHT)
    train = track(tmp_path / "train", kind=TrackKind.TRAIN)
    assert workflows.push_tracks([flight, train], str(zip_path)).ok
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    flight_views = collections.collection_paths(TrackKind.FLIGHT, zip_path.parent)
    before = [p.read_bytes() for p in flight_views]
    archive.pop_kml_archive(train.stem, TrackKind.TRAIN, str(zip_path))
    assert kmlfile.get_kml_type(output / train.name) == TrackKind.TRAIN
    with zipfile.ZipFile(zip_path) as zf:
        assert zf.namelist() == [archive.zip_entry_name(flight, "Flight")]
    assert [p.read_bytes() for p in flight_views] == before
    desktop, mobile = collections.collection_paths(TrackKind.TRAIN, zip_path.parent)
    assert not collections.has_desktop_track(train.stem, desktop)
    assert not collections.has_mobile_track(train.stem, mobile)


@pytest.mark.parametrize("failure", ["copy", "write", "validate", "sync", "replace", "interrupt"])
def test_failed_append_preserves_archive_sources_and_cleans_scratch(tmp_path, monkeypatch, failure):
    zip_path = make_archive(tmp_path / "archive")
    old = track(tmp_path / "sources")
    archive.push_compressed_kml(old, zip_path)
    before = zip_path.read_bytes()
    new = [track(old.parent, f"2024-05-0{i} new.kml") for i in (2, 3)]
    files_before = set(zip_path.parent.iterdir())

    def fail(*args, **kwargs):
        raise OSError("injected failure")

    if failure == "copy":
        monkeypatch.setattr(archive.shutil, "copyfileobj", fail)
    elif failure in ("write", "interrupt"):
        original = zipfile.ZipFile.write

        def failed_write(self, *args, **kwargs):
            original(self, *args, **kwargs)
            if failure == "interrupt":
                raise KeyboardInterrupt
            fail()

        monkeypatch.setattr(zipfile.ZipFile, "write", failed_write)
    elif failure == "validate":
        monkeypatch.setattr(zipfile.ZipFile, "testzip", lambda self: "corrupt.kml")
    elif failure == "sync":
        monkeypatch.setattr(archive.os, "fsync", fail)
    else:
        monkeypatch.setattr(archive.os, "replace", fail)
    with pytest.raises((OSError, zipfile.BadZipFile, KeyboardInterrupt)):
        archive.push_compressed_kmls([(p, "Default") for p in new], zip_path)
    assert zip_path.read_bytes() == before
    assert all(p.is_file() for p in new)
    assert set(zip_path.parent.iterdir()) == files_before


def test_append_publishes_complete_batch_preserving_zip_metadata(tmp_path, monkeypatch):
    zip_path = tmp_path / "Archive.zip"
    info = zipfile.ZipInfo("Default/2024-05/old.kml", date_time=(2024, 5, 1, 12, 0, 0))
    info.comment = b"entry comment"
    info.external_attr = 0o100640 << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.comment = b"archive comment"
        zf.writestr(info, b"old data")
    zip_path.chmod(0o640)
    before, mode = zip_path.read_bytes(), zip_path.stat().st_mode
    new = [track(tmp_path / "sources", f"2024-05-0{i} new.kml") for i in (2, 3)]
    replace = os.replace
    calls = []

    def inspect_replace(source, destination):
        assert zip_path.read_bytes() == before
        assert Path(source).parent == zip_path.parent
        with zipfile.ZipFile(source) as zf:
            assert zf.testzip() is None
            assert len(zf.namelist()) == 3
            assert zf.comment == b"archive comment"
            saved = zf.getinfo(info.filename)
            assert (saved.comment, saved.date_time, saved.external_attr, saved.compress_type) == (
                info.comment,
                info.date_time,
                info.external_attr,
                info.compress_type,
            )
        calls.append(destination)
        replace(source, destination)

    monkeypatch.setattr(archive.os, "replace", inspect_replace)
    archive.push_compressed_kmls([(p, "Default") for p in new] + [(new[0], "Default")], zip_path)
    assert calls == [zip_path]
    assert zip_path.stat().st_mode == mode
    before = zip_path.read_bytes()
    archive.push_compressed_kmls([(p, "Default") for p in new], zip_path)
    assert zip_path.read_bytes() == before  # A duplicate-only batch does not replace the ZIP.
    assert calls == [zip_path]
    assert not list(tmp_path.glob(".Archive.zip.*.tmp"))


def test_failed_push_does_not_move_sources_or_advance_fingerprint(tmp_path, monkeypatch):
    zip_path = make_archive(tmp_path / "archive")
    old = track(tmp_path / "sources")
    workflows.push_tracks([old], str(zip_path))
    stored = archive.read_views_fingerprint(zip_path)
    before = zip_path.read_bytes()
    new = track(old.parent, "2024-05-02 new.kml")

    def fail(*args):
        raise OSError("publication failed")

    monkeypatch.setattr(archive.os, "replace", fail)
    with pytest.raises(OSError):
        workflows.push_tracks([new], str(zip_path), move=True)
    assert new.exists()
    assert not (zip_path.parent / "Backup").exists()
    assert zip_path.read_bytes() == before
    assert archive.read_views_fingerprint(zip_path) == stored


def test_append_plan_does_not_create_zip_or_scratch(tmp_path, plan_mode):
    source = track(tmp_path / "sources")
    zip_path = tmp_path / "new.zip"
    archive.push_compressed_kml(source, zip_path)
    assert set(tmp_path.iterdir()) == {source.parent}


@pytest.fixture
def merge_inputs(tmp_path, monkeypatch):
    zip_path = make_archive(tmp_path / "archive")
    config = Config(tmp_path / "config.json")
    config["archive_path"] = str(zip_path.parent)
    monkeypatch.setattr(ctx, "config", config)
    source = track(tmp_path / "sources")
    return source, zip_path


@pytest.mark.parametrize("preview", [False, True])
@pytest.mark.parametrize(
    "occupied",
    [
        "source",
        "file",
        "directory",
        "symlink",
        "dangling",
        "hardlink",
        "zip",
        "manifest",
        "missing_zip",
        "missing_view",
        "parent_alias",
    ],
)
def test_merge_preflight_rejects_occupied_and_reserved_outputs(merge_inputs, tmp_path, monkeypatch, preview, occupied):
    from tracktool.context import RunMode

    source, zip_path = merge_inputs
    output = tmp_path / "output.kml"
    if occupied == "source":
        output = source
    elif occupied == "file":
        output.write_bytes(b"another track")
    elif occupied == "directory":
        output.mkdir()
    elif occupied == "symlink":
        output.symlink_to(source)
    elif occupied == "dangling":
        output.symlink_to(tmp_path / "absent.kml")
    elif occupied == "hardlink":
        os.link(source, output)
    elif occupied in ("zip", "missing_zip"):
        output = zip_path
        if occupied == "missing_zip":
            zip_path.unlink()
    elif occupied == "manifest":
        output = zip_path.parent / "archive.json"
    elif occupied == "missing_view":
        output = zip_path.parent / "Default.kml"
    else:
        alias = tmp_path / "alias"
        alias.symlink_to(source.parent, target_is_directory=True)
        output = alias / source.name
    files = [p for p in tmp_path.rglob("*") if p.is_file() and not p.is_symlink()]
    before = {p: p.read_bytes() for p in files}
    all_paths = set(tmp_path.rglob("*"))
    monkeypatch.setattr(ctx, "mode", RunMode.PLAN if preview else RunMode.APPLY)
    with pytest.raises(UserInputError, match="Output"):
        edit.merge_kml([source], output, move=True)
    assert {p: p.read_bytes() for p in files} == before
    assert set(tmp_path.rglob("*")) == all_paths


def test_merge_does_not_overwrite_target_appearing_after_preflight(merge_inputs, tmp_path, monkeypatch):
    source, zip_path = merge_inputs
    before, zip_before = source.read_bytes(), zip_path.read_bytes()
    output = tmp_path / "merged.kml"
    link = os.link

    def race(src, dst):
        Path(dst).write_bytes(b"arrived during merge")
        link(src, dst)

    monkeypatch.setattr(edit.os, "link", race)
    with pytest.raises(UserInputError, match="without overwriting"):
        edit.merge_kml([source], output, move=True)
    assert output.read_bytes() == b"arrived during merge"
    assert source.read_bytes() == before
    assert zip_path.read_bytes() == zip_before
    assert not list(tmp_path.glob(".merged.kml.*.tmp"))


@pytest.mark.parametrize("use_filename", [False, True])
def test_pop_exact_name_does_not_remove_a_longer_name(tmp_path, monkeypatch, use_filename):
    zip_path = make_archive(tmp_path / "archive")
    longer = track(tmp_path / "sources", "2024-05-01 trip-extra.kml")
    exact = track(longer.parent)
    workflows.push_tracks([longer, exact], str(zip_path))
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    archive.pop_kml_archive(exact.name if use_filename else exact.stem, TrackKind.DEFAULT, str(zip_path))
    with zipfile.ZipFile(zip_path) as zf:
        assert zf.namelist() == [archive.zip_entry_name(longer, "Default")]
    desktop, mobile = collections.collection_paths(TrackKind.DEFAULT, zip_path.parent)
    assert collections.has_desktop_track(longer.stem, desktop)
    assert collections.has_mobile_track(longer.stem, mobile)
    assert not collections.has_desktop_track(exact.stem, desktop)
    assert not collections.has_mobile_track(exact.stem, mobile)


@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("preview", [False, True])
def test_pop_rejects_ambiguous_entries_even_when_forced(tmp_path, monkeypatch, force, preview):
    from tracktool.context import RunMode

    zip_path = make_archive(tmp_path / "archive")
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(zip_path))
    with zipfile.ZipFile(zip_path, "a") as zf:
        zf.writestr("Default/2024-06/" + source.name, source.read_bytes())
    before = {p: p.read_bytes() for p in zip_path.parent.iterdir()}
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    monkeypatch.setattr(ctx, "mode", RunMode.PLAN if preview else RunMode.APPLY)
    with pytest.raises(UserInputError, match="Ambiguous"):
        archive.pop_kml_archive(source.stem, TrackKind.DEFAULT, str(zip_path), force=force)
    assert {p: p.read_bytes() for p in zip_path.parent.iterdir()} == before
    assert not list(output.iterdir())


def test_pop_legacy_flat_entry_uses_its_tags_and_exact_name(tmp_path, monkeypatch):
    zip_path = make_archive(tmp_path / "archive")
    source = track(tmp_path / "sources", kind=TrackKind.TRAIN)
    with zipfile.ZipFile(zip_path, "a") as zf:
        zf.writestr(source.name, source.read_bytes())
    archive.rebuild(str(zip_path))
    before = zip_path.read_bytes()
    with pytest.raises(UserInputError, match="Track not found in ZIP"):
        archive.pop_kml_archive(source.name, TrackKind.FLIGHT, str(zip_path))
    assert zip_path.read_bytes() == before
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    archive.pop_kml_archive(source.name, TrackKind.TRAIN, str(zip_path))
    assert (output / source.name).read_bytes() == source.read_bytes()
    with zipfile.ZipFile(zip_path) as zf:
        assert not zf.namelist()


def test_pop_does_not_guess_type_of_untagged_flat_entry(tmp_path):
    zip_path = make_archive(tmp_path / "archive")
    with zipfile.ZipFile(zip_path, "a") as zf:
        zf.writestr("2024-05-01 trip.kml", TRACK_KML)
    before = zip_path.read_bytes()
    with pytest.raises(UserInputError, match="Track not found in ZIP"):
        archive.pop_kml_archive("2024-05-01 trip", TrackKind.DEFAULT, str(zip_path))
    assert zip_path.read_bytes() == before


def test_merge_batches_archive_publication_and_preserves_original_points(merge_inputs, tmp_path, monkeypatch):
    source, zip_path = merge_inputs
    second = track(source.parent, "2024-05-02 next.kml")
    originals = {p: p.read_bytes() for p in (source, second)}
    output = tmp_path / "merged.kml"
    replace = os.replace
    calls = []

    def record_replace(src, dst):
        calls.append(dst)
        replace(src, dst)

    monkeypatch.setattr(archive.os, "replace", record_replace)
    edit.merge_kml([source, second, source], output, move=True)
    assert calls == [zip_path]
    with zipfile.ZipFile(zip_path) as zf:
        assert len(zf.namelist()) == 2
        for p, data in originals.items():
            assert zf.read(archive.zip_entry_name(p, "Default")) == data
            assert (zip_path.parent / "Backup" / p.name).read_bytes() == data
            assert not p.exists()
    assert output.is_file()


def test_merge_cli_preserves_a_dangling_output_symlink(merge_inputs, tmp_path):
    from typer.testing import CliRunner

    from tracktool.cli import app

    source, zip_path = merge_inputs
    output = tmp_path / "linked.kml"
    absent = tmp_path / "absent.kml"
    output.symlink_to(absent)
    before = zip_path.read_bytes()
    result = CliRunner().invoke(app, ["--dry-run", "kml", "merge", str(source), "-o", str(output)])
    assert isinstance(result.exception, UserInputError)
    assert "Output already exists" in str(result.exception)
    assert output.is_symlink() and not absent.exists()
    assert zip_path.read_bytes() == before


@pytest.mark.parametrize("collection", ["desktop", "mobile"])
def test_pop_refuses_ambiguous_view_before_extracting(tmp_path, monkeypatch, collection):
    from copy import deepcopy

    from tracktool.kml import xmlutil

    zip_path = make_archive(tmp_path / "archive")
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(zip_path))
    desktop, mobile = collections.collection_paths(TrackKind.DEFAULT, zip_path.parent)
    view = desktop if collection == "desktop" else mobile
    tree = xmlutil.parse_file(view)
    node = xmlutil.find(tree, "//kml:Placemark" if collection == "desktop" else "//kml:LineString")
    node.getparent().append(deepcopy(node))
    xmlutil.save(tree, view)
    before = {p: p.read_bytes() for p in zip_path.parent.iterdir()}
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    with pytest.raises(UserInputError, match="Ambiguous"):
        archive.pop_kml_archive(source.stem, TrackKind.DEFAULT, str(zip_path), force=True)
    assert not list(output.iterdir())
    assert {p: p.read_bytes() for p in zip_path.parent.iterdir()} == before


def test_pop_preview_validates_type_but_changes_nothing(tmp_path, monkeypatch, plan_mode):
    from tracktool.context import RunMode

    zip_path = make_archive(tmp_path / "archive")
    source = track(tmp_path / "sources")
    monkeypatch.setattr(ctx, "mode", RunMode.APPLY)
    workflows.push_tracks([source], str(zip_path))
    monkeypatch.setattr(ctx, "mode", RunMode.PLAN)
    before = {p: p.read_bytes() for p in zip_path.parent.iterdir()}
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    archive.pop_kml_archive(source.name, TrackKind.DEFAULT, str(zip_path))
    assert not list(output.iterdir())
    assert {p: p.read_bytes() for p in zip_path.parent.iterdir()} == before


def test_pop_rejects_substring_query_without_changing_archive(tmp_path, monkeypatch):
    zip_path = make_archive(tmp_path / "archive")
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(zip_path))
    before = {p: p.read_bytes() for p in zip_path.parent.iterdir()}
    monkeypatch.chdir(tmp_path)
    with pytest.raises(UserInputError, match="Track not found in ZIP"):
        archive.pop_kml_archive("2024-05-01", TrackKind.DEFAULT, str(zip_path))
    assert {p: p.read_bytes() for p in zip_path.parent.iterdir()} == before
    assert not (tmp_path / source.name).exists()
