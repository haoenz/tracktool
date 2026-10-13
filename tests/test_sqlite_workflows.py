"""CLI compatibility under the SQLite contract; exports are deliberately explicit."""

import pytest
from conftest import TRACK_KML, make_archive
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.cli import app
from tracktool.context import RunMode, ctx
from tracktool.errors import UserInputError
from tracktool.kml import archive, storage
from tracktool.kml.archive_reader import open_archive
from tracktool.kml.kmlfile import TrackKind


def source(tmp_path, name="2024-05-01 trip.kml", tag="徒步"):
    p = tmp_path / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        TRACK_KML.replace(
            "<Document>", f'<Document><ExtendedData><Data name="TrackTags"><value>{tag}</value></Data></ExtendedData>'
        )
    )
    return p


@pytest.mark.parametrize("keep", [True, False])
def test_push_source_policy_and_idempotent_duplicate(tmp_path, keep):
    locator = make_archive(tmp_path / "archive")
    src = source(tmp_path)
    raw = src.read_bytes()
    workflows.push_tracks([src], str(locator), move=not keep)
    assert src.exists() == keep
    if not keep:
        assert (locator.parent / "Backup" / src.name).read_bytes() == raw
        src.write_bytes(raw)
    workflows.push_tracks([src], str(locator), move=not keep)
    with open_archive(locator) as reader:
        assert len(reader.list_entries()) == 1
        assert reader.read_bytes(reader.list_entries()[0].path) == raw
    assert not locator.exists()


def test_backup_conflict_keeps_both_files(tmp_path):
    locator = make_archive(tmp_path / "archive")
    src = source(tmp_path)
    backup = locator.parent / "Backup" / src.name
    backup.parent.mkdir()
    backup.write_bytes(b"different")
    workflows.push_tracks([src], str(locator))
    assert src.exists() and backup.read_bytes() == b"different"
    with open_archive(locator) as reader:
        assert len(reader.list_entries()) == 1


@pytest.mark.parametrize("bad", ["unknown", "undated", "invalid-xml"])
def test_bad_inputs_report_partial_failure_and_keep_sources(tmp_path, bad):
    locator = make_archive(tmp_path / "archive")
    good = source(tmp_path)
    broken = source(
        tmp_path,
        "undated.kml" if bad == "undated" else "2024-05-02 bad.kml",
        tag="unknown" if bad == "unknown" else "徒步",
    )
    if bad == "invalid-xml":
        broken.write_bytes(b"bad XML")
    result = workflows.push_tracks([good, broken], str(locator))
    assert result.failed == [broken] and broken.exists() and not good.exists()
    with open_archive(locator) as reader:
        assert len(reader.list_entries()) == 1


def test_cli_partial_failure_and_keep(tmp_path):
    locator = make_archive(tmp_path / "archive")
    good = source(tmp_path)
    bad = source(tmp_path, "2024-05-02 bad.kml", tag="unknown")
    result = CliRunner().invoke(app, ["kml", "push", str(good), str(bad), "--zip", str(locator), "--keep"])
    assert result.exit_code == 3
    assert good.exists() and bad.exists()


def test_push_preview_and_pop_preview_do_not_write(tmp_path, monkeypatch):
    locator = make_archive(tmp_path / "archive")
    src = source(tmp_path)
    raw_db = (locator.parent / storage.DB_NAME).read_bytes()
    monkeypatch.setattr(ctx, "mode", RunMode.PLAN)
    result = workflows.push_tracks([src], str(locator))
    assert result.ok and src.exists()
    assert "SQLite" in result.succeeded[0][0].kind
    assert (locator.parent / storage.DB_NAME).read_bytes() == raw_db
    assert not locator.exists()


def test_pop_exact_identity_type_and_ambiguous_filename(tmp_path, monkeypatch):
    locator = make_archive(tmp_path / "archive")
    first = source(tmp_path / "one")
    second = source(tmp_path / "two", tag="火车")
    longer = source(tmp_path, "2024-05-01 trip-long.kml")
    workflows.push_tracks([first, second, longer], str(locator), move=False)
    out = tmp_path / "out"
    out.mkdir()
    monkeypatch.chdir(out)
    with pytest.raises(UserInputError, match="Ambiguous"):
        archive.pop_kml_archive(first.stem, zip_path=str(locator), force=True)
    with pytest.raises(UserInputError, match="not found"):
        archive.pop_kml_archive("trip", zip_path=str(locator))
    archive.pop_kml_archive(first.stem, TrackKind.TRAIN, str(locator))
    assert (out / first.name).read_bytes() == second.read_bytes()
    with open_archive(locator) as reader:
        assert len(reader.list_entries()) == 2
    with pytest.raises(UserInputError, match="already exists"):
        archive.pop_kml_archive(first.stem, zip_path=str(locator), force=True)


def test_unknown_geometry_can_be_pushed_with_type(tmp_path):
    from test_sqlite_storage import UNSUPPORTED

    locator = make_archive(tmp_path / "archive")
    src = tmp_path / "2026-10-01 point.kml"
    src.write_bytes(UNSUPPORTED)
    assert workflows.push_tracks([src], str(locator), TrackKind.DEFAULT, move=False).ok
    with open_archive(locator) as reader:
        assert reader.read_bytes(reader.list_entries()[0].path) == UNSUPPORTED


def test_identical_sources_at_two_locations_are_both_collected(tmp_path):
    locator = make_archive(tmp_path / "archive")
    first, second = source(tmp_path / "one"), source(tmp_path / "two")
    raw = first.read_bytes()
    workflows.push_tracks([first, second], str(locator))
    assert not first.exists() and not second.exists()
    assert (locator.parent / "Backup" / first.name).read_bytes() == raw
    with open_archive(locator) as reader:
        assert len(reader.list_entries()) == 1
