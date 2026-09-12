"""Exiftool wrapper.

Tag reads go through read_tags: one `-j -G1 -n` call per file returns every
requested tag as a keyed JSON object, so a missing tag is an absent key and
diagnostics on stderr (perl locale warnings, ...) can never be mistaken for a
value.

`-n` is what keeps callers in numbers rather than display text: derived GPS
tags come back as signed decimals ("-50", "-12.3456789012222") instead of
exiftool's rendering ("50 m Below Sea Level", "12 deg 20' 44.44\" S"), so no
consumer has to parse display form back into numbers. Date/time and text tags
are unaffected by `-n`, which is why a single numeric read can serve every
consumer of one file.

Write paths filter ignorable warnings (output_filters from config,
|-separated regexes), then raise on any line matching \bError\b.

Batch mode uses the -stay_open -@ argfile protocol for a persistent exiftool
process, eliminating the per-file process startup cost. One process is not
safe to share across threads, so the read helpers use a thread-local
persistent process.

ExiftoolBackend is what the rest of the package talks to: it implements the
MetadataBackend protocol, so exiftool's argument syntax never leaves this file.
"""

import json
import os
import re
import subprocess
import tempfile
import threading
from collections.abc import Mapping, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any

from . import log
from .errors import ToolError
from .metadata import MetadataBackend

ERROR_PATTERN = re.compile(r"\bError\b")

_EXECUTABLE = os.environ.get("TRACKTOOL_EXIFTOOL", "exiftool")
_local = threading.local()

# 派生标签（GPSPosition / GPSLatitude / GPSAltitude）在 -G1 下渲染在 Composite 组，
# 且 -n 下只有 Composite 那份是按 GPSAltitudeRef 定了符号的（GPS: 那份是无符号量值）
_COMPOSITE_GROUP = "Composite"


class ExiftoolError(ToolError):
    """Raised when exiftool is unavailable or its output contains an error."""


def _filters() -> list[re.Pattern[str]]:
    # 延迟导入：context 在导入期就要构造默认后端，而默认后端就是本模块
    from .context import ctx

    return [re.compile(f) for f in ctx.config.output_filters]


def _check_output(output: list[str], filters: list[re.Pattern[str]], cmd_desc: str) -> list[str]:
    """Apply the config's output filters, then raise on any remaining line containing Error."""
    lines = [line for line in output if line and not any(f.search(line) for f in filters)]
    errors = [line for line in lines if ERROR_PATTERN.search(line)]
    if errors:
        message = "Exiftool encountered error(s):\n" + "\n".join(errors)
        raise ExiftoolError(message)
    return lines


def invoke(*params: str) -> list[str]:
    """Run exiftool once with the given arguments (one-shot subprocess)."""
    cmd = [_EXECUTABLE, *params]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    except OSError as exc:
        raise ExiftoolError(f"Could not run exiftool ({_EXECUTABLE}): {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ExiftoolError(f"exiftool timed out: {' '.join(cmd[:4])}") from exc
    output = (proc.stdout + proc.stderr).splitlines()
    return _check_output(output, _filters(), " ".join(cmd[:4]))


def _split_tag(tag: str) -> tuple[str, str]:
    """'ExifIFD:DateTimeOriginal' -> ('ExifIFD', 'DateTimeOriginal'); no group -> ('', tag)."""
    group, _, name = tag.rpartition(":")
    return group, name


def _resolve_key(payload: dict[str, Any], tag: str) -> str | None:
    """Find the JSON key holding `tag` in a `-j -G1 -n` payload.

    -G1 prints the family-1 group name, which normally equals the group the
    caller wrote (ExifIFD:, XMP-exif:, QuickTime:, Track1:, ...). Two kinds of
    name still need a fallback: derived tags, which exiftool renders under
    Composite (GPSPosition, GPSLatitude, GPSAltitude), and ungrouped names
    (Make). Preferring Composite doubles as preferring the signed value, since
    -n leaves GPS:GPSAltitude an unsigned magnitude while
    Composite:GPSAltitude carries the GPSAltitudeRef sign. A name matching
    several groups is reported and left unresolved rather than guessed at, so
    an ambiguous request reads as "absent" instead of as the wrong group's
    value.
    """
    if tag in payload:
        return tag

    group, name = _split_tag(tag)
    if not group:
        composite = f"{_COMPOSITE_GROUP}:{name}"
        if composite in payload:
            return composite

    candidates = [key for key in payload if _split_tag(key)[1] == name]
    if group:
        candidates = [key for key in candidates if _split_tag(key)[0].lower().startswith(group.lower())]
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        log.warning(f"Ambiguous tag {tag!r}; exiftool reported: {', '.join(sorted(candidates))}")
    return None


def _parse_read_output(lines: list[str], path: Path) -> dict[str, Any]:
    """First record of exiftool's -j array; an unreadable file is a tool
    failure, not a file without tags."""
    try:
        payload = json.loads("\n".join(lines))
        record = payload[0]
    except (json.JSONDecodeError, IndexError, TypeError) as exc:
        raise ExiftoolError(f"Unreadable exiftool JSON output for {path}: {exc}") from exc
    if not isinstance(record, dict):
        raise ExiftoolError(f"Unexpected exiftool JSON record for {path}: {record!r}")
    if "Error" in record:
        raise ExiftoolError(f"Exiftool failed to read {path}: {record['Error']}")
    return {key: value for key, value in record.items() if key != "SourceFile"}


class _StayOpenProcess:
    """A persistent exiftool process speaking the -stay_open argfile protocol.

    Protocol: write args (one per line) to stdin with "-@ -" reading from
    stdin, then a line "-executeNNN" (unique marker). exiftool processes the
    args and responds with "{readyNNN}" on stdout. Send "-stay_open\nFalse"
    to terminate.

    stderr goes to a scratch file instead of being merged into stdout:
    exiftool reports failures there and perl writes locale warnings there, and
    a merged stream is what made a missing tag read back as a warning line.
    """

    _marker_counter = 0
    _marker_lock = threading.Lock()

    def __init__(self) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._filters = _filters()
        self._closed = False
        self._stderr = tempfile.TemporaryFile()
        self._stderr_offset = 0

    def _ensure_started(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            if self._proc is not None and self._proc.poll() is not None:
                log.debug("Exiftool persistent process died, restarting")
            try:
                self._proc = subprocess.Popen(
                    [_EXECUTABLE, "-stay_open", "True", "-@", "-", "-charset", "filename=UTF8"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=self._stderr,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
            except OSError as exc:
                raise ExiftoolError(f"Could not start exiftool ({_EXECUTABLE}): {exc}") from exc

    def _read_new_diagnostics(self) -> list[str]:
        """Diagnostics written since the previous command.

        Only new lines are returned: the perl startup warning is written once
        and must not be re-read (and re-reported) on every later call.
        """
        self._stderr.seek(self._stderr_offset)
        chunk = self._stderr.read()
        self._stderr_offset = self._stderr.tell()
        if isinstance(chunk, bytes):
            chunk = chunk.decode("utf-8", errors="replace")
        return chunk.splitlines()

    def execute(self, args: list[str]) -> list[str]:
        """Run one command through the persistent process, return stdout lines."""
        with _StayOpenProcess._marker_lock:
            _StayOpenProcess._marker_counter += 1
            marker = str(_StayOpenProcess._marker_counter)

        with self._lock:
            self._ensure_started()
            assert self._proc is not None and self._proc.stdin is not None and self._proc.stdout is not None

            self._proc.stdin.write("\n".join([*args, f"-execute{marker}"]) + "\n")
            self._proc.stdin.flush()

            lines: list[str] = []
            ready_token = f"{{ready{marker}}}"
            for line in self._proc.stdout:
                stripped = line.rstrip("\r\n")
                if stripped == ready_token:
                    break
                lines.append(stripped)

            diagnostics = self._read_new_diagnostics()

        # 诊断里的 Error 才是失败信号，它不参与返回值
        _check_output([*lines, *diagnostics], self._filters, "stay_open execute")
        return lines

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            proc, self._proc = self._proc, None
            if proc is not None and proc.stdin is not None:
                try:
                    proc.stdin.write("-stay_open\nFalse\n")
                    proc.stdin.flush()
                    proc.wait(timeout=10)
                except (OSError, subprocess.TimeoutExpired):
                    proc.kill()
            self._stderr.close()


def _get_process() -> _StayOpenProcess:
    proc = getattr(_local, "exiftool_proc", None)
    if proc is None:
        proc = _StayOpenProcess()
        _local.exiftool_proc = proc
    return proc


def invoke_persistent(*params: str) -> list[str]:
    """Run a command through the thread-local persistent exiftool process."""
    return _get_process().execute(list(params))


def close_thread_process() -> None:
    """Terminate the calling thread's persistent process (pool worker shutdown)."""
    proc = getattr(_local, "exiftool_proc", None)
    if proc is not None:
        proc.close()
        _local.exiftool_proc = None


LARGE_FILE_THRESHOLD = 4 * 1024**3  # 4 GiB, mirrors $_.Length -ge 4GB


def _large_file_args(path: Path) -> list[str]:
    """-api largefilesupport=1 for files >= 4 GiB."""
    try:
        if path.stat().st_size >= LARGE_FILE_THRESHOLD:
            return ["-api", "largefilesupport=1"]
    except OSError as exc:
        log.debug(f"Cannot stat file; skipping large-file check: {exc}", target=str(path))
    return []


def read_tags(path: Path, tags: Sequence[str]) -> dict[str, str]:
    """Read every requested tag in a single exiftool call.

    Values come out in numeric mode (`-n`), so GPS tags arrive as signed
    decimals ready to use. Returns a dict keyed by the requested names; a tag
    the file does not carry is absent from the dict. Reading the whole set at
    once is what keeps a file at one round-trip instead of one per tag.
    """
    requested = list(dict.fromkeys(tags))
    lines = invoke_persistent("-j", "-G1", "-n", *[f"-{tag}" for tag in requested], str(path))
    payload = _parse_read_output(lines, path)
    return {tag: str(payload[key]).strip() for tag in requested
            if (key := _resolve_key(payload, tag)) is not None}


def get_media_tag(path: Path, tag: str) -> str:
    """Read a single tag; empty string when absent."""
    return read_tags(path, [tag]).get(tag, "")


def _shift_amount(delta: timedelta) -> str:
    """A timedelta as the operand of exiftool's date shift ('0:0:1 2:30:00').

    exiftool shifts a date tag with `-Tag+=operand` / `-Tag-=operand`, where the
    operand counts from a zero date as `D:0:0 HH:MM:SS`. The sign lives in the
    operator, so only the magnitude is rendered here.
    """
    days, remainder = divmod(abs(int(delta.total_seconds())), 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"0:0:{days} {hours}:{minutes}:{seconds}"


class ExiftoolBackend(MetadataBackend):
    """The MetadataBackend over a persistent exiftool process."""

    def read_tags(self, path: Path, tags: Sequence[str]) -> dict[str, str]:
        return read_tags(path, tags)

    def write_tags(self, path: Path, tags: Mapping[str, str], *, overwrite: bool = False) -> None:
        params = [str(path), *(f"-{tag}={value}" for tag, value in tags.items())]
        if overwrite:
            params.append("-overwrite_original")
        invoke(*params, *_large_file_args(path))

    def shift_tags(self, path: Path, tags: Sequence[str], delta: timedelta,
                   *, overwrite: bool = False) -> None:
        sign = "-=" if delta < timedelta(0) else "+="
        operand = _shift_amount(delta)
        params = [str(path), *(f"-{tag}{sign}{operand}" for tag in tags)]
        if overwrite:
            params.append("-overwrite_original")
        invoke(*params, *_large_file_args(path))
