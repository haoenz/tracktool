"""KML file inspection and content extraction.

Ports Get-KmlType / Set-KmlType (TrackTags ExtendedData) and Get-KmlContent
(LineString coordinates + stitched description).
"""

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from .. import log
from . import xmlutil


class TrackType(StrEnum):
    """Track category shared by kmlfile/archive/cli; value doubles as collection filename."""

    DEFAULT = "Default"
    TRAIN = "Train"
    FLIGHT = "Flight"
    UNKNOWN = "Unknown"


# 2bulu TrackTags (Chinese activity names) -> category
TAG_TO_TYPE = {
    "默认": TrackType.DEFAULT,
    "徒步": TrackType.DEFAULT,
    "爬山": TrackType.DEFAULT,
    "骑行": TrackType.DEFAULT,
    "驾车": TrackType.DEFAULT,
    "摩托": TrackType.DEFAULT,
    "轮船": TrackType.DEFAULT,
    "散步": TrackType.DEFAULT,
    "飞机": TrackType.FLIGHT,
    "滑翔": TrackType.FLIGHT,
    "轨交": TrackType.TRAIN,
    "缆车": TrackType.TRAIN,
    "地铁": TrackType.TRAIN,
    "火车": TrackType.TRAIN,
}


def get_kml_type(path: Path) -> TrackType:
    """Map the TrackTags ExtendedData value to a TrackType."""
    tree = xmlutil.parse_file(path)
    track_tags = xmlutil.extended_data_value(tree, "TrackTags")
    kml_type = TAG_TO_TYPE.get(track_tags)
    if kml_type is None:
        # set_kml_type 写入的是英文名（如 "Train"），接受它使 set→get 往返成立
        try:
            kml_type = TrackType(track_tags)
        except ValueError:
            kml_type = TrackType.UNKNOWN
    log.debug(f"Detected track type: {kml_type} (tag: {track_tags})", target=str(path))
    return kml_type


def set_kml_type(path: Path, type_: TrackType) -> None:
    """Overwrite the TrackTags ExtendedData value in place."""
    tree = xmlutil.parse_file(path)
    nodes = xmlutil.findall(tree, "/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='TrackTags']/kml:value")
    for node in nodes:
        node.text = type_.value
    xmlutil.save(tree, path)
    log.info(f"Updated track tags to: {type_.value}", target=str(path))


@dataclass
class KmlContent:
    line_string: str
    description: str


def get_kml_content(path: Path) -> KmlContent:
    """Extract LineString coordinates and the stitched description.

    gx:Track coordinates are converted to LineString tuples ("lon lat alt"
    joined by commas). The description combines the source Placemark's
    description (as plain text), TrackTags/PosStartName/PosEndName, and the
    Placemark description again — mirroring the original stitching, which
    relies on Out-String line breaks.
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
    for data_name in ("TrackTags", "PosStartName", "PosEndName"):
        value = xmlutil.extended_data_value(tree, data_name)
        description += f"{data_name}:{value}\n"
    if desc_node is not None:
        description += ("".join(desc_node.itertext()) or "") + "\n"
    log.debug("Extracted track description and metadata", target=str(path))

    return KmlContent(line_string=line_string, description=description)
