"""KML file inspection and content extraction.

A KML's type comes from its TrackTags ExtendedData value (a 2bulu export
records the activity in Chinese); its content is the LineString coordinates —
gx:Track coords converted to LineString tuples — plus a stitched description.
"""

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from .. import log
from ..errors import UserInputError
from ..fileutil import BatchResult, FileFailure, run_per_file
from ..tags import POS_END_NAME, POS_START_NAME, TRACK_TAGS
from . import xmlutil

# 写入与读取共用的一条 XPath：TrackTags 的 value 节点住在哪儿，读写就得一致
TRACK_TAGS_NODE = f"/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='{TRACK_TAGS}']/kml:value"


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
    return kind_from_tree(xmlutil.parse_file(path), str(path))


def kind_from_tree(tree: xmlutil.etree._ElementTree, target: str = "") -> TrackKind | None:
    """The same mapping for an already-parsed document — what rebuild reads from the ZIP."""
    track_tags = xmlutil.extended_data_value(tree, TRACK_TAGS)
    kind = TAG_TO_KIND.get(track_tags)
    if kind is None:
        # set_kml_type 写入的是英文名（如 "Train"），接受它使 set→get 往返成立
        try:
            kind = TrackKind(track_tags)
        except ValueError:
            kind = None
    log.debug(f"Detected track type: {kind} (tag: {track_tags})", target=target or None)
    return kind


def _create_track_tags(tree: xmlutil.etree._ElementTree) -> xmlutil.etree._Element:
    """Add Document/ExtendedData/Data[@name='TrackTags']/value; return the value node.

    ExtendedData goes right after <name> — where 2bulu exports and the files
    our own splitter writes keep it — and first when there is no <name>. The
    node lands exactly where TRACK_TAGS_NODE looks for it, so the value written
    into it reads back at once, and an ExtendedData that is already there keeps
    its other Data children.
    """
    ns = xmlutil.doc_ns(tree)
    document = xmlutil.find(tree, "/kml:kml/kml:Document")
    if document is None:
        raise UserInputError("No kml:Document element to add TrackTags to")
    extended = xmlutil.find(tree, "/kml:kml/kml:Document/kml:ExtendedData")
    if extended is None:
        extended = xmlutil.etree.Element(f"{{{ns}}}ExtendedData")
        document.insert(1 if document.find(f"{{{ns}}}name") is not None else 0, extended)
    data = xmlutil.etree.SubElement(extended, f"{{{ns}}}Data", name=TRACK_TAGS)
    return xmlutil.etree.SubElement(data, f"{{{ns}}}value")


def set_kml_type(path: Path, kind: TrackKind, create_tag: bool = False) -> bool:
    """Overwrite the TrackTags ExtendedData value in place.

    False means the document holds no TrackTags value to overwrite — a derived
    file (split, merge, hand-drawn) rather than one 2bulu exported — and
    `create_tag` was not asked for. Saying so keeps a batch's success count
    honest: rewriting such a file changes nothing, so claiming "updated" would
    be a lie with a log line to back it up.
    """
    tree = xmlutil.parse_file(path)
    nodes = xmlutil.findall(tree, TRACK_TAGS_NODE)
    created = not nodes
    if created:
        if not create_tag:
            return False
        nodes = [_create_track_tags(tree)]
    for node in nodes:
        node.text = kind.value
    done = f"Created TrackTags: {kind.value}" if created else f"Updated track tags to: {kind.value}"
    plan = f"Would create TrackTags: {kind.value}" if created else f"Would set track tags to: {kind.value}"
    if xmlutil.save(tree, path):
        log.info(done, target=str(path))
    else:
        # save 只在 PLAN 下返回 False：预演要说出这一批会改成什么，而不只是"会写"
        log.info(plan, target=str(path))
    return True


def set_kml_types(paths: list[Path], kind: TrackKind, create_tag: bool = False) -> BatchResult[None]:
    """Set the track type on every KML of a batch.

    The CLI expands the wildcards and hands the list over as one table, so each
    file is an entry of the same batch: a file that cannot be read and a file
    that carries no TrackTags value are logged and counted rather than aborting
    the rest. Files the user named are processed whatever they are — pointing
    at one is the stronger statement than an extension, and a non-KML fails at
    the parse, per file, with its own reason. `create_tag` is the only way a
    missing node is written: a derived file is never retagged behind the user's
    back, it is reported and the option adds it.
    """

    def process(path: Path) -> None:
        try:
            updated = set_kml_type(path, kind, create_tag)
        except UserInputError as exc:
            log.error(str(exc), target=str(path))
            raise FileFailure(str(exc), quarantine=False) from exc
        if not updated:
            reason = "No TrackTags node to overwrite (pass --create-tag to add one)"
            log.error(reason, target=str(path))
            raise FileFailure(reason, quarantine=False)

    return run_per_file(paths, process, activity="Setting track type")


@dataclass
class KmlContent:
    line_string: str
    description: str


def get_kml_content(path: Path) -> KmlContent:
    """Extract LineString coordinates and the stitched description from a KML file.

    gx:Track coordinates are converted to LineString tuples ("lon lat alt"
    joined by commas). The description combines the source Placemark's
    description (as plain text), TrackTags/PosStartName/PosEndName, and the
    Placemark description again, separated by line breaks.
    """
    return content_from_tree(xmlutil.parse_file(path), str(path))


def content_from_tree(tree: xmlutil.etree._ElementTree, target: str = "") -> KmlContent:
    """The same extraction for an already-parsed document — what rebuild reads from the ZIP."""
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
    log.debug("Extracted LineString coordinates", target=target or None)

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
    log.debug("Extracted track description and metadata", target=target or None)

    return KmlContent(line_string=line_string, description=description)
