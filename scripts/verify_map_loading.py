"""Real-browser switching, cancellation and export acceptance using a NEW isolated cache."""

import argparse
import hashlib
import json
import threading
import time
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

import tracktool.editor as editor
from tracktool.errors import UserInputError
from tracktool.kml.storage import DB_NAME, create_database


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, help="Optional dedicated test cache; never point at the user's cache")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    app = editor.EditorServer(0, args.cache or args.output / "cache")
    original = editor.default_state

    def state(versions):
        result = original(versions)
        result["style"]["basemap"] = "google-satellite"
        result["camera"] = {"center": [102.72, 25.04], "zoom": 10}
        result["output"] = {"width": 960, "height": 720}
        return result

    editor.default_state = state
    app.mode = "normal"

    class FaultHandler(editor.Handler):
        def _get(self, path, query):
            if path.startswith("/tiles/google-road/"):
                if app.mode == "failure":
                    raise UserInputError("injected source failure")
                if app.mode == "slow":
                    time.sleep(1)
            return super()._get(path, query)

    app.RequestHandlerClass = FaultHandler
    thread = threading.Thread(target=app.serve_forever, daemon=True)
    thread.start()
    fixture = args.output / "fixture"
    fixture.mkdir()
    (fixture / "archive.json").write_text("{}")
    archive = fixture / "Archive.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr(
            "Default/2026-10-13 test.kml",
            """<kml xmlns="http://www.opengis.net/kml/2.2">
          <Document><Placemark><MultiGeometry>
          <LineString><coordinates>102.65,25.02 102.69,25.07</coordinates></LineString>
          <LineString><coordinates>102.76,25.07 102.8,25.02</coordinates></LineString>
          </MultiGeometry></Placemark></Document></kml>""",
        )
    create_database(fixture / DB_NAME, archive)
    original_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    report = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1400, "height": 1000}, accept_downloads=True)
            errors, selections = [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("request", lambda r: selections.append(r.url) if "/api/selection" in r.url else None)
            page.goto(app.origin)
            try:
                page.locator("#status").filter(has_text="地图已就绪").wait_for(timeout=90000)
            except Exception:
                report["startup_status"] = page.locator("#status").inner_text()
                report["page_errors"] = errors
                page.screenshot(path=str(args.output / "startup-failure.png"))
                print(json.dumps(report, ensure_ascii=False), flush=True)
                raise
            # Load a tiny, generated archive through the ordinary project flow.
            selected = app.workspace.selection(str(archive.resolve()), ["Default/2026-10-13 test.kml"])
            project = page.evaluate("window.tracktool.state")
            project.update(
                archive=str(archive.resolve()),
                title="昆明 · 双分段轨迹",
                tracks=[{k: t[k] for k in ("entry", "sha256")} for t in selected["tracks"]],
            )
            project_file = args.output / "input.json"
            project_file.write_text(json.dumps(project))
            page.locator("#project-file").set_input_files(project_file)
            page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
            reads = len(selections)
            app.mode = "slow"
            page.evaluate("window.previousMap=window.tracktool.renderer")
            page.locator("#basemap").select_option("google-road")
            expect(page.locator("#stage")).to_have_attribute("aria-busy", "true")
            expect(page.locator("#save-project")).to_be_disabled()
            expect(page.locator("#basemap")).to_be_enabled()
            assert page.evaluate("window.tracktool.state.style.basemap") == "google-satellite"
            assert page.evaluate("window.previousMap === window.tracktool.renderer && !window.previousMap.destroyed")
            page.screenshot(path=str(args.output / "switch-loading.png"))
            # Old map remains interactive and the hidden map follows its WGS84 camera.
            page.mouse.move(710, 550)
            page.mouse.down()
            page.mouse.move(765, 585, steps=6)
            page.mouse.up()
            page.locator("#basemap").select_option("google-terrain")
            page.locator("#basemap").select_option("bing-satellite")
            expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
            if page.evaluate("window.tracktool.state.style.basemap") != "bing-satellite":
                report["transient_switch_failure"] = page.locator("#status").inner_text()
                print(report["transient_switch_failure"], flush=True)
                assert "保留原底图" in report["transient_switch_failure"]
                page.locator("#retry").click()
                expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
            assert page.evaluate("window.tracktool.state.style.basemap") == "bing-satellite", page.locator(
                "#status"
            ).inner_text()
            assert page.locator(".staging-frame").count() == 0
            assert page.evaluate("window.previousMap.destroyed")
            report["rapid_switch"] = "only final source committed; previous map retained and interactive"
            # Failure after the target extent starts loading must preserve everything committed.
            before = page.evaluate("window.tracktool.state")
            app.mode = "failure"
            page.locator("#basemap").select_option("google-road")
            expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
            assert "保留原底图" in page.locator("#status").inner_text()
            assert page.evaluate("window.tracktool.state") == before
            assert page.locator(".staging-frame").count() == 0
            page.screenshot(path=str(args.output / "switch-failed.png"))
            app.mode = "normal"
            page.locator("#retry").click()
            expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
            assert page.evaluate("window.tracktool.state.style.basemap") == "google-road"
            report["failure_retry"] = "old state retained; retry committed requested source"
            # True pointer drags + wheel, then test a cold final viewport and coordinate roundtrip.
            for dx in (120, -190, 150):
                page.mouse.move(750, 560)
                page.mouse.down()
                page.mouse.move(750 + dx, 580, steps=3)
                page.mouse.up()
                page.mouse.wheel(0, -120)
            page.evaluate("window.tracktool.renderer.ready()")
            assert page.evaluate("""async () => {
                const {displayCoordinate}=await import('/static/coordinates.js');
                const r=window.tracktool.renderer;
                const expected=displayCoordinate(window.tracktool.state.camera.center,r.crs);
                const actual=r.map.getCenter();
                return Math.abs(expected[0]-actual.lng)<.000002 && Math.abs(expected[1]-actual.lat)<.000002;
            }""")
            page.locator("#toggle-frame").click()
            page.evaluate("window.tracktool.renderer.ready()")
            labels = page.evaluate("window.tracktool.renderer.labels")
            camera = page.evaluate("window.tracktool.state.camera")
            with page.expect_download(timeout=180000) as download:
                page.locator("#export").click()
            download.value.save_as(args.output / "export.png")
            exported = next(j for j in app.jobs.values() if j["status"] == "done")
            report["preview_labels"] = labels
            report["export"] = exported["report"]
            report["preview_camera"] = camera
            page.screenshot(path=str(args.output / "editor.png"))
            assert exported["report"]["labels"] == labels
            assert exported["report"]["camera"] == camera
            page.screenshot(path=str(args.output / "editor.png"))
            report["export"] = exported["report"]
            with page.expect_download() as download:
                page.locator("#save-project").click()
            saved_path = args.output / "saved.json"
            download.value.save_as(saved_path)
            saved = page.evaluate("window.tracktool.state")
            page.locator("#basemap").select_option("light")
            expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
            page.locator("#project-file").set_input_files(saved_path)
            page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
            assert page.evaluate("window.tracktool.state") == saved
            assert len(selections) == reads, "camera/source changes re-read KML"
            assert not errors, errors
            assert hashlib.sha256(archive.read_bytes()).hexdigest() == original_hash
            report.update(
                project_roundtrip=True,
                no_kml_reparse=True,
                page_errors=errors,
                scheduler=dict(app.resources.downloads.stats),
            )
            browser.close()
            print(json.dumps(report, ensure_ascii=False), flush=True)
    finally:
        (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        app.shutdown()
        app.server_close()


if __name__ == "__main__":
    main()
