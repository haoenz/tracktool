"""Coverage for the archive change log and `archive undo`.

Three commands move the archive's truth — `kml push`, `kml pop`, `kml merge` —
and each of them appends a line saying what it actually did. These cases drive
that log through the commands and then read it back: what a record holds, what
an undo reverses, what refuses it, and what survives when it partially fails.

The one rule every case here is really about: **nothing is deleted until a
copy of it exists somewhere else.** A file whose way back is blocked keeps its
entry in the ZIP, because after that entry goes the track exists nowhere.
"""

import logging
import zipfile
import zlib
from pathlib import Path

import pytest
from conftest import TRACK_KML, make_archive
from typer.testing import CliRunner

from tracktool import workflows
from tracktool.cli import app
from tracktool.config import Config
from tracktool.context import RunMode, ctx
from tracktool.errors import UserInputError
from tracktool.kml import archive, collections, edit, history, undo
from tracktool.kml.kmlfile import TrackKind

runner = CliRunner()

_ACTIVITY_OF = {
    TrackKind.DEFAULT: "徒步",
    TrackKind.TRAIN: "火车",
    TrackKind.FLIGHT: "飞机",
}


def track(directory: Path, name: str = "2024-05-01 trip.kml", kind: TrackKind = TrackKind.DEFAULT) -> Path:
    """A track filed under `kind`, tagged so its type comes from the file itself.

    TrackTags holds an activity and the archive folder holds a category, so
    each kind gets one activity from the built-in table. Writing the category
    name instead would be a value no table classifies: the entry would land in
    _unclassified and the case would no longer be about the kind it names.
    """
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(
        TRACK_KML.replace(
            "<Document>",
            f'<Document><ExtendedData><Data name="TrackTags"><value>{_ACTIVITY_OF[kind]}</value></Data></ExtendedData>',
        ),
        encoding="utf-8",
    )
    return path


@pytest.fixture
def archive_zip(tmp_path, monkeypatch) -> Path:
    """A declared archive, with ctx.config pointing at it (merge resolves it)."""
    zip_path = make_archive(tmp_path / "archive")
    config = Config(path=tmp_path / "config.json").load()
    config["archive_path"] = str(zip_path.parent)
    monkeypatch.setattr(ctx, "config", config)
    return zip_path


def entries(zip_path: Path) -> list[str]:
    with zipfile.ZipFile(zip_path) as zf:
        return zf.namelist()


def records(zip_path: Path) -> list[history.Change]:
    return history.load(zip_path.parent)


def log_path(zip_path: Path) -> Path:
    return zip_path.parent / "history.jsonl"


def backup_of(zip_path: Path, source: Path) -> Path:
    return zip_path.parent / "Backup" / source.name


# ── what each command records ───────────────────────────────────────────────


def test_a_push_records_the_entries_it_actually_added(archive_zip, tmp_path):
    first = track(tmp_path / "sources")
    second = track(first.parent, "2024-05-02 next.kml")

    workflows.push_tracks([first, second], str(archive_zip))

    record = records(archive_zip)[-1]
    assert record.command == history.PUSH
    assert record.version == history.VERSION
    assert record.added_entries == [
        archive.zip_entry_name(first, "Default"),
        archive.zip_entry_name(second, "Default"),
    ]
    assert record.removed_entries == []
    assert record.extracted_file is None
    assert record.undo_of is None and record.not_undone == []
    assert record.zip_hash_before != record.zip_hash_after
    assert archive.current_hash(archive_zip) == record.zip_hash_after


def test_a_push_records_only_what_landed_not_what_was_asked_for(archive_zip, tmp_path):
    """判重跳过的那条不算：按命令行反推会把上一次 push 的成果一并删掉。"""
    filed = track(tmp_path / "sources")
    new = track(filed.parent, "2024-05-02 next.kml")
    workflows.push_tracks([filed], str(archive_zip))

    workflows.push_tracks([filed, new], str(archive_zip))

    record = records(archive_zip)[-1]
    assert record.added_entries == [archive.zip_entry_name(new, "Default")]


def test_a_push_that_could_file_nothing_records_nothing(archive_zip, tmp_path):
    """一条都没读出来时没有任何步骤，也就没有动过归档的东西可记。"""
    undated = tmp_path / "sources" / "no date here.kml"
    undated.parent.mkdir(parents=True, exist_ok=True)
    undated.write_text(TRACK_KML, encoding="utf-8")

    result = workflows.push_tracks([undated], str(archive_zip))

    assert result.failed == [undated]
    assert not log_path(archive_zip).exists()


def test_a_push_with_move_records_every_file_it_carried_away(archive_zip, tmp_path):
    source = track(tmp_path / "sources")

    workflows.push_tracks([source], str(archive_zip), move=True)

    record = records(archive_zip)[-1]
    assert record.source_paths == [str(source)]
    assert [Path(move.original_path) for move in record.backup_moves] == [source]
    assert [Path(move.backup_path) for move in record.backup_moves] == [backup_of(archive_zip, source)]
    assert backup_of(archive_zip, source).is_file()


def test_a_restore_records_the_entry_and_the_file_it_wrote(archive_zip, tmp_path, monkeypatch):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=False)
    entry = archive.zip_entry_name(source, "Default")
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)

    archive.pop_kml_archive(source.stem, TrackKind.DEFAULT, str(archive_zip))

    record = records(archive_zip)[-1]
    assert record.command == history.POP
    assert record.removed_entries == [entry]
    assert record.added_entries == []
    extracted = record.extracted_file
    assert extracted is not None
    assert extracted.entry_path == entry
    assert Path(extracted.file_path) == output / source.name
    assert extracted.size_bytes == len(source.read_bytes())
    assert extracted.crc32 == zlib.crc32(source.read_bytes())


def test_a_merge_records_the_entries_and_the_output_it_wrote(archive_zip, tmp_path):
    first = track(tmp_path / "sources")
    second = track(first.parent, "2024-05-02 next.kml")
    output = tmp_path / "merged.kml"

    edit.merge_kml([first, second], output)

    record = records(archive_zip)[-1]
    assert record.command == history.MERGE
    assert len(record.added_entries) == 2
    assert record.source_paths == [str(first), str(second)]
    assert record.output_file is not None
    assert Path(record.output_file.file_path) == output
    assert record.output_file.size_bytes == len(output.read_bytes())


def test_the_change_log_cannot_be_a_merge_output(archive_zip, tmp_path):
    source = track(tmp_path / "sources")

    with pytest.raises(UserInputError, match="archive storage path"):
        edit.merge_kml([source], log_path(archive_zip))


def test_each_command_that_moves_the_archive_records_one_line(archive_zip, tmp_path, monkeypatch):
    first = track(tmp_path / "sources")
    second = track(first.parent, "2024-05-02 next.kml")
    output = tmp_path / "output"
    output.mkdir()

    workflows.push_tracks([first, second], str(archive_zip), move=False)
    monkeypatch.chdir(output)
    archive.pop_kml_archive(second.stem, TrackKind.DEFAULT, str(archive_zip))
    edit.merge_kml([first], tmp_path / "merged.kml")

    assert [record.command for record in records(archive_zip)] == [history.PUSH, history.POP, history.MERGE]
    assert [record.id for record in records(archive_zip)] == [1, 2, 3]


# ── what an undo reverses ───────────────────────────────────────────────────


def test_undoing_a_push_takes_back_what_it_added(archive_zip, tmp_path):
    first = track(tmp_path / "sources")
    second = track(first.parent, "2024-05-02 next.kml")
    workflows.push_tracks([first, second], str(archive_zip))
    record = records(archive_zip)[-1]

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert entries(archive_zip) == []
    assert archive.current_hash(archive_zip) == record.zip_hash_before
    # 视图跟着真值一起空掉：撤掉的最后一条不许留在聚合里
    assert not collections.has_desktop_track(first.stem, archive_zip.parent / "Default.kml")
    assert not collections.has_mobile_track(first.stem, archive_zip.parent / "Default.Mobile.kml")
    assert first.is_file() and second.is_file()


def test_undoing_a_push_with_move_puts_the_sources_back(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    original = source.read_bytes()
    workflows.push_tracks([source], str(archive_zip), move=True)
    assert not source.exists()

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert source.read_bytes() == original
    assert not backup_of(archive_zip, source).exists()
    assert entries(archive_zip) == []


def test_an_all_duplicate_push_is_recorded_as_no_change_and_still_consumed(archive_zip, tmp_path):
    """空操作也占一条记录：否则下次 undo 会跳过它去撤更早的改动。"""
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=False)
    entry = archive.zip_entry_name(source, "Default")

    workflows.push_tracks([source], str(archive_zip))

    assert len(records(archive_zip)) == 2
    empty = records(archive_zip)[-1]
    assert empty.added_entries == []
    assert empty.zip_hash_before == empty.zip_hash_after

    assert undo.undo_last(str(archive_zip)).ok
    assert entries(archive_zip) == [entry]

    assert undo.undo_last(str(archive_zip)).ok
    assert entries(archive_zip) == []


def test_undoing_a_restore_puts_the_entry_back_where_it_was(archive_zip, tmp_path, monkeypatch):
    source = track(tmp_path / "sources")
    payload = source.read_bytes()
    workflows.push_tracks([source], str(archive_zip))
    entry = archive.zip_entry_name(source, "Default")
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    archive.pop_kml_archive(source.stem, TrackKind.DEFAULT, str(archive_zip))
    extracted = output / source.name

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert entries(archive_zip) == [entry]
    with zipfile.ZipFile(archive_zip) as zf:
        assert zf.read(entry) == payload
    assert not extracted.exists()
    assert archive.read_views_hash(archive_zip) == archive.archive_hash(archive_zip)


def test_undoing_a_merge_removes_the_entries_and_the_output(archive_zip, tmp_path):
    first = track(tmp_path / "sources")
    second = track(first.parent, "2024-05-02 next.kml")
    payload = {path: path.read_bytes() for path in (first, second)}
    output = tmp_path / "merged.kml"
    edit.merge_kml([first, second], output, move=True)

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert entries(archive_zip) == []
    assert not output.exists()
    for path, data in payload.items():
        assert path.read_bytes() == data
        assert not backup_of(archive_zip, path).exists()


def test_undoing_a_merge_keeps_an_output_the_user_has_edited(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    output = tmp_path / "merged.kml"
    edit.merge_kml([source], output)
    output.write_text("edited by hand", encoding="utf-8")

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert entries(archive_zip) == []
    assert output.read_text(encoding="utf-8") == "edited by hand"


def test_a_merge_output_that_is_already_gone_is_harmless(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    output = tmp_path / "merged.kml"
    edit.merge_kml([source], output)
    output.unlink()

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert entries(archive_zip) == []


def test_stepping_back_two_changes_rebuilds_the_views_once(archive_zip, tmp_path, monkeypatch):
    first = track(tmp_path / "sources")
    second = track(first.parent, "2024-05-02 next.kml")
    earliest = archive.current_hash(archive_zip)
    workflows.push_tracks([first], str(archive_zip))
    workflows.push_tracks([second], str(archive_zip))
    ids = [record.id for record in records(archive_zip)]
    rebuilds: list[str] = []
    original = archive.rebuild

    def count_rebuild(zip_path, *, tag_map=None):
        rebuilds.append(zip_path)
        return original(zip_path, tag_map=tag_map)

    monkeypatch.setattr(archive, "rebuild", count_rebuild)

    outcome = undo.undo_last(str(archive_zip), steps=2)

    assert outcome.undone == list(reversed(ids))
    assert entries(archive_zip) == []
    assert archive.current_hash(archive_zip) == earliest
    assert len(rebuilds) == 1


def test_a_push_with_move_does_not_warn_about_the_sources_it_carried_away(archive_zip, tmp_path, caplog):
    """搬移（默认，`--keep` 时无）让源文件离开原位是它的本分，不是「源文件不见了」。"""
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=True)

    undo.undo_last(str(archive_zip))

    assert "Source file(s) already gone" not in caplog.text


def test_a_source_the_user_deleted_is_warned_about_but_not_refused(archive_zip, tmp_path, caplog):
    """用户自己删的源文件不构成拒绝，但撤完这条轨迹就没有别处了，得先说一句。"""
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=False)
    source.unlink()

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert "Source file(s) already gone" in caplog.text
    assert entries(archive_zip) == []


# ── what refuses an undo ────────────────────────────────────────────────────


def test_an_unrecorded_change_to_the_zip_refuses_the_undo(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=False)
    with zipfile.ZipFile(archive_zip, "a") as zf:
        zf.writestr("Default/2024-06/2024-06-01 stray.kml", TRACK_KML)
    before = entries(archive_zip)

    with pytest.raises(UserInputError, match="has changed since it was recorded"):
        undo.undo_last(str(archive_zip))

    assert entries(archive_zip) == before
    assert source.is_file()


def test_a_missing_zip_refuses_the_undo_without_a_traceback(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=False)
    archive_zip.unlink()

    result = runner.invoke(app, ["archive", "undo", "--zip", str(archive_zip)])

    assert result.exit_code == 1
    assert isinstance(result.exception, UserInputError)
    assert "does not exist" in str(result.exception)
    assert source.is_file()


def test_an_archive_with_no_history_has_nothing_to_undo(archive_zip, caplog):
    caplog.set_level(logging.INFO)

    result = runner.invoke(app, ["archive", "undo", "--zip", str(archive_zip)])

    assert result.exit_code == 0
    assert "Nothing to undo" in caplog.text


def test_a_changed_extracted_file_refuses_the_undo(archive_zip, tmp_path, monkeypatch):
    """pop 出来的那份是那条轨迹唯一的一份：改过就不许冒充原条目。"""
    first = track(tmp_path / "sources")
    second = track(first.parent, "2024-05-02 next.kml")
    workflows.push_tracks([first, second], str(archive_zip))
    output = tmp_path / "output"
    output.mkdir()
    monkeypatch.chdir(output)
    archive.pop_kml_archive(first.stem, TrackKind.DEFAULT, str(archive_zip))
    (output / first.name).write_text("not the track any more", encoding="utf-8")
    before = entries(archive_zip)

    with pytest.raises(UserInputError, match="changed"):
        undo.undo_last(str(archive_zip))

    assert entries(archive_zip) == before
    assert (output / first.name).read_text(encoding="utf-8") == "not the track any more"


def test_a_cleared_backup_folder_still_undoes_the_move(archive_zip, tmp_path):
    """Backup 是近期暂存，手工清掉不碍撤回：还原材料还有那笔 push 落下的条目。"""
    source = track(tmp_path / "sources")
    payload = source.read_bytes()
    workflows.push_tracks([source], str(archive_zip), move=True)
    backup_of(archive_zip, source).unlink()

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert source.read_bytes() == payload
    assert not backup_of(archive_zip, source).exists()
    assert entries(archive_zip) == []


def test_an_occupied_original_refuses_the_undo(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=True)
    source.write_bytes(b"something else arrived")

    with pytest.raises(UserInputError, match="something occupies where it came from"):
        undo.undo_last(str(archive_zip))

    assert source.read_bytes() == b"something else arrived"


def test_a_refusal_is_only_a_pause(archive_zip, tmp_path):
    """被拒时一个字节都没动、记录仍是 pending：把占住原位的东西挪走再跑一次就成。"""
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=True)
    source.write_bytes(b"in the way")

    with pytest.raises(UserInputError, match="something occupies where it came from"):
        undo.undo_last(str(archive_zip))

    source.unlink()
    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert source.is_file()
    assert entries(archive_zip) == []


# ── what survives a forced undo ─────────────────────────────────────────────


def test_a_forced_undo_keeps_the_entry_of_a_file_it_cannot_put_back(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    entry = archive.zip_entry_name(source, "Default")
    workflows.push_tracks([source], str(archive_zip), move=True)
    backup = backup_of(archive_zip, source)
    source.write_bytes(b"something else arrived")

    outcome = undo.undo_last(str(archive_zip), force=True)

    assert not outcome.ok
    assert outcome.mismatched
    assert outcome.not_undone
    # 原位被占、还不了位：条目留在 ZIP，实物也仍在 Backup，什么都没有丢
    assert entries(archive_zip) == [entry]
    assert source.read_bytes() == b"something else arrived"
    assert backup.is_file()


def test_a_cleared_backup_still_undoes_a_move_that_added_no_entry(archive_zip, tmp_path):
    """跨记录：第二次 push --move 判重没加条目，只把源件搬进了 Backup。

    Backup 清掉后，还原材料是第一次 push 落下的条目；两步连撤，条目由
    撤第一次 push 的那步摘掉——还原材料从来不是 Backup 独占的。
    """
    source = track(tmp_path / "sources")
    payload = source.read_bytes()
    workflows.push_tracks([source], str(archive_zip))
    workflows.push_tracks([source], str(archive_zip), move=True)
    backup_of(archive_zip, source).unlink()

    outcome = undo.undo_last(str(archive_zip), steps=2)

    assert outcome.ok
    assert source.read_bytes() == payload
    assert entries(archive_zip) == []


def test_a_copy_the_backup_folder_already_held_is_dropped_and_recorded(archive_zip, tmp_path):
    """Backup 里已有同内容副本时，第二次 --move 清掉新副本，账照记。

    清掉的副本必须进 backup_moves：不记的话源文件就被静默丢掉，undo 不知道
    少了什么，也就还不了。记了之后，撤销与一次真搬移同形。
    """
    source = track(tmp_path / "sources")
    content = source.read_text(encoding="utf-8")
    workflows.push_tracks([source], str(archive_zip), move=True)  # 源件进了 Backup

    stray = source.parent / source.name
    stray.write_text(content, encoding="utf-8")  # 同内容的散落副本

    workflows.push_tracks([stray], str(archive_zip), move=True)

    assert not stray.exists()  # 副本清掉
    assert backup_of(archive_zip, source).read_text(encoding="utf-8") == content  # 已在那份没被动
    record = records(archive_zip)[-1]
    assert record.added_entries == []  # ZIP 判重，没有第二条
    assert [Path(move.original_path) for move in record.backup_moves] == [stray]

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert stray.read_text(encoding="utf-8") == content  # 撤销把副本从 Backup 还回原位


def test_both_positions_come_back_when_they_shared_one_backup_copy(archive_zip, tmp_path):
    """两份源件内容相同、Backup 里只有一份实物：两个位置现在都还得上。

    较新的记录先把实物搬回它的原位；较早那条还原用的是第一次 push 落下的
    条目——按「先造副本，后消耗副本」，解压在前、删条目在后，两份都在。
    """
    first = track(tmp_path / "one")
    content = first.read_text(encoding="utf-8")
    workflows.push_tracks([first], str(archive_zip), move=True)  # one/ 那份进了 Backup

    second = track(tmp_path / "two")  # 同名同内容，另一个位置
    assert second.read_text(encoding="utf-8") == content
    workflows.push_tracks([second], str(archive_zip), move=True)

    assert not first.exists() and not second.exists()  # 两个位置都空了，实物只有一份

    outcome = undo.undo_last(str(archive_zip), steps=2)

    assert outcome.ok
    assert first.read_text(encoding="utf-8") == content
    assert second.read_text(encoding="utf-8") == content
    assert not backup_of(archive_zip, first).exists()
    assert entries(archive_zip) == []


def test_a_cleared_backup_still_undoes_a_merge_with_move(archive_zip, tmp_path):
    """merge --move 后清掉 Backup：源件从条目还原，输出照删。"""
    source = track(tmp_path / "sources")
    payload = source.read_bytes()
    output = tmp_path / "merged.kml"
    edit.merge_kml([source], output, move=True)
    backup_of(archive_zip, source).unlink()

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert source.read_bytes() == payload
    assert entries(archive_zip) == []
    assert not output.exists()


# ── previews and the log command ────────────────────────────────────────────


def test_a_preview_undo_touches_nothing(archive_zip, tmp_path, monkeypatch):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip))
    before_zip = archive_zip.read_bytes()
    before_log = log_path(archive_zip).read_bytes()

    monkeypatch.setattr(ctx, "mode", RunMode.PLAN)
    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert archive_zip.read_bytes() == before_zip
    assert log_path(archive_zip).read_bytes() == before_log
    assert entries(archive_zip) == [archive.zip_entry_name(source, "Default")]


def test_a_preview_of_the_entry_fallback_touches_nothing(archive_zip, tmp_path, monkeypatch):
    """Backup 清空后的还原走条目解压：预演里照样一个字节不动。"""
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=True)
    backup_of(archive_zip, source).unlink()
    before_zip = archive_zip.read_bytes()
    before_log = log_path(archive_zip).read_bytes()

    monkeypatch.setattr(ctx, "mode", RunMode.PLAN)
    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert archive_zip.read_bytes() == before_zip
    assert log_path(archive_zip).read_bytes() == before_log
    assert not source.exists()


def test_a_torn_last_line_is_skipped_and_the_earlier_change_still_undoes(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip))
    with log_path(archive_zip).open("a", encoding="utf-8", newline="\n") as stream:
        stream.write('{"version": 1, "id": 2, "comm')

    outcome = undo.undo_last(str(archive_zip))

    assert outcome.ok
    assert entries(archive_zip) == []


def test_a_record_from_a_newer_history_format_refuses_the_undo(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip))
    text = log_path(archive_zip).read_text(encoding="utf-8")
    log_path(archive_zip).write_text(text.replace('"version": 1', '"version": 2'), encoding="utf-8")

    with pytest.raises(UserInputError, match="history format v2"):
        undo.undo_last(str(archive_zip))

    assert entries(archive_zip) == [archive.zip_entry_name(source, "Default")]


def test_the_log_lists_every_change_and_whether_it_still_stands(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip))

    undo.undo_last(str(archive_zip))

    result = runner.invoke(app, ["archive", "log", "--zip", str(archive_zip)])
    assert result.exit_code == 0, result.output
    assert "kml push" in result.output
    assert "archive undo" in result.output
    assert "undone" in result.output
    assert "pending" not in result.output


def test_the_log_reports_a_partial_undo(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip), move=True)
    source.write_bytes(b"in the way")

    result = runner.invoke(app, ["archive", "undo", "--zip", str(archive_zip), "--force"])

    assert result.exit_code == 3, result.output
    listing = runner.invoke(app, ["archive", "log", "--zip", str(archive_zip)])
    assert "partial" in listing.output


def test_the_log_says_there_are_no_changes_yet(archive_zip, caplog):
    caplog.set_level(logging.INFO)

    result = runner.invoke(app, ["archive", "log", "--zip", str(archive_zip)])

    # 断言日志原文而不比 result.output：后者经 Rich 按终端宽度折行，这句子会被
    # 切进两行（"No" 一行、缩进的 "recorded changes" 一行），折与不折全看这一段
    # 前面排了多少字符——临时目录路径长一点就翻脸，跟被测代码无关
    assert result.exit_code == 0
    assert "No recorded changes" in caplog.text


# ── the archive_history switch ──────────────────────────────────────────────


def test_a_command_records_nothing_when_the_log_is_off(archive_zip, tmp_path):
    ctx.config["archive_history"] = False
    source = track(tmp_path / "sources")

    workflows.push_tracks([source], str(archive_zip))

    # 关掉的是记账，不是命令：归档照旧动了，账本一行没有
    assert entries(archive_zip) == [archive.zip_entry_name(source, "Default")]
    assert not log_path(archive_zip).exists()


def test_a_merge_records_nothing_when_the_log_is_off(archive_zip, tmp_path):
    ctx.config["archive_history"] = False
    source = track(tmp_path / "sources")
    output = tmp_path / "merged.kml"

    edit.merge_kml([source], output)

    assert output.is_file()
    assert entries(archive_zip) == [archive.zip_entry_name(source, "Default")]
    assert not log_path(archive_zip).exists()


def test_an_undo_refuses_while_the_log_is_off(archive_zip, tmp_path):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip))  # recorded
    ctx.config["archive_history"] = False
    later = track(tmp_path / "sources", "2024-05-02 later.kml")
    workflows.push_tracks([later], str(archive_zip))  # not recorded

    before = entries(archive_zip)
    with pytest.raises(UserInputError, match="archive_history"):
        undo.undo_last(str(archive_zip))

    assert entries(archive_zip) == before
    assert len(records(archive_zip)) == 1


def test_a_preview_of_an_undo_refuses_while_the_log_is_off(archive_zip, tmp_path):
    # 开关与 --dry-run 无关：预演报的是这条命令的结论，不是一个字节的差别
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip))
    ctx.config["archive_history"] = False

    result = runner.invoke(app, ["--dry-run", "archive", "undo", "--zip", str(archive_zip)])

    assert result.exit_code == 1


def _push_across_a_gap(archive_zip, tmp_path) -> tuple[Path, Path, Path]:
    """push、关掉开关再 push、打开开关再 push，返回三份源文件。"""
    first = track(tmp_path / "sources")
    workflows.push_tracks([first], str(archive_zip))
    ctx.config["archive_history"] = False
    second = track(tmp_path / "sources", "2024-05-02 gap.kml")
    workflows.push_tracks([second], str(archive_zip))
    ctx.config["archive_history"] = True
    third = track(tmp_path / "sources", "2024-05-03 after.kml")
    workflows.push_tracks([third], str(archive_zip))
    return first, second, third


def test_recording_resumes_when_the_log_is_switched_back_on(archive_zip, tmp_path):
    first, second, _ = _push_across_a_gap(archive_zip, tmp_path)

    outcome = undo.undo_last(str(archive_zip))

    # 空档有界：已经记下的改动照撤，空档里那一条只是撤不回来，不牵连别的
    assert outcome.ok
    assert entries(archive_zip) == [
        archive.zip_entry_name(first, "Default"),
        archive.zip_entry_name(second, "Default"),
    ]


def test_stepping_back_across_the_gap_is_refused(archive_zip, tmp_path):
    _push_across_a_gap(archive_zip, tmp_path)

    with pytest.raises(UserInputError, match="does not start where"):
        undo.undo_last(str(archive_zip), steps=2)

    assert len(entries(archive_zip)) == 3


def test_the_log_still_lists_what_it_holds_when_recording_is_off(archive_zip, tmp_path, caplog):
    source = track(tmp_path / "sources")
    workflows.push_tracks([source], str(archive_zip))
    ctx.config["archive_history"] = False

    result = runner.invoke(app, ["archive", "log", "--zip", str(archive_zip)])

    assert result.exit_code == 0
    assert "kml push" in result.output
    assert "Recording is off" in caplog.text
