"""The backend contract, run against the real exiftool adapter.

`BackendContract` is asserted twice: over the in-memory double on every run,
and here over the adapter the app actually uses. Without this half the double
would be free to drift — a rule could pass the suite and still fail on a real
file.

Marked `integration`: real exiftool reads and writes real JPEGs.
"""

from pathlib import Path

import pytest
from conftest import requires_media_tools
from fixtures.backend_contract import BackendContract
from fixtures.media import make_test_jpeg

from tracktool import exiftool
from tracktool.config import Config

pytestmark = requires_media_tools


@pytest.fixture
def backend(tmp_path: Path) -> exiftool.ExiftoolBackend:
    return exiftool.ExiftoolBackend(Config(path=tmp_path / "config.json").load())


@pytest.fixture
def photo(tmp_path: Path) -> Path:
    """A real JPEG: exiftool rewrites the file, so the bytes have to be a file."""
    path = tmp_path / "a.jpg"
    make_test_jpeg(path)
    return path


class TestExiftoolBackendContract(BackendContract):
    """The real adapter answering the same assertions as the double."""


class TestTheBackupPromise:
    """`write_tags` keeps the original unless told not to — the protocol's one
    promise whose evidence is a file on disk rather than a tag."""

    def test_a_write_keeps_the_original_beside_the_file(self, backend, photo):
        backend.write_tags(photo, {"IPTC:City": "Beijing"})

        assert photo.with_name(photo.name + "_original").is_file()

    def test_overwrite_leaves_no_original_behind(self, backend, photo):
        backend.write_tags(photo, {"IPTC:City": "Beijing"}, overwrite=True)

        assert not photo.with_name(photo.name + "_original").exists()
