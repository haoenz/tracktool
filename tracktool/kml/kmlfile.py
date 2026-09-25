"""KML file inspection and content extraction.

A KML's type comes from its TrackTags ExtendedData value (a 2bulu export
records the activity in Chinese); its content is the LineString coordinates —
gx:Track coords converted to LineString tuples — plus a stitched description.
"""

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from .. import log
from ..tags import POS_END_NAME, POS_START_NAME, TRACK_TAGS
from . import xmlutil


class TrackKind(StrEnum):
    """Track category: doubles as the collection file name and the --type domain.

    Recognition results are not a kind: `get_kml_type` returns None when it
    cannot recognize a file, instead of an UNKNOWN member that could be filed
    into an `Unknown.kml` collection.
    """

    DEFAULT = "Default"
    TRAIN = "Train"
    FLIGHT = "Flight"


# 2bulu TrackTags (Chinese activity names) -> category
TAG_TO_KIND = {
    "默认": TrackKind.DEFAULT,
    "徒步": TrackKind.DEFAULT,
    "爬山": TrackKind.DEFAULT,
    "骑行": TrackKind.DEFAULT,
    "驾车": TrackKind.DEFAULT,
    "摩托": TrackKind.DEFAULT,
    "轮船": TrackKind.DEFAULT,
    "散步": TrackKind.DEFAULT,
    "飞机": TrackKind.FLIGHT,
    "滑翔": TrackKind.FLIGHT,
    "轨交": TrackKind.TRAIN,
    "缆车": TrackKind.TRAIN,
    "地铁": TrackKind.TRAIN,
    "火车": TrackKind.TRAIN,
}


def get_kml_type(path: Path) -> TrackKind | None:
    """Map the TrackTags ExtendedData value to a TrackKind; None when unrecognized."""
    tree = xmlutil.parse_file(path)
    track_tags = xmlutil.extended_data_value(tree, TRACK_TAGS)
    kind = TAG_TO_KIND.get(track_tags)
    if kind is None:
        # set_kml_type 写入的是英文名（如 "Train"），接受它使 set→get 往返成立
        try:
            kind = TrackKind(track_tags)
        except ValueError:
            kind = None
    log.debug(f"Detected track type: {kind} (tag: {track_tags})", target=str(path))
    return kind


def set_kml_type(path: Path, kind: TrackKind) -> None:
    """Overwrite the TrackTags ExtendedData value in place."""
    tree = xmlutil.parse_file(path)
    nodes = xmlutil.findall(
        tree, f"/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='{TRACK_TAGS}']/kml:value")
    for node in nodes:
        node.text = kind.value
    if xmlutil.save(tree, path):
        log.info(f"Updated track tags to: {kind.value}", target=str(path))


@dataclass
class KmlContent:
    line_string: str
    description: str


def get_kml_content(path: Path) -> KmlContent:
    """Extract LineString coordinates and the stitched description.

    gx:Track coordinates are converted to LineString tuples ("lon lat alt"
    joined by commas). The description combines the source Placemark's
    description (as plain text), TrackTags/PosStartName/PosEndName, and the
    Placemark description again, separated by line breaks.
    """
    tree = xmlutil.parse_file(path)

    line_string = ""
    for placemark in xmlutil.findall(tree, "//kml:Placemark"):
        # coordinates directly under this Placemark's LineString
        ls_node = placemark.find(f"{{{xmlutil.doc_ns(tree)}}}LineString/{{{xmlutil.doc_ns(tree)}}}coordinates")
        if ls_node is not None and (ls_node.text or "").strip():
            line_string = " ".join(part for part in (line_string, (ls_node.text or "").strip()) if part)
        else:
            # 将带时间信息的 gx:Track 转换为不带时间信息的 LineString
            for coord in placemark.iter(f"{{{xmlutil.GX_NS}}}coord"):
                if (coord.text or "").strip():
                    line_string = " ".join(
                        part for part in (line_string, (coord.text or "").strip().replace(" ", ",")) if part
                    )
    log.debug("Extracted LineString coordinates", target=str(path))

    description = ""
    desc_node = xmlutil.find(tree, "/kml:kml/kml:Document/kml:Folder/kml:Placemark/kml:description")
    if desc_node is not None:
        # 将一些以 div 标签形式记录的 Track 属性打包放进 Description
        for div in desc_node:
            description += (div.itertext() and "".join(div.itertext()) or "") + "\n"
    for data_name in (TRACK_TAGS, POS_START_NAME, POS_END_NAME):
        value = xmlutil.extended_data_value(tree, data_name)
        description += f"{data_name}:{value}\n"
    if desc_node is not None:
        description += ("".join(desc_node.itertext()) or "") + "\n"
    log.debug("Extracted track description and metadata", target=str(path))

    return KmlContent(line_string=line_string, description=description)
