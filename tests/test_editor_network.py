"""LAN Host/Origin validation and internal export destinations, without sockets."""

import json
import sys
from contextlib import nullcontext
from email.message import Message
from types import SimpleNamespace

import pytest

from tracktool.editor import EditorServer, Handler


def handler(destination, host, origin=None, token="session"):
    request = object.__new__(Handler)
    request.server = SimpleNamespace(server_port=8765, token="session")
    request.connection = SimpleNamespace(getsockname=lambda: (destination, 8765))
    request.headers = Message()
    request.headers["Host"] = host
    request.headers["X-Tracktool-Token"] = token
    if origin is not None:
        request.headers["Origin"] = origin
    return request


@pytest.mark.parametrize(
    "address,host",
    [
        ("127.0.0.1", "127.0.0.1:8765"),
        ("127.0.0.1", "localhost:8765"),
        ("192.168.1.20", "192.168.1.20:8765"),
    ],
)
def test_accepts_matching_interface_and_origin(address, host):
    handler(address, host, f"http://{host}")._guard(api=True)


@pytest.mark.parametrize(
    "host,origin,token",
    [
        ("attacker.example:8765", None, "session"),
        ("192.168.1.21:8765", None, "session"),
        ("192.168.1.20:8000", None, "session"),
        ("192.168.1.20:8765", "http://attacker.example", "session"),
        ("192.168.1.20:8765", "http://127.0.0.1:8765", "session"),
        ("192.168.1.20:8765", None, ""),
    ],
)
def test_lan_still_rejects_unknown_host_cross_origin_and_missing_token(host, origin, token):
    with pytest.raises(PermissionError):
        handler("192.168.1.20", host, origin, token)._guard(api=True)


@pytest.mark.parametrize(
    "bind,destination",
    [
        ("0.0.0.0", "127.0.0.1"),
        ("127.0.0.1", "127.0.0.1"),
        ("192.168.1.20", "192.168.1.20"),
    ],
)
def test_export_uses_a_reachable_host_instead_of_wildcard(bind, destination):
    server = object.__new__(EditorServer)
    server.host = bind
    server.server_port = 8765
    assert server.origin == f"http://{destination}:8765"


@pytest.mark.parametrize("config_key", ["archive_path", "kml_zip_path"])
def test_launcher_uses_configured_archive_without_migrating_config(tmp_path, monkeypatch, config_key):
    pytest.importorskip("fontTools.ttLib")
    pytest.importorskip("playwright.sync_api")
    from tracktool import config, editor
    from tracktool.kml.storage import DB_NAME, create_database

    archive = tmp_path / "archive"
    create_database(archive / DB_NAME)
    config_file = tmp_path / "config.json"
    content = json.dumps({config_key: str(archive if config_key == "archive_path" else archive / "Archive.zip")})
    config_file.write_text(content)
    monkeypatch.setattr(config, "default_config_path", lambda: config_file)
    monkeypatch.setattr(sys, "argv", ["tracktool-map", "--no-browser"])
    opened = []

    def server(port, cache, initial, *, host):
        opened.append(initial)
        return nullcontext(
            SimpleNamespace(origin="http://127.0.0.1:8765", host=host, server_port=port, serve_forever=lambda: None)
        )

    monkeypatch.setattr(editor, "EditorServer", server)
    editor.main()
    assert opened == [str(archive)]
    assert config_file.read_text() == content
    assert not (archive / "Archive.zip").exists()
