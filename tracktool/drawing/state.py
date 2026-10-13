"""The versioned project contract shared by preview, disk files and export."""

import copy
import math
import re
from typing import Any

from ..errors import UserInputError
from .basemaps import BASEMAP_IDS, LEGACY_BASEMAPS, OVERLAYS, PRESETS

SCHEMA = 2
FEATURE_OPTIONS = {
    "places": ("none", "major", "all"),
    "roads": ("none", "major", "all"),
    "road_names": ("none", "major", "all"),
    "boundaries": ("none", "country", "region", "local"),
    "poi": ("none", "major", "all"),
    "buildings": ("none", "all"),
    "housenumbers": ("none", "all"),
    "peaks": ("none", "name", "elevation"),
    "water_names": ("none", "all"),
}
DEFAULT_FEATURES = {key: "none" for key in FEATURE_OPTIONS} | {
    "roads": "all",
    "boundaries": "region",
    "buildings": "all",
}


def overlay_reason(basemap: str, identity: str, active: list[str]) -> str:
    source = OVERLAYS[identity]
    base = PRESETS.get(basemap, {})
    if source["crs"] != base.get("crs", "wgs84"):
        return "坐标系不兼容，尚未实现瓦片重投影"
    if set(source["content"]) & set(base.get("content", [])):
        return "底图已含同类内容，透明图片不能拆分"
    if any(set(source["content"]) & set(OVERLAYS[key]["content"]) for key in active):
        return "已启用同类叠加层"
    return ""


FRAMES = {
    "4:3": (960, 720),
    "3:2": (960, 640),
    "16:9": (960, 540),
    "1:1": (960, 960),
    "3:4": (720, 960),
    "2:3": (640, 960),
}


def default_state(versions: dict) -> dict:
    return {
        "schema": SCHEMA,
        "archive": "",
        "tracks": [],
        "camera": {"center": [105, 35], "zoom": 3.5},
        "style": {
            "basemap": "light",
            "color": "#e05240",
            "width": 3,
            "cities": "county",
            "features": dict(DEFAULT_FEATURES),
            "overlays": [],
            "power": {"min_voltage": 0, "facilities": "all"},
        },
        "frame": {"ratio": "4:3", "width": 960, "height": 720},
        "output": {"width": 1920, "height": 1440},
        "title": "",
        "versions": versions,
    }


def number(value: Any, low: float, high: float) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def validate_state(value: Any) -> dict:
    """Reject invalid projects before opening sources or starting a browser."""
    try:
        value = copy.deepcopy(value)
        if value["schema"] == 1:
            value["schema"] = SCHEMA
            style = value["style"]
            style.setdefault("features", dict(DEFAULT_FEATURES))
            style.setdefault("overlays", [])
            style.setdefault("power", {"min_voltage": 0, "facilities": "all"})
            old = style["basemap"]
            if old in LEGACY_BASEMAPS:
                style["basemap"] = LEGACY_BASEMAPS[old]
                style["overlays"] = [{"id": old, "enabled": True, "opacity": 1}]
                base_name = PRESETS.get(style["basemap"], {}).get("name", "默认浅色")
                value["migration"] = (
                    f"旧透明底图「{PRESETS[old]['name']}」已迁为叠加层，搭配「{base_name}」；轨迹和视野不变。"
                )
        if value["schema"] != SCHEMA:
            raise ValueError("不支持的项目版本")
        if not isinstance(value["archive"], str) or len(value["archive"]) > 4096:
            raise ValueError("归档路径无效")
        tracks = value["tracks"]
        if not isinstance(tracks, list) or len(tracks) > 200:
            raise ValueError("每个项目最多选择 200 条轨迹")
        entries = set()
        for track in tracks:
            if not isinstance(track["entry"], str) or not track["entry"] or len(track["entry"]) > 4096:
                raise ValueError("轨迹引用需要完整 ZIP 路径")
            if track["entry"] in entries or not re.fullmatch(r"[0-9a-f]{64}", track["sha256"]):
                raise ValueError("重复轨迹或无效内容指纹")
            entries.add(track["entry"])
        center = value["camera"]["center"]
        if len(center) != 2 or not number(center[0], -180, 180) or not number(center[1], -85, 85):
            raise ValueError("视野中心必须位于 Web Mercator 有效范围")
        if not number(value["camera"]["zoom"], 0, 18):
            raise ValueError("缩放级别应为 0–18")
        style = value["style"]
        if style["basemap"] not in BASEMAP_IDS or style["cities"] not in ("none", "county"):
            raise ValueError("未知地图样式")
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", style["color"]) or not number(style["width"], 0.5, 12):
            raise ValueError("轨迹颜色或线宽无效")
        if set(style["features"]) != set(FEATURE_OPTIONS) or any(
            style["features"][key] not in options for key, options in FEATURE_OPTIONS.items()
        ):
            raise ValueError("地图要素设置无效")
        overlays = style["overlays"]
        if not isinstance(overlays, list) or len(overlays) > len(OVERLAYS):
            raise ValueError("叠加层列表无效")
        seen: set[str] = set()
        active: list[str] = []
        for overlay in overlays:
            identity = overlay["id"]
            if identity not in OVERLAYS or identity in seen or type(overlay["enabled"]) is not bool:
                raise ValueError("未知或重复叠加层")
            seen.add(identity)
            if not number(overlay["opacity"], 0.1, 1):
                raise ValueError("叠加层透明度应为 0.1–1")
            if overlay["enabled"]:
                reason = overlay_reason(style["basemap"], identity, active)
                if reason:
                    raise ValueError(f"{identity}：{reason}")
                active.append(identity)
        if style["power"]["min_voltage"] not in (0, 110, 220, 500) or style["power"]["facilities"] not in (
            "none",
            "substations",
            "generation",
            "all",
        ):
            raise ValueError("电网过滤设置无效")
        frame = value["frame"]
        if (frame["width"], frame["height"]) != FRAMES[frame["ratio"]]:
            raise ValueError("画框逻辑尺寸与比例不一致")
        width, height = value["output"]["width"], value["output"]["height"]
        if type(width) is not int or type(height) is not int or not (256 <= width <= 4096 and 256 <= height <= 4096):
            raise ValueError("输出宽高应为 256–4096 像素")
        if abs(height - width * frame["height"] / frame["width"]) > 0.51:
            raise ValueError("输出尺寸必须保持画框比例")
        if not isinstance(value["title"], str) or len(value["title"]) > 60 or any(ord(c) < 32 for c in value["title"]):
            raise ValueError("标题最多 60 字，不能包含换行或控制字符")
        if not isinstance(value["versions"], dict):
            raise ValueError("项目缺少资源版本")
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise UserInputError(f"地图项目无效：{exc}") from exc
    return copy.deepcopy(value)
