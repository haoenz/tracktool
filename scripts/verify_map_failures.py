"""Explicit network/browser acceptance: missing resources, retry, target size and segment PNG."""

import argparse
import json
import threading
import time
import zipfile
from pathlib import Path

import requests

from tracktool.editor import EditorServer, Handler
from tracktool.errors import UserInputError

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/tracktool/maps")
args = parser.parse_args()
OUT = args.output
OUT.mkdir(parents=True, exist_ok=True)


class FaultHandler(Handler):
    def _get(self, path, query):
        if self.server.mode == "font" and "NotoSansCJKsc-Regular.otf" in path:
            raise UserInputError("injected missing font")
        if self.server.mode == "tile" and path.startswith("/tiles/"):
            raise UserInputError("injected tile failure")
        return super()._get(path, query)


app = EditorServer(0, args.cache)
app.RequestHandlerClass = FaultHandler
app.mode = "ok"
thread = threading.Thread(target=app.serve_forever, daemon=True)
thread.start()
s = requests.Session()
s.trust_env = False
s.headers["X-Tracktool-Token"] = app.token
base = app.origin
state = s.get(base + "/api/bootstrap").json()["state"]
state["output"] = {"width": 960, "height": 720}
reports = {}


def export(state):
    r = s.post(base + "/api/export", json=state)
    r.raise_for_status()
    job = r.json()["job"]
    deadline = time.monotonic() + 130
    while time.monotonic() < deadline:
        result = s.get(base + "/api/jobs/" + job).json()
        if result["status"] in ["failed", "done"]:
            return result, job
        time.sleep(0.2)
    raise AssertionError("export timeout")


try:
    # Failures must produce no PNG; each retry is a fresh browser, not a stale map.
    for mode in ["tile", "font", "ok"]:
        app.mode = mode
        result, job = export(state)
        reports[mode] = result
        print(mode, result["status"], result.get("error", "")[:140], flush=True)
        if mode != "ok":
            assert result["status"] == "failed" and "png" not in app.jobs[job]
        else:
            assert result["status"] == "done"
    # Odd target size: output is a fresh DPR render with exact final dimensions.
    state["frame"] = {"ratio": "3:4", "width": 720, "height": 960}
    state["output"] = {"width": 751, "height": 1001}
    result, job = export(state)
    reports["odd_pixels"] = result
    print("odd pixels", result["status"], result.get("error", ""), flush=True)
    assert result["status"] == "done"
    # Missing glyph cannot silently fall back.
    state["title"] = "旅行 🚀"
    r = s.post(base + "/api/export", json=state)
    assert r.status_code == 400 and "缺少字符" in r.text
    reports["missing_glyph"] = r.json()
    # Security boundary: read APIs need session token and accepted Host/Origin.
    assert requests.get(base + "/api/browse").status_code == 403
    assert s.get(base + "/api/browse", headers={"Origin": "https://example.com"}).status_code == 403
    assert s.get(base + "/api/browse", headers={"Host": "example.com"}).status_code == 403
    # Separate, untimed segments + different file: rendered lines must not bridge.
    fixture = OUT / "segments"
    fixture.mkdir(exist_ok=True)
    (fixture / "archive.json").write_text("{}")
    kml = (
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><MultiGeometry>'
        "<LineString><coordinates>100,26 100.1,26</coordinates></LineString>"
        "<LineString><coordinates>100.9,26 101,26</coordinates></LineString>"
        "</MultiGeometry></Placemark></Document></kml>"
    )
    with zipfile.ZipFile(fixture / "Archive.zip", "w") as z:
        z.writestr("Default/same.kml", kml)
        z.writestr("Train/same.kml", kml.replace("26", "26.3"))
    selected = s.post(
        base + "/api/selection",
        json={"archive": str(fixture / "Archive.zip"), "entries": ["Default/same.kml", "Train/same.kml"]},
    ).json()
    state = s.get(base + "/api/bootstrap").json()["state"]
    state.update(
        archive=str(fixture / "Archive.zip"),
        title="分段检查 · 中间必须留白",
        tracks=[{"entry": t["entry"], "sha256": t["sha256"]} for t in selected["tracks"]],
    )
    state["camera"] = {"center": [100.5, 26.15], "zoom": 9}
    state["style"].update(color="#ff0000", width=5, cities="none")
    state["output"] = {"width": 960, "height": 720}
    result, job = export(state)
    assert result["status"] == "done"
    png = s.get(base + "/api/jobs/" + job + "/png").content
    (OUT / "segments.png").write_bytes(png)
    reports["segments"] = result
    (OUT / "fault-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2))
finally:
    app.shutdown()
    app.server_close()
    thread.join()
