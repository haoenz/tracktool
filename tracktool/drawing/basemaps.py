"""Reviewed base maps and overlays, including the user's Ovital QR presets.

No QR parsing or arbitrary expression evaluation occurs at runtime.
"""

import json
from pathlib import Path

CATALOG_PATH = Path(__file__).parent / "data/basemaps.json"
CATALOG = json.loads(CATALOG_PATH.read_text())
PRESETS = {source["id"]: source for source in CATALOG["sources"]}
OVERLAYS = {key: source for key, source in PRESETS.items() if source["kind"] == "overlay"}
BASEMAP_IDS = {"light", "dark", "satellite", *(PRESETS.keys() - OVERLAYS.keys())}
LEGACY_BASEMAPS = {
    "amap-labels": "amap-satellite",
    "amap-roads": "amap-satellite",
    "google-labels": "google-satellite",
    "google-labels-large": "google-satellite",
    "tencent-labels": "tencent-satellite",
    "tianditu-labels": "esri-satellite",
    "openrailwaymap-standard": "light",
}


def tile_url(source: dict, z: int, x: int, y: int) -> str:
    """MapLibre already accounts for 256/512px tile zoom and addressing."""
    quadkey = "".join(str(((x >> i) & 1) + 2 * ((y >> i) & 1)) for i in range(z - 1, -1, -1))
    inverted = (1 << z) - 1 - y
    return source["url"].format(
        x=x,
        y=y,
        z=z,
        quadkey=quadkey,
        galileo="Galileo"[: (3 * x + y) % 8],
        y_tms=inverted,
        x16=x // 16,
        y_tms16=inverted // 16,
    )


def public_presets() -> list[dict]:
    return [
        {
            **{
                key: source[key]
                for key in (
                    "id",
                    "name",
                    "group",
                    "tile_size",
                    "tile_display_size",
                    "maxzoom",
                    "crs",
                    "imagery",
                    "has_text",
                    "overlay_only",
                    "attribution",
                    "kind",
                    "format",
                    "content",
                    "minzoom",
                    "scheme",
                    "addressing",
                    "coverage",
                    "content_note",
                )
            },
            "available": True,
            "category": source.get("category", "base"),
        }
        for source in PRESETS.values()
    ]
