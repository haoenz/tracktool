"""Exiftool wrapper.

Mirrors Invoke-Exiftool semantics: filter ignorable warnings (outputFilters
from config, |-separated regexes), raise on any line matching \\bError\\b.

Batch mode uses the -stay_open -@ argfile protocol for a persistent exiftool
process, eliminating the per-file process startup cost of the PowerShell
version. One process is not safe to share across threads, so get_media_tag
etc. use a thread-local persistent process.
"""

import os
import re
import subprocess
import threading
from pathlib import Path

from . import log
from .config import Config, config

ERROR_PATTERN = re.compile(r"\bError\b")

_EXECUTABLE = os.environ.get("TRACKTOOL_EXIFTOOL", "exiftool")
_local = threading.local()


class ExiftoolError(Exception):
    """Raised when exiftool output contains an error."""


def _filters(cfg: Config) -> list[re.Pattern[str]]:
    return [re.compile(f) for f in cfg.output_filters]


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
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    output = (proc.stdout + proc.stderr).splitlines()
    return _check_output(output, _filters(config), " ".join(cmd[:4]))


class _StayOpenProcess:
    """A persistent exiftool process speaking the -stay_open argfile protocol.

    Protocol: write args (one per line) to stdin with "-@ -" reading from
    stdin, then a line "-executeNNN" (unique marker). exiftool processes the
    args and responds with "{readyNNN}" on stdout. Send "-stay_open\nFalse"
    to terminate.
    """

    _marker_counter = 0
    _marker_lock = threading.Lock()

    def __init__(self) -> None:
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._filters = _filters(config)
        self._closed = False

    def _ensure_started(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            if self._proc is not None and self._proc.poll() is not None:
                log.debug("Exiftool persistent process died, restarting")
            self._proc = subprocess.Popen(
                [_EXECUTABLE, "-stay_open", "True", "-@", "-", "-charset", "filename=UTF8"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

    def execute(self, args: list[str]) -> list[str]:
        """Run one command through the persistent process, return output lines."""
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

        return _check_output(lines, self._filters, "stay_open execute")

    def close(self) -> None:
        with self._lock:
            if self._closed or self._proc is None:
                return
            self._closed = True
            assert self._proc.stdin is not None
            try:
                self._proc.stdin.write("-stay_open\nFalse\n")
                self._proc.stdin.flush()
                self._proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                self._proc.kill()
            finally:
                self._proc = None


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


def large_file_args(path: Path) -> list[str]:
    """-api largefilesupport=1 for files >= 4 GiB."""
    try:
        if path.stat().st_size >= LARGE_FILE_THRESHOLD:
            return ["-api", "largefilesupport=1"]
    except OSError as exc:
        log.debug(f"Cannot stat file; skipping large-file check: {exc}", target=str(path))
    return []


def get_media_tag(path: Path, tag: str) -> str:
    """Read a single tag; empty string when absent (mirrors Get-MediaTag)."""
    output = invoke_persistent("-s3", f"-{tag}", str(path))
    return output[0].strip() if output else ""
