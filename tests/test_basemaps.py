"""Raster source identities, address adaptation and invalid-resource rejection."""

import hashlib
import json
from io import BytesIO
from string import Formatter
from urllib.parse import parse_qsl, urlsplit

import pytest

from tracktool.drawing.basemaps import (
    BASEMAP_IDS,
    CATALOG,
    LEGACY_BASEMAPS,
    OVERLAYS,
    PRESETS,
    public_presets,
    tile_url,
)
from tracktool.drawing.resources import Resources
from tracktool.drawing.state import default_state, validate_state
from tracktool.errors import UserInputError


def test_all_presets_roundtrip_without_secrets():
    assert len(PRESETS) == len(CATALOG["sources"]) == 34
    for identity in BASEMAP_IDS:
        state = default_state({})
        state["style"]["basemap"] = identity
        assert validate_state(json.loads(json.dumps(state))) == state
    public = json.dumps(public_presets())
    assert "https:" not in public and "apikey" not in public and "tk=" not in public
    assert "opencycle" not in PRESETS


def test_legacy_transparent_basemap_migration_preserves_project():
    for identity, replacement in LEGACY_BASEMAPS.items():
        state = default_state({})
        state["schema"] = 1
        state["style"] = {"basemap": identity, "cities": "county", "color": "#ff7700", "width": 2}
        state["title"] = "旧项目"
        before = json.loads(json.dumps(state))
        migrated = validate_state(state)
        assert state == before
        assert migrated["style"]["basemap"] == replacement
        assert migrated["style"]["overlays"] == [{"id": identity, "enabled": True, "opacity": 1}]
        assert all(migrated[key] == state[key] for key in ("tracks", "camera", "archive", "title", "versions"))
        assert validate_state(migrated) == migrated


@pytest.mark.parametrize(
    "base,overlay",
    [("amap-satellite", "openseamap-seamarks"), ("osm-standard", "tianditu-labels"), ("light", "google-labels")],
)
def test_incompatible_and_duplicate_compositions_rejected(base, overlay):
    state = default_state({})
    state["style"]["basemap"] = base
    state["style"]["overlays"] = [{"id": overlay, "enabled": True, "opacity": 0.5}]
    with pytest.raises(UserInputError):
        validate_state(state)
    state["style"]["overlays"][0]["enabled"] = False
    assert validate_state(state) == state  # Disabled settings are retained for future use.


def test_labelled_basemap_allows_themes_and_checks_theme_conflicts():
    state = default_state({})
    state["style"]["basemap"] = "osm-standard"
    state["style"]["overlays"] = [
        {"id": id, "enabled": True, "opacity": 0.7}
        for id in ("openrailwaymap-standard", "openseamap-seamarks", "openinframap-power")
    ]
    assert validate_state(state) == state
    state["style"]["overlays"].append({"id": "openrailwaymap-gauge", "enabled": True, "opacity": 1})
    with pytest.raises(UserInputError, match="同类"):
        validate_state(state)


def test_catalog_classification_and_empty_thematic_tiles():
    assert len(OVERLAYS) == 13
    assert "roads" in OVERLAYS["tianditu-labels"]["content"]
    assert OVERLAYS["amap-roads"]["content"] == ["roads"]
    Resources._validate("openinframap-power", b"")
    with pytest.raises(UserInputError):
        Resources._validate("vector", b"")
    with pytest.raises(UserInputError):
        Resources._validate("openinframap-power", b"<html>bad gateway</html>")


def test_catalog_templates_are_unique_and_supported():
    templates = set()
    for source in PRESETS.values():
        assert source["crs"] in {"wgs84", "gcj02"}
        assert source["tile_size"] in {256, 512}
        assert 0 < source["maxzoom"] <= 18
        assert source["attribution"]
        fields = {field for _, field, _, _ in Formatter().parse(source["url"]) if field}
        assert fields <= {"x", "y", "z", "quadkey", "galileo", "y_tms", "x16", "y_tms16"}
        url = urlsplit(tile_url(source, 7, 99, 68))
        assert url.scheme == "https" and "{" not in url.geturl()
        canonical = (url.netloc, url.path, tuple(sorted(parse_qsl(url.query))))
        assert canonical not in templates
        templates.add(canonical)


def test_tms_and_tencent_directory_addressing():
    # XYZ y=68 -> TMS y=59 at z=7; folder numbers are floor(x/16), floor(TMS y/16).
    assert "/sateTiles/7/6/3/99_59.jpg" in tile_url(PRESETS["tencent-satellite"], 7, 99, 68)
    assert "/demTiles/7/6/3/99_59.jpg" in tile_url(PRESETS["tencent-terrain"], 7, 99, 68)
    assert "z=7&x=99&y=59" in tile_url(PRESETS["tencent-road"], 7, 99, 68)
    assert "x=99&y=59" in tile_url(PRESETS["360-road"], 7, 99, 68)
    assert "x=99&y=68&z=7" in tile_url(PRESETS["amap-roads"], 7, 99, 68)
    assert "/standard/7/99/68.png" in tile_url(PRESETS["openrailwaymap-standard"], 7, 99, 68)
    assert "/0/0/0_0.jpg" in tile_url(PRESETS["tencent-satellite"], 0, 0, 0)


@pytest.mark.parametrize("identity,invalid_zoom", [("tencent-terrain", 16), ("esri-topo", 14)])
def test_unavailable_native_zoom_is_rejected_before_download(tmp_path, monkeypatch, identity, invalid_zoom):
    resources = Resources(tmp_path)
    monkeypatch.setattr(resources, "fetch", lambda _: pytest.fail("unsupported tile was requested"))
    try:
        with pytest.raises(UserInputError, match="级别"):
            resources.tile(identity, invalid_zoom, 0, 0)
    finally:
        resources.close()


def test_provider_placeholder_is_not_cached(tmp_path, monkeypatch):
    image = pytest.importorskip("PIL.Image", reason="requires optional maps dependencies")
    output = BytesIO()
    image.new("RGB", (256, 256), "grey").save(output, format="JPEG")
    placeholder = output.getvalue()
    monkeypatch.setitem(PRESETS["esri-topo"], "invalid_tile_sha256", [hashlib.sha256(placeholder).hexdigest()])
    resources = Resources(tmp_path)
    monkeypatch.setattr(resources, "fetch", lambda _: placeholder)
    try:
        with pytest.raises(UserInputError, match="占位图片"):
            resources.tile("esri-topo", 12, 3372, 1552)
        assert resources.tiles.db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 0
    finally:
        resources.close()


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
