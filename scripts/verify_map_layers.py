"""Real Chromium acceptance of composition, saved state, pixels and failures.

Run explicitly (network required): python scripts/verify_map_layers.py --output sandbox/layers/acceptance
Uses an isolated editor and cache; never edits a user's archive.
"""

import argparse
import json
import threading
import time
from pathlib import Path

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import expect, sync_playwright

from tracktool.drawing.state import default_state
from tracktool.editor import EditorServer, Handler
from tracktool.errors import UserInputError

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--cache", type=Path, default=Path("sandbox/layers/cache"))
parser.add_argument("--features-only", action="store_true", help="Verify detailed OSM features and migration")
parser.add_argument("--tail-only", action="store_true", help="Verify empty coverage and fault recovery only")
parser.add_argument("--labelled-only", action="store_true", help="Verify burned-in content suppression")
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)


class FaultHandler(Handler):
    def _get(self, path, query):
        if self.server.fail_layer and path.startswith("/tiles/" + self.server.fail_layer + "/"):
            raise UserInputError("injected thematic tile failure")
        return super()._get(path, query)


app = EditorServer(0, args.cache)
app.RequestHandlerClass = FaultHandler
app.fail_layer = ""
thread = threading.Thread(target=app.serve_forever, daemon=True)
thread.start()
reports = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1800, "height": 1200}, accept_downloads=True)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: print("browser", m.type, m.text[:400], flush=True) if m.type == "error" else None)
        page.on("dialog", lambda d: d.accept())
        page.goto(app.origin)
        page.locator("#initial-loading").wait_for(state="hidden", timeout=90000)
        page.evaluate("window.tracktool.renderer.ready()")

        def state():
            return page.evaluate("window.tracktool.state")

        def ready():
            expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=100000)
            page.evaluate("window.tracktool.renderer.ready()")

        def inspector():
            if page.locator("#output-panel").is_visible():
                page.locator("#leave-export").click()
            page.locator("#toggle-inspector").click()

        def restore(value):
            print("restore", value["style"]["basemap"], value["camera"], flush=True)
            value["versions"] = app.resources.versions()
            path = args.output / "input.json"
            path.write_text(json.dumps(value, ensure_ascii=False))
            page.locator("#status").evaluate("e=>e.textContent=''")
            page.locator("#project-file").set_input_files(path)
            try:
                page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=75000)
            except Exception:
                message = page.locator("#status").inner_text()
                print("RESTORE RETRY", message, flush=True)
                page.screenshot(path=str(args.output / "failure.png"))
                reports.append({"name": "project-restore-retry", "message": message})
                if page.locator("#retry").is_hidden():
                    raise
                page.locator("#retry").click()
                page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
            ready()
            inspector()

        def select(selector, value):
            print("select", selector, value, flush=True)
            page.locator(selector).select_option(value)
            ready()
            if "保留原底图" in page.locator("#status").inner_text():
                reports.append({"name": "transient-retry", "message": page.locator("#status").inner_text()})
                page.locator("#retry").click()
                ready()
            assert "保留原底图" not in page.locator("#status").inner_text(), page.locator("#status").inner_text()

        def check(identity, enabled=True):
            print("overlay", identity, enabled, flush=True)
            page.locator("#overlay-" + identity).set_checked(enabled)
            ready()
            if "保留原底图" in page.locator("#status").inner_text():
                reports.append({"name": "transient-retry", "message": page.locator("#status").inner_text()})
                page.locator("#retry").click()
                ready()
            assert any(o["id"] == identity and o["enabled"] == enabled for o in state()["style"]["overlays"]), (
                page.locator("#status").inner_text()
            )

        def export(name, compare=True):
            page.locator("#open-export").click()
            ready()
            page.locator("#frame").screenshot(path=str(args.output / (name + "-preview.png")))
            with page.expect_download(timeout=150000) as downloaded:
                with page.expect_response("**/api/export") as response:
                    page.locator("#export").click()
            downloaded.value.save_as(args.output / (name + ".png"))
            job = response.value.json()["job"]
            report = page.evaluate(
                """async (id) => {
              const {api}=await import('/static/core.js'); return await api('/api/jobs/'+id);
            }""",
                job,
            )
            assert report["status"] == "done", report
            assert report["report"]["camera"] == state()["camera"]
            assert report["report"]["labels"] == page.evaluate("window.tracktool.renderer.labels")
            preview = Image.open(args.output / (name + "-preview.png")).convert("RGB")
            output = Image.open(args.output / (name + ".png")).convert("RGB")
            assert output.size == (state()["output"]["width"], state()["output"]["height"])
            diff = None
            if compare and output.size == preview.size:
                diff = sum(ImageStat.Stat(ImageChops.difference(preview, output)).mean) / 3
                assert diff < 3, (name, diff)
            reports.append({"name": name, "state": state(), "export": report, "mean_pixel_difference": diff})
            (args.output / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2))
            print(name, "PASS", "pixel difference", diff, flush=True)
            inspector()

        if args.labelled_only:
            labelled = default_state(app.resources.versions())
            labelled["style"]["basemap"] = "osm-standard"
            labelled["style"]["features"].update(
                places="major", road_names="major", water_names="all", peaks="elevation", housenumbers="all"
            )
            labelled["camera"] = {"center": [9.97, 53.54], "zoom": 13}
            labelled["output"] = {"width": 960, "height": 720}
            labelled["title"] = "汉堡港 · 铁路、航标与电网"
            labelled["style"]["overlays"] = [
                {"id": id, "enabled": True, "opacity": 0.6 if id == "openseamap-seamarks" else 1}
                for id in ["openrailwaymap-standard", "openseamap-seamarks", "openinframap-power"]
            ]
            restore(labelled)
            for key in ["roads", "places", "road_names", "buildings", "water_names", "peaks", "housenumbers"]:
                assert page.locator("#feature-" + key).is_disabled()
            assert not page.evaluate("!!window.tracktool.renderer.map.getSource('base')")
            assert (
                page.evaluate("window.tracktool.renderer.map.queryRenderedFeatures({layers:['power-lines']}).length")
                > 0
            )
            export("labelled-osm-themes")
            assert not errors, errors
            browser.close()
            raise SystemExit(0)

        if args.features_only:
            detail = default_state(app.resources.versions())
            detail["output"] = {"width": 960, "height": 720}
            detail["camera"] = {"center": [13.35, 52.525], "zoom": 16.5}
            detail["title"] = "OSM 独立要素 · 建筑、门牌与兴趣点"
            detail["style"]["features"].update(
                places="all", road_names="all", poi="all", housenumbers="all", water_names="all"
            )
            restore(detail)
            for layer in ["housenumbers", "poi", "road-names", "buildings"]:
                assert (
                    page.evaluate(
                        "id => window.tracktool.renderer.map.queryRenderedFeatures({layers:[id]}).length", layer
                    )
                    > 0
                ), layer
            export("osm-detail-berlin")
            select("#feature-roads", "none")
            assert not page.evaluate("!!window.tracktool.renderer.map.getLayer('roads-major')")
            select("#feature-road_names", "none")
            assert not page.evaluate("!!window.tracktool.renderer.map.getLayer('road-names')")
            for value, level in [("country", 2), ("region", 6), ("local", 10)]:
                select("#feature-boundaries", value)
                assert page.evaluate("window.tracktool.renderer.map.getFilter('boundary')")[2] == level
            detail["camera"] = {"center": [7.6586, 45.9763], "zoom": 12}
            detail["title"] = "阿尔卑斯山 · 名称与海拔"
            detail["style"]["features"]["peaks"] = "elevation"
            restore(detail)
            assert page.evaluate("window.tracktool.renderer.map.queryRenderedFeatures({layers:['peaks']}).length") > 0
            export("osm-peaks-alps")
            facilities = default_state(app.resources.versions())
            facilities["output"] = detail["output"]
            facilities["camera"] = {"center": [13.27, 52.53], "zoom": 12}
            facilities["style"]["overlays"] = [{"id": "openinframap-power", "enabled": True, "opacity": 1}]
            restore(facilities)
            positions = page.evaluate("""() => {
              const map=window.tracktool.renderer.map;
              return ['power_plant_point','power_substation_point'].map(sourceLayer => {
                const features=map.querySourceFeatures('openinframap-power',{sourceLayer});
                return features.find(f=>f.properties.name)?.geometry.coordinates || features[0].geometry.coordinates;
              });
            }""")
            for kind, position in zip(["plant", "substation"], positions, strict=True):
                facilities["camera"] = {"center": position, "zoom": 15.5}
                facilities["title"] = "OpenInfraMap · " + kind
                restore(facilities)
                layer = "power-power_plant_point" if kind == "plant" else "power-substation"
                assert (
                    page.evaluate(
                        "id=>window.tracktool.renderer.map.queryRenderedFeatures({layers:[id]}).length", layer
                    )
                    > 0
                )
                export("power-facility-" + kind)
            # Actual old-project file import displays the deterministic migration.
            legacy = default_state(app.resources.versions())
            legacy["schema"] = 1
            legacy["camera"] = {"center": [9.97, 53.54], "zoom": 13}
            legacy["output"] = detail["output"]
            legacy["style"] = {"basemap": "openrailwaymap-standard", "color": "#ff7700", "width": 3, "cities": "county"}
            restore(legacy)
            assert state()["schema"] == 2 and state()["style"]["basemap"] == "light"
            assert "迁" in page.locator("#layer-notice").inner_text()
            export("legacy-railway-migration")
            page.screenshot(path=str(args.output / "layers-desktop.png"))
            page.set_viewport_size({"width": 430, "height": 900})
            page.screenshot(path=str(args.output / "layers-mobile.png"))
            assert not errors, errors
            browser.close()
            raise SystemExit(0)

        initial = default_state(app.resources.versions())
        initial["camera"] = {"center": [9.97, 53.54], "zoom": 13}
        initial["output"] = {"width": 960, "height": 720}
        initial["title"] = "汉堡港 · 铁路、航标与电网"
        initial["style"]["features"].update(places="major", road_names="major", water_names="all")
        if not args.tail_only:
            restore(initial)
            # Basemap menu never contains a transparent-only source.
            options = page.locator("#basemap option").evaluate_all("els=>els.map(e=>e.value)")
            assert "openrailwaymap-standard" not in options and "amap-labels" not in options
            for id in ["openrailwaymap-standard", "openseamap-seamarks", "openinframap-power"]:
                check(id)
            assert (
                page.evaluate("window.tracktool.renderer.map.queryRenderedFeatures({layers:['power-lines']}).length")
                > 0
            )
            assert page.evaluate("window.tracktool.renderer.labels.length") == 0  # OSM owns place labels.
            page.locator("#opacity-openseamap-seamarks").evaluate("e => e.value = '0.6'")
            page.locator("#opacity-openseamap-seamarks").dispatch_event("change")
            ready()
            assert (
                page.evaluate("window.tracktool.renderer.map.getPaintProperty('openseamap-seamarks','raster-opacity')")
                == 0.6
            )
            export("hamburg-light-combined")
            select("#basemap", "dark")
            assert sum(o["enabled"] for o in state()["style"]["overlays"]) == 3
            export("hamburg-dark-combined")
            select("#basemap", "osm-standard")
            assert page.locator("#feature-roads").is_disabled()
            assert not page.locator("#overlay-openinframap-power").is_disabled()
            assert not page.evaluate("!!window.tracktool.renderer.map.getLayer('road-names')")
            export("labelled-osm-themes")
            select("#basemap", "esri-satellite")
            assert not page.locator("#feature-roads").is_disabled()
            export("imagery-osm-themes")
            check("openrailwaymap-standard", False)
            for topic in ["maxspeed", "electrification", "gauge", "signals"]:
                check("openrailwaymap-" + topic)
                export("railway-" + topic)
                check("openrailwaymap-" + topic, False)
            # Saved file preserves enabled flags, opacity and feature/power controls exactly.
            page.locator("#power-controls").evaluate("e=>e.open=true")
            select("#power-voltage", "220")
            select("#power-facilities", "substations")
            saved = state()
            page.locator("#project-menu > summary").click()
            with page.expect_download() as downloaded:
                page.locator("#save-project").click()
            saved_path = args.output / "saved-project.json"
            downloaded.value.save_as(saved_path)
            select("#basemap", "amap-satellite")
            assert all(not o["enabled"] for o in state()["style"]["overlays"])
            assert "坐标系" in page.locator("#layer-notice").inner_text()
            assert page.locator("#overlay-openseamap-seamarks").is_disabled()
            restore(json.loads(saved_path.read_text()))
            assert state() == saved
            # High zoom power facilities, actual data fields and filters.
            power = default_state(app.resources.versions())
            power["camera"] = {"center": [13.269, 52.531], "zoom": 15}
            power["output"] = initial["output"]
            power["style"]["features"].update(places="all", road_names="all", poi="all", housenumbers="all")
            power["style"]["overlays"] = [{"id": "openinframap-power", "enabled": True, "opacity": 0.8}]
            restore(power)
            assert (
                page.evaluate(
                    "window.tracktool.renderer.map.querySourceFeatures('openinframap-power',{sourceLayer:'power_plant'}).length"
                )
                > 0
            )
            export("power-berlin-closeup")
            page.locator("#open-export").click()
            page.locator("#pixels").fill("1920")
            page.locator("#pixels").dispatch_event("change")
            inspector()
            export("power-berlin-1920", compare=False)
            # GCJ and WGS84 representative image combinations at high zoom.
            china = default_state(app.resources.versions())
            china["camera"] = {"center": [100.2309295, 26.8711791], "zoom": 16}
            china["output"] = initial["output"]
            china["title"] = "丽江 · 高缩放组合对齐"
            source_project = Path("sandbox/qr-import/closeup/input-project.json")
            if source_project.exists():
                source = json.loads(source_project.read_text())
                china["archive"] = str(Path("sandbox/New/archive.sqlite3").resolve())
                china["tracks"] = source["tracks"]
            china["style"]["basemap"] = "amap-satellite"
            restore(china)
            for base, overlay in [
                ("amap-satellite", "amap-labels"),
                ("amap-satellite", "amap-roads"),
                ("google-satellite", "google-labels-large"),
                ("tencent-satellite", "tencent-labels"),
                ("esri-satellite", "tianditu-labels"),
            ]:
                select("#basemap", base)
                for entry in state()["style"]["overlays"]:
                    if entry["enabled"]:
                        check(entry["id"], False)
                check(overlay)
                assert state()["tracks"] == china["tracks"] and state()["camera"] == china["camera"]
                export("closeup-" + overlay)
        # Real blank thematic tiles are allowed and remain enabled.
        ocean = default_state(app.resources.versions())
        ocean["camera"] = {"center": [-30, 0], "zoom": 8}
        ocean["output"] = initial["output"]
        ocean["style"]["overlays"] = [
            {"id": id, "enabled": True, "opacity": 1} for id in ["openseamap-seamarks", "openinframap-power"]
        ]
        restore(ocean)
        export("ocean-empty-themes")
        # Inject a missing overlay at server level: preview retains old map; export must fail.
        restore(initial)
        before = state()
        app.fail_layer = "openseamap-seamarks"
        page.locator("#overlay-openseamap-seamarks").check()
        expect(page.locator("#stage")).to_have_attribute("aria-busy", "false", timeout=90000)
        assert state() == before
        assert "保留原底图" in page.locator("#status").inner_text()
        app.fail_layer = ""
        page.locator("#retry").click()
        ready()
        assert any(o["id"] == "openseamap-seamarks" and o["enabled"] for o in state()["style"]["overlays"])
        app.fail_layer = "openseamap-seamarks"
        page.locator("#open-export").click()
        with page.expect_response("**/api/export") as response:
            page.locator("#export").click()
        job = response.value.json()["job"]
        deadline = time.monotonic() + 100
        while app.jobs[job]["status"] not in ["done", "failed"] and time.monotonic() < deadline:
            time.sleep(0.2)
        assert app.jobs[job]["status"] == "failed" and "png" not in app.jobs[job]
        reports.append(
            {"name": "failure-retention-retry-export-rejection", "ok": True, "error": app.jobs[job]["error"]}
        )
        app.fail_layer = ""
        expect(page.locator("#export")).to_have_text("下载 PNG", timeout=30000)
        # A failed project import also retains the old project and retries the target.
        retained = state()
        target = json.loads(json.dumps(initial))
        target["style"]["basemap"] = "dark"
        target["camera"] = {"center": [10.15, 54.33], "zoom": 13}
        target["style"]["overlays"] = [{"id": "openseamap-seamarks", "enabled": True, "opacity": 0.7}]
        app.fail_layer = "openseamap-seamarks"
        target_path = args.output / "failed-target.json"
        target_path.write_text(json.dumps(target))
        page.locator("#project-file").set_input_files(target_path)
        try:
            page.locator("#status").filter(has_text="保留原项目").wait_for(timeout=30000)
        except Exception:
            print("PROJECT FAULT STATUS", page.locator("#status").inner_text(), state(), flush=True)
            raise
        assert state() == retained
        app.fail_layer = ""
        page.locator("#retry").click()
        page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
        ready()
        assert state() == target, {
            k: {"actual": state()[k], "expected": target[k]} for k in target if state()[k] != target[k]
        }
        reports.append({"name": "project-failure-atomic-restore-and-retry", "ok": True})
        (args.output / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2))
        # Last request wins under rapid base changes in an already loaded extent.
        restore(initial)
        inspector()
        page.locator("#basemap").select_option("dark")
        page.locator("#basemap").select_option("light")
        ready()
        assert state()["style"]["basemap"] == "light"
        assert not errors, errors
        reports.append({"name": "rapid-switch-no-script-errors", "ok": True})
        (args.output / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2))
        browser.close()
finally:
    app.shutdown()
    app.server_close()
