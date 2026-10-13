"""LAN Host/Origin validation and internal export destinations, without sockets."""

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
