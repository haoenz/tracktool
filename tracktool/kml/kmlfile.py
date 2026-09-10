"""KML file inspection and content extraction.

Ports Get-KmlType / Set-KmlType (TrackTags ExtendedData) and Get-KmlContent
(LineString coordinates + stitched description).
"""

from dataclasses import dataclass
from pathlib import Path

from .. import log
from . import xmlutil

# 2bulu TrackTags (Chinese activity names) -> category
TAG_TO_TYPE = {
    "默认": "Default",
    "徒步": "Default",
    "爬山": "Default",
    "骑行": "Default",
    "驾车": "Default",
    "摩托": "Default",
    "轮船": "Default",
    "散步": "Default",
    "飞机": "Flight",
    "滑翔": "Flight",
    "轨交": "Train",
    "缆车": "Train",
    "地铁": "Train",
    "火车": "Train",
}


def get_kml_type(path: Path) -> str:
    """Map the TrackTags ExtendedData value to Default/Flight/Train/Unknown."""
    tree = xmlutil.parse_file(path)
    track_tags = xmlutil.extended_data_value(tree, "TrackTags")
    kml_type = TAG_TO_TYPE.get(track_tags, "Unknown")
    log.debug(f"Detected track type: {kml_type} (tag: {track_tags})", target=str(path))
    return kml_type


def set_kml_type(path: Path, type_: str) -> None:
    """Overwrite the TrackTags ExtendedData value in place."""
    tree = xmlutil.parse_file(path)
    nodes = xmlutil.findall(tree, "/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='TrackTags']/kml:value")
    for node in nodes:
        node.text = type_
    xmlutil.save(tree, path)
    log.info(f"Updated track tags to: {type_}", target=str(path))


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
