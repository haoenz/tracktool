"""Check media destinations as a batch, before metadata writes or conversion."""

import errno
import logging
from datetime import timedelta
from pathlib import Path

import pytest
from conftest import InMemoryBackend
from typer.testing import CliRunner

from tracktool import actions, workflows
from tracktool.actions import Rename, ShiftTags
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import ctx
from tracktool.exif.media import convert_to_mp4, shift_exif_time
from tracktool.fileutil import BatchResult, FileFailure
from tracktool.tags import MAKE, MAKE_INSTA360, QUICKTIME_CREATE_DATE


@pytest.fixture
def backend(tmp_path, monkeypatch):
    backend = InMemoryBackend()
    monkeypatch.setattr(ctx, "backend", backend)
    monkeypatch.setattr(ctx, "config", Config(tmp_path / "config.json"))
    monkeypatch.setattr(ctx, "reporter", lambda activity: None)
    return backend


def video(path, backend):
    path.write_bytes(path.name.encode())
    backend.tags[path] = {MAKE: MAKE_INSTA360, QUICKTIME_CREATE_DATE: "2024:05:01 12:00:00"}
    return path


def occupy(path, kind):
    if kind == "file":
        path.write_bytes(b"existing target")
    elif kind == "directory":
        path.mkdir()
    else:
        path.symlink_to(path.with_name("missing"))


def assert_occupied(path, kind):
    if kind == "file":
        assert path.read_bytes() == b"existing target"
    elif kind == "directory":
        assert path.is_dir() and not list(path.iterdir())
    else:
        assert path.is_symlink() and path.readlink() == path.with_name("missing")


@pytest.mark.parametrize("kind", ["file", "directory", "dangling_symlink"])
@pytest.mark.parametrize("overwrite", [False, True])
def test_rename_conflict_is_rejected_before_metadata_changes(tmp_path, backend, kind, overwrite):
    source = video(tmp_path / "VID_20240501_120000_00.mp4", backend)
    target = tmp_path / "VID_20240501_130000_00.mp4"
    occupy(target, kind)
    original = source.read_bytes()

    result = shift_exif_time(source, "+1h", overwrite=overwrite)

    assert result.failed == [source]
    assert backend.shifts == [] and backend.writes == []
    assert source.read_bytes() == original
    assert_occupied(target, kind)
    assert set(tmp_path.iterdir()) == {source, target}


@pytest.mark.parametrize("parallel", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
def test_rename_chain_fails_independently_of_order_and_other_files_continue(
    tmp_path, backend, parallel, reverse, caplog
):
    caplog.set_level(logging.WARNING)
    first = video(tmp_path / "VID_20240501_120000_00.mp4", backend)
    second = video(tmp_path / "VID_20240501_130000_00.mp4", backend)
    good = video(tmp_path / "VID_20240501_160000_00.mp4", backend)
    files = [good, first, second]
    if reverse:
        files.reverse()
    original_shift = backend.shift_tags

    def shift_after_all_checks(*args, **kwargs):
        assert len(backend.reads) == len(files)
        assert first.name in caplog.text and second.name in caplog.text
        original_shift(*args, **kwargs)

    backend.shift_tags = shift_after_all_checks
    result = shift_exif_time(files, "+1h", overwrite=True, parallel=parallel)

    assert result.failed == [file for file in files if file != good]
    assert [file for file, *_ in backend.shifts] == [good]
    assert first.read_bytes() == first.name.encode()
    assert second.read_bytes() == second.name.encode()
    assert not (tmp_path / "VID_20240501_140000_00.mp4").exists()
    assert (tmp_path / "VID_20240501_170000_00.mp4").read_bytes() == good.name.encode()


@pytest.mark.parametrize("parallel", [False, True])
def test_duplicate_conversion_outputs_reject_all_owners_before_any_conversion(tmp_path, backend, monkeypatch, parallel):
    files = [video(tmp_path / name, backend) for name in ("good.mov", "trip.mov", "trip.avi")]
    converted = []

    def ffmpeg(args, source):
        assert len(backend.reads) == len(files)
        converted.append(source)
        Path(args[-1]).write_bytes(b"converted")

    monkeypatch.setattr(actions, "_ffmpeg", ffmpeg)
    result = convert_to_mp4(files, parallel=parallel)

    assert result.failed == files[1:]
    assert converted == files[:1]
    assert [file for file, *_ in backend.writes] == [tmp_path / "good.mp4"]
    assert not (tmp_path / "trip.mp4").exists()
    assert all(file.read_bytes() == file.name.encode() for file in files)


@pytest.mark.parametrize("kind", ["file", "directory", "dangling_symlink"])
def test_existing_conversion_target_is_a_failure(tmp_path, backend, monkeypatch, kind):
    source = video(tmp_path / "trip.mov", backend)
    target = tmp_path / "trip.mp4"
    occupy(target, kind)
    monkeypatch.setattr(actions, "_ffmpeg", lambda *args: pytest.fail("conversion started despite conflict"))

    result = convert_to_mp4(source)

    assert result.failed == [source]
    assert not backend.writes
    assert source.read_bytes() == source.name.encode()
    assert_occupied(target, kind)


@pytest.mark.parametrize("kind", ["directory", "dangling_symlink"])
def test_blocked_backup_is_rejected_before_any_writes(tmp_path, backend, kind):
    source = video(tmp_path / "trip.mp4", backend)
    backup = source.with_name(source.name + "_original")
    occupy(backup, kind)

    result = convert_to_mp4(source)

    assert result.failed == [source]
    assert not backend.writes
    assert source.read_bytes() == source.name.encode()
    assert_occupied(backup, kind)
    assert set(tmp_path.iterdir()) == {source, backup}


def test_successful_shift_renames_without_copying_video_bytes(tmp_path, backend, monkeypatch):
    source = video(tmp_path / "VID_20240501_120000_00.mp4", backend)
    original_inode = source.stat().st_ino
    monkeypatch.setattr(actions.shutil, "copy2", lambda *args: pytest.fail("unexpected media copy"))

    result = shift_exif_time(source, "+1h", overwrite=True)

    assert result.ok
    target = tmp_path / "VID_20240501_130000_00.mp4"
    assert target.stat().st_ino == original_inode
    assert not source.exists()
    assert set(tmp_path.iterdir()) == {target}


def test_target_created_after_preflight_is_not_overwritten(tmp_path, backend):
    source = video(tmp_path / "VID_20240501_120000_00.mp4", backend)
    target = tmp_path / "VID_20240501_130000_00.mp4"
    original_shift = backend.shift_tags

    def concurrent_target(*args, **kwargs):
        original_shift(*args, **kwargs)
        target.write_bytes(b"arrived after preflight")

    backend.shift_tags = concurrent_target
    result = shift_exif_time(source, "+1h", overwrite=True)

    assert result.failed == [source]
    assert source.read_bytes() == source.name.encode()
    assert target.read_bytes() == b"arrived after preflight"
    assert len(backend.shifts) == 1  # No rollback of metadata was promised.


def test_conversion_target_created_during_ffmpeg_is_not_overwritten(tmp_path, backend, monkeypatch):
    source = video(tmp_path / "trip.mov", backend)
    target = tmp_path / "trip.mp4"

    def concurrent_target(args, source):
        Path(args[-1]).write_bytes(b"conversion output")
        target.write_bytes(b"arrived during conversion")

    monkeypatch.setattr(actions, "_ffmpeg", concurrent_target)
    result = convert_to_mp4(source)

    assert result.failed == [source]
    assert not backend.writes
    assert source.read_bytes() == source.name.encode()
    assert target.read_bytes() == b"arrived during conversion"
    assert set(tmp_path.iterdir()) == {source, target}


def test_direct_rename_also_refuses_overwrite(tmp_path):
    source, target = tmp_path / "a.mp4", tmp_path / "b.mp4"
    source.write_bytes(b"source")
    target.write_bytes(b"target")

    with pytest.raises(FileFailure) as exc:
        actions.apply(Rename(source, target.name))

    assert not exc.value.quarantine
    assert source.read_bytes() == b"source" and target.read_bytes() == b"target"


def test_unsupported_link_fails_without_falling_back_to_overwriting(tmp_path, monkeypatch):
    source, target = tmp_path / "a.mp4", tmp_path / "b.mp4"
    source.write_bytes(b"source")

    def unsupported(*args, **kwargs):
        raise OSError(errno.EOPNOTSUPP, "hard links unavailable")

    monkeypatch.setattr(actions.os, "link", unsupported)
    with pytest.raises(FileFailure):
        actions.apply(Rename(source, target.name))

    assert source.read_bytes() == b"source" and not target.exists()


def test_single_plan_preflight_runs_before_metadata_write(tmp_path, backend):
    source = video(tmp_path / "a.mp4", backend)
    target = video(tmp_path / "b.mp4", backend)

    with pytest.raises(FileFailure):
        actions.run([ShiftTags(source, [QUICKTIME_CREATE_DATE], timedelta(hours=1)), Rename(source, target.name)])

    assert not backend.shifts


def test_duplicate_input_paths_are_not_processed_twice(tmp_path, backend):
    source = video(tmp_path / "VID_20240501_120000_00.mp4", backend)

    result = shift_exif_time([source, source], "+1h", parallel=True)

    assert result.failed == [source, source]
    assert not backend.shifts
    assert source.exists()


def test_conversion_to_same_file_through_directory_alias_keeps_output(tmp_path, backend):
    directory = tmp_path / "videos"
    directory.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(directory, target_is_directory=True)
    source = video(directory / "trip.mp4", backend)

    result = convert_to_mp4(source, output_directory=alias)

    assert result.ok
    assert source.read_bytes() == source.name.encode()
    assert (directory / "trip.mp4_original").read_bytes() == source.name.encode()
    assert len(backend.writes) == 1


def test_input_aliases_cannot_be_modified_twice(tmp_path, backend):
    directory = tmp_path / "videos"
    directory.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(directory, target_is_directory=True)
    source = video(directory / "trip.mp4", backend)
    alias_source = alias / source.name
    backend.tags[alias_source] = backend.tags[source]

    result = convert_to_mp4([source, alias_source], parallel=True)

    assert result.failed == [source, alias_source]
    assert not backend.writes
    assert set(directory.iterdir()) == {source}


def test_unreadable_file_does_not_prevent_other_files_from_being_planned(tmp_path, backend, monkeypatch):
    bad = video(tmp_path / "bad.mp4", backend)
    good = video(tmp_path / "good.mp4", backend)
    original_read = backend.read_tags

    def read(file, tags):
        if file == bad:
            raise OSError("unreadable metadata")
        return original_read(file, tags)

    monkeypatch.setattr(backend, "read_tags", read)
    result = convert_to_mp4([bad, good])

    assert result.failed == [bad]
    assert [file for file, *_ in backend.writes] == [good]
    assert bad.read_bytes() == bad.name.encode()
    assert not bad.with_name(bad.name + "_original").exists()


def test_output_parent_occupied_by_file_is_detected_before_conversion(tmp_path, backend, monkeypatch):
    source = video(tmp_path / "trip.mov", backend)
    blocked = tmp_path / "output"
    blocked.write_bytes(b"occupied")
    monkeypatch.setattr(actions, "_ffmpeg", lambda *args: pytest.fail("conversion started despite blocked directory"))

    result = convert_to_mp4(source, output_directory=blocked)

    assert result.failed == [source]
    assert blocked.read_bytes() == b"occupied"
    assert not backend.writes


@pytest.mark.parametrize("command", ["shift-time", "to-mp4"])
def test_cli_preview_reports_conflicts_without_writes(tmp_path, backend, command):
    if command == "shift-time":
        source = video(tmp_path / "VID_20240501_120000_00.mp4", backend)
        target = tmp_path / "VID_20240501_130000_00.mp4"
        options = ["--by", "+1h"]
    else:
        source = video(tmp_path / "trip.mov", backend)
        target = tmp_path / "trip.mp4"
        options = []
    target.write_bytes(b"occupied")

    result = CliRunner().invoke(app, ["--dry-run", "exif", command, str(source), *options])

    assert result.exit_code == 3, result.output
    assert not backend.shifts and not backend.writes
    assert source.read_bytes() == source.name.encode()
    assert target.read_bytes() == b"occupied"
    assert set(tmp_path.iterdir()) == {source, target}


def test_check_only_detects_duplicate_outputs(tmp_path, backend):
    files = [video(tmp_path / name, backend) for name in ("trip.mov", "trip.avi")]

    result = convert_to_mp4(files, check_only=True)

    assert result.failed == files
    assert not backend.writes
    assert set(tmp_path.iterdir()) == set(files)


def test_repair_vid_detects_collisions_before_directory_rename(tmp_path, backend):
    directory = tmp_path / "VID"
    directory.mkdir()
    files = [video(directory / name, backend) for name in ("trip.mov", "trip.mp4")]

    result = workflows.resolve_vid_exif(tmp_path)

    assert result.failed == files
    assert not backend.writes
    assert set(tmp_path.iterdir()) == {directory}
    assert set(directory.iterdir()) == set(files)


def test_repair_vid_resume_keeps_completed_output(tmp_path, backend, monkeypatch):
    original, output = tmp_path / "VID_original", tmp_path / "VID"
    original.mkdir()
    output.mkdir()
    source = video(original / "trip.mov", backend)
    target = output / "trip.mp4"
    target.write_bytes(b"completed conversion")
    monkeypatch.setattr(workflows, "resolve_missing_gps", lambda *args, **kwargs: BatchResult())
    monkeypatch.setattr(actions, "_ffmpeg", lambda *args: pytest.fail("completed video reconverted"))

    result = workflows.resolve_vid_exif(tmp_path)

    assert result.ok
    assert not backend.writes
    assert source.read_bytes() == source.name.encode()
    assert target.read_bytes() == b"completed conversion"


@pytest.mark.parametrize("preview", [False, True])
def test_repair_vid_first_run_allows_distinct_outputs(tmp_path, backend, monkeypatch, preview):
    from tracktool.context import RunMode

    directory = tmp_path / "VID"
    directory.mkdir()
    files = [video(directory / name, backend) for name in ("one.mov", "two.mp4")]
    # The workflow relocates its inputs; the fake metadata follows each file.
    monkeypatch.setattr(backend, "read_tags", lambda file, tags: backend.tags[directory / file.name])
    monkeypatch.setattr(workflows, "resolve_missing_gps", lambda *args, **kwargs: BatchResult())
    monkeypatch.setattr(actions, "_ffmpeg", lambda args, source: Path(args[-1]).write_bytes(b"converted"))
    if preview:
        monkeypatch.setattr(ctx, "mode", RunMode.PLAN)

    result = workflows.resolve_vid_exif(tmp_path)

    assert result.ok
    if preview:
        assert set(directory.iterdir()) == set(files)
        assert not (tmp_path / "VID_original").exists()
        assert not backend.writes
    else:
        assert {file.name for file in directory.iterdir()} == {"one.mp4", "two.mp4"}
        assert (tmp_path / "VID_original" / "one.mov").exists()
        assert (tmp_path / "VID_original" / "two.mp4_original").exists()
        assert len(backend.writes) == 2
