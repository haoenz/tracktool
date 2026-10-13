"""Exclusive session leases: reusable HTTPS connections without shared mutable Sessions."""

import queue
import random
import threading
import time
from urllib.parse import urlparse

import requests

from ..errors import UserInputError


class Transport:
    def __init__(self, size: int) -> None:
        self.sessions: queue.LifoQueue = queue.LifoQueue(size)
        for _ in range(size):
            session = requests.Session()
            session.headers["User-Agent"] = "tracktool-map/1.0 (local interactive map editor)"
            session.mount(
                "https://", requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=1, pool_block=True)
            )
            self.sessions.put(session)
        self.size = size
        self.policy_lock = threading.Lock()
        self.railway_cooldown = 0.0
        self.railway_failures = 0

    def fetch(self, url: str) -> bytes:
        if urlparse(url).scheme != "https":
            raise UserInputError("地图数据源必须使用 HTTPS")
        session = self.sessions.get(timeout=90)
        railway = urlparse(url).hostname == "tiles.openrailwaymap.org"
        try:
            if railway:
                with self.policy_lock:
                    if time.monotonic() < self.railway_cooldown:
                        raise UserInputError("铁路服务冷却中，请稍后重试")
            for attempt in range(1 if railway else 3):
                try:
                    with session.get(
                        url, timeout=(5, 5) if railway else (5, 10), stream=True, allow_redirects=False
                    ) as response:
                        if 300 <= response.status_code < 400:
                            raise UserInputError("地图服务要求重定向；为避免转发地图凭据，本次请求已停止")
                        if railway and response.status_code == 429:
                            retry = response.headers.get("Retry-After", "")
                            with self.policy_lock:
                                self.railway_cooldown = time.monotonic() + max(
                                    60, int(retry) if retry.isdecimal() else 60
                                )
                            raise UserInputError("铁路服务限流，已停止请求，至少一分钟后重试")
                        if not railway and response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                            retry = response.headers.get("Retry-After", "")
                            # Never ignore a provider's long cooldown by retrying earlier.
                            if retry and (not retry.isdecimal() or int(retry) > 2):
                                raise UserInputError("地图服务限流，请稍后重试")
                            response.close()
                            time.sleep(max(float(retry or 0), 0.2 * 2**attempt) + random.uniform(0, 0.1))
                            continue
                        response.raise_for_status()
                        data = bytearray()
                        deadline = time.monotonic() + 20
                        for chunk in response.iter_content(65536):
                            data.extend(chunk)
                            if len(data) > 16 * 1024 * 1024:
                                raise UserInputError("地图资源超过单文件 16 MiB 限制")
                            if time.monotonic() > deadline:
                                raise UserInputError("地图资源下载超时，请重试")
                        if railway:
                            with self.policy_lock:
                                self.railway_failures = 0
                        return bytes(data)
                except requests.HTTPError as exc:
                    if railway:
                        self._railway_failed()
                    code = exc.response.status_code if exc.response is not None else "未知"
                    raise UserInputError(f"地图服务返回 HTTP {code}；请重试或更换底图") from None
                except requests.RequestException as exc:
                    if railway:
                        self._railway_failed()
                    if railway or attempt == 2:
                        raise UserInputError(f"地图资源下载失败（{type(exc).__name__}），检查网络后重试") from None
                    time.sleep(0.2 * 2**attempt)
            raise AssertionError("unreachable")
        finally:
            # A lease is used by only one thread at a time; no cookies cross requests.
            session.cookies.clear()
            self.sessions.put(session)

    def _railway_failed(self) -> None:
        with self.policy_lock:
            self.railway_failures += 1
            if self.railway_failures >= 3:
                self.railway_cooldown = time.monotonic() + 30

    def close(self) -> None:
        for _ in range(self.size):
            self.sessions.get(timeout=90).close()
