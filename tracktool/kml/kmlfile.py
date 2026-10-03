"""KML file inspection and content extraction.

A KML records what a track *is* in one ExtendedData value, TrackTags: a 2bulu
activity name (徒步, 地铁). The archive's category — the collection file name,
the ZIP entry's folder — is derived from that, never stored beside it, and the
table saying which activity belongs to which category is the user's, so it
lives in the config (`track_tag.*`) and reaches this module as a `tag_map`
argument. A caller that has no Config — a test, a library user — falls back to
the built-in table, which is the same data `config.DEFAULTS` holds, read the
other way round.

A KML's content is the LineString coordinates — gx:Track coords converted to
LineString tuples — plus a stitched description.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from .. import log
from ..config import DEFAULTS, TRACK_TAG_PREFIX
from ..errors import UserInputError
from ..fileutil import BatchResult, FileFailure, run_per_file
from ..tags import POS_END_NAME, POS_START_NAME, TRACK_TAGS
from . import xmlutil

# 写入与读取共用的一条 XPath：TrackTags 的 value 节点住在哪儿，读写就得一致
TRACK_TAGS_NODE = f"/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='{TRACK_TAGS}']/kml:value"


class TrackKind(StrEnum):
    """Track category: doubles as the collection file name and the --type domain.

    A category is not something TrackTags holds — writing one there puts a word
    from the archive's layout into the track's own data — and it is not a
    recognition result either: `get_kml_type` returns None when it cannot
    recognize a file, instead of an UNKNOWN member that could be filed into an
    `Unknown.kml` collection.
    """

    DEFAULT = "Default"
    TRAIN = "Train"
    FLIGHT = "Flight"


# 活动名 -> 类别，从 config 的 `track_tag.*` 默认值反转而来。生产路径走
# `Config.track_tag_map`（用户可能增补过活动名），这一份服务没有 Config 的调用者：
# 两边是同一张表的两个方向，不是两张表。
DEFAULT_TAG_MAP: dict[str, str] = {
    activity: key[len(TRACK_TAG_PREFIX) :]
    for key, activities in DEFAULTS.items()
    if key.startswith(TRACK_TAG_PREFIX)
    for activity in activities
}

# 类别名 -> 成员。查表而不是构造 TrackKind：一张手填的表里若出现不存在的类别名，
# 那条轨迹只是认不出来，不该让整次运行崩在 ValueError 上。
_KIND_BY_NAME = {kind.value: kind for kind in TrackKind}


def tag_map_for(tag_map: Mapping[str, str] | None) -> Mapping[str, str]:
    """The caller's table, or the built-in one when nobody handed one over."""
    return DEFAULT_TAG_MAP if tag_map is None else tag_map


def get_kml_type(path: Path, *, tag_map: Mapping[str, str] | None = None) -> TrackKind | None:
    """Map the TrackTags ExtendedData value to a TrackKind; None when unrecognized."""
    return kind_from_tree(xmlutil.parse_file(path), str(path), tag_map=tag_map)


def get_track_tags(path: Path) -> str:
    """The TrackTags value as stored — the activity name — or '' when there is none."""
    return track_tags_from_tree(xmlutil.parse_file(path))


def track_tags_from_tree(tree: xmlutil.etree._ElementTree) -> str:
    """The same reading for an already-parsed document."""
    return xmlutil.extended_data_value(tree, TRACK_TAGS)


def kind_from_tree(
    tree: xmlutil.etree._ElementTree, target: str = "", *, tag_map: Mapping[str, str] | None = None
) -> TrackKind | None:
    """The same mapping for an already-parsed document — what rebuild reads from the ZIP.

    None is not a category: a file whose TrackTags is absent, empty, or outside
    the table has no kind to file it under, and picking one anyway would put a
    real track in the wrong collection. Callers that tell a user about it say
    why with `explain_unknown_tags`.
    """
    track_tags = track_tags_from_tree(tree)
    kind = _KIND_BY_NAME.get(tag_map_for(tag_map).get(track_tags, ""))
    log.debug(f"Detected track type: {kind} (tag: {track_tags})", target=target or None)
    return kind


def explain_unknown_tags(tags: str) -> str:
    """Why a TrackTags value classified as nothing, phrased for the caller's report.

    A library helper stays quiet about severity (see log): the caller that acts
    on the failure decides whether it is an error, a warning, or one line of a
    batch's summary. This only names the value and the way out of it.
    """
    if not tags:
        return "No TrackTags value; set the activity with `kml set-tag --tag <activity>`"
    if tags in _KIND_BY_NAME:
        # 类别名曾经就是写进这个字段的值（`kml set-type` 的老写法）。认出来只为把
        # 「认不出来」变成「这是旧值，换成活动名」——判定结果仍是不识别
        return (
            f'TrackTags holds "{tags}", a category name — an older `kml set-type` wrote it; '
            f"set the activity with `kml set-tag --tag <activity>`"
        )
    return (
        f'TrackTags holds "{tags}", which is not in the activity table; add it with: '
        f'tracktool config set "{TRACK_TAG_PREFIX}Default" "+{tags}"'
    )


def summarize_unknown_tags(counts: Mapping[str, int]) -> str:
    """One line naming the unrecognized TrackTags values and how often each was seen.

    A batch that meets the same unknown value hundreds of times reports it once,
    which is the difference between a finding and a wall of lines.
    """
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    listed = ", ".join(f"{tags or '(no value)'} ({count})" for tags, count in ranked)
    return f"{sum(counts.values())} track(s) carry an unrecognized TrackTags value: {listed} — see `kml type --raw`"


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


def set_track_tags(path: Path, activity: str, create_tag: bool = False) -> bool:
    """Overwrite the TrackTags ExtendedData value in place.

    `activity` is a name from the user's own table (config `track_tag.*`), not a
    category: the field records what the track *is* — 地铁 — and the category is
    looked up from it. Writing a category name here would put a word from the
    archive's layout into the track's own data, a word the table cannot classify,
    so a round trip would depend on the reader remembering that exception.

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
        node.text = activity
    done = f"Created TrackTags: {activity}" if created else f"Updated track tags to: {activity}"
    plan = f"Would create TrackTags: {activity}" if created else f"Would set track tags to: {activity}"
    if xmlutil.save(tree, path):
        log.info(done, target=str(path))
    else:
        # save 只在 PLAN 下返回 False：预演要说出这一批会改成什么，而不只是"会写"
        log.info(plan, target=str(path))
    return True


def set_track_tags_batch(paths: list[Path], activity: str, create_tag: bool = False) -> BatchResult[None]:
    """Set the activity on every KML of a batch.

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
            updated = set_track_tags(path, activity, create_tag)
        except UserInputError as exc:
            log.error(str(exc), target=str(path))
            raise FileFailure(str(exc), quarantine=False) from exc
        if not updated:
            reason = "No TrackTags node to overwrite (pass --create-tag to add one)"
            log.error(reason, target=str(path))
            raise FileFailure(reason, quarantine=False)

    return run_per_file(paths, process, activity="Setting the track activity")


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
