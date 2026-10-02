"""Time-shift input errors must fail before media discovery or metadata access."""

import sys
from pathlib import Path

import pytest
from conftest import InMemoryBackend

from tracktool.cli import cli_main
from tracktool.config import Config
from tracktool.context import RunMode, ctx
from tracktool.errors import UserInputError
from tracktool.exif import media


@pytest.mark.parametrize(
    ("value", "seconds"),
    [
        ("+1h30m", 5400),
        ("-2d", -172800),
        ("1d2h3m4s", 93784),
        ("-1d2h3m4s", -93784),
        ("1d4s", 86404),
        ("90m", 5400),
        ("60s", 60),
        ("001h", 3600),
        ("0s", 0),
        ("-0s", 0),
    ],
)
def test_valid_time_diff(value, seconds):
    assert media._parse_time_diff(value) == seconds


@pytest.mark.parametrize(
    "value",
    [
        "",
        " ",
        "+",
        "-",
        "garbage",
        "1hXYZ",
        "++1h",
        "--1h",
        "+-1h",
        "-+1h",
        "1",
        "h",
        "1h2h",
        "30m1h",
        "1.5h",
        "1h-30m",
        "1h 30m",
        " 1h",
        "1h ",
        "1h\n",
    ],
)
def test_invalid_time_diff(value):
    with pytest.raises(UserInputError, match="Invalid TimeDiff"):
        media._parse_time_diff(value)


@pytest.mark.parametrize("mode", [RunMode.APPLY, RunMode.PLAN])
@pytest.mark.parametrize("parallel", [False, True])
def test_invalid_input_fails_before_discovery(tmp_path, monkeypatch, mode, parallel):
    monkeypatch.setattr(ctx, "mode", mode)

    def unexpected_discovery(path):
        pytest.fail("Invalid input must be rejected before discovering media files")

    monkeypatch.setattr(media, "list_files", unexpected_discovery)
    with pytest.raises(UserInputError, match="Invalid TimeDiff"):
        media.shift_exif_time(tmp_path, "1hXYZ", offset_time="+08:00", parallel=parallel)


def test_invalid_input_in_empty_batch():
    with pytest.raises(UserInputError, match="Invalid TimeDiff"):
        media.shift_exif_time([], "garbage")


@pytest.mark.parametrize("dry_run", [False, True])
@pytest.mark.parametrize("value", ["garbage", "1hXYZ", "++1h", " ", ""])
def test_cli_rejects_bad_shift_without_touching_media(tmp_path, monkeypatch, caplog, dry_run, value):
    file = tmp_path / "photo.jpg"
    file.write_bytes(b"original media")
    backend = InMemoryBackend()
    monkeypatch.setattr(ctx, "backend", backend)
    monkeypatch.setattr(ctx, "config", Config(tmp_path / "config.json"))
    argv = ["tracktool", *(["--dry-run"] if dry_run else []), "exif", "shift-time", str(file)]
    monkeypatch.setattr(sys, "argv", [*argv, "--by", value, "--offset-time", "+08:00"])

    with pytest.raises(SystemExit) as exc:
        cli_main()

    assert exc.value.code == 1
    assert "Invalid TimeDiff" in caplog.text or "--by must not be empty" in caplog.text
    assert backend.reads == backend.writes == backend.shifts == []
    assert file.read_bytes() == b"original media"
    assert list(tmp_path.glob("*.jpg*")) == [file]


def test_whitespace_is_not_an_absent_shift():
    with pytest.raises(UserInputError, match="Invalid TimeDiff"):
        media._compute_time_shift(Path("photo.jpg"), " ", "+08:00", "SONY", "+08:00")


@pytest.mark.parametrize("offset_only", [False, True])
def test_cli_preserves_zero_shift_and_offset_only(tmp_path, monkeypatch, offset_only):
    file = tmp_path / "photo.jpg"
    file.touch()
    backend = InMemoryBackend({file: {"Make": "SONY", "ExifIFD:OffsetTime": "+08:00"}})
    monkeypatch.setattr(ctx, "backend", backend)
    monkeypatch.setattr(ctx, "config", Config(tmp_path / "config.json"))
    options = ["--offset-time", "+09:00"] if offset_only else ["--by", "0s"]
    monkeypatch.setattr(sys, "argv", ["tracktool", "exif", "shift-time", str(file), *options])

    with pytest.raises(SystemExit) as exc:
        cli_main()

    assert exc.value.code == 0
    assert len(backend.reads) == 1
    if offset_only:
        assert backend.shifts[0][2].total_seconds() == 3600
        assert backend.writes[0][1]["ExifIFD:OffsetTime"] == "+09:00"
    else:
        assert backend.writes == backend.shifts == []
