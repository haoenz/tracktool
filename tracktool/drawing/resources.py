"""Versioned local assets and a bounded, on-demand tile cache."""

import hashlib
import json
import os
import tempfile
import threading
import time
from collections.abc import Callable
from importlib.metadata import version
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from ..errors import UserInputError
from .basemaps import CATALOG_PATH, PRESETS, public_presets, tile_url
from .downloads import Downloads
from .tilecache import TileCache
from .transport import Transport

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
ATTRIBUTION = "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"


class Resources:
    def __init__(self, cache: Path) -> None:
        self.cache = cache
        self.cache.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.cities = json.loads((ROOT / "data/cities-cn.json").read_text())
        self.assets = json.loads((ROOT / "data/assets.json").read_text())
        self.vector: dict = {}
        self.vector_credit = os.environ.get("TRACKTOOL_MAP_VECTOR_ATTRIBUTION", "")
        if os.environ.get("TRACKTOOL_MAP_TILEJSON") and not self.vector_credit:
            raise UserInputError("自定义矢量源需配置 TRACKTOOL_MAP_VECTOR_ATTRIBUTION 以保留实际来源署名")
        self.satellite = os.environ.get("TRACKTOOL_MAP_SATELLITE_URL", "")
        self.satellite_credit = os.environ.get("TRACKTOOL_MAP_SATELLITE_ATTRIBUTION", "")
        self.satellite_version = os.environ.get("TRACKTOOL_MAP_SATELLITE_VERSION", "")
        if self.satellite and not (self.satellite_credit and self.satellite_version):
            raise UserInputError("卫星数据源需同时配置 URL、ATTRIBUTION 和 VERSION")
        self._cmap: set[int] | None = None

        def setting(name: str, default: int, low: int, high: int) -> int:
            try:
                value = int(os.environ.get(name, default))
                if not low <= value <= high:
                    raise ValueError()
                return value
            except ValueError:
                raise UserInputError(f"{name} 需为 {low}–{high} 的整数") from None

        concurrency = setting("TRACKTOOL_MAP_DOWNLOADS", 8, 1, 32)
        capacity = setting("TRACKTOOL_MAP_CACHE_MIB", 1024, 1, 16384) * 1024 * 1024
        limits = {
            "google": 8,
            "bing": 4,
            "vector": 6,
            "custom": 4,
            "openrailwaymap": 2,
            "openseamap": 2,
            "openinframap": 2,
        }
        try:
            configured = json.loads(os.environ.get("TRACKTOOL_MAP_PROVIDER_LIMITS", "{}"))
            if not isinstance(configured, dict) or any(
                k not in limits or type(v) is not int or not 1 <= v <= 32 for k, v in configured.items()
            ):
                raise ValueError()
            limits.update(configured)
        except ValueError, TypeError:
            raise UserInputError(
                "TRACKTOOL_MAP_PROVIDER_LIMITS 需为已知提供方到 1–32 整数的 JSON，"
                "专题提供方为 openrailwaymap/openseamap/openinframap"
            ) from None
        self.tiles = TileCache(cache, capacity)
        self.transport = Transport(concurrency)
        self.downloads = Downloads(concurrency, limits)
        self.closed = False

    def fetch(self, url: str) -> bytes:
        return self.transport.fetch(url)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.downloads.close()
        self.transport.close()
        self.tiles.close()

    def prepare(self, refresh: bool = False) -> None:
        with self.lock:
            for name, info in self.assets["files"].items():
                path = ROOT / name
                if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != info["sha256"]:
                    raise UserInputError(f"前端或字体文件缺失/校验失败：{name}；请重新安装 tracktool")
            url = os.environ.get("TRACKTOOL_MAP_TILEJSON", "https://tiles.openfreemap.org/planet")
            metadata = self.cache / ("basemap-" + hashlib.sha256(url.encode()).hexdigest() + ".json")
            legacy = self.cache / "basemap.json"
            if not metadata.exists() and legacy.exists() and not os.environ.get("TRACKTOOL_MAP_TILEJSON"):
                value = json.loads(legacy.read_text())
                if all(urlparse(u).netloc == "tiles.openfreemap.org" for u in value.get("tiles", [])):
                    self._atomic(metadata, legacy.read_bytes())
            if refresh or not metadata.exists():
                value = json.loads(self.fetch(url))
                if not value.get("tiles") or not value.get("vector_layers"):
                    raise UserInputError("底图 TileJSON 必须符合 OpenMapTiles 矢量 schema")
                self._atomic(metadata, json.dumps(value).encode())
            self.vector = json.loads(metadata.read_text())
            layers = {layer["id"] for layer in self.vector.get("vector_layers", [])}
            if not {"transportation", "water", "landcover"} <= layers:
                raise UserInputError("需要 OpenMapTiles schema；Shortbread 不能直接替换，尚无适配器")

    @staticmethod
    def _atomic(path: Path, data: bytes) -> None:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name, suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            try:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def versions(self) -> dict:
        templates = self.vector.get("tiles", [])
        return {
            "renderer": "tracktool-map-v1",
            "renderer_sha256": hashlib.sha256(
                b"".join(
                    (STATIC / name).read_bytes()
                    for name in (
                        "core.js",
                        "styles.js",
                        "layers.js",
                        "coordinates.js",
                        "render.js",
                        "style.css",
                        "fonts.css",
                    )
                )
            ).hexdigest(),
            "playwright": version("playwright"),
            "maplibre": self.assets["maplibre"],
            "gcoord": self.assets["gcoord"],
            "basemap_presets_sha256": hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest(),
            "font": self.assets["font"],
            "font_sha256": self.assets["files"]["static/vendor/NotoSansCJKsc-Regular.otf"]["sha256"],
            "cities_sha256": hashlib.sha256((ROOT / "data/cities-cn.json").read_bytes()).hexdigest(),
            "basemap": {
                "templates": [
                    u
                    if urlparse(u).netloc == "tiles.openfreemap.org"
                    and not urlparse(u).query
                    and not urlparse(u).fragment
                    else "custom"
                    for u in templates
                ],
                "sha256": hashlib.sha256(json.dumps(templates).encode()).hexdigest(),
            },
            "satellite": self.satellite_version,
            "satellite_sha256": hashlib.sha256(self.satellite.encode()).hexdigest() if self.satellite else "",
            "vector_attribution": self.vector_credit or ATTRIBUTION,
            "satellite_attribution": self.satellite_credit,
        }

    def check_text(self, text: str) -> None:
        if self._cmap is None:
            from fontTools.ttLib import TTFont

            with TTFont(STATIC / "vendor/NotoSansCJKsc-Regular.otf") as font:
                self._cmap = set(font.getBestCmap() or {})
        missing = sorted({c for c in text if not c.isspace() and ord(c) not in self._cmap})
        if missing:
            raise UserInputError(f"固定字体缺少字符：{''.join(missing[:20])}；请修改标题，不能用缺字方框导出")

    def glyph(self, span: str, *, cancelled=lambda: False, export: bool = False) -> bytes:
        """One fixed public font, bounded ranges, shared scheduler and disk LRU."""
        try:
            start, end = map(int, span.split("-"))
            if start % 256 or end != start + 255 or not 0 <= start <= 65280:
                raise ValueError()
        except ValueError:
            raise UserInputError("无效字体范围") from None
        url = f"https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/{span}.pbf"
        key = hashlib.sha256(("glyph-v1:" + url).encode()).hexdigest()

        def download():
            cached = self.tiles.get(key)
            if cached is not None:
                return cached
            data = self.fetch(url)
            if not data.startswith(b"\x0a"):
                raise UserInputError("地图字体返回无效数据")
            self.tiles.put(key, data)
            return data

        return self.downloads.load(key, "vector", download, cancelled, export)

    def tile(
        self,
        source: str,
        z: int,
        x: int,
        y: int,
        *,
        cancelled: Callable[[], bool] = lambda: False,
        export: bool = False,
    ) -> tuple[bytes, str]:
        if source not in {"vector", "satellite", *PRESETS} or not (0 <= z <= 18 and 0 <= x < 2**z and 0 <= y < 2**z):
            raise UserInputError("无效瓦片坐标")
        if source in PRESETS:
            if not PRESETS[source].get("minzoom", 0) <= z <= PRESETS[source]["maxzoom"]:
                raise UserInputError("地图源不支持该瓦片级别")
            url = tile_url(PRESETS[source], z, x, y)
        else:
            template = self.vector["tiles"][0] if source == "vector" else self.satellite
            if not template:
                raise UserInputError("卫星底图尚未配置")
            url = template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
        expected = PRESETS[source]["tile_size"] if source in PRESETS else 256
        identity = hashlib.sha256(
            json.dumps(
                [
                    "tile-v2",
                    source,
                    url,
                    expected,
                    PRESETS[source]
                    if source in PRESETS
                    else self.vector
                    if source == "vector"
                    else self.satellite_version,
                ],
                sort_keys=True,
            ).encode()
        ).hexdigest()
        legacy = hashlib.sha256((self.satellite_version + url).encode()).hexdigest()

        def cached() -> bytes | None:
            data = self.tiles.get(identity)
            if data is not None:
                try:
                    self._validate(source, data)
                    return data
                except UserInputError:
                    self.tiles.delete(identity)
            old = self.tiles.get("legacy:" + legacy)
            if old is not None:
                try:
                    self._validate(source, old)
                    self.tiles.put(identity, old)
                    return old
                except UserInputError:
                    pass
                finally:
                    self.tiles.delete("legacy:" + legacy)
            return None

        data = cached()
        if data is None:

            def download() -> bytes:
                # A preceding flight/process may have filled the cache while queued.
                hit = cached()
                if hit is not None:
                    return hit
                result = self.fetch(url)
                self._validate(source, result)
                self.tiles.put(identity, result)
                return result

            provider = source.split("-")[0] if source in PRESETS else "vector" if source == "vector" else "custom"
            data = self.downloads.load(identity, provider, download, cancelled, export)
        return data, self._mime(source, data)

    @staticmethod
    def _validate(source: str, data: bytes) -> None:
        # Tegola's documented empty MVT is a zero-layer protobuf (zero bytes).
        # Only this verified thematic service gets this exception, never HTTP errors.
        if not data and source == "openinframap-power":
            return
        if not data:
            raise UserInputError("数据源返回空瓦片")
        if hashlib.sha256(data).hexdigest() in PRESETS.get(source, {}).get("invalid_tile_sha256", []):
            raise UserInputError("地图源返回暂无地图的占位图片，不能导出；请更换底图")
        if source == "vector" or PRESETS.get(source, {}).get("format") == "vector":
            # Validate protobuf wire bounds and the MVT layer envelope before caching.
            # MapLibre performs full geometry decoding and export rejects its errors.
            def fields(payload: bytes):
                i = 0

                def varint():
                    nonlocal i
                    result = 0
                    for shift in range(0, 70, 7):
                        byte = payload[i]
                        i += 1
                        result |= (byte & 127) << shift
                        if byte < 128:
                            return result
                    raise ValueError()

                while i < len(payload):
                    tag = varint()
                    if tag >> 3 == 0:
                        raise ValueError()
                    wire = tag & 7
                    if wire == 0:
                        value = varint()
                    elif wire in (1, 2, 5):
                        length = varint() if wire == 2 else 8 if wire == 1 else 4
                        if i + length > len(payload):
                            raise ValueError()
                        value = payload[i : i + length]
                        i += length
                    else:
                        raise ValueError()
                    yield tag >> 3, value

            try:
                layers = [v for k, v in fields(data) if k == 3]
                if not layers:
                    raise ValueError()
                for layer in layers:
                    values = dict(fields(layer))
                    if not isinstance(values.get(1), bytes) or values.get(15) not in (1, 2):
                        raise ValueError()
                    values[1].decode("utf-8")
            except ValueError, IndexError, TypeError, UnicodeError:
                raise UserInputError("地图源返回无效矢量瓦片，请重试或更换底图") from None
            return
        from PIL import Image

        try:
            with Image.open(BytesIO(data)) as raster:
                expected = PRESETS[source]["tile_size"] if source in PRESETS else 256
                if raster.format not in ("PNG", "JPEG", "WEBP") or raster.size != (expected, expected):
                    raise ValueError("unexpected tile dimensions or format")
                raster.verify()
        except (OSError, ValueError) as exc:
            raise UserInputError("地图源返回无效图片或错误瓦片尺寸，不能导出；请更换底图") from exc

    @staticmethod
    def _mime(source: str, data: bytes) -> str:
        if source == "vector" or PRESETS.get(source, {}).get("format") == "vector":
            return "application/x-protobuf"
        if data.startswith(b"\xff\xd8"):
            return "image/jpeg"
        if data.startswith(b"RIFF"):
            return "image/webp"
        return "image/png"

    def public_config(self) -> dict:
        return {
            "versions": self.versions(),
            "vectorMaxZoom": min(14, self.vector.get("maxzoom", 14)),
            "satellite": bool(self.satellite),
            "basemaps": [s for s in public_presets() if s["kind"] == "basemap"],
            "overlays": [s for s in public_presets() if s["kind"] == "overlay"],
            "vectorLayers": {s["id"]: s.get("fields", {}) for s in self.vector.get("vector_layers", [])},
            "attribution": ATTRIBUTION,
            "customVectorAttribution": self.vector_credit,
            "satelliteAttribution": self.satellite_credit,
            "cityAttribution": "GeoNames · CC BY 4.0",
            "cityCoverage": self.cities["coverage"],
            "cacheTime": int(time.time()),
        }
