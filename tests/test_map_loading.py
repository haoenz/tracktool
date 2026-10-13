"""Concurrency and persistence contracts, using separate temporary caches only."""

import hashlib
import threading
import time
from collections import Counter
from concurrent.futures import CancelledError, ThreadPoolExecutor
from io import BytesIO

import pytest

from tracktool.drawing.basemaps import PRESETS, tile_url
from tracktool.drawing.downloads import Downloads
from tracktool.drawing.resources import Resources
from tracktool.drawing.tilecache import TileCache
from tracktool.drawing.transport import Transport
from tracktool.errors import UserInputError


def until(predicate):
    deadline = time.monotonic() + 5
    while not predicate():
        assert time.monotonic() < deadline, "condition timed out"
        time.sleep(0.005)


@pytest.fixture
def raster():
    image = pytest.importorskip("PIL.Image")
    output = BytesIO()
    image.new("RGB", (256, 256), "green").save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def resources(tmp_path):
    resource = Resources(tmp_path)
    yield resource
    resource.close()


def test_single_flight_preview_export_and_individual_cancellation(resources, raster, monkeypatch):
    release = threading.Event()
    cancelled = threading.Event()
    calls = []

    def fetch(url):
        calls.append(url)
        assert release.wait(5)
        return raster

    monkeypatch.setattr(resources, "fetch", fetch)
    with ThreadPoolExecutor(3) as pool:
        first = pool.submit(resources.tile, "google-road", 4, 3, 5, cancelled=cancelled.is_set)
        until(lambda: len(calls) == 1)
        second = pool.submit(resources.tile, "google-road", 4, 3, 5, export=True)
        third = pool.submit(resources.tile, "google-road", 4, 3, 5)
        until(lambda: resources.downloads.stats["shared"] == 2)
        cancelled.set()
        with pytest.raises(CancelledError):
            first.result(5)
        release.set()
        assert second.result(5) == third.result(5) == (raster, "image/png")
    assert len(calls) == 1
    assert resources.tile("google-road", 4, 3, 5) == (raster, "image/png")
    assert len(calls) == 1


def test_failed_flight_wakes_everyone_and_can_retry(resources, raster, monkeypatch):
    release = threading.Event()

    def broken(url):
        assert release.wait(5)
        return b"<html>error</html>"

    monkeypatch.setattr(resources, "fetch", broken)
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(resources.tile, "google-road", 4, 3, 5) for _ in range(2)]
        until(lambda: resources.downloads.stats["shared"] == 1)
        release.set()
        for future in futures:
            with pytest.raises(UserInputError, match="无效图片"):
                future.result(5)
    assert resources.tiles.db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0] == 0
    monkeypatch.setattr(resources, "fetch", lambda url: raster)
    assert resources.tile("google-road", 4, 3, 5)[0] == raster


def test_limits_skip_obsolete_queue_and_export_fairness():
    queue = Downloads(3, {"google": 2, "bing": 1, "custom": 1})
    gate = threading.Event()
    cancelled = threading.Event()
    active, peaks, order = Counter(), Counter(), []
    lock = threading.Lock()

    def run(provider, identity, block=False):
        with lock:
            active[provider] += 1
            active["total"] += 1
            for key in active:
                peaks[key] = max(peaks[key], active[key])
            order.append(identity)
        if block:
            assert gate.wait(5)
        with lock:
            active[provider] -= 1
            active["total"] -= 1
        return identity

    try:
        with ThreadPoolExecutor(16) as pool:
            initial = [
                pool.submit(queue.load, str(i), p, lambda p=p, i=i: run(p, i, True), lambda: False, False)
                for i, p in enumerate(["google", "google", "bing"])
            ]
            until(lambda: active["total"] == 3)
            stale = pool.submit(
                queue.load,
                "stale",
                "google",
                lambda: pytest.fail("obsolete request downloaded"),
                cancelled.is_set,
                False,
            )
            queued = [
                pool.submit(queue.load, str(i), "google", lambda i=i: run("google", i), lambda: False, False)
                for i in range(3, 10)
            ]
            export = pool.submit(queue.load, "export", "google", lambda: run("google", "export"), lambda: False, True)
            until(lambda: len(queue.tasks) == 12)
            cancelled.set()
            with pytest.raises(CancelledError):
                stale.result(5)
            gate.set()
            assert export.result(5) == "export"
            for future in initial + queued:
                future.result(5)
        assert peaks == {"google": 2, "bing": 1, "total": 3}
        assert order.index("export") <= 5  # Never waits behind the entire preview queue.
        assert queue.stats["skipped"] == 1
    finally:
        gate.set()
        queue.close()


def test_queue_capacity_shutdown_and_cancelled_waiters():
    queue = Downloads(1, {"custom": 1}, max_pending=1)
    gate = threading.Event()
    started = threading.Event()

    def run():
        started.set()
        gate.wait(5)

    try:
        with ThreadPoolExecutor(1) as pool:
            future = pool.submit(queue.load, "one", "custom", run, lambda: False, False)
            assert started.wait(5)
            with pytest.raises(UserInputError, match="队列已满"):
                queue.load("two", "custom", run, lambda: False, False)
            gate.set()
            future.result(5)
    finally:
        gate.set()
        queue.close()
    with pytest.raises(CancelledError):
        queue.load("closed", "custom", run, lambda: False, False)


def test_cancelling_a_queued_preview_does_not_cancel_its_export_consumer():
    queue = Downloads(1, {"custom": 1})
    gate, cancelled, started = threading.Event(), threading.Event(), threading.Event()

    def block():
        started.set()
        assert gate.wait(5)

    try:
        with ThreadPoolExecutor(3) as pool:
            first = pool.submit(queue.load, "running", "custom", block, lambda: False, False)
            assert started.wait(5)
            preview = pool.submit(queue.load, "shared", "custom", lambda: b"tile", cancelled.is_set, False)
            export = pool.submit(queue.load, "shared", "custom", lambda: b"tile", lambda: False, True)
            until(lambda: queue.stats["shared"] == 1)
            cancelled.set()
            with pytest.raises(CancelledError):
                preview.result(5)
            gate.set()
            assert export.result(5) == b"tile"
            first.result(5)
        assert queue.stats["started"] == 2
    finally:
        gate.set()
        queue.close()


def test_cache_lru_restart_and_transaction_rollback(tmp_path):
    cache = TileCache(tmp_path, 8)
    cache.put("a", b"aaaa")
    cache.put("b", b"bbbb")
    assert cache.get("a") == b"aaaa"
    cache.put("c", b"cccc")
    assert cache.get("b") is None
    cache.put("oversize", b"x" * 9)
    assert cache.get("oversize") is None
    cache.db.execute("BEGIN IMMEDIATE")
    cache.db.execute("DELETE FROM tiles")
    # Closing an interrupted transaction must roll back, including the size trigger.
    cache.db.close()
    recovered = TileCache(tmp_path, 8)
    assert recovered.get("a") == b"aaaa" and recovered.get("c") == b"cccc"
    assert recovered.db.execute("SELECT size FROM accounting").fetchone()[0] == 8
    recovered.close()


def test_cache_process_interruption_and_shared_writes(tmp_path):
    import subprocess
    import sys

    cache = TileCache(tmp_path, 40)
    cache.put("original", b"safe")
    cache.close()
    subprocess.run(
        [
            sys.executable,
            "-c",
            """
import os, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('BEGIN IMMEDIATE')
db.execute('DELETE FROM tiles')
os._exit(0)
""",
            str(tmp_path / "tiles.sqlite3"),
        ],
        check=True,
    )
    one, two = TileCache(tmp_path, 40), TileCache(tmp_path, 40)
    try:
        assert one.get("original") == b"safe"
        with ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(c.put, str(i), b"0123456789") for i in range(20) for c in (one, two)]
            for future in futures:
                future.result(5)
        assert one.db.execute("SELECT size FROM accounting").fetchone()[0] <= 40
        assert one.db.execute("SELECT SUM(size) FROM tiles").fetchone()[0] <= 40
    finally:
        one.close()
        two.close()


def test_cache_download_path_never_scans_directory(resources, raster, monkeypatch):
    from pathlib import Path

    monkeypatch.setattr(resources, "fetch", lambda url: raster)
    monkeypatch.setattr(Path, "glob", lambda *args: pytest.fail("per-download directory scan"))
    resources.tile("google-road", 4, 3, 5)
    resources.tile("google-road", 4, 4, 5)
    resources.tile("google-road", 4, 3, 5)


def test_legacy_cache_reuse_and_corrupt_entry_refetch(tmp_path, raster, monkeypatch):
    identity = hashlib.sha256(tile_url(PRESETS["google-road"], 4, 3, 5).encode()).hexdigest()
    (tmp_path / f"{identity}.tile").write_bytes(raster)
    resource = Resources(tmp_path)
    calls = []
    monkeypatch.setattr(resource, "fetch", lambda url: calls.append(url) or raster)
    try:
        assert resource.tile("google-road", 4, 3, 5)[0] == raster
        assert not calls
        assert not (tmp_path / f"{identity}.tile").exists()
        with resource.tiles.db:
            resource.tiles.db.execute("UPDATE tiles SET data=?", (b"error",))
        assert resource.tile("google-road", 4, 3, 5)[0] == raster
        assert len(calls) == 1
    finally:
        resource.close()
    reopened = Resources(tmp_path)
    monkeypatch.setattr(reopened, "fetch", lambda url: pytest.fail("restart lost valid cache"))
    try:
        assert reopened.tile("google-road", 4, 3, 5)[0] == raster
    finally:
        reopened.close()


def test_content_configuration_changes_cache_identity(resources, raster, monkeypatch):
    calls = []
    monkeypatch.setattr(resources, "fetch", lambda url: calls.append(url) or raster)
    resources.satellite = "https://example.org/{z}/{x}/{y}"
    resources.satellite_version = "1"
    resources.tile("satellite", 4, 3, 5)
    resources.satellite_version = "2"
    resources.tile("satellite", 4, 3, 5)
    assert len(calls) == 2


@pytest.mark.parametrize(
    "name,value",
    [
        ("TRACKTOOL_MAP_DOWNLOADS", "0"),
        ("TRACKTOOL_MAP_CACHE_MIB", "invalid"),
        ("TRACKTOOL_MAP_PROVIDER_LIMITS", '{"google":0}'),
        ("TRACKTOOL_MAP_PROVIDER_LIMITS", "[]"),
    ],
)
def test_invalid_configuration_rejected_without_echoing_values(tmp_path, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(UserInputError, match=name):
        Resources(tmp_path)


def test_version_metadata_never_exposes_credentials(resources):
    import json

    resources.vector = {"tiles": ["https://tiles.openfreemap.org/a?secret=private-test-key"]}
    assert "private-test-key" not in json.dumps(resources.public_config())


@pytest.mark.parametrize("data", [b"<html>error</html>", b"", b"\x1a\xff", b"\x1a\x03foo"])
def test_vector_validation_rejects_errors(data):
    with pytest.raises(UserInputError):
        Resources._validate("vector", data)


def test_transport_bounded_retry_redirect_and_session_reuse(monkeypatch):
    from requests import Response

    transport = Transport(1)
    session = transport.sessions.queue[0]
    calls = []
    codes = iter([429, 503, 200, 302, 503, 503, 503])

    def get(url, **kwargs):
        calls.append(kwargs)
        response = Response()
        response.status_code = next(codes)
        response._content = b"image"
        response._content_consumed = True
        return response

    monkeypatch.setattr(session, "get", get)
    monkeypatch.setattr("tracktool.drawing.transport.time.sleep", lambda _: None)
    try:
        assert transport.fetch("https://example.org") == b"image"
        assert len(calls) == 3
        with pytest.raises(UserInputError, match="重定向"):
            transport.fetch("https://example.org")
        with pytest.raises(UserInputError, match="503"):
            transport.fetch("https://example.org")
        assert len(calls) == 7
        assert all(c["allow_redirects"] is False and c["timeout"] == (5, 10) for c in calls)
        assert transport.sessions.queue[0] is session
    finally:
        transport.close()


def test_railway_rate_limit_stops_retries_and_queued_network(monkeypatch):
    from requests import Response

    transport = Transport(1)
    calls = []

    def get(url, **kwargs):
        calls.append(kwargs)
        response = Response()
        response.status_code = 429
        response.headers["Retry-After"] = "120"
        response._content = b"busy"
        response._content_consumed = True
        return response

    monkeypatch.setattr(transport.sessions.queue[0], "get", get)
    try:
        with pytest.raises(UserInputError, match="限流"):
            transport.fetch("https://tiles.openrailwaymap.org/standard/0/0/0.png")
        with pytest.raises(UserInputError, match="冷却"):
            transport.fetch("https://tiles.openrailwaymap.org/signals/0/0/0.png")
        assert len(calls) == 1 and calls[0]["timeout"] == (5, 5)
    finally:
        transport.close()


def test_empty_power_tile_is_cached_but_other_empty_sources_are_rejected(resources, monkeypatch):
    calls = []
    monkeypatch.setattr(resources, "fetch", lambda url: calls.append(url) or b"")
    assert resources.tile("openinframap-power", 8, 106, 128) == (b"", "application/x-protobuf")
    assert resources.tile("openinframap-power", 8, 106, 128) == (b"", "application/x-protobuf")
    assert len(calls) == 1
    with pytest.raises(UserInputError, match="空瓦片"):
        resources.tile("openseamap-seamarks", 8, 106, 128)
