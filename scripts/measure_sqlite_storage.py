"""Compare an isolated b4dc3df checkout with SQLite; generates all source data.

PYTHONPATH=. python scripts/measure_sqlite_storage.py --baseline /tmp/baseline --output /tmp/new-results
No OS page-cache flush: restart means fresh Python process, warm filesystem cache.
"""

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path


def worker(args):
    sys.path.insert(0, str(args.code))
    from tracktool import log, workflows
    from tracktool.context import ctx
    from tracktool.kml.archive import init_archive
    from tracktool.kml.kmlfile import TrackKind
    from tracktool.map_workflow import MapWorkspace

    log.set_level("ERROR")
    ctx.config["archive_history"] = False
    root = args.output
    archive = root / "archive" / "Archive.zip"
    if args.phase == "setup":
        init_archive(archive.parent)
        files = []
        for i in range(180):
            path = root / f"2026-10-{i % 28 + 1:02d} track-{i:04d}.kml"
            coords = " ".join(
                f"{100 + i * 0.0001 + j * 0.00001:.8f},{26 + j * 0.00001:.8f},{j % 100}" for j in range(2000)
            )
            path.write_text(
                '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
                '<ExtendedData><Data name="TrackTags"><value>徒步</value></Data></ExtendedData>'
                f"<Placemark><LineString><coordinates>{coords}</coordinates></LineString></Placemark>"
                "</Document></kml>"
            )
            files.append(path)
        workflows.push_tracks(files[:160], str(archive), TrackKind.DEFAULT, move=False)
        start = time.perf_counter()
        workflows.push_tracks(files[160:], str(archive), TrackKind.DEFAULT, move=False)
        result = {"push_20_into_160_seconds": time.perf_counter() - start}
    else:
        workspace = MapWorkspace()
        entries = [e["entry"] for e in workspace.catalog(str(archive))["entries"]][:50]
        samples = []
        for _ in range(6):
            start = time.perf_counter()
            selected = workspace.selection(str(archive), entries)
            samples.append(time.perf_counter() - start)
            assert not selected["errors"]
            assert sum(t["points"] for t in selected["tracks"]) == 100000
        result = {
            "first_read_seconds": samples[0],
            "repeat_read_seconds": samples[1:],
            "repeat_median_seconds": statistics.median(samples[1:]),
        }
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--code", type=Path)
    parser.add_argument("--phase", choices=["setup", "index-build", "restart"])
    args = parser.parse_args()
    if args.phase:
        worker(args)
        return
    args.output.mkdir(parents=True, exist_ok=False)
    result = {
        "fixture": {
            "existing_files": 160,
            "added_files": 20,
            "points_per_file": 2000,
            "selected_files": 50,
            "cache": "fresh process, warm OS cache; SQLite index persisted before restart",
            "baseline": "b4dc3df; history disabled; push includes ZIP and aggregate writes; --keep",
        },
        "runs": {},
    }
    for label, code in [("before", args.baseline), ("after", Path(__file__).resolve().parents[1])]:
        runs = []
        for trial in range(3):
            directory = args.output / f"{label}-{trial}"
            directory.mkdir()
            phases = {}
            for phase in ["setup", "index-build", "restart"]:
                command = [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--code",
                    str(code),
                    "--output",
                    str(directory),
                    "--phase",
                    phase,
                ]
                completed = subprocess.run(command, text=True, capture_output=True, check=True, cwd=directory)
                phases[phase] = json.loads(completed.stdout)
            runs.append(phases)
        result["runs"][label] = runs
    (args.output / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(
        json.dumps(
            {
                label: {
                    "push_median_s": statistics.median(r["setup"]["push_20_into_160_seconds"] for r in runs),
                    "first_index_median_s": statistics.median(r["index-build"]["first_read_seconds"] for r in runs),
                    "restart_median_s": statistics.median(r["restart"]["first_read_seconds"] for r in runs),
                    "repeat_median_s": statistics.median(r["restart"]["repeat_median_seconds"] for r in runs),
                }
                for label, runs in result["runs"].items()
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
