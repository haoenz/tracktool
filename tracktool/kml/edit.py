"""KML track editing: split, bad-point removal, merge, altitude fill,
MultiGeometry conversion.

These commands rewrite a KML's gx:Track in place (or into sibling files named
after the edit); merging fills altitude through Google and can file the
sources into the archive afterwards.
"""

import re
from pathlib import Path

from .. import googleapi, log
from ..context import ctx
from ..errors import UserInputError
from ..fileutil import move_to_folder
from ..metadata import is_missing_altitude
from ..paths import display_path
from ..workspace import resolve_archive
from . import archive, kmlfile, xmlutil
from .collections import new_empty_kml

_TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_COORDINATE_PATTERN = re.compile(r"-?\d{1,3}(\.\d+)?\s-?\d{1,2}(\.\d+)?\s\d+(\.\d+)?")


def _get_track(tree: xmlutil.etree._ElementTree) -> xmlutil.etree._Element:
    """The single gx:Track under Document/Folder/Placemark (2bulu layout)."""
    track = xmlutil.find(tree, "/kml:kml/kml:Document/kml:Folder/kml:Placemark/gx:Track")
    if track is None:
        raise UserInputError("No gx:Track found under Document/Folder/Placemark")
    return track


def _track_location_index(track: xmlutil.etree._Element, location: str) -> int:
    """Index of a timestamp or coordinate string in the track, -1 if absent."""
    index = -1
    if _TIMESTAMP_PATTERN.search(location):
        whens = [w.text or "" for w in track.findall(f"{{{xmlutil.KML_NS}}}when")]
        if location in whens:
            index = whens.index(location)
            log.debug(f"Found timestamp in track at index {index}")
    elif _COORDINATE_PATTERN.search(location):
        coords = [c.text or "" for c in track.findall(f"{{{xmlutil.GX_NS}}}coord")]
        if location in coords:
            index = coords.index(location)
            log.debug(f"Found coordinate in track at index {index}")
    else:
        log.error(f"Invalid location format: {location}")

    if index == -1:
        log.error(f"Location not found in track: {location}")
    return index


def split_kml(path: Path, split_points: list[str]) -> None:
    """Split the track at timestamps/coordinates into <name>-Splited-N.kml files."""
    tree = xmlutil.parse_file(path)
    track = _get_track(tree)
    coords = [c.text or "" for c in track.findall(f"{{{xmlutil.GX_NS}}}coord")]
    whens = [w.text or "" for w in track.findall(f"{{{xmlutil.KML_NS}}}when")]

    indices = [-1]
    for loc in split_points:
        index = _track_location_index(track, loc)
        if index == -1:
            return
        indices.append(index)
    indices.append(len(coords) - 1)
    indices = sorted(indices)

    ns = xmlutil.doc_ns(tree)
    for i in range(1, len(indices)):
        new_tree = xmlutil.parse_string(xmlutil.etree.tostring(tree, encoding="unicode"))
        placemark = xmlutil.find(new_tree, "/kml:kml/kml:Document/kml:Folder/kml:Placemark")
        old_track = _get_track(new_tree)
        assert placemark is not None  # gx:Track 存在，其 Placemark 必在
        placemark.remove(old_track)

        new_track = xmlutil.etree.SubElement(placemark, f"{{{xmlutil.GX_NS}}}Track")
        for j in range(indices[i - 1] + 1, indices[i] + 1):
            coord = xmlutil.etree.SubElement(new_track, f"{{{xmlutil.GX_NS}}}coord")
            coord.text = coords[j]
        for j in range(indices[i - 1] + 1, indices[i] + 1):
            when = xmlutil.etree.SubElement(new_track, f"{{{ns}}}when")
            when.text = whens[j]
        log.info(f"Split track at coordinate: {coords[indices[i]]}", target=str(path))

        if "-Splited" in path.stem:
            new_kml_name = f"{path.stem}-{i}"
        else:
            new_kml_name = f"{path.stem}-Splited-{i}"
        new_kml_name = new_kml_name.replace(":", "")
        name_node = xmlutil.find(new_tree, "/kml:kml/kml:Document/kml:name")
        if name_node is not None:
            name_node.text = new_kml_name
        new_kml_path = path.parent / f"{new_kml_name}.kml"
        if xmlutil.save(new_tree, new_kml_path):
            log.info("Created split track file", target=str(new_kml_path))


def prune_points(path: Path, bad_points: list[str]) -> None:
    """Remove one point, or the inclusive range between two, as <name>-Fixed.kml."""
    if len(bad_points) > 2:
        raise UserInputError(f"Too many bad points specified (max 2): {len(bad_points)}")

    tree = xmlutil.parse_file(path)
    track = _get_track(tree)
    log.debug("Removing bad points from track", target=str(path))

    indices = []
    for loc in bad_points:
        index = _track_location_index(track, loc)
        if index == -1:
            return
        indices.append(index)
    indices.sort()

    coord_nodes = track.findall(f"{{{xmlutil.GX_NS}}}coord")
    coord_texts = [c.text or "" for c in coord_nodes]
    # 子元素按 [coord...] 后接 [when...] 排列（2bulu 导出格式）
    when_nodes = track.findall(f"{{{xmlutil.KML_NS}}}when")

    def remove_at(index: int) -> None:
        loc = coord_texts[index]
        track.remove(coord_nodes.pop(index))
        track.remove(when_nodes.pop(index))
        log.debug(f"Removed point: {loc}", target=str(path))

    if len(indices) == 1:
        remove_at(indices[0])
        removed_count = 1
    else:
        removed_count = 0
        for _ in range(indices[0], indices[1] + 1):
            remove_at(indices[0])
            removed_count += 1

    log.info(f"Removed {removed_count} bad point(s) from track", target=str(path))

    new_kml_name = f"{path.stem}-Fixed".replace(":", "")
    name_node = xmlutil.find(tree, "/kml:kml/kml:Document/kml:name")
    if name_node is not None:
        name_node.text = new_kml_name
    new_kml_path = path.parent / f"{new_kml_name}.kml"
    if xmlutil.save(tree, new_kml_path):
        log.info("Created cleaned track file", target=str(new_kml_path))


def merge_kml(paths: list[Path], output_path: Path, connected: bool = False,
              move: bool = False) -> None:
    """Merge multiple KMLs into one LineString (-Connected) or MultiGeometry.

    The merged output stays where --output puts it; the source files are
    filed into the ZIP — the archive's truth — and stay put unless `move`
    collects them into the backup folder. A source listed twice is filed
    once and moved once: the ZIP skips the duplicate by entry path, and the
    dedup below keeps the move from chasing a file already carried away.
    """
    all_line_strings: list[str] = []
    first_description = ""
    for i, path in enumerate(paths):
        content = kmlfile.get_kml_content(path)
        all_line_strings.append(content.line_string)
        if i == 0:
            first_description = content.description

    output_tree = new_empty_kml()
    xmlutil.doc_ns(output_tree)
    folder = xmlutil.find(output_tree, "//kml:Folder")

    placemark = xmlutil.sub(folder, "Placemark")
    xmlutil.sub(placemark, "name", output_path.stem)
    xmlutil.sub(placemark, "description", first_description)

    if connected:
        # 所有坐标首尾相连合并为单一 LineString
        ls = xmlutil.sub(placemark, "LineString")
        xmlutil.sub(ls, "coordinates", " ".join(all_line_strings))
        log.info(f"Merged {len(all_line_strings)} track(s) into a single LineString")
    else:
        # 各段轨迹保持独立，用 MultiGeometry 包装
        multi_geom = xmlutil.sub(placemark, "MultiGeometry")
        for ls_coords in all_line_strings:
            ls = xmlutil.sub(multi_geom, "LineString")
            xmlutil.sub(ls, "coordinates", ls_coords)
        log.info(f"Merged {len(all_line_strings)} track(s) into MultiGeometry")

    # 归档位置与压缩包先备好，再写合并结果：归档这一步失败不该留下一个半成品
    archive_dir, zip_file = resolve_archive(None)
    archive.ensure_zip_file(zip_file)

    output_path = output_path.resolve()
    if xmlutil.save(output_tree, output_path):
        log.info(f"Saved merged KML to: {display_path(output_path)}")

    for path in dict.fromkeys(paths):
        archive.push_compressed_kml(path, zip_file)
        if move:
            move_to_folder(path, ctx.config.kml_backup_dir_name, archive_dir)


def _track_of(node: xmlutil.etree._Element) -> xmlutil.etree._Element:
    """The track a coordinates node belongs to: its Placemark, else its LineString."""
    placemarks = node.xpath("ancestor::*[local-name()='Placemark'][1]")
    return placemarks[0] if placemarks else node.getparent()


def fill_kml_altitude_from_google(path: Path, api_key: str | None = None) -> None:
    """Fill altitude in place for every track whose coordinates have none.

    A track is a Placemark, so one file — an archive collection, say — holds
    both kinds at once. One real altitude anywhere in a track means it carries
    the elevations its device recorded, and that track is left alone rather
    than flattened to DEM values (with 0 written where the API has no answer).
    Tracks with no altitude on any point — the hand-drawn ones — are what it
    fills; a file where no track qualifies is not written at all.
    """
    tree = xmlutil.parse_file(path)
    coord_nodes = xmlutil.findall(tree, "//kml:LineString/kml:coordinates")
    if not coord_nodes:
        log.warning("No LineString coordinates found", target=str(path))
        return

    # KML 坐标格式: "lon,lat,alt lon,lat,alt ..."
    parsed: list[tuple[xmlutil.etree._Element, list[str], list[int]]] = []
    has_altitude: dict[xmlutil.etree._Element, bool] = {}
    for node in coord_nodes:
        tuples = (node.text or "").strip().split()
        indexes = [i for i, tup in enumerate(tuples) if len(tup.split(",")) >= 2]
        if not indexes:
            continue
        parsed.append((node, tuples, indexes))
        # 第三分量缺失与 0 同义（is_missing_altitude 数值判零）
        carrying = any(len(tuples[i].split(",")) > 2
                       and not is_missing_altitude(tuples[i].split(",")[2]) for i in indexes)
        track = _track_of(node)
        has_altitude[track] = has_altitude.get(track, False) or carrying

    skipped = sum(1 for carrying in has_altitude.values() if carrying)
    if skipped:
        log.info(f"Tracks already carrying altitude: {skipped} of {len(has_altitude)}, left alone",
                 target=str(path))

    tuples_by_node: dict[xmlutil.etree._Element, list[str]] = {}
    alt_targets: list[tuple[xmlutil.etree._Element, int]] = []  # 下标与 points 对齐
    points: list[tuple[float, float]] = []
    for node, tuples, indexes in parsed:
        if has_altitude[_track_of(node)]:
            continue
        tuples_by_node[node] = tuples
        for i in indexes:
            parts = tuples[i].split(",")
            # KML 是 lon,lat，而 API 与领域模型都用 (lat, lon)
            points.append((float(parts[1]), float(parts[0])))
            alt_targets.append((node, i))

    if not points:
        log.info("Every track already carries altitude, nothing to fill", target=str(path))
        return

    log.info(f"Querying Google Elevation API for {len(points)} point(s)", target=str(path))

    if ctx.is_plan:
        # 坐标已经读出来了，但查询是花钱的动作：预演到此为止，不再花配额
        log.info(f"Would write {display_path(path)}")
        return

    elevations = googleapi.get_altitudes(points, api_key=api_key)

    # 将高程写回，重建 coordinates 文本
    for i, (node, index) in enumerate(alt_targets):
        tuples = tuples_by_node[node]
        parts = tuples[index].split(",")
        alt = elevations[i] if i < len(elevations) and elevations[i] is not None else 0
        tuples[index] = f"{parts[0]},{parts[1]},{alt}"

    for node, tuples in tuples_by_node.items():
        node.text = " ".join(tuples)

    if xmlutil.save(tree, path):
        log.info("Saved KML with updated altitudes", target=str(path))


def convert_kml_to_multigeometry(path: Path, output_path: Path | None = None) -> None:
    """Rewrap all LineStrings of a KML into a single MultiGeometry Placemark.

    Preserves the source's name and styles.
    """
    tree = xmlutil.parse_file(path)
    coord_nodes = xmlutil.findall(tree, "//kml:LineString/kml:coordinates")
    if not coord_nodes:
        log.warning("No LineString coordinates found", target=str(path))
        return
    log.info(f"Found {len(coord_nodes)} LineString(s)", target=str(path))

    # 收集所有坐标文本及其来源 Placemark 的 name（用作 LineString id）
    coord_entries: list[tuple[str, str]] = []
    for node in coord_nodes:
        placemark_node = node.getparent().getparent()  # coordinates -> LineString -> Placemark
        name_node = placemark_node.find(f"{{{xmlutil.doc_ns(tree)}}}name") if placemark_node is not None else None
        entry_id = (name_node.text or "").strip() if name_node is not None else ""
        coord_entries.append(((node.text or "").strip(), entry_id))

    # 构建输出 KML：kml > Folder > (name + Style* + StyleMap* + Placemark > MultiGeometry)
    kml_ns = xmlutil.doc_ns(tree)
    root = xmlutil.etree.fromstring(
        f"<?xml version='1.0' encoding='UTF-8'?><kml xmlns='{kml_ns}'/>".encode())
    output_tree = root.getroottree()
    folder = xmlutil.etree.SubElement(root, f"{{{kml_ns}}}Folder")

    # 从源文件的顶层容器（Document 或 Folder）中提取 name 和样式节点
    src_container = xmlutil.find(tree, "//kml:Document")
    if src_container is None:
        src_container = xmlutil.find(tree, "//kml:Folder")

    if src_container is not None:
        src_name = src_container.find(f"{{{kml_ns}}}name")
        if src_name is not None and (src_name.text or "").strip():
            xmlutil.sub(folder, "name", (src_name.text or "").strip())
        for style in list(src_container):
            tag = xmlutil.etree.QName(style).localname
            if tag in ("Style", "StyleMap"):
                folder.append(xmlutil.etree.fromstring(xmlutil.etree.tostring(style)))

    placemark = xmlutil.sub(folder, "Placemark", ns=kml_ns)
    multi_geom = xmlutil.sub(placemark, "MultiGeometry", ns=kml_ns)
    for text, entry_id in coord_entries:
        ls = xmlutil.sub(multi_geom, "LineString", ns=kml_ns)
        if entry_id:
            ls.set("id", entry_id)
        xmlutil.sub(ls, "coordinates", text, ns=kml_ns)

    if output_path is None:
        output_path = path.parent / f"{path.stem}-Merged.kml"
    if xmlutil.save(output_tree, output_path.resolve()):
        log.info(f"Saved merged KML to: {display_path(output_path)}", target=str(path))
