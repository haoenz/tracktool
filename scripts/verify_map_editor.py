"""Browser acceptance against an already running local editor; writes only QA artifacts.

Choose a short date range (under 200 tracks). No sample paths/counts are embedded.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--archive", type=Path, required=True)
parser.add_argument("--from-date", required=True)
parser.add_argument("--to-date", required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--url", default="http://127.0.0.1:8765")
args = parser.parse_args()
archive = args.archive.expanduser().resolve()
OUT = args.output
OUT.mkdir(parents=True, exist_ok=True)
with archive.open("rb") as handle:
    original_hash = hashlib.file_digest(handle, "sha256").hexdigest()
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1500, "height": 1000}, device_scale_factor=1, accept_downloads=True)
    errors = []
    requests = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: requests.append(r.url))
    page.goto(args.url)
    page.locator("#status").filter(has_text="地图已就绪").wait_for(timeout=90000)
    # The map reaches every edge, while tools float independently above it.
    viewport = page.locator(".map").bounding_box()
    assert viewport["x"] <= 0 and viewport["y"] <= 0
    assert viewport["x"] + viewport["width"] >= 1500
    assert viewport["y"] + viewport["height"] >= 1000
    # Browsing labels cover the viewport, rather than an invisible export crop.
    page.locator("#zoom-in").click()
    page.evaluate("window.tracktool.renderer.ready()")
    boot_state = page.evaluate("window.tracktool.state")
    assert page.locator("#export-boundary").is_hidden()
    assert page.locator("#stage > .viewport-credit").count() == 1
    assert page.evaluate("""() => {
      const r = window.tracktool.renderer;
      const [w, h] = r.surroundSize;
      const x = (w-r.state.frame.width)/2, y = (h-r.state.frame.height)/2;
      return !r.exportPreview && r.labels.some(l =>
        l.x < x || l.x > w-x || l.y < y || l.y > h-y);
    }""")
    page.locator("#toggle-frame").click()
    assert page.evaluate("window.tracktool.renderer.exportPreview")
    assert page.locator("#frame > .credit").count() == 1
    assert page.evaluate("window.tracktool.state") == boot_state
    page.locator("#browse").click()
    page.locator("#folder-path").fill(str(archive.parent))
    page.locator("#go-folder").click()
    page.get_by_role("button", name="◇ " + archive.name, exact=True).click()
    page.locator("#status").filter(has_text="已打开归档").wait_for()
    page.locator("#date-from").fill(args.from_date)
    page.locator("#date-to").fill(args.to_date)
    page.locator("#kind").select_option("Flight")
    assert page.locator("#track-list input:checked").count() == 0
    page.locator("#kind").select_option("Default")
    search_name = page.locator("#track-list strong").first.inner_text()
    page.locator("#search").fill(search_name)
    assert page.locator("#track-list input").count() >= 1
    page.locator("#search").fill("")
    page.locator("#select-visible").click()
    page.locator("#status").filter(has_text=re.compile("已绘制")).wait_for(timeout=90000)
    page.locator("#kind").select_option("Train")
    page.locator("#select-visible").click()
    page.locator("#status").filter(has_text=re.compile("已绘制")).wait_for(timeout=90000)
    page.locator("#kind").select_option("")
    chosen = page.locator("#track-list input:checked").count()
    print("selected", chosen, flush=True)
    # Cancel and select one again; preserve choices outside filters.
    name = page.locator("#track-list input:checked").first.get_attribute("aria-label")
    first = page.get_by_role("checkbox", name=name, exact=True)
    first.uncheck()
    page.locator("#status").filter(has_text="已绘制").wait_for(timeout=90000)
    first.check()
    page.locator("#status").filter(has_text="已绘制").wait_for(timeout=90000)
    page.locator("#fit").click()
    page.evaluate("window.tracktool.renderer.ready()")
    print("padding", page.evaluate("window.tracktool.renderer.map.getPadding()"), flush=True)
    before = len([u for u in requests if "/api/selection" in u])
    page.locator("#basemap").select_option("dark")
    page.locator("#color").fill("#ffb35c")
    page.locator("#width").fill("4.5")
    page.locator("#width").dispatch_event("input")
    page.locator("#cities").select_option("none")
    page.evaluate("window.tracktool.renderer.ready()")
    assert page.evaluate("window.tracktool.renderer.labels.length") == 0
    page.locator("#cities").select_option("county")
    page.locator("#ratio").select_option("3:2")
    page.locator("#pixels").fill("1920")
    page.locator("#pixels").dispatch_event("change")
    page.locator("#title").fill("旅途 · 山河之间")
    page.locator("#fit").click()
    page.evaluate("window.tracktool.renderer.ready()")
    # Exercise real pointer interactions in a CSS-scaled fixed frame.
    box = page.locator("#frame").bounding_box()
    x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2
    camera = page.evaluate("window.tracktool.state.camera")
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 25, y + 18, steps=8)
    page.mouse.up()
    page.evaluate("window.tracktool.renderer.ready()")
    assert camera != page.evaluate("window.tracktool.state.camera")
    page.locator("#zoom-in").click()
    page.evaluate("window.tracktool.renderer.ready()")
    page.locator("#zoom-out").click()
    page.evaluate("window.tracktool.renderer.ready()")
    assert before == len([u for u in requests if "/api/selection" in u]), "styles re-read KML"
    state = page.evaluate("window.tracktool.state")
    assert len(state["tracks"]) == chosen and not any(t["entry"].startswith("Flight/") for t in state["tracks"])
    # Browser resize must never change logical geometry, camera or label layout.
    labels = page.evaluate("window.tracktool.renderer.labels")
    frame = page.locator("#frame").bounding_box()
    for panel in ("library", "inspector"):
        page.locator(f"[data-close={panel}]").click()
        assert page.locator(f"#{panel}-panel").is_hidden()
        assert page.locator(f"#toggle-{panel}").get_attribute("aria-expanded") == "false"
    assert page.locator("#frame").bounding_box() == frame
    assert page.evaluate("window.tracktool.state") == state
    page.screenshot(path=str(OUT / "editor-map-only.png"))
    # The shaded area outside the export frame also accepts real map drags.
    page.mouse.move(80, 400)
    page.mouse.down()
    page.mouse.move(105, 415, steps=8)
    page.mouse.up()
    page.evaluate("window.tracktool.renderer.ready()")
    assert page.evaluate("window.tracktool.state.camera") != state["camera"]
    page.evaluate("camera => window.tracktool.renderer.map.jumpTo(camera)", state["camera"])
    page.evaluate("window.tracktool.renderer.ready()")
    assert page.evaluate("window.tracktool.renderer.labels") == labels
    for panel in ("library", "inspector"):
        page.locator(f"#toggle-{panel}").click()
    page.set_viewport_size({"width": 1200, "height": 850})
    page.evaluate("window.tracktool.renderer.ready()")
    assert page.evaluate("window.tracktool.state") == state
    assert page.evaluate("window.tracktool.renderer.labels") == labels
    page.set_viewport_size({"width": 1500, "height": 1000})
    page.evaluate("window.tracktool.renderer.ready()")
    with page.expect_download() as download:
        page.locator("#save-project").click()
    download.value.save_as(OUT / "map-project.json")
    saved = json.loads((OUT / "map-project.json").read_text())
    assert saved == state
    page.locator("#basemap").select_option("light")
    page.locator("#title").fill("临时改动")
    page.locator("#ratio").select_option("1:1")
    page.locator("#project-file").set_input_files(OUT / "map-project.json")
    page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
    restored = page.evaluate("window.tracktool.state")
    assert restored == saved, (restored, saved)
    page.screenshot(path=str(OUT / "editor-dark.png"))
    preview_labels = page.evaluate("window.tracktool.renderer.labels")
    page.locator("#toggle-frame").click()
    assert not page.evaluate("window.tracktool.renderer.exportPreview")
    assert page.evaluate("window.tracktool.state") == restored
    for panel in ("library", "inspector"):
        page.locator(f"[data-close={panel}]").click()
    page.screenshot(path=str(OUT / "editor-full-map.png"))
    # Export while browsing still uses the fixed frame and its label layout.
    with page.expect_download(timeout=180000) as download:
        page.locator("#export").click()
    download.value.save_as(OUT / "map-dark.png")
    print("EXPORT", page.locator("#status").inner_text(), flush=True)
    # Compare isolated export report labels/camera with fixed-frame preview.
    report = page.evaluate(
        r"""async()=>{
          const t=document.querySelector('meta[name=session-token]').content;
          const paths=performance.getEntriesByType('resource').map(r=>r.name)
            .filter(n=>/api\/jobs\//.test(n)&&!n.endsWith('/png'));
          return (await fetch(paths.at(-1),{headers:{'X-Tracktool-Token':t}})).json();
        }"""
    )
    assert report["report"]["labels"] == preview_labels, "preview/export label drift"
    assert report["report"]["camera"] == page.evaluate("window.tracktool.state.camera"), "camera drift"
    page.locator("#toggle-frame").click()
    assert page.evaluate("window.tracktool.renderer.labels") == preview_labels
    for panel in ("library", "inspector"):
        page.locator(f"#toggle-{panel}").click()
    page.locator("#basemap").select_option("light")
    page.locator("#color").fill("#d65338")
    page.locator("#ratio").select_option("3:4")
    page.locator("#fit").click()
    page.evaluate("window.tracktool.renderer.ready()")
    with page.expect_download(timeout=180000) as download:
        page.locator("#export").click()
    download.value.save_as(OUT / "map-light-portrait.png")
    page.screenshot(path=str(OUT / "editor-light-portrait.png"))
    assert not errors, errors
    (OUT / "report.json").write_text(
        json.dumps(
            {
                "selected": chosen,
                "state": saved,
                "dark_export": report,
                "page_errors": errors,
                "selection_requests": before,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print(
        "PASS: browser selection, styles, ratio, drag, zoom, immutable resize, save/reopen, "
        "2 exports, label/camera equality, floating panels, drag outside frame",
        flush=True,
    )
    # Enlarging the map around the frame must not trigger pole/zoom constraints
    # that silently alter the real MapLibre camera when resizing the window.
    actual_camera = (
        "({center:window.tracktool.renderer.map.getCenter().toArray(),zoom:window.tracktool.renderer.map.getZoom()})"
    )
    for camera in ({"center": [105, 35], "zoom": 1.5}, {"center": [0, 75], "zoom": 4}):
        page.evaluate("c=>window.tracktool.renderer.map.jumpTo(c)", camera)
        page.evaluate("window.tracktool.renderer.ready()")
        state = page.evaluate("window.tracktool.state")
        actual = page.evaluate(actual_camera)
        for width, height in ((1200, 700), (390, 844), (1500, 1000)):
            page.set_viewport_size({"width": width, "height": height})
            page.evaluate("window.tracktool.renderer.ready()")
            assert page.evaluate("window.tracktool.state") == state
            assert page.evaluate(actual_camera) == actual
    page.set_viewport_size({"width": 390, "height": 844})
    page.locator("#toggle-library").click()
    page.locator("#toggle-inspector").click()
    page.locator("#toggle-inspector").click()
    assert page.locator("#library-panel").is_hidden()
    assert page.locator("#inspector-panel").is_visible()
    page.locator("#ratio").select_option("3:4")
    page.locator("#toggle-inspector").click()
    assert page.evaluate("document.documentElement.scrollWidth") == 390
    page.screenshot(path=str(OUT / "editor-mobile.png"))
    assert not errors, errors
    print("PASS: low zoom/polar resize keeps actual camera; mobile tool windows and no horizontal overflow", flush=True)
    b.close()

with archive.open("rb") as handle:
    assert hashlib.file_digest(handle, "sha256").hexdigest() == original_hash, "source archive changed"
print("Source archive SHA-256 unchanged:", original_hash)
