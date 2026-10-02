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
from tracktool.kml import archive, edit
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
