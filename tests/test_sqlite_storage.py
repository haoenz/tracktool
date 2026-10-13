"""SQLite acceptance: raw identity, snapshot exports, durable file intents, index lifecycle."""

import hashlib
import math
import os
import sqlite3
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.cli import app
from tracktool.context import ctx
from tracktool.drawing.state import default_state
from tracktool.errors import UserInputError
from tracktool.kml import archive, index, storage, trackdata, xmlutil
from tracktool.kml.archive_reader import open_archive
from tracktool.map_workflow import MapWorkspace

COMPLEX = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"
 xmlns:custom="urn:extra"><Document><name>原始中文</name>
<ExtendedData><Data name="TrackTags"><value>火车</value></Data>
<Data name="unknown"><value><![CDATA[a<b & c]]></value></Data></ExtendedData>
<Style id="keep"><LineStyle><color>ff0000ff</color><width>4.25</width></LineStyle></Style>
<custom:opaque foo="bar">untouched</custom:opaque>
<Placemark id="p"><name>多段</name><description><![CDATA[<b>描述</b>]]></description><styleUrl>#keep</styleUrl>
<MultiGeometry><LineString id="a"><coordinates>100,26 101,27,0 102,28,8.25</coordinates></LineString>
<gx:Track id="b"><when>2026-10-01T00:00:00.123456789Z</when><when>2026-10-01T08:00:01+08:00</when>
<gx:coord>103 29 9</gx:coord><gx:coord>104 30</gx:coord></gx:Track>
<LineString><coordinates>105,31</coordinates></LineString>
<Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 0,1 0,0</coordinates>
</LinearRing></outerBoundaryIs></Polygon>
</MultiGeometry></Placemark></Document></kml>""".encode()
UNSUPPORTED = b'<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>'


def members(path):
    with zipfile.ZipFile(path) as zf:
        return {i.filename: hashlib.sha256(zf.read(i)).hexdigest() for i in zf.infolist() if not i.is_dir()}


def db_at(tmp_path):
    path = tmp_path / storage.DB_NAME
    storage.create_database(path)
    return path


def insert(path, name="Train/2026-10/2026-10-01 中文.kml", raw=COMPLEX, kind="Train"):
    with storage.connect(path, write=True) as db:
        return storage.add_entry(db, name, raw, kind)


def test_zip_sqlite_zip_fresh_sqlite_zip_exact_bytes_and_paths(tmp_path):
    old = tmp_path / "old.zip"
    content = {
        "Train/2026-10/2026-10-01 中文.kml": COMPLEX,
        "Default/副本.KML": COMPLEX,
        "_unclassified/点.kml": UNSUPPORTED,
        "未知/未解析.kml": b"invalid XML\x00",
        "Case.kml": b"A",
        "case.kml": b"B",
    }
    with zipfile.ZipFile(old, "w") as zf:
        for name, raw in content.items():
            zf.writestr(name, raw)
    original = old.read_bytes()
    first = tmp_path / "one" / storage.DB_NAME
    storage.create_database(first, old)
    with storage.connect(first) as db:
        assert db.execute("SELECT count(*) FROM archive_entries").fetchone()[0] == 6
        assert db.execute("SELECT count(*) FROM kml_objects").fetchone()[0] == 5
        assert dict(db.execute("SELECT path,category FROM archive_entries"))["Default/副本.KML"] == "Default"
    one = tmp_path / "one.zip"
    storage.export_zip(first, one)
    second = tmp_path / "new-machine" / storage.DB_NAME
    storage.create_database(second, one)
    two = tmp_path / "two.zip"
    storage.export_zip(second, two)
    assert members(old) == members(one) == members(two)
    assert old.read_bytes() == original
    with zipfile.ZipFile(two) as zf:
        assert {name: zf.read(name) for name in content} == content
    assert not (second.parent / "archive.json").exists()


@pytest.mark.parametrize("name", ["../escape.kml", "/absolute.kml", "a//b.kml", "a/./b.kml", r"a\b.kml", "C:/bad.kml"])
def test_import_illegal_paths_never_publishes(tmp_path, name):
    old = tmp_path / "bad.zip"
    with zipfile.ZipFile(old, "w") as zf:
        zf.writestr(name, COMPLEX)
    target = tmp_path / "dest" / storage.DB_NAME
    with pytest.raises(UserInputError, match="Illegal"):
        storage.create_database(target, old)
    assert not target.exists()
    assert not list(target.parent.iterdir())


@pytest.mark.parametrize("problem", ["duplicate", "crc", "invalid-zip", "non-kml", "symlink"])
def test_import_validates_all_content_before_publication(tmp_path, problem):
    old = tmp_path / "bad.zip"
    with zipfile.ZipFile(old, "w") as zf:
        zf.writestr("ok.kml", COMPLEX)
        if problem == "duplicate":
            with pytest.warns(UserWarning):
                zf.writestr("ok.kml", b"different")
        elif problem == "non-kml":
            zf.writestr("secret.txt", b"x")
        elif problem == "symlink":
            info = zipfile.ZipInfo("link.kml")
            info.external_attr = 0o120777 << 16
            zf.writestr(info, b"target")
    if problem == "crc":
        old.write_bytes(old.read_bytes().replace(b"untouched", b"corrupted"))
    elif problem == "invalid-zip":
        old.write_bytes(b"broken")
    target = tmp_path / "dest" / storage.DB_NAME
    with pytest.raises(UserInputError):
        storage.create_database(target, old)
    assert not target.exists()


def test_existing_database_never_overwritten_and_flat_classification_ignores_config(tmp_path):
    old = tmp_path / "old.zip"
    with zipfile.ZipFile(old, "w") as zf:
        zf.writestr("2026-10-01 flat.kml", COMPLEX)
    ctx.config["track_tag.Default"] = ["火车"]
    db = tmp_path / storage.DB_NAME
    storage.create_database(db, old)
    before = db.read_bytes()
    with pytest.raises(UserInputError, match="already exists"):
        storage.create_database(db, old)
    assert db.read_bytes() == before
    with storage.connect(db) as conn:
        assert conn.execute("SELECT category FROM archive_entries").fetchone()[0] == "Train"


@pytest.mark.parametrize("failure", ["write", "verify", "replace", "fsync"])
def test_failed_export_preserves_existing_zip(tmp_path, monkeypatch, failure):
    path = db_at(tmp_path)
    insert(path)
    target = tmp_path / "Archive.zip"
    storage.export_zip(path, target)
    before = target.read_bytes()
    insert(path, "new.kml", b"other")

    def fail(*a, **k):
        raise OSError("injected")

    with monkeypatch.context() as patch:
        if failure == "write":
            patch.setattr(zipfile.ZipFile, "writestr", fail)
        elif failure == "verify":
            patch.setattr(zipfile.ZipFile, "read", fail)
        else:
            patch.setattr(os, "replace" if failure == "replace" else "fsync", fail)
        with pytest.raises(OSError):
            storage.export_zip(path, target)
    assert target.read_bytes() == before
    assert not list(tmp_path.glob(".archive-export-*"))
    with storage.connect(path) as db:
        meta = db.execute("SELECT * FROM archive_meta").fetchone()
        assert meta["zip_revision"] < meta["revision"]


def test_snapshot_export_concurrent_writer_does_not_claim_latest(tmp_path, monkeypatch):
    path = db_at(tmp_path)
    insert(path, "old.kml")
    write = zipfile.ZipFile.writestr
    fired = False

    def concurrent(zf, *args, **kwargs):
        nonlocal fired
        if not fired:
            fired = True
            with ThreadPoolExecutor(1) as pool:
                pool.submit(insert, path, "new.kml", b"new").result(timeout=10)
        return write(zf, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "writestr", concurrent)
    target = tmp_path / "Archive.zip"
    assert storage.export_zip(path, target) == 1
    assert set(members(target)) == {"old.kml"}
    with storage.connect(path) as db:
        assert tuple(db.execute("SELECT revision,zip_revision FROM archive_meta").fetchone()) == (2, 1)


def test_snapshot_reader_and_write_competition(tmp_path):
    path = db_at(tmp_path)
    insert(path, "old.kml")
    with open_archive(path) as reader:
        assert len(reader.list_entries()) == 1
        with ThreadPoolExecutor(4) as pool:
            list(pool.map(lambda i: insert(path, f"{i}.kml"), range(10)))
        assert len(reader.list_entries()) == 1
        assert reader.read_bytes("old.kml") == COMPLEX
    with open_archive(path) as reader:
        assert len(reader.list_entries()) == 11
    with pytest.raises(UserInputError, match="closed"):
        reader.list_entries()


def test_old_time_mismatch_error_rebuilds_as_untimed_geometry(tmp_path, monkeypatch):
    path = db_at(tmp_path)
    raw = COMPLEX.replace(b'<gx:Track id="b">', b'<gx:Track id="b"><when>extra</when>')
    insert(path, "mismatch.kml", raw)
    digest = hashlib.sha256(raw).hexdigest()
    with storage.connect(path, write=True) as db:
        revision = db.execute("SELECT revision FROM archive_meta").fetchone()[0]
        db.execute(
            "INSERT INTO kml_index VALUES (?,?,?,?,?,?)",
            (digest, 1, "error", "{}", None, "2 coordinates but 3 timestamps"),
        )
    with open_archive(path) as reader:
        data = reader.read_track_data("mismatch.kml")
    segment = data.tracks[0].segments[1]
    assert list(segment.longitude) == [103, 104]
    assert list(segment.latitude) == [29, 30]
    assert segment.time_us is None
    with storage.connect(path) as db:
        assert db.execute("SELECT revision FROM archive_meta").fetchone()[0] == revision
        assert storage.read_object(db, digest) == raw
        assert [tuple(r) for r in db.execute("SELECT parser_version,status FROM kml_index")] == [
            (index.PARSER_VERSION, "ok")
        ]

    def unexpected_parse(*args, **kwargs):
        pytest.fail("Reopened database should reuse the persistent index")

    monkeypatch.setattr(trackdata, "track_data_from_tree", unexpected_parse)
    with open_archive(path) as reader:
        cached = reader.read_track_data("mismatch.kml").tracks[0].segments[1]
        assert cached.longitude == segment.longitude
        assert cached.time_us is None


def test_index_persists_precise_arrays_and_only_content_version_invalidates(tmp_path, monkeypatch):
    path = db_at(tmp_path)
    insert(path, "a.kml")
    calls = []
    parse = trackdata.track_data_from_tree

    def counted(*a, **kw):
        calls.append(1)
        return parse(*a, **kw)

    monkeypatch.setattr(trackdata, "track_data_from_tree", counted)
    with open_archive(path) as reader:
        original = reader.read_track_data("a.kml")
    assert len(calls) == 1
    insert(path, "same-content.kml")
    insert(path, "other.kml", b"invalid")
    with open_archive(path) as reader:
        loaded = reader.read_track_data("same-content.kml")
    assert len(calls) == 1
    assert len(loaded.tracks[0].segments) == 3
    for a, b in zip(original.tracks[0].segments, loaded.tracks[0].segments, strict=True):
        assert a.longitude.tobytes() == b.longitude.tobytes()
        assert a.latitude.tobytes() == b.latitude.tobytes()
        assert (a.time_us.tobytes() if a.time_us else None) == (b.time_us.tobytes() if b.time_us else None)
        assert (a.altitude.tobytes() if a.altitude else None) == (b.altitude.tobytes() if b.altitude else None)
    assert math.isnan(loaded.tracks[0].segments[0].altitude[0])
    assert loaded.tracks[0].segments[1].time_us[0] % 1_000_000 == 123456
    monkeypatch.setattr(index, "PARSER_VERSION", index.PARSER_VERSION + 1)
    with open_archive(path) as reader:
        reader.read_track_data("a.kml")
    assert len(calls) == 2


def test_unsupported_and_invalid_kml_are_indexed_as_errors_but_exported(tmp_path):
    path = db_at(tmp_path)
    insert(path, "point.kml", UNSUPPORTED)
    insert(path, "bad.kml", b"bad")
    for _ in range(2):
        with open_archive(path) as reader:
            for name in ["point.kml", "bad.kml"]:
                with pytest.raises(UserInputError):
                    reader.read_track_data(name)
    with storage.connect(path) as db:
        assert [r[0] for r in db.execute("SELECT status FROM kml_index")] == ["error", "error"]
    out = tmp_path / "backup.zip"
    storage.export_zip(path, out)
    assert len(members(out)) == 2


@pytest.mark.parametrize("operation", ["push", "pop"])
@pytest.mark.parametrize("phase", ["before-output", "after-output", "after-unlink"])
def test_interruption_recovery_never_loses_only_copy(tmp_path, monkeypatch, operation, phase):
    path = db_at(tmp_path)
    identity, digest, _ = insert(path, "x.kml")
    source = tmp_path / "source.kml"
    source.write_bytes(COMPLEX)
    target = tmp_path / "output" / "target.kml"
    with storage.connect(path, write=True) as db:
        storage.queue_operation(db, operation, identity, digest, target, source if operation == "push" else None)
    publish = storage.write_exclusive
    unlink = Path.unlink

    def interrupted(target, raw):
        if phase != "before-output":
            publish(target, raw)
        raise KeyboardInterrupt("simulated power interruption")

    def interrupted_unlink(file, *a, **kw):
        result = unlink(file, *a, **kw)
        if file == source:
            raise KeyboardInterrupt("after unlink")
        return result

    with monkeypatch.context() as patch:
        if phase == "after-unlink" and operation == "push":
            patch.setattr(Path, "unlink", interrupted_unlink)
        else:
            patch.setattr(storage, "write_exclusive", interrupted)
        with pytest.raises(KeyboardInterrupt):
            storage.recover(path)
    with storage.connect(path) as db:
        assert storage.read_object(db, digest) == COMPLEX
        assert db.execute("SELECT count(*) FROM file_operations").fetchone()[0] == 1
    assert storage.recover(path) == 1
    assert target.read_bytes() == COMPLEX
    assert storage.recover(path) == 0
    with storage.connect(path) as db:
        assert db.execute("SELECT count(*) FROM archive_entries").fetchone()[0] == (1 if operation == "push" else 0)


def test_recovery_conflicts_keep_intent_and_changed_source(tmp_path):
    path = db_at(tmp_path)
    identity, digest, _ = insert(path)
    source = tmp_path / "source.kml"
    source.write_bytes(b"changed")
    target = tmp_path / "Backup" / "a.kml"
    with storage.connect(path, write=True) as db:
        storage.queue_operation(db, "push", identity, digest, target, source)
    with pytest.raises(UserInputError, match="Source changed"):
        storage.recover(path)
    assert source.read_bytes() == b"changed" and target.read_bytes() == COMPLEX
    with storage.connect(path) as db:
        assert db.execute("SELECT count(*) FROM file_operations").fetchone()[0] == 1


def test_revision_changes_only_for_members_and_projects_survive_reopen(tmp_path):
    path = db_at(tmp_path)
    insert(path, "a.kml")
    work = MapWorkspace()
    chosen = work.selection(str(path), ["a.kml"])
    state = default_state({"renderer": "test"})
    state.update(archive=str(path), tracks=[{k: chosen["tracks"][0][k] for k in ("entry", "sha256")}])
    work.save("中文项目", state)
    assert MapWorkspace().load(str(path), "中文项目")[0] == state
    assert work.projects(str(path)) == ["中文项目"]
    with storage.connect(path) as db:
        assert db.execute("SELECT revision FROM archive_meta").fetchone()[0] == 1


def test_explicit_schema_migration_is_atomic(tmp_path, monkeypatch):
    path = db_at(tmp_path)
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE export_receipts")
        db.execute("DROP INDEX operation_source")
        db.execute("DROP INDEX operation_entry")
        db.execute("CREATE UNIQUE INDEX operation_entry ON file_operations(entry_id)")
        db.execute("PRAGMA user_version=1")
    with pytest.raises(UserInputError, match="schema 1"):
        with storage.connect(path):
            pass
    with monkeypatch.context() as patch:
        patch.setitem(storage._MIGRATIONS, 1, [*storage._MIGRATIONS[1], "INVALID SQL"])
        with pytest.raises(UserInputError, match="rolled back"):
            storage.migrate(path)
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
        assert not db.execute("SELECT name FROM sqlite_master WHERE name='export_receipts'").fetchall()
    storage.migrate(path)
    with storage.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == storage.SCHEMA_VERSION
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_push_pop_and_exports_preserve_sources_paths_and_segments(tmp_path, monkeypatch):
    directory = tmp_path / "archive"
    archive.init_archive(directory)
    source = tmp_path / "2026-10-01 中文.kml"
    source.write_bytes(COMPLEX)
    zip_path = directory / "Archive.zip"
    workflows.push_tracks([source], str(zip_path))
    assert not source.exists()
    assert (directory / "Backup" / source.name).read_bytes() == COMPLEX
    assert not zip_path.exists() and not (directory / "Train.kml").exists()
    archive.rebuild(str(zip_path))
    for name in ["Train.kml", "Train.Mobile.kml"]:
        tree = xmlutil.parse_file(directory / name)
        assert len(xmlutil.findall(tree, "//kml:LineString")) == 3
    storage.export_zip(directory / storage.DB_NAME, zip_path)
    before = zip_path.read_bytes()
    monkeypatch.chdir(tmp_path)
    archive.pop_kml_archive(source.stem, zip_path=str(zip_path))
    assert source.read_bytes() == COMPLEX
    assert zip_path.read_bytes() == before  # stale backup untouched by daily pop
    with open_archive(zip_path) as reader:
        assert reader.list_entries() == []


def test_push_conflicts_roll_back_whole_batch_and_keep_sources(tmp_path):
    path = db_at(tmp_path / "archive")
    first = tmp_path / "2026-10-01 first.kml"
    first.write_bytes(COMPLEX)
    archive.push_compressed_kmls([(first, "Train")], path)
    first.write_bytes(COMPLEX + b"\n")
    second = tmp_path / "2026-10-02 second.kml"
    second.write_bytes(COMPLEX)
    with pytest.raises(UserInputError, match="conflict"):
        archive.push_compressed_kmls([(second, "Train"), (first, "Train")], path, move=True)
    assert first.exists() and second.exists()
    with open_archive(path) as reader:
        assert len(reader.list_entries()) == 1


def test_cli_migration_backup_status_and_undo_message(tmp_path):
    runner = CliRunner()
    old = tmp_path / "only-backup.zip"
    with zipfile.ZipFile(old, "w") as zf:
        zf.writestr("a.kml", COMPLEX)
    target = tmp_path / "new"
    result = runner.invoke(app, ["archive", "import-zip", str(old), str(target)])
    assert result.exit_code == 0, result.output
    locator = str(target / "Archive.zip")
    assert runner.invoke(app, ["archive", "backup", "--zip", locator]).exit_code == 0
    result = runner.invoke(app, ["archive", "status", "--zip", locator])
    assert result.exit_code == 0 and "current" in result.output
    result = runner.invoke(app, ["archive", "undo", "--zip", locator])
    assert result.exit_code != 0
    assert isinstance(result.exception, UserInputError) and "retired" in str(result.exception)


def test_no_implicit_zip_migration(tmp_path):
    zip_path = tmp_path / "Archive.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("a.kml", COMPLEX)
    with pytest.raises(UserInputError, match="import-zip"):
        with open_archive(zip_path):
            pass
    assert not (tmp_path / storage.DB_NAME).exists()


def test_late_old_export_cannot_replace_newer_snapshot(tmp_path, monkeypatch):
    path = db_at(tmp_path)
    insert(path, "old.kml")
    target = tmp_path / "Archive.zip"
    write = zipfile.ZipFile.writestr
    fired = False

    def nested(zf, *args, **kwargs):
        nonlocal fired
        if not fired:
            fired = True
            insert(path, "new.kml", b"new")
            storage.export_zip(path, target)
            # A second target must not erase the first target's publication guard.
            storage.export_zip(path, tmp_path / "other.zip")
        return write(zf, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "writestr", nested)
    with pytest.raises(UserInputError, match="newer ZIP"):
        storage.export_zip(path, target)
    assert set(members(target)) == {"old.kml", "new.kml"}


def test_corrupt_raw_object_blocks_export_and_preserves_existing_backup(tmp_path):
    path = db_at(tmp_path)
    insert(path)
    target = tmp_path / "Archive.zip"
    storage.export_zip(path, target)
    before = target.read_bytes()
    with storage.connect(path, write=True) as db:
        db.execute("UPDATE kml_objects SET payload=x'00'")
    with pytest.raises(UserInputError, match="Corrupt"):
        storage.export_zip(path, target)
    assert target.read_bytes() == before


def test_reader_arrays_are_owned_and_corrupt_index_is_rebuildable(tmp_path):
    path = db_at(tmp_path)
    insert(path, "a.kml")
    with open_archive(path) as reader:
        data = reader.read_track_data("a.kml")
        data.tracks[0].segments[0].longitude[0] = 0
        assert reader.read_track_data("a.kml").tracks[0].segments[0].longitude[0] == 100
    with storage.connect(path, write=True) as db:
        db.execute("UPDATE kml_index SET geometry=x'00'")
    with open_archive(path) as reader:
        assert reader.read_track_data("a.kml").tracks[0].segments[0].longitude[0] == 100


def test_catalog_reads_no_objects_and_map_cache_survives_unrelated_push(tmp_path, monkeypatch):
    path = db_at(tmp_path)
    insert(path, "a.kml")
    workspace = MapWorkspace()
    workspace.selection(str(path), ["a.kml"])
    insert(path, "b.kml", UNSUPPORTED)
    with monkeypatch.context() as patch:

        def fail(*a, **kw):
            pytest.fail("unrelated entry invalidated unchanged geometry")

        patch.setattr(storage, "read_object", fail)
        patch.setattr(trackdata, "track_data_from_tree", fail)
        assert len(workspace.catalog(str(path))["entries"]) == 2
        assert not workspace.selection(str(path), ["a.kml"])["errors"]


@pytest.mark.parametrize("operation", ["push", "pop"])
def test_process_death_after_file_publication_recovers_on_reopen(tmp_path, operation):
    import subprocess
    import sys

    path = db_at(tmp_path)
    identity, digest, _ = insert(path, "a.kml")
    source = tmp_path / "source.kml"
    source.write_bytes(COMPLEX)
    target = tmp_path / "target.kml"
    with storage.connect(path, write=True) as db:
        storage.queue_operation(db, operation, identity, digest, target, source if operation == "push" else None)
    code = """
import os, sys
from pathlib import Path
from tracktool.kml import storage
original = storage.write_exclusive
def die(target, raw):
    original(target, raw)
    os._exit(73)
storage.write_exclusive = die
storage.recover(Path(sys.argv[1]))
"""
    result = subprocess.run([sys.executable, "-c", code, str(path)], check=False)
    assert result.returncode == 73
    assert target.read_bytes() == COMPLEX
    with storage.connect(path) as db:
        assert db.execute("SELECT count(*) FROM file_operations").fetchone()[0] == 1
    assert storage.recover(path) == 1
    assert target.read_bytes() == COMPLEX


def test_export_directory_sync_failure_rolls_back_published_target(tmp_path, monkeypatch):
    path = db_at(tmp_path)
    insert(path, "old.kml")
    target = tmp_path / "Archive.zip"
    storage.export_zip(path, target)
    before = target.read_bytes()
    insert(path, "new.kml", b"new")
    sync = storage.sync_directory
    calls = 0

    def fail_once(directory):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("directory sync failed after replace")
        sync(directory)

    monkeypatch.setattr(storage, "sync_directory", fail_once)
    with pytest.raises(OSError, match="directory sync"):
        storage.export_zip(path, target)
    assert target.read_bytes() == before
    with storage.connect(path) as db:
        assert tuple(db.execute("SELECT revision,zip_revision FROM archive_meta").fetchone()) == (2, 1)


def test_import_publication_sync_failure_does_not_leave_a_database(tmp_path, monkeypatch):
    def fail(*a):
        raise OSError("sync failed")

    monkeypatch.setattr(storage, "sync_directory", fail)
    path = tmp_path / storage.DB_NAME
    with pytest.raises(UserInputError, match="sync failed"):
        storage.create_database(path)
    assert not path.exists()
