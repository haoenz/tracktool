"""Raster source identities, address adaptation and invalid-resource rejection."""

import json
from io import BytesIO

import pytest

from tracktool.drawing.basemaps import PRESETS, public_presets, tile_url
from tracktool.drawing.resources import Resources
from tracktool.drawing.state import default_state, validate_state
from tracktool.errors import UserInputError


def test_all_presets_roundtrip_without_secrets():
    assert len(PRESETS) == 10
    for identity in PRESETS:
        state = default_state({})
        state["style"]["basemap"] = identity
        assert validate_state(json.loads(json.dumps(state))) == state
    public = json.dumps(public_presets())
    assert "private-test-key" not in public and "https:" not in public and "apikey" not in public
    assert "opencycle" not in PRESETS


def test_quadkey_and_large_tile_addressing():
    assert "/ch/213?" in tile_url(PRESETS["bing-satellite"], 3, 3, 5)
    large = PRESETS["google-hybrid-large"]
    assert large["tile_size"] == 512 and large["crs"] == "gcj02"
    # MapLibre performs the 512px pyramid shift; applying it twice is wrong.
    assert "x=3&y=5&z=7" in tile_url(large, 7, 3, 5)


def test_raster_validation_mime_cache_and_source_identity(tmp_path, monkeypatch, request):
    image = pytest.importorskip("PIL.Image", reason="requires optional maps dependencies")
    resources = Resources(tmp_path)
    request.addfinalizer(resources.close)
    output = BytesIO()
    image.new("RGB", (256, 256), "green").save(output, format="JPEG")
    data = output.getvalue()
    calls = []
    monkeypatch.setattr(resources, "fetch", lambda url: calls.append(url) or data)
    assert resources.tile("google-satellite", 3, 3, 5) == (data, "image/jpeg")
    assert resources.tile("google-satellite", 3, 3, 5) == (data, "image/jpeg")
    resources.tile("bing-satellite", 3, 3, 5)
    assert len(calls) == 2
    with pytest.raises(UserInputError, match="尺寸"):
        resources.tile("google-hybrid-large", 3, 3, 5)
    monkeypatch.setattr(resources, "fetch", lambda url: b"<html>upstream failure</html>")
    with pytest.raises(UserInputError, match="无效图片"):
        resources.tile("google-road", 3, 3, 5)
    assert resources.tiles.db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 2
