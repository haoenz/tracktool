"""Undo retirement must be explicit and must not touch legacy artifacts."""

import pytest
from typer.testing import CliRunner

from tracktool.cli import app
from tracktool.errors import UserInputError
from tracktool.kml import storage, undo


def test_retired_undo_never_changes_old_zip_or_history(tmp_path):
    zip_path = tmp_path / "Archive.zip"
    history = tmp_path / "history.jsonl"
    zip_path.write_bytes(b"old-backup")
    history.write_bytes(b"legacy-history")
    with pytest.raises(UserInputError, match="retired"):
        undo.undo_last(str(zip_path), force=True)
    assert zip_path.read_bytes() == b"old-backup"
    assert history.read_bytes() == b"legacy-history"


def test_log_explicitly_reports_legacy_only(tmp_path):
    storage.create_database(tmp_path / storage.DB_NAME)
    result = CliRunner().invoke(app, ["archive", "log", "--zip", str(tmp_path / "Archive.zip")])
    assert result.exit_code == 0
    assert "Legacy history only" in result.output
