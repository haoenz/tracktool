"""Fixed-view browser measurements with a NEW dedicated cache; never use user cache.

Run with PYTHONPATH=. .venv/bin/python scripts/measure_map_loading.py --output <new-dir>.
Upstream counts measure fetch attempts (including failed calls), not browser requests.
"""

import argparse
import json
import threading
import time
from collections import Counter
from pathlib import Path

from playwright.sync_api import sync_playwright
from requests import Session
from urllib3.connection import HTTPSConnection

from tracktool.drawing.state import default_state
from tracktool.editor import EditorServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cold-pan", action="store_true", help="Also stop in a previously unvisited target extent")
    parser.add_argument(
        "--delay-ms", type=int, default=0, help="Optional injected upstream delay for cancellation checks"
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    server = EditorServer(0, args.output / "cache")
    server.resources.prepare()
    state = default_state(server.resources.versions())
    state.update(camera={"center": [102.72, 25.04], "zoom": 10}, title="昆明 · 加载验证")
    state["style"]["basemap"] = "google-satellite"
    state["output"] = {"width": 960, "height": 720}
    server.jobs["measure"] = {"state": state, "tracks": [], "status": "done", "created": time.monotonic()}
    fetch = server.resources.fetch
    tile = server.resources.tile
    calls = Counter()
    lock = threading.Lock()
    active = 0
    metrics = Counter()
    connect = HTTPSConnection.connect
    send = Session.send

    def counted_connect(connection):
        with lock:
            metrics["https_connections"] += 1
        return connect(connection)

    def counted_send(session, request, **kwargs):
        with lock:
            metrics["http_attempts"] += 1
        return send(session, request, **kwargs)

    HTTPSConnection.connect = counted_connect
    Session.send = counted_send

    def counted_tile(*args, **kwargs):
        nonlocal active
        with lock:
            active += 1
        try:
            return tile(*args, **kwargs)
        finally:
            with lock:
                active -= 1

    def drain():
        deadline = time.monotonic() + 100
        # Also include flights that continue after their last browser consumer aborts.
        while active or bool(getattr(server.resources.downloads, "tasks", {})):
            if time.monotonic() > deadline:
                raise AssertionError("download drain timed out")
            time.sleep(0.05)

    def counted(url):
        with lock:
            calls[url] += 1
        if args.delay_ms:
            time.sleep(args.delay_ms / 1000)
        return fetch(url)

    server.resources.fetch = counted
    server.resources.tile = counted_tile
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    reports = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 960, "height": 720})
            phases = ["cold", "hot", "rapid-pan"] + (["cold-pan"] if args.cold_pan else [])
            for phase in phases:
                before = sum(calls.values())
                before_metrics = metrics.copy()
                start = time.perf_counter()
                if phase in ("rapid-pan", "cold-pan"):
                    page.evaluate(
                        """async (cold) => {
                      const m=window.renderer.map;
                      for(let i=0;i<10;i++) {
                        m.jumpTo({center:[(cold?106.72:102.72)+i*.14,(cold?26.04:25.04)+i*.04],zoom:10+i%2});
                        await new Promise(r=>setTimeout(r,60));
                      }
                      m.jumpTo({center:cold?[105.72,26.04]:[102.72,25.04],zoom:10});
                    }""",
                        phase == "cold-pan",
                    )
                    start = time.perf_counter()
                    page.evaluate("window.renderer.ready()")
                    status = {"ready": True}
                else:
                    page.goto(server.origin + "/render?job=measure")
                    page.locator("body[data-render-status]").wait_for(timeout=90000)
                    status = page.evaluate("window.renderStatus")
                seconds = round(time.perf_counter() - start, 3)
                drain()
                reports.append(
                    {
                        "phase": phase,
                        "seconds": seconds,
                        "upstream": sum(calls.values()) - before,
                        **dict(metrics - before_metrics),
                        "ready": status.get("ready", False),
                        "error": status.get("error"),
                        "scheduler": dict(getattr(server.resources.downloads, "stats", {})),
                    }
                )
                print(reports[-1], flush=True)
                if not status.get("ready"):
                    break
            page.screenshot(path=str(args.output / "preview.png"))
            # A fresh target view shared by preview and the background exporter.
            state["camera"]["center"] = [104.5, 26.5]
            server.jobs["measure"]["state"] = state
            before = sum(calls.values())
            before_calls = calls.copy()
            before_metrics = metrics.copy()
            start = time.perf_counter()
            job = server.submit(state, [])
            page.goto(server.origin + "/render?job=measure")
            page.locator("body[data-render-status]").wait_for(timeout=90000)
            deadline = time.monotonic() + 100
            while server.jobs[job]["status"] in ("queued", "rendering") and time.monotonic() < deadline:
                time.sleep(0.1)
            result = server.jobs[job]
            seconds = round(time.perf_counter() - start, 3)
            drain()
            delta = calls - before_calls
            reports.append(
                {
                    "phase": "preview-export",
                    "seconds": seconds,
                    "upstream": sum(calls.values()) - before,
                    "duplicates": sum(n - 1 for n in delta.values()),
                    **dict(metrics - before_metrics),
                    "status": result["status"],
                    "error": result.get("error"),
                }
            )
            if "png" in result:
                (args.output / "export.png").write_bytes(result["png"])
            print(reports[-1], flush=True)
            browser.close()
    finally:
        (args.output / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2))
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
