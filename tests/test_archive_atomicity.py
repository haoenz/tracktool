"""Interrupted storage operations are covered end to end in test_sqlite_storage.
Additional archive transaction regression: rollback on arbitrary insertion error.
"""

import pytest

from tracktool.kml import archive, storage
from tracktool.kml.archive_reader import open_archive


def test_push_transaction_failure_retains_every_source(tmp_path, monkeypatch):
    path = tmp_path / storage.DB_NAME
    storage.create_database(path)
    sources = [tmp_path / f"2026-10-0{i}.kml" for i in (1, 2)]
    for source in sources:
        source.write_bytes(b"raw")
    insert = storage.add_entry
    calls = 0

    def fail(*a, **kw):
        nonlocal calls
        calls += 1
        result = insert(*a, **kw)
        if calls == 2:
            raise KeyboardInterrupt("injected after insertion")
        return result

    monkeypatch.setattr(storage, "add_entry", fail)
    with pytest.raises(KeyboardInterrupt):
        archive.push_compressed_kmls([(s, "Default") for s in sources], path, move=True)
    with open_archive(path) as reader:
        assert reader.list_entries() == []
    assert all(s.read_bytes() == b"raw" for s in sources)
