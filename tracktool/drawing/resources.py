"""Versioned local assets and a bounded, on-demand tile cache."""

import hashlib
import json
import os
import threading
import time
from importlib.metadata import version
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

import requests

from ..errors import UserInputError
from .basemaps import CATALOG_PATH, PRESETS, public_presets, tile_url

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
ATTRIBUTION = "OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"


class Resources:
    def __init__(self, cache: Path) -> None:
        self.cache = cache
        self.cache.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.downloads = threading.BoundedSemaphore(6)
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

    @staticmethod
    def fetch(url: str) -> bytes:
        if urlparse(url).scheme != "https":
            raise UserInputError("地图数据源必须使用 HTTPS")
        try:
            with requests.get(
                url,
                timeout=(10, 30),
                stream=True,
                headers={"User-Agent": "tracktool-map/1.0 (local interactive map editor)"},
            ) as response:
                response.raise_for_status()
                if 300 <= response.status_code < 400:
                    raise UserInputError("地图服务要求重定向；为避免转发地图凭据，本次请求已停止")
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data.extend(chunk)
                    if len(data) > 16 * 1024 * 1024:
                        raise UserInputError("地图资源超过单文件 16 MiB 限制")
                return bytes(data)
        except requests.HTTPError as exc:
            code = exc.response.status_code if exc.response is not None else "未知"
            raise UserInputError(f"地图服务返回 HTTP {code}；请重试或更换底图") from None
        except requests.RequestException as exc:
            # Do not leak credential-bearing satellite URLs into logs/projects.
            raise UserInputError(f"地图资源下载失败（{type(exc).__name__}），检查网络和数据源配置后重试") from exc

    def prepare(self, refresh: bool = False) -> None:
        with self.lock:
            for name, info in self.assets["files"].items():
                path = ROOT / name
                if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != info["sha256"]:
                    raise UserInputError(f"前端或字体文件缺失/校验失败：{name}；请重新安装 tracktool")
            metadata = self.cache / "basemap.json"
            if refresh or not metadata.exists():
                url = os.environ.get("TRACKTOOL_MAP_TILEJSON", "https://tiles.openfreemap.org/planet")
                value = json.loads(self.fetch(url))
                if not value.get("tiles") or not value.get("vector_layers"):
                    raise UserInputError("底图 TileJSON 必须符合 OpenMapTiles 矢量 schema")
                self._atomic(metadata, json.dumps(value).encode())
            self.vector = json.loads(metadata.read_text())

    @staticmethod
    def _atomic(path: Path, data: bytes) -> None:
        temporary = path.with_suffix(f".{threading.get_ident()}.tmp")
        temporary.write_bytes(data)
        temporary.replace(path)

    def versions(self) -> dict:
        templates = self.vector.get("tiles", [])
        return {
            "renderer": "tracktool-map-v1",
            "renderer_sha256": hashlib.sha256(
                b"".join(
                    (STATIC / name).read_bytes()
                    for name in ("core.js", "styles.js", "coordinates.js", "render.js", "style.css", "fonts.css")
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
                "templates": [u if urlparse(u).netloc == "tiles.openfreemap.org" else "custom" for u in templates],
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

    def tile(self, source: str, z: int, x: int, y: int) -> tuple[bytes, str]:
        if source not in {"vector", "satellite", *PRESETS} or not (0 <= z <= 18 and 0 <= x < 2**z and 0 <= y < 2**z):
            raise UserInputError("无效瓦片坐标")
        if source in PRESETS:
            if z > PRESETS[source]["maxzoom"]:
                raise UserInputError("地图源不支持该瓦片级别")
            url = tile_url(PRESETS[source], z, x, y)
        else:
            template = self.vector["tiles"][0] if source == "vector" else self.satellite
            if not template:
                raise UserInputError("卫星底图尚未配置")
            url = template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
        identity = hashlib.sha256((self.satellite_version + url).encode()).hexdigest()
        path = self.cache / f"{identity}.tile"
        # Lock per cache lookup/write, never hold it over network requests.
        with self.lock:
            if path.exists():
                data = path.read_bytes()
                os.utime(path, None)
                return data, self._mime(source, data)
        with self.downloads:
            data = self.fetch(url)
        if not data:
            raise UserInputError("数据源返回空瓦片")
        if source != "vector":
            from PIL import Image

            try:
                with Image.open(BytesIO(data)) as raster:
                    expected = PRESETS[source]["tile_size"] if source in PRESETS else 256
                    if raster.format not in ("PNG", "JPEG", "WEBP") or raster.size != (expected, expected):
                        raise ValueError("unexpected tile dimensions or format")
                    raster.verify()
            except (OSError, ValueError) as exc:
                raise UserInputError("地图源返回无效图片或错误瓦片尺寸，不能导出；请更换底图") from exc
        with self.lock:
            self._atomic(path, data)
            files = list(self.cache.glob("*.tile"))
            sizes = [(p.stat().st_mtime, p.stat().st_size, p) for p in files]
            total = sum(size for _, size, _ in sizes)
            for _, size, old in sorted(sizes):
                if total <= 256 * 1024 * 1024:
                    break
                old.unlink(missing_ok=True)
                total -= size
        return data, self._mime(source, data)

    @staticmethod
    def _mime(source: str, data: bytes) -> str:
        if source == "vector":
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
            "basemaps": public_presets(),
            "attribution": ATTRIBUTION,
            "customVectorAttribution": self.vector_credit,
            "satelliteAttribution": self.satellite_credit,
            "cityAttribution": "GeoNames · CC BY 4.0",
            "cityCoverage": self.cities["coverage"],
            "cacheTime": int(time.time()),
        }
