"""Shared test fixtures: media files produced by real tools.

The JPEG comes from ffmpeg — one generated frame is more reliable than
hand-written EXIF byte streams.
"""

import subprocess
from pathlib import Path


def make_test_jpeg(path: Path) -> None:
    """A one-frame JPEG at `path` (needs ffmpeg on PATH)."""
    ret = subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", str(path)], capture_output=True
    )
    assert ret.returncode == 0, ret.stderr.decode(errors="replace")
