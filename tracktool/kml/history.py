"""The archive's change log: what each command did to the truth, so it can be undone.

An archive's truth is its ZIP, and a command moves it by adding or removing
entries — never by editing one. That makes a change reversible in principle,
but only if what changed was written down: `kml push a b`, where b was already
filed, adds one entry, and no reading of the command line can tell which one.
So every command that moves the truth appends a line here, naming the entries
it actually added or removed and the files it moved in or out.

The log is append-only. Undoing a change appends a tombstone naming the record
it reversed; no line is ever edited or deleted, so the file reads as the
archive's history rather than as its state. It lives inside the archive
directory under a fixed name, because the archive's identity is its directory
(E1) — moving the directory takes its history along.

Keys are the Change fields verbatim (`json.dumps(asdict(change))`): one set of
names, no mapping between a key and an attribute, and so no second place to
get one wrong. Every line carries all of them, absent values as null or [].

What is *not* here: the views. They are derived from the ZIP, so a rebuild
brings them back in step with a truth that just moved; recording them would
add a second thing that must agree with the ZIP.
"""

import json
import zlib
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime
from pathlib import Path

from .. import log
from ..context import ctx
from ..errors import UserInputError
from ..paths import display_path
from ..workspace import HISTORY_NAME, history_log_path

# 日志格式版本。解析只认这一个：别处的值说明写它的版本比现在新，字段语义未必一样
VERSION = 1

# 记账的四个取值，也是 command 字段的全部取值域
PUSH = "kml push"
POP = "kml pop"
MERGE = "kml merge"
UNDO = "archive undo"


@dataclass(frozen=True)
class BackupMove:
    """One file carried between the user's ground and the archive's Backup/."""

    original_path: str
    backup_path: str


@dataclass(frozen=True)
class ExtractedFile:
    """The file a restore wrote out, and the entry it came from.

    size_bytes and crc32 are the ZIP's own entry metadata, and an undo holds
    them against the file on disk: content that has changed may not pass
    itself off as the entry it was extracted from. This file has no copy
    anywhere else, which is what makes it the hard premise of undoing a pop.
    """

    entry_path: str
    file_path: str
    size_bytes: int
    crc32: int


@dataclass(frozen=True)
class OutputFile:
    """What a merge wrote to --output, which is never an archive entry.

    Unlike ExtractedFile's, its size_bytes and crc32 are measured on disk when
    the change is recorded; an undo uses them to tell whether the output is
    still the file that merge produced.
    """

    file_path: str
    size_bytes: int
    crc32: int


@dataclass
class Change:
    """One recorded change.

    Mutable on purpose, unlike the records it holds: the command that owns the
    transaction fills it in as its steps land — the entries each step manages
    to add, the files it manages to move — and commit stamps the id last.
    """

    command: str
    zip_hash_before: str
    version: int = VERSION
    id: int = 0
    timestamp: str = ""
    zip_hash_after: str = ""
    added_entries: list[str] = field(default_factory=list)
    removed_entries: list[str] = field(default_factory=list)
    source_paths: list[str] = field(default_factory=list)
    extracted_file: ExtractedFile | None = None
    backup_moves: list[BackupMove] = field(default_factory=list)
    output_file: OutputFile | None = None
    undo_of: int | None = None
    not_undone: list[str] = field(default_factory=list)


# 每个 log 行恒定带全这些键；解析时缺的按空值算，多出来的键忽略
_LIST_KEYS = ("added_entries", "removed_entries", "source_paths", "not_undone")
_FIELDS = {definition.name for definition in fields(Change)}


def start(command: str, *, zip_hash_before: str) -> Change:
    """Begin a change: which command it is, and the truth it is about to move."""
    return Change(command=command, zip_hash_before=zip_hash_before)


def file_metadata(path: Path) -> tuple[int, int]:
    """One file's size and CRC-32, measured on disk.

    What an output record holds: unlike an extracted file's numbers, which come
    from the ZIP's own directory, a merge's output exists only on disk, so the
    numbers that later prove it unchanged have to be taken here.
    """
    data = path.read_bytes()
    return len(data), zlib.crc32(data)


def undone_ids(changes: Sequence[Change]) -> set[int]:
    """The ids some tombstone already names — "already undone", read off the log."""
    return {change.undo_of for change in changes if change.undo_of is not None}


def commit(archive_dir: Path, change: Change, *, zip_hash_after: str) -> Change:
    """Append the record, stamped with its id and the truth's new hash.

    The id is one past the highest already in the file, never reused and never
    renumbered: a record is not edited, a tombstone is appended, and that
    tombstone needs a number of its own. A timestamp already set is kept, so a
    caller that wants one test can hand it in.

    In PLAN mode the line is reported rather than written — a preview leaves
    the log exactly as it found it.
    """
    change.zip_hash_after = zip_hash_after
    path = history_log_path(archive_dir)
    if ctx.is_plan:
        log.info(f"Would record {change.command} in {HISTORY_NAME}", target=str(path))
        return change
    change.id = next_id(load(archive_dir))
    if not change.timestamp:
        change.timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(asdict(change), ensure_ascii=False) + "\n")
    except OSError as exc:
        raise UserInputError(f"Cannot append to archive history {display_path(path)}: {exc}") from exc
    log.verbose(f"Recorded {change.command} as #{change.id}", target=str(path))
    return change


def next_id(changes: Sequence[Change]) -> int:
    """One past the highest recorded id."""
    return max((change.id for change in changes), default=0) + 1


def load(archive_dir: Path) -> list[Change]:
    """Every recorded change, oldest first.

    A line that cannot be parsed is skipped with a warning: a torn last line
    is the standing cost of an append-only file, and the hash checks make a
    missing record refuse an undo rather than undo the wrong thing. A missing
    file is not an error either — it is simply an archive with no history.
    """
    path = history_log_path(archive_dir)
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise UserInputError(f"Cannot read archive history {display_path(path)}: {exc}") from exc
    changes: list[Change] = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            changes.append(_from_json(line))
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            log.warning(f"Ignoring unreadable history line {number}: {exc}", target=str(path))
    return changes


def pending(archive_dir: Path) -> list[Change]:
    """The records an undo still has to reverse, oldest first.

    A tombstone is never a target, and neither is a record some tombstone
    already names: "already undone" is a fact written on the log, not an edit
    made to the record.
    """
    changes = load(archive_dir)
    undone = undone_ids(changes)
    return [change for change in changes if change.command != UNDO and change.id not in undone]


def _from_json(line: str) -> Change:
    """Build a Change from one log line, ignoring keys this version does not know.

    Unknown keys have to be tolerated: a line written by a newer version is
    still readable history, and saying which version wrote it is the undo's
    job, not the parser's.
    """
    data = json.loads(line)
    if not isinstance(data, dict):
        raise TypeError(f"expected a JSON object, found {type(data).__name__}")
    known = _FIELDS
    values = {key: value for key, value in data.items() if key in known}
    for key in _LIST_KEYS:
        values[key] = list(values.get(key) or [])
    values["backup_moves"] = [_backup_move(item) for item in values.get("backup_moves") or []]
    for key, build in (("extracted_file", _extracted_file), ("output_file", _output_file)):
        values[key] = build(values[key]) if values.get(key) else None
    return Change(**values)


def _backup_move(data: object) -> BackupMove:
    if not isinstance(data, dict):
        raise TypeError(f"expected an object for a backup move, found {type(data).__name__}")
    return BackupMove(original_path=str(data["original_path"]), backup_path=str(data["backup_path"]))


def _extracted_file(data: object) -> ExtractedFile:
    if not isinstance(data, dict):
        raise TypeError(f"expected an object for an extracted file, found {type(data).__name__}")
    return ExtractedFile(
        entry_path=str(data["entry_path"]),
        file_path=str(data["file_path"]),
        size_bytes=int(data["size_bytes"]),
        crc32=int(data["crc32"]),
    )


def _output_file(data: object) -> OutputFile:
    if not isinstance(data, dict):
        raise TypeError(f"expected an object for an output file, found {type(data).__name__}")
    return OutputFile(
        file_path=str(data["file_path"]),
        size_bytes=int(data["size_bytes"]),
        crc32=int(data["crc32"]),
    )
