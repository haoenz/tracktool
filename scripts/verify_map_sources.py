"""Real browser raster acceptance; needs a saved project and running editor.

The built-in presets require no locally configured credentials.
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--project", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--url", default="http://127.0.0.1:8765")
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 1000}, accept_downloads=True)
    errors, reads = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.on("request", lambda r: reads.append(r.url) if "/api/selection" in r.url else None)
    page.goto(args.url)
    page.locator("#status").filter(has_text="地图已就绪").wait_for(timeout=90000)
    state = json.loads(args.project.read_text())
    state["versions"] = page.evaluate("window.tracktool.state.versions")
    state["output"] = {"width": state["frame"]["width"] * 2, "height": state["frame"]["height"] * 2}
    test_project = args.output / "input-project.json"
    test_project.write_text(json.dumps(state, ensure_ascii=False))
    page.locator("#project-file").set_input_files(test_project)
    page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
    page.locator("#toggle-inspector").click()
    original_camera = page.evaluate("window.tracktool.state.camera")
    original_tracks = page.evaluate("window.tracktool.state.tracks")
    ids = page.locator("#preset-basemaps option").evaluate_all("els => els.map(e => e.value)")
    assert len(ids) == 10
    for identity in ids:
        old = page.evaluate("window.tracktool.state.style.basemap")
        if page.locator(f'option[value="{identity}"]').is_disabled():
            results.append({"id": identity, "error": "missing credentials"})
            continue
        if page.locator("#output-panel").is_visible():
            page.locator("#leave-export").click()
        page.locator("#basemap").select_option(identity)
        expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=120000)
        if page.evaluate("window.tracktool.state.style.basemap") != identity:
            message = page.locator("#status").inner_text()
            assert "保留原底图" in message
            assert page.evaluate("window.tracktool.state.style.basemap") == old
            results.append({"id": identity, "error": message})
            print(identity, message, flush=True)
            continue
        page.evaluate("window.tracktool.renderer.ready()")
        assert page.evaluate("window.tracktool.state.camera") == original_camera
        assert page.evaluate("window.tracktool.state.tracks") == original_tracks
        assert not page.evaluate("window.tracktool.renderer.errors")
        # Rendering conversion retains segment boundaries and never mutates WGS84 arrays.
        geometry = page.evaluate("""async () => {
          const {displayCoordinate} = await import('/static/coordinates.js');
          const r=window.tracktool.renderer, orig=JSON.stringify(r.data);
          const source=r.data.features[0].geometry.coordinates;
          const shown=r.displayData.features[0].geometry.coordinates;
          const a=source[0][0], b=shown[0][0];
          const expected=displayCoordinate(a,r.crs);
          const reverse=displayCoordinate(expected,r.crs,true);
          return {sameSegments: source.length===shown.length && source.every((s,i)=>s.length===shown[i].length),
            projected: JSON.stringify(b)===JSON.stringify(expected), unchanged: orig===JSON.stringify(r.data),
            roundtrip: Math.max(Math.abs(a[0]-reverse[0]),Math.abs(a[1]-reverse[1]))};
        }""")
        assert geometry["sameSegments"] and geometry["projected"] and geometry["unchanged"]
        assert geometry["roundtrip"] < 0.000002
        page.screenshot(path=str(args.output / f"{identity}-editor.png"))
        result = {"id": identity, "ok": True, "geometry": geometry}
        if identity in ("bing-satellite", "google-satellite", "google-hybrid-large"):
            page.locator("#open-export").click()
            labels = page.evaluate("window.tracktool.renderer.labels")
            with page.expect_download(timeout=180000) as download:
                with page.expect_response("**/api/export") as submitted:
                    page.locator("#export").click()
            download.value.save_as(args.output / f"{identity}.png")
            report = page.evaluate(
                """async (job) => {
              const token=document.querySelector('meta[name=session-token]').content;
              return (await fetch(`/api/jobs/${job}`,{headers:{'X-Tracktool-Token':token}})).json();
            }""",
                submitted.value.json()["job"],
            )
            assert report["report"]["camera"] == original_camera
            (args.output / f"{identity}-labels.json").write_text(
                json.dumps({"preview": labels, "export": report["report"]["labels"]}, ensure_ascii=False, indent=2)
            )
            assert report["report"]["labels"] == labels
            result["export"] = report
        results.append(result)
        print(identity, "PASS", flush=True)
    assert not reads, "source switch re-read KML"
    # The final Google layer uses GCJ-02; a real drag must persist WGS84.
    page.mouse.move(700, 500)
    page.mouse.down()
    page.mouse.move(735, 525, steps=8)
    page.mouse.up()
    page.evaluate("window.tracktool.renderer.ready()")
    assert page.evaluate("window.tracktool.state.camera") != original_camera
    assert page.evaluate("""async () => {
      const {displayCoordinate} = await import('/static/coordinates.js');
      const r=window.tracktool.renderer, center=r.map.getCenter();
      const expected=displayCoordinate(window.tracktool.state.camera.center,r.crs);
      return Math.abs(center.lng-expected[0])<0.000002 && Math.abs(center.lat-expected[1])<0.000002;
    }""")
    page.locator("#project-menu > summary").click()
    with page.expect_download() as download:
        page.locator("#save-project").click()
    saved_path = args.output / "saved-project.json"
    download.value.save_as(saved_path)
    saved = page.evaluate("window.tracktool.state")
    if page.locator("#output-panel").is_visible():
        page.locator("#leave-export").click()
    page.locator("#basemap").select_option("light")
    expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
    page.locator("#project-file").set_input_files(saved_path)
    page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
    assert page.evaluate("window.tracktool.state") == saved
    assert not errors, errors
    (args.output / "report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    browser.close()
