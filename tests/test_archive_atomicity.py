"""Restoring one track must never destroy other tracks on rewrite failure."""

import os
import stat
import zipfile
from pathlib import Path

import pytest

from tracktool.kml import archive


@pytest.fixture
def archived_tracks(tmp_path):
    zip_path = tmp_path / "Archive.zip"
    entries = {
        "Default/2024-05/restore.kml": b"restored track",
        "Default/2024-05/keep.kml": b"first remaining track",
        "Running/2024-06/keep.kml": b"second remaining track",
    }
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.comment = b"archive comment"
        for name, data in entries.items():
            info = zipfile.ZipInfo(name, date_time=(2024, 5, 1, 12, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.comment = b"entry comment"
            info.external_attr = 0o100640 << 16
            zf.writestr(info, data)
    zip_path.chmod(0o640)
    output = tmp_path / "restored"
    output.mkdir()
    return zip_path, entries, output


def test_restore_preserves_remaining_contents_and_metadata(archived_tracks):
    zip_path, entries, output = archived_tracks
    restored = next(iter(entries))

    archive.pop_zip_entry(restored, zip_path, output)

    assert (output / "restore.kml").read_bytes() == entries[restored]
    with zipfile.ZipFile(zip_path) as zf:
        assert zf.testzip() is None
        assert zf.namelist() == list(entries)[1:]
        assert zf.comment == b"archive comment"
        for info in zf.infolist():
            assert zf.read(info) == entries[info.filename]
            assert info.date_time == (2024, 5, 1, 12, 0, 0)
            assert info.compress_type == zipfile.ZIP_DEFLATED
            assert info.comment == b"entry comment"
            assert info.external_attr == 0o100640 << 16
    assert stat.S_IMODE(zip_path.stat().st_mode) == 0o640
    assert set(zip_path.parent.iterdir()) == {zip_path, output}


@pytest.mark.parametrize("failure", ["write", "validate", "extract_sync", "archive_sync", "replace"])
def test_failure_preserves_original_archive_and_cleans_temporary_file(archived_tracks, monkeypatch, failure):
    zip_path, entries, output = archived_tracks
    original = zip_path.read_bytes()
    restored = next(iter(entries))

    if failure == "write":
        original_write = zipfile.ZipFile.writestr

        def fail_after_write(self, *args, **kwargs):
            original_write(self, *args, **kwargs)
            raise OSError("injected write failure")

        monkeypatch.setattr(zipfile.ZipFile, "writestr", fail_after_write)
    elif failure == "validate":
        monkeypatch.setattr(zipfile.ZipFile, "testzip", lambda self: list(entries)[1])
    elif failure in {"extract_sync", "archive_sync"}:
        original_sync = os.fsync
        calls = 0

        def fail_sync(fd):
            nonlocal calls
            calls += 1
            if calls == (1 if failure == "extract_sync" else 2):
                raise OSError("injected sync failure")
            original_sync(fd)

        monkeypatch.setattr(os, "fsync", fail_sync)
    else:

        def fail_replace(source, destination):
            assert Path(source).parent == zip_path.parent
            assert Path(destination) == zip_path
            assert zip_path.read_bytes() == original
            with zipfile.ZipFile(source) as zf:
                assert zf.namelist() == list(entries)[1:]
            raise OSError("injected replace failure")

        monkeypatch.setattr(os, "replace", fail_replace)

    with pytest.raises((OSError, zipfile.BadZipFile)):
        archive.pop_zip_entry(restored, zip_path, output)

    assert zip_path.read_bytes() == original
    with zipfile.ZipFile(zip_path) as zf:
        assert {info.filename: zf.read(info) for info in zf.infolist()} == entries
    assert (output / "restore.kml").read_bytes() == entries[restored]
    assert set(zip_path.parent.iterdir()) == {zip_path, output}


def test_restoring_last_entry_leaves_valid_empty_zip(tmp_path):
    zip_path = tmp_path / "Archive.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("only.kml", b"only track")

    archive.pop_zip_entry("only.kml", zip_path, tmp_path)

    assert (tmp_path / "only.kml").read_bytes() == b"only track"
    with zipfile.ZipFile(zip_path) as zf:
        assert zf.namelist() == []
        assert zf.testzip() is None
    assert set(tmp_path.iterdir()) == {zip_path, tmp_path / "only.kml"}


def test_plan_does_not_extract_or_rewrite(archived_tracks, plan_mode):
    zip_path, entries, output = archived_tracks
    original = zip_path.read_bytes()

    archive.pop_zip_entry(next(iter(entries)), zip_path, output)

    assert zip_path.read_bytes() == original
    assert list(output.iterdir()) == []
    assert set(zip_path.parent.iterdir()) == {zip_path, output}
