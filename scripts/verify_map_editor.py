"""Browser acceptance for the single-sidebar editor, against an isolated running server."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from tracktool.kml.archive import archive_hash

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
original_hash = archive_hash(archive)
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = b.new_page(viewport={"width": 1500, "height": 1000}, accept_downloads=True)
    errors, requests = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: requests.append(r.url))
    page.on("dialog", lambda d: d.accept())
    try:
        page.goto(args.url)
        page.locator("#status").filter(has_text="地图已就绪").wait_for(timeout=90000)
        viewport = page.locator(".map").bounding_box()
        assert viewport["x"] <= 1 and viewport["y"] <= 1
        assert viewport["x"] + viewport["width"] >= 1499
        assert viewport["y"] + viewport["height"] >= 999
        assert page.locator("#filters").is_hidden()
        assert page.locator("#inspector-panel").is_hidden()
        assert page.locator("#export-boundary").is_hidden()
        assert page.locator("#retry").is_hidden()
        assert page.locator("#stage > .viewport-credit").count() == 1
        page.locator("#browse").click()
        page.locator("#folder-path").fill(str(archive.parent))
        page.locator("#go-folder").click()
        page.get_by_role("button", name="◇ " + archive.name, exact=True).click()
        page.locator("#status").filter(has_text="已打开归档").wait_for()
        page.locator("#toggle-filters").click()
        page.locator("#date-from").fill(args.from_date)
        page.locator("#date-to").fill(args.to_date)
        page.locator("#kind").select_option("Default")
        page.locator("#select-visible").click()
        page.locator("#status").filter(has_text="已绘制").wait_for(timeout=90000)
        page.locator("#kind").select_option("Train")
        page.locator("#select-visible").click()
        page.locator("#status").filter(has_text="已绘制").wait_for(timeout=90000)
        chosen = len(page.evaluate("window.tracktool.state.tracks"))
        assert chosen >= 2
        # Selected view ignores filters and makes all selected paths removable.
        page.locator("#search").fill("no-match")
        assert page.locator("#track-list input").count() == 0
        page.locator("#show-selected").click()
        assert page.locator("#track-list input").count() == chosen
        assert page.locator("#search").is_disabled()
        before_tracks = page.evaluate("window.tracktool.state.tracks")
        page.locator("#track-list .locate").first.click()
        page.evaluate("window.tracktool.renderer.ready()")
        assert page.evaluate("window.tracktool.state.tracks") == before_tracks
        page.locator("#show-all").click()
        page.locator("#search").fill("")
        for chip in ("清除筛选：火车", "清除筛选：自 " + args.from_date, "清除筛选：至 " + args.to_date):
            page.get_by_role("button", name=chip, exact=True).click()
        page.locator("#fit").click()
        page.evaluate("window.tracktool.renderer.ready()")
        page.screenshot(path=str(OUT / "editor-tracks.png"))
        reads = len([url for url in requests if "/api/selection" in url])
        state = page.evaluate("window.tracktool.state")
        frame = page.locator("#frame").bounding_box()
        page.locator("#toggle-inspector").click()
        assert page.locator("#library-panel").is_hidden()
        assert page.evaluate("window.tracktool.state") == state
        assert page.locator("#frame").bounding_box() == frame
        page.locator("#basemap").select_option("dark")
        expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
        assert page.evaluate("window.tracktool.state.style.basemap") == "dark"
        page.locator("#color").fill("#ffb35c")
        page.locator("#width").fill("4.5")
        page.locator("#cities").select_option("none")
        page.evaluate("window.tracktool.renderer.ready()")
        assert page.evaluate("window.tracktool.renderer.labels.length") == 0
        page.locator("#cities").select_option("county")
        page.screenshot(path=str(OUT / "editor-style.png"))
        # Entering/leaving output mode changes only preview visibility, not camera/state.
        state = page.evaluate("window.tracktool.state")
        page.locator("#open-export").click()
        assert page.evaluate("window.tracktool.renderer.exportPreview")
        assert page.evaluate("window.tracktool.state") == state
        assert page.locator("#frame > .credit").count() == 1
        page.locator("#ratio").select_option("3:2")
        page.locator("#pixels").fill("479")
        page.locator("#pixels").dispatch_event("change")
        page.locator("#export").click()
        expect(page.locator("#status")).to_contain_text("480–4096")
        assert not any("/api/export" in url for url in requests)
        page.locator("#pixels").fill("1920")
        page.locator("#pixels").dispatch_event("change")
        page.locator("#title").fill("旅途 · 山河之间")
        page.locator("#fit").click()
        page.evaluate("window.tracktool.renderer.ready()")
        box = page.locator("#frame").bounding_box()
        panel = page.locator("#tool-panel").bounding_box()
        assert box["x"] > panel["x"] + panel["width"], "sidebar covers export frame"
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        camera = page.evaluate("window.tracktool.state.camera")
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 25, y + 18, steps=8)
        page.mouse.up()
        page.evaluate("window.tracktool.renderer.ready()")
        assert camera != page.evaluate("window.tracktool.state.camera")
        page.locator("#zoom-in").click()
        page.locator("#zoom-out").click()
        page.evaluate("window.tracktool.renderer.ready()")
        assert reads == len([url for url in requests if "/api/selection" in url])
        state = page.evaluate("window.tracktool.state")
        labels = page.evaluate("window.tracktool.renderer.labels")
        frame = page.locator("#frame").bounding_box()
        page.locator("#preview-only").click()
        assert page.locator("#tool-panel").is_hidden()
        assert page.locator("#frame").bounding_box() == frame
        assert page.evaluate("window.tracktool.state") == state
        page.screenshot(path=str(OUT / "editor-map-only.png"))
        page.locator("#toggle-tools").click()
        for w, h in ((1200, 850), (1500, 1000)):
            page.set_viewport_size({"width": w, "height": h})
            page.evaluate("window.tracktool.renderer.ready()")
            assert page.evaluate("window.tracktool.state") == state
            assert page.evaluate("window.tracktool.renderer.labels") == labels
        page.locator("#project-menu > summary").click()
        with page.expect_download() as download:
            page.locator("#save-project").click()
        download.value.save_as(OUT / "map-project.json")
        assert json.loads((OUT / "map-project.json").read_text()) == state
        page.locator("#title").fill("临时改动")
        page.locator("#project-file").set_input_files(OUT / "map-project.json")
        page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
        assert page.evaluate("window.tracktool.state") == state
        page.screenshot(path=str(OUT / "editor-output.png"))
        with page.expect_download(timeout=180000) as download:
            page.locator("#export").click()
        download.value.save_as(OUT / "map-dark.png")
        report = page.evaluate(r"""async () => {
          const paths=performance.getEntriesByType('resource').map(r=>r.name)
            .filter(n=>/api\/jobs\//.test(n)&&!n.endsWith('/png'));
          return (await fetch(paths.at(-1),{headers:{'X-Tracktool-Token':
            document.querySelector('meta[name=session-token]').content}})).json();
        }""")
        assert report["report"]["labels"] == labels
        assert report["report"]["camera"] == state["camera"]
        page.locator("#leave-export").click()
        assert not page.evaluate("window.tracktool.renderer.exportPreview")
        assert page.locator("#inspector-panel").is_visible()
        assert page.evaluate("window.tracktool.state") == state
        page.locator("#basemap").select_option("light")
        expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
        page.locator("#color").fill("#d65338")
        page.locator("#open-export").click()
        page.locator("#ratio").select_option("3:4")
        page.locator("#fit").click()
        page.evaluate("window.tracktool.renderer.ready()")
        with page.expect_download(timeout=180000) as download:
            page.locator("#export").click()
        download.value.save_as(OUT / "map-light-portrait.png")
        actual_camera = (
            "({center:window.tracktool.renderer.map.getCenter().toArray(),"
            "zoom:window.tracktool.renderer.map.getZoom()})"
        )
        for camera in ({"center": [105, 35], "zoom": 1.5}, {"center": [0, 75], "zoom": 4}):
            page.evaluate("c=>window.tracktool.renderer.map.jumpTo(c)", camera)
            page.evaluate("window.tracktool.renderer.ready()")
            state = page.evaluate("window.tracktool.state")
            actual = page.evaluate(actual_camera)
            for w, h in ((1200, 700), (390, 844), (1500, 1000)):
                page.set_viewport_size({"width": w, "height": h})
                page.evaluate("window.tracktool.renderer.ready()")
                assert page.evaluate("window.tracktool.state") == state
                assert page.evaluate(actual_camera) == actual
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator("#leave-export").click()
        page.locator("#toggle-library").click()
        page.locator("#toggle-inspector").focus()
        page.keyboard.press("ArrowLeft")
        assert page.locator("#toggle-library").get_attribute("aria-selected") == "true"
        page.locator("#toggle-inspector").click()
        assert page.locator("#library-panel").is_hidden()
        page.screenshot(path=str(OUT / "editor-mobile.png"))
        page.locator("#open-export").click()
        page.locator("#preview-only").click()
        assert page.locator("#tool-panel").is_hidden()
        assert page.locator("#export-boundary").is_visible()
        assert page.evaluate("document.documentElement.scrollWidth") == 390
        page.screenshot(path=str(OUT / "editor-mobile-preview.png"))
        assert not errors, errors
        (OUT / "report.json").write_text(
            json.dumps({"selected": chosen, "export": report, "page_errors": errors}, indent=2)
        )
        print(
            "PASS: filters, selected view, locate, tabs, project JSON, PNG, camera/labels, mobile, no reparse",
            flush=True,
        )
    finally:
        page.screenshot(path=str(OUT / "last.png"))
        b.close()
assert archive_hash(archive) == original_hash
