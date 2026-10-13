"""Fixed, reviewed raster presets decoded from the user's Ovital QR sheet.

No QR parsing or arbitrary template evaluation occurs at runtime. Only verified, credential-free presets are offered.
"""

import json
from pathlib import Path

CATALOG_PATH = Path(__file__).parent / "data/basemaps.json"
CATALOG = json.loads(CATALOG_PATH.read_text())
PRESETS = {source["id"]: source for source in CATALOG["sources"]}
BASEMAP_IDS = {"light", "dark", "satellite", *PRESETS}


def tile_url(source: dict, z: int, x: int, y: int) -> str:
    """MapLibre already accounts for 256/512px tile zoom and addressing."""
    quadkey = "".join(str(((x >> i) & 1) + 2 * ((y >> i) & 1)) for i in range(z - 1, -1, -1))
    return source["url"].format(x=x, y=y, z=z, quadkey=quadkey, galileo="Galileo"[: (3 * x + y) % 8])


def public_presets() -> list[dict]:
    return [
        {
            **{
                key: source[key]
                for key in (
                    "id",
                    "name",
                    "tile_size",
                    "maxzoom",
                    "crs",
                    "imagery",
                    "has_text",
                    "overlay_only",
                    "attribution",
                )
            },
            "available": True,
        }
        for source in PRESETS.values()
    ]
