"""Local HTTP entry point, optionally shared on LAN. Owns sessions/jobs."""

import argparse
import json
import mimetypes
import secrets
import select
import socket
import threading
import time
import webbrowser
from concurrent.futures import CancelledError, ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Address
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import Config
from .drawing.basemaps import PRESETS
from .drawing.export import render_png
from .drawing.resources import STATIC, Resources
from .drawing.state import default_state
from .errors import UserInputError
from .map_workflow import MapWorkspace


class EditorServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, cache: Path, initial: str = "", *, host: str = "127.0.0.1") -> None:
        self.host = str(IPv4Address(host))
        self.token = secrets.token_urlsafe(32)
        self.workspace = MapWorkspace()
        self.resources = Resources(cache)
        self.resources_ready = False
        self.initial = initial
        self.jobs: dict[str, dict] = {}
        self.jobs_lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="map-export")
        try:
            super().__init__((self.host, port), Handler)
        except BaseException:
            self.executor.shutdown(wait=True, cancel_futures=True)
            self.resources.close()
            raise

    @property
    def origin(self) -> str:
        # Wildcard addresses are bind targets, not browser/export destinations.
        host = "127.0.0.1" if self.host == "0.0.0.0" else self.host
        return f"http://{host}:{self.server_port}"

    def submit(self, state: dict, tracks: list) -> str:
        with self.jobs_lock:
            self.jobs = {
                k: v
                for k, v in self.jobs.items()
                if v["status"] in ("queued", "rendering") or time.monotonic() - v["created"] < 900
            }
            if any(j["status"] in ("queued", "rendering") for j in self.jobs.values()):
                raise UserInputError("已有导出任务，请等待完成后重试")
            while len(self.jobs) >= 5:
                del self.jobs[next(iter(self.jobs))]
            identity = secrets.token_urlsafe(20)
            self.jobs[identity] = {"status": "queued", "created": time.monotonic(), "state": state, "tracks": tracks}
        self.executor.submit(self._export, identity)
        return identity

    def _export(self, identity: str) -> None:
        job = self.jobs[identity]
        job["status"] = "rendering"
        try:
            job["png"], job["report"] = render_png(f"{self.origin}/render?job={identity}", self.token, job["state"])
            job["status"] = "done"
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
            job["status"] = "failed"
        finally:
            job.pop("tracks", None)

    def server_close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.resources.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    server: EditorServer

    def log_message(self, format: str, *args: object) -> None:
        pass  # Requests contain local paths. Keep those out of routine logs.

    def _disconnected(self) -> bool:
        # Native MapLibre fetch abort closes this HTTP/1.0 connection. Poll only
        # while waiting; peeking must not consume the next request's bytes.
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError, ValueError:
            return True

    def _send(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store" if content_type.startswith("application/json") else "no-cache")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; worker-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def _json(self, value: object, status: int = 200) -> None:
        self._send(
            json.dumps(value, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8", status
        )

    def _guard(self, api: bool) -> None:
        # Validate against the actual destination interface, including LAN
        # interfaces when bound to 0.0.0.0. Never trust arbitrary Host names.
        address = self.connection.getsockname()[0]
        allowed = {f"{address}:{self.server.server_port}"}
        if IPv4Address(address).is_loopback:
            allowed.add(f"localhost:{self.server.server_port}")
        host = self.headers.get("Host")
        if host not in allowed:
            raise PermissionError("请使用服务器 IP 地址访问（拒绝未知 Host）")
        if self.headers.get("Origin") not in (None, f"http://{host}"):
            raise PermissionError("拒绝跨站请求")
        if api and not secrets.compare_digest(self.headers.get("X-Tracktool-Token", ""), self.server.token):
            raise PermissionError("本地会话已过期，请刷新页面")

    def do_GET(self) -> None:
        self._handle(False)

    def do_POST(self) -> None:
        self._handle(True)

    def _handle(self, post: bool) -> None:
        try:
            url = urlparse(self.path)
            self._guard(url.path.startswith("/api/") or post)
            if post:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 2 * 1024 * 1024:
                    raise UserInputError("请求体需为 1 B–2 MiB JSON")
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise UserInputError("需要 application/json 请求")
                body = json.loads(self.rfile.read(size))
                self._post(url.path, body)
            else:
                self._get(url.path, parse_qs(url.query))
        except PermissionError as exc:
            self._json({"error": str(exc)}, 403)
        except BrokenPipeError, ConnectionResetError, CancelledError:
            pass
        except (UserInputError, OSError, ValueError, KeyError, TypeError) as exc:
            self._json({"error": str(exc)}, 400)
        except Exception as exc:
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def _get(self, path: str, query: dict) -> None:
        app = self.server
        if path in ("/", "/render"):
            html = (STATIC / ("render.html" if path == "/render" else "index.html")).read_text()
            self._send(html.replace("__TOKEN__", app.token).encode(), "text/html; charset=utf-8")
        elif path == "/api/bootstrap":
            if not app.resources_ready:
                app.resources.prepare()
                app.resources.check_text("".join(label["name"] for label in app.resources.cities["labels"]))
                app.resources_ready = True
            self._json(
                {
                    "config": app.resources.public_config(),
                    "state": default_state(app.resources.versions()),
                    "initialArchive": app.initial,
                    "directory": str(Path.cwd()),
                }
            )
        elif path == "/api/cities":
            self._json(app.resources.cities)
        elif path == "/api/browse":
            folder = Path(query.get("path", [str(Path.cwd())])[0]).expanduser().resolve()
            directories, archives = [], []
            for child in sorted(folder.iterdir(), key=lambda p: p.name.casefold()):
                if child.name.startswith("."):
                    continue
                if child.is_dir():
                    directories.append({"name": child.name, "path": str(child)})
                elif child.name == "archive.sqlite3":
                    archives.append({"name": child.name, "path": str(child)})
            self._json(
                {"path": str(folder), "parent": str(folder.parent), "directories": directories, "archives": archives}
            )
        elif path.startswith("/api/jobs/"):
            identity = path.removeprefix("/api/jobs/").removesuffix("/png")
            job = app.jobs[identity]
            if path.endswith("/png"):
                self._send(job["png"], "image/png")
            else:
                self._json({k: v for k, v in job.items() if k in ("status", "error", "report")})
        elif path.startswith("/api/render/"):
            job = app.jobs[path.removeprefix("/api/render/")]
            self._json({"state": job["state"], "tracks": job["tracks"], "config": app.resources.public_config()})
        elif path.startswith("/tiles/"):
            _, _, source, z, x, y = path.split("/")
            body, mime = app.resources.tile(
                source,
                int(z),
                int(x),
                int(y.split(".")[0]),
                cancelled=self._disconnected,
                export=self.headers.get("X-Tracktool-Render") == app.token,
            )
            self._send(body, mime)
        elif path.startswith("/static/"):
            file = (STATIC / path.removeprefix("/static/")).resolve()
            if not file.is_relative_to(STATIC.resolve()) or not file.is_file():
                raise UserInputError("静态资源不存在")
            self._send(file.read_bytes(), mimetypes.guess_type(file.name)[0] or "application/octet-stream")
        elif path == "/favicon.ico":
            self._send(b"", "image/x-icon", 204)
        else:
            self._json({"error": "未找到页面"}, 404)

    def _post(self, path: str, body: dict) -> None:
        app = self.server
        if path == "/api/archive":
            self._json(app.workspace.catalog(body["path"]))
        elif path == "/api/projects":
            self._json({"names": app.workspace.projects(body["archive"])})
        elif path == "/api/projects/save":
            if body["state"]["versions"] != app.resources.versions():
                raise UserInputError("项目资源版本不同，请先确认使用当前资源")
            app.workspace.save(body["name"], body["state"])
            self._json({"ok": True})
        elif path == "/api/projects/load":
            state, selected = app.workspace.load(body["archive"], body["name"])
            self._json({"state": state, **selected, "versionsChanged": state["versions"] != app.resources.versions()})
        elif path == "/api/basemap-check":
            source = body["id"]
            if source not in PRESETS:
                raise UserInputError("未知内置地图源")
            try:
                app.resources.tile(source, 2, 3, 1)
            except UserInputError as exc:
                raise UserInputError(f"{PRESETS[source]['name']}：{exc}") from None
            self._json({"id": source, "ok": True})
        elif path == "/api/selection":
            self._json(app.workspace.selection(body["archive"], body["entries"]))
        elif path in ("/api/project", "/api/export"):
            state, selected = app.workspace.project(body)
            changed = state["versions"] != app.resources.versions()
            if path == "/api/export":
                if selected["errors"]:
                    raise UserInputError("源轨迹缺失或变化：" + json.dumps(selected["errors"], ensure_ascii=False))
                if changed:
                    raise UserInputError("项目资源版本不同，请在界面确认使用当前资源并另存项目")
                if state["style"]["basemap"] == "satellite" and not app.resources.satellite:
                    raise UserInputError("卫星底图未配置，请选择浅色或深色")
                app.resources.check_text(state["title"])
                self._json({"job": app.submit(state, selected["tracks"])})
            else:
                self._json({"state": state, **selected, "versionsChanged": changed})
        else:
            raise UserInputError("未知操作")


def ipv4_host(value: str) -> str:
    try:
        return str(IPv4Address(value))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("监听地址需为 IPv4，例如 127.0.0.1 或 0.0.0.0") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="Tracktool 本地交互式轨迹地图编辑器")
    parser.add_argument("--host", type=ipv4_host, default="127.0.0.1", help="监听 IPv4；0.0.0.0 允许局域网访问")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--archive", default="", help="SQLite 归档目录或文件；默认打开配置的 archive_path")
    parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/tracktool/maps")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--refresh-basemap", action="store_true", help="更新缓存的底图数据版本")
    args = parser.parse_args()
    try:
        import fontTools.ttLib  # noqa: F401
        import playwright.sync_api  # noqa: F401
    except ImportError:
        parser.error("请先运行 uv sync --extra maps，再运行 uv run --extra maps playwright install chromium")
    initial = args.archive
    if not initial:
        configured = str(Config().load(persist_migration=False)["archive_path"] or "")
        if configured and (Path(configured).expanduser() / "archive.sqlite3").is_file():
            initial = str(Path(configured).expanduser().resolve())
    with EditorServer(args.port, args.cache, initial, host=args.host) as server:
        if args.refresh_basemap:
            server.resources.prepare(refresh=True)
        print(
            f"Tracktool 地图编辑器：{server.origin}（监听 {server.host}:{server.server_port}；Ctrl+C 停止）", flush=True
        )
        if not IPv4Address(server.host).is_loopback:
            print(f"局域网设备访问 http://<本机局域网 IPv4>:{server.server_port}；归档从服务端电脑读取。", flush=True)
        if not args.no_browser:
            webbrowser.open(server.origin)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
