"""Meaningful contract tests; no network, browser, or mutable real archive needed."""

import hashlib
import json
import zipfile
from array import array

import pytest

from tracktool.drawing.gazetteer import build_gazetteer
from tracktool.drawing.geometry import geojson
from tracktool.drawing.state import default_state, validate_state
from tracktool.errors import UserInputError
from tracktool.kml import storage, trackdata
from tracktool.map_workflow import MapWorkspace

KML = """<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><MultiGeometry>
<LineString><coordinates>100,26 101,27</coordinates></LineString>
<LineString><coordinates>102,28 103,29</coordinates></LineString>
<LineString><coordinates>104,30</coordinates></LineString>
</MultiGeometry></Placemark></Document></kml>"""


def archive_at(tmp_path, members):
    path = tmp_path / "Archive.zip"
    db_path = tmp_path / storage.DB_NAME
    if not db_path.exists():
        storage.create_database(db_path)
    with storage.connect(db_path, write=True) as db:
        db.execute("DELETE FROM archive_entries")
        for name, content in members:
            category = (
                name.split("/")[0] if "/" in name and name.split("/")[0] in {"Default", "Train", "Flight"} else None
            )
            storage.add_entry(db, name, content.encode(), category)
    return path


def test_catalog_never_reads_kml_and_full_path_is_identity(tmp_path, monkeypatch):
    first, second = "Default/2026-10/2026-10-04 same.kml", "Flight/2026-10/2026-10-04 same.kml"
    path = archive_at(tmp_path, [(first, KML), (second, KML.replace("100,26", "99,26")), ("unknown.kml", "bad")])
    workspace = MapWorkspace()
    with monkeypatch.context() as patch:
        patch.setattr(zipfile.ZipFile, "read", lambda *a, **k: pytest.fail("catalog read KML"))
        catalog = workspace.catalog(str(path))
    assert [(e["entry"], e["kind"], e["date"]) for e in catalog["entries"]] == [
        (first, "Default", "2026-10-04"),
        (second, "Flight", "2026-10-04"),
        ("unknown.kml", "Unknown", ""),
    ]
    result = workspace.selection(str(path), [first, second, "unknown.kml"])
    assert [t["entry"] for t in result["tracks"]] == [first, second]
    assert result["tracks"][0]["sha256"] != result["tracks"][1]["sha256"]
    assert result["errors"][0]["entry"] == "unknown.kml"


def test_no_time_data_and_segments_survive_boundary_without_bridges(tmp_path):
    path = archive_at(tmp_path, [("untimed.kml", KML)])
    selected = MapWorkspace().selection(str(path), ["untimed.kml"])
    assert not selected["errors"]
    track = selected["tracks"][0]
    assert track["sha256"] == hashlib.sha256(KML.encode()).hexdigest()
    assert track["points"] == 5
    lines, singletons = track["geojson"]["features"]
    assert lines["geometry"]["coordinates"] == [[(100, 26), (101, 27)], [(102, 28), (103, 29)]]
    assert singletons["geometry"]["coordinates"] == [(104, 30)]


def test_project_roundtrip_cache_and_changed_source(tmp_path, monkeypatch):
    path = archive_at(tmp_path, [("untimed.kml", KML)])
    workspace = MapWorkspace()
    selected = workspace.selection(str(path), ["untimed.kml"])
    state = default_state({"renderer": "test"})
    state.update(
        archive=str(path), title="中文旅途", tracks=[{k: selected["tracks"][0][k] for k in ("entry", "sha256")}]
    )
    state["camera"] = {"center": [101.2, 27.6], "zoom": 8.5}
    state["style"]["width"] = 7
    with monkeypatch.context() as patch:
        patch.setattr(trackdata, "track_data_from_tree", lambda *a, **k: pytest.fail("cached KML parsed again"))
        restored, geometry = workspace.project(json.loads(json.dumps(state)))
        assert restored == state and geometry["tracks"] == selected["tracks"]
    archive_at(tmp_path, [("untimed.kml", KML.replace("100,26", "100.1,26"))])
    restored, changed = workspace.project(state)
    assert not changed["tracks"] and "变化" in changed["errors"][0]["error"]
    assert restored["tracks"] == state["tracks"]  # Never silently adopt new source contents.
    archive_at(tmp_path, [])
    assert "not found" in workspace.project(state)[1]["errors"][0]["error"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("camera", {"center": [float("nan"), 26], "zoom": 8}),
        ("camera", {"center": [100, 86], "zoom": 8}),
        ("output", {"width": 1920, "height": 1200}),
        ("output", {"width": 16000, "height": 12000}),
        ("frame", {"ratio": "4:3", "width": 1000, "height": 750}),
        ("title", "bad\nheading"),
    ],
)
def test_invalid_project_rejected(field, value):
    state = default_state({})
    state[field] = value
    with pytest.raises(UserInputError, match="项目无效"):
        validate_state(state)


def test_projection_limit_and_dateline_segments():
    result = geojson(
        [(array("d", [179, -179]), array("d", [10, 11])), (array("d", [-170, -169]), array("d", [20, 21]))]
    )
    assert result["features"][0]["geometry"]["coordinates"] == [[(179, 10), (181, 11)], [(-170, 20), (-169, 21)]]
    with pytest.raises(UserInputError, match="纬度范围"):
        geojson([(array("d", [1, 2]), array("d", [80, 89]))])


def geoname(identity, name, code, admin2="1234", admin3="55", position=(100, 26)):
    return "\t".join(
        [
            identity,
            name,
            name,
            name,
            str(position[1]),
            str(position[0]),
            "A" if code.startswith("ADM") else "P",
            code,
            "CN",
            "",
            "29",
            admin2,
            admin3,
            "",
            "100",
            "",
            "",
            "Asia/Shanghai",
            "2026-01-01",
        ]
    )


def test_admin_evidence_and_seat_correction_never_promote_town_names(tmp_path):
    source = tmp_path / "CN.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr(
            "CN.txt",
            "\n".join(
                [
                    geoname("1", "示例县", "ADM3"),
                    geoname("2", "县城镇", "PPLA3", position=(100.1, 26.1)),
                    geoname("3", "很大镇", "PPLA4"),
                    geoname("4", "误称城市", "PPL"),
                    geoname("5", "残缺县", "ADM3", admin3=""),
                ]
            ),
        )
    data = build_gazetteer(source)
    assert len(data["labels"]) == 1
    label = data["labels"][0]
    assert (label["name"], label["level"], label["code"]) == ("示例县", 3, "ADM3")
    assert label["position"] == [100.1, 26.1] and label["position_kind"] == "seat"
    assert data["skipped"]["missing_admin_code"] == 1
