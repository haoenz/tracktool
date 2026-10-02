"""Failure-file organization is optional and must never abort the main batch."""

import logging
import zipfile

import pytest
from conftest import TRACK_KML, InMemoryBackend, make_archive
from typer.testing import CliRunner

from tracktool import fileutil, workflows
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.exif import google as exif_google
from tracktool.exif.write import MissingTagResult
from tracktool.fileutil import BatchResult, FileFailure, run_per_file
from tracktool.tags import CAPTURE_TIME, OFFSET_TIME_ORIGINAL


@pytest.fixture(autouse=True)
def no_progress(monkeypatch):
    monkeypatch.setattr(ctx, "reporter", lambda activity: None)


@pytest.fixture
def files(tmp_path):
    files = [tmp_path / name for name in ("a.txt", "bad.txt", "c.txt")]
    for file in files:
        file.write_text(file.name)
    return files


@pytest.mark.parametrize("parallel", [False, True])
@pytest.mark.parametrize("error_type", [FileFailure, RuntimeError])
def test_blocked_directory_disables_moves_before_processing(files, tmp_path, caplog, parallel, error_type):
    caplog.set_level(logging.DEBUG, logger="tracktool")
    blocked = tmp_path / "Failed"
    blocked.write_text("occupied")
    visited = []

    def process(file):
        assert "moves disabled for this batch" in caplog.text
        visited.append(file)
        if file == files[1]:
            raise error_type("original processing problem")
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed", parallel=parallel)

    assert result.failed == files[1:2]
    assert result.succeeded == [files[0].name, files[2].name]
    assert set(visited) == set(files)
    assert blocked.read_text() == "occupied"
    assert all(file.read_text() == file.name for file in files)
    assert "original processing problem" in caplog.text
    assert "Failed file moved to" not in caplog.text


@pytest.mark.parametrize("parallel", [False, True])
@pytest.mark.parametrize("error_type", [FileFailure, RuntimeError])
def test_move_error_preserves_both_errors_and_batch_result(files, tmp_path, monkeypatch, caplog, parallel, error_type):
    def fail_move(*args, **kwargs):
        raise PermissionError("destination became read-only")

    monkeypatch.setattr(fileutil.shutil, "move", fail_move)

    def process(file):
        assert (tmp_path / "Failed").is_dir()
        if file == files[1]:
            raise error_type("original processing problem")
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed", parallel=parallel)

    assert result.failed == files[1:2]
    assert result.succeeded == [files[0].name, files[2].name]
    assert "original processing problem" in caplog.text
    assert "destination became read-only" in caplog.text
    assert "1 file(s) failed" in caplog.text
    assert "Failed file moved to" not in caplog.text
    assert all(file.read_text() == file.name for file in files)


@pytest.mark.parametrize("failure", ["access", "probe"])
def test_unwritable_directory_disables_moves_but_successful_processing_continues(
    files, tmp_path, monkeypatch, caplog, failure
):
    if failure == "access":
        monkeypatch.setattr(fileutil.os, "access", lambda *args: False)
    else:

        def fail_probe(*args, **kwargs):
            raise PermissionError("cannot create write probe")

        monkeypatch.setattr(fileutil.tempfile, "NamedTemporaryFile", fail_probe)

    def process(file):
        assert "moves disabled for this batch" in caplog.text
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed")

    assert result.ok and result.succeeded == [file.name for file in files]
    assert all(file.exists() for file in files)
    assert not list(tmp_path.rglob(".tracktool-write-check-*"))


def test_preflight_prepares_directory_once_before_parallel_workers(files, tmp_path, monkeypatch):
    real_probe = fileutil.tempfile.NamedTemporaryFile
    probes = []

    def probe(*args, **kwargs):
        probes.append(kwargs["dir"])
        return real_probe(*args, **kwargs)

    monkeypatch.setattr(fileutil.tempfile, "NamedTemporaryFile", probe)

    def process(file):
        assert probes == [tmp_path / "Failed"]
        assert not list((tmp_path / "Failed").glob(".tracktool-write-check-*"))
        raise FileFailure("cannot process")

    result = run_per_file(files, process, failed_folder_name="Failed", parallel=True)

    assert result.failed == files
    assert {file.name for file in (tmp_path / "Failed").iterdir()} == {file.name for file in files}
    assert all(not file.exists() for file in files)


@pytest.mark.parametrize("kind", ["file", "dangling_symlink"])
def test_existing_target_is_reported_before_processing_and_preserved(files, tmp_path, caplog, kind):
    directory = tmp_path / "Failed"
    directory.mkdir()
    target = directory / files[1].name
    if kind == "file":
        target.write_text("older failed file")
    else:
        target.symlink_to(directory / "missing")

    def process(file):
        assert "Failure destination already exists" in caplog.text
        if file == files[1]:
            raise FileFailure("processing failed")
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed")

    assert result.failed == files[1:2]
    assert files[1].read_text() == files[1].name
    if kind == "file":
        assert target.read_text() == "older failed file"
    else:
        assert target.is_symlink() and not target.exists()
    assert "Failed file moved to" not in caplog.text


def test_duplicate_destinations_are_not_moved_in_parallel(tmp_path, caplog):
    files = []
    for name in ("first", "second"):
        directory = tmp_path / name
        directory.mkdir()
        file = directory / "same.txt"
        file.write_text(name)
        files.append(file)
    destination = tmp_path / "Failed"

    def process(file):
        assert "Multiple inputs share failure destination" in caplog.text
        raise FileFailure("processing failed")

    result = run_per_file(files, process, failed_folder_name=str(destination), parallel=True)

    assert result.failed == files
    assert [file.read_text() for file in files] == ["first", "second"]
    assert list(destination.iterdir()) == []


def test_target_appearing_after_preflight_is_kept_and_not_reported_as_moved(files, tmp_path, caplog):
    caplog.set_level(logging.INFO)
    target = tmp_path / "Failed" / files[1].name

    def process(file):
        if file == files[1]:
            target.write_text("newly arrived file")
            raise FileFailure("processing failed")
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed")

    assert result.failed == files[1:2]
    assert target.read_text() == "newly arrived file"
    assert files[1].read_text() == files[1].name
    assert "not moved" in caplog.text
    assert "Failed file moved to" not in caplog.text


def test_successful_move_is_reported_only_after_it_happens(files, tmp_path, caplog):
    caplog.set_level(logging.INFO)

    def process(file):
        if file == files[1]:
            raise FileFailure("processing failed")
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed")

    assert result.failed == files[1:2]
    assert (tmp_path / "Failed" / files[1].name).read_text() == files[1].name
    assert not files[1].exists()
    assert "Failed file moved to" in caplog.text
    assert "1 file(s) failed, moved to" not in caplog.text


def test_one_unusable_directory_disables_moves_for_the_whole_batch(tmp_path, caplog):
    files = []
    for name in ("first", "second"):
        directory = tmp_path / name
        directory.mkdir()
        file = directory / "a.txt"
        file.write_text(name)
        files.append(file)
    (files[1].parent / "Failed").write_text("occupied")

    def process(file):
        raise FileFailure("processing failed")

    result = run_per_file(files, process, failed_folder_name="Failed", parallel=True)

    assert result.failed == files
    assert all(file.exists() for file in files)
    assert "moves disabled for this batch" in caplog.text
    assert not (files[0].parent / "Failed").exists()


@pytest.mark.parametrize("blocked", [False, True])
def test_preview_only_reads_and_never_claims_a_move(files, tmp_path, monkeypatch, caplog, plan_mode, blocked):
    caplog.set_level(logging.INFO)
    if blocked:
        (tmp_path / "Failed").write_text("occupied")
    before = set(tmp_path.iterdir())
    monkeypatch.setattr(
        fileutil.tempfile, "NamedTemporaryFile", lambda *args, **kwargs: pytest.fail("preview created a probe")
    )

    def process(file):
        if file == files[1]:
            raise FileFailure("processing failed")
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed")

    assert result.failed == files[1:2]
    assert result.succeeded == [files[0].name, files[2].name]
    assert set(tmp_path.iterdir()) == before
    assert "Failed file moved to" not in caplog.text
    assert ("Would move into Failed" in caplog.text) is not blocked


def test_missing_source_during_organization_does_not_abort_the_batch(files, caplog):
    def process(file):
        if file == files[1]:
            file.unlink()
            raise FileFailure("source disappeared during processing")
        return file.name

    result = run_per_file(files, process, failed_folder_name="Failed")

    assert result.failed == files[1:2]
    assert result.succeeded == [files[0].name, files[2].name]
    assert "source disappeared during processing" in caplog.text
    assert "could not move failed file" in caplog.text


@pytest.mark.parametrize("stage", ["processing", "organization", "preflight"])
def test_keyboard_interrupt_is_not_swallowed(files, monkeypatch, stage):
    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    if stage == "organization":
        monkeypatch.setattr(fileutil.shutil, "move", interrupt)
    elif stage == "preflight":
        monkeypatch.setattr(fileutil.tempfile, "NamedTemporaryFile", interrupt)

    def process(file):
        if stage == "processing":
            raise KeyboardInterrupt
        raise FileFailure("processing failed")

    with pytest.raises(KeyboardInterrupt):
        run_per_file(files, process, failed_folder_name="Failed")


def test_empty_batch_does_not_create_failure_directory(tmp_path):
    result = run_per_file([], lambda file: file, failed_folder_name=str(tmp_path / "Failed"))

    assert result.ok
    assert not list(tmp_path.iterdir())


def test_cli_keeps_partial_failure_exit_code_when_failure_directory_is_blocked(tmp_path, monkeypatch):
    zip_path = make_archive(tmp_path / "archive")
    with zipfile.ZipFile(zip_path, "a") as zf:
        zf.writestr("2024-05-01 track.kml", TRACK_KML)
    directory = tmp_path / "photos"
    directory.mkdir()
    bad, good = directory / "a.jpg", directory / "b.jpg"
    for file in (bad, good):
        file.write_bytes(b"photo")
    (directory / "Failed").write_text("occupied")
    backend = InMemoryBackend({good: {CAPTURE_TIME: "2024:05:01 08:01:30", OFFSET_TIME_ORIGINAL: "+08:00"}})
    monkeypatch.setattr(ctx, "backend", backend)
    monkeypatch.setattr(ctx, "config", Config(tmp_path / "config.json"))

    result = CliRunner().invoke(
        app, ["exif", "geotag", str(directory), "--zip", str(zip_path), "--failed-folder", "Failed", "--overwrite"]
    )

    assert result.exit_code == 3, result.output
    assert [file for file, *_ in backend.writes] == [good]
    assert bad.exists() and (directory / "Failed").read_text() == "occupied"


@pytest.mark.parametrize("failure", ["blocked_directory", "move_error"])
def test_repair_never_files_an_unmoved_failure_as_success(tmp_path, monkeypatch, failure):
    files = [tmp_path / name for name in ("bad.jpg", "good.jpg")]
    for file in files:
        file.write_bytes(b"photo")
    backend = InMemoryBackend({file: {"GPSLatitude": "39.0", "GPSLongitude": "116.0"} for file in files})
    monkeypatch.setattr(ctx, "backend", backend)
    monkeypatch.setattr(
        workflows,
        "find_missing_tag",
        lambda *args, **kwargs: BatchResult([MissingTagResult(file, ["GPSAltitude"]) for file in files]),
    )
    monkeypatch.setattr(exif_google.googleapi, "get_altitudes", lambda *args, **kwargs: [None, 10.0])
    if failure == "blocked_directory":
        (tmp_path / "GoogleAltFailed").write_text("occupied")
    else:
        real_move = fileutil.shutil.move

        def move(source, target):
            if "GoogleAltFailed" in target:
                raise PermissionError("failed-folder move denied")
            return real_move(source, target)

        monkeypatch.setattr(fileutil.shutil, "move", move)

    result = workflows.resolve_missing_gps(tmp_path)

    assert result.failed == files[:1]
    assert files[0].read_bytes() == b"photo"
    assert not (tmp_path / "GoogleAltOK" / "bad.jpg").exists()
    assert (tmp_path / "GoogleAltOK" / "good.jpg").read_bytes() == b"photo"
