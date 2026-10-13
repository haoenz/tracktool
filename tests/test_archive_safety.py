"""Regression coverage for interrupted pushes, merge outputs and restore identity."""

import os
from pathlib import Path

import pytest
from conftest import TRACK_KML, make_archive

from tracktool.config import Config
from tracktool.context import ctx
from tracktool.errors import UserInputError
from tracktool.kml import edit
from tracktool.kml.kmlfile import TrackKind

_ACTIVITY_OF = {
    TrackKind.DEFAULT: "徒步",
    TrackKind.TRAIN: "火车",
    TrackKind.FLIGHT: "飞机",
}


def track(directory, name="2024-05-01 trip.kml", kind=TrackKind.DEFAULT):
    """A track filed under `kind`, tagged so its type comes from the file itself.

    TrackTags holds an activity and the archive folder holds a category, but
    these cases think in categories, so each kind gets one activity from the
    built-in table. Writing the category name instead would be a value no table
    classifies, and the entry would land in _unclassified, hiding whatever the
    case is about. The table's own contract lives in
    tests/test_misc.py::TestConfigTrackTags.
    """
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(
        TRACK_KML.replace(
            "<Document>",
            f'<Document><ExtendedData><Data name="TrackTags"><value>{_ACTIVITY_OF[kind]}</value></Data></ExtendedData>',
        ),
        encoding="utf-8",
    )
    return path


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
        "missing_database",
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
    elif occupied in ("zip", "missing_database"):
        output = zip_path
        if occupied == "missing_database":
            (zip_path.parent / "archive.sqlite3").unlink()
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
    with pytest.raises(UserInputError, match="Output|not a tracktool archive"):
        edit.merge_kml([source], output, move=True)
    assert {p: p.read_bytes() for p in files} == before
    assert set(tmp_path.rglob("*")) == all_paths


def test_merge_does_not_overwrite_target_appearing_after_preflight(merge_inputs, tmp_path, monkeypatch):
    source, zip_path = merge_inputs
    before, zip_before = source.read_bytes(), (zip_path.parent / "archive.sqlite3").read_bytes()
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
    assert (zip_path.parent / "archive.sqlite3").read_bytes() == zip_before
    assert not list(tmp_path.glob(".merged.kml.*.tmp"))


def test_merge_cli_preserves_a_dangling_output_symlink(merge_inputs, tmp_path):
    from typer.testing import CliRunner

    from tracktool.cli import app

    source, zip_path = merge_inputs
    output = tmp_path / "linked.kml"
    absent = tmp_path / "absent.kml"
    output.symlink_to(absent)
    before = (zip_path.parent / "archive.sqlite3").read_bytes()
    result = CliRunner().invoke(app, ["--dry-run", "kml", "merge", str(source), "-o", str(output)])
    assert isinstance(result.exception, UserInputError)
    assert "Output already exists" in str(result.exception)
    assert output.is_symlink() and not absent.exists()
    assert (zip_path.parent / "archive.sqlite3").read_bytes() == before
