"""The Google Elevation client batches up to 512 locations per request; these
tests pin the batch boundary at the callers.

The repair orchestration used to hand the client one file at a time, so a
directory of 300 files missing altitude meant 300 requests instead of one —
the client's batching never had anything to batch. The same shape existed on
the KML side, where a per-file loop re-read and re-parsed the whole archive.
"""

from pathlib import Path

from conftest import InMemoryBackend

from tracktool import googleapi
from tracktool.context import ctx
from tracktool.exif import google as exif_google
from tracktool.exif import resolve as exif_resolve
from tracktool.exif.write import MissingTagResult
from tracktool.fileutil import BatchResult


def _paths(tmp_path: Path, prefix: str, count: int) -> list[Path]:
    return [tmp_path / f"{prefix}{i}.jpg" for i in range(count)]


def _install_backend(monkeypatch, files: list[Path], tags: dict[str, str]) -> InMemoryBackend:
    """Every listed file reports the same tags, so what these tests measure is
    the batch boundary rather than any per-file difference. Returns the double
    so a test can check what was finally written."""
    backend = InMemoryBackend({path: dict(tags) for path in files})
    monkeypatch.setattr(ctx, "backend", backend)
    return backend


class TestOneElevationCallPerSelection:
    def test_one_call_covers_every_file(self, tmp_path: Path, monkeypatch):
        files = _paths(tmp_path, "p", 3)
        backend = _install_backend(monkeypatch, files,
                                   {"GPSLatitude": "39.0", "GPSLongitude": "116.0"})
        queried: list[list[tuple[float, float]]] = []
        monkeypatch.setattr(
            exif_google.googleapi, "get_altitudes",
            lambda points, api_key=None: queried.append(list(points)) or [10.0] * len(points))

        result = exif_google.set_altitude_from_google(files)

        assert queried == [[(39.0, 116.0)] * 3], "整表一次查询"
        assert [path for path, _, _ in backend.writes] == files
        assert [tags["GPSAltitude"] for _, tags, _ in backend.writes] == ["10.0"] * 3
        assert result.ok

    def test_no_call_when_nothing_needs_altitude(self, tmp_path: Path, monkeypatch):
        files = _paths(tmp_path, "p", 2)
        _install_backend(monkeypatch, files, {"GPSAltitude": "100", "GPSLatitude": "39.0",
                                              "GPSLongitude": "116.0"})
        queried: list[object] = []
        monkeypatch.setattr(exif_google.googleapi, "get_altitudes",
                            lambda points, api_key=None: queried.append(points))

        result = exif_google.set_altitude_from_google(files)

        assert queried == []
        assert result.ok

    def test_a_directory_target_is_still_one_call(self, tmp_path: Path, monkeypatch):
        files = _paths(tmp_path, "p", 4)
        for path in files:
            path.touch()
        backend = _install_backend(monkeypatch, files,
                                   {"GPSLatitude": "39.0", "GPSLongitude": "116.0"})
        calls: list[int] = []
        monkeypatch.setattr(
            exif_google.googleapi, "get_altitudes",
            lambda points, api_key=None: calls.append(len(points)) or [1.0] * len(points))

        result = exif_google.set_altitude_from_google(tmp_path)

        assert calls == [4]
        assert len(backend.writes) == 4
        assert result.ok


class TestRepairPassesTheWholeSelectionToEachStage:
    def test_each_stage_is_called_once_with_its_file_list(self, tmp_path: Path, monkeypatch):
        altitude_only = [MissingTagResult(file=path, missing_tags=["GPSAltitude"])
                         for path in _paths(tmp_path, "a", 3)]
        position_only = [MissingTagResult(file=path, missing_tags=["GPSPosition"])
                         for path in _paths(tmp_path, "p", 2)]
        monkeypatch.setattr(exif_resolve, "find_missing_tag",
                            lambda path, tags, parallel=False: BatchResult(
                                [*altitude_only, *position_only]))
        calls: list[tuple[str, list[Path]]] = []
        monkeypatch.setattr(
            exif_resolve, "set_altitude_from_google",
            lambda files, **kwargs: calls.append(("altitude", list(files))) or BatchResult())
        monkeypatch.setattr(
            exif_resolve, "set_position_from_kml",
            lambda files, zip_path=None, **kwargs: calls.append(("position", list(files))) or BatchResult())
        monkeypatch.setattr(exif_resolve, "_organize_repaired", lambda files: None)

        exif_resolve.resolve_missing_gps(tmp_path)

        assert calls == [
            ("altitude", [r.file for r in altitude_only]),
            ("position", [r.file for r in position_only]),
        ]

    def test_stage_failures_reach_the_returned_result(self, tmp_path: Path, monkeypatch):
        missing = BatchResult([MissingTagResult(file=tmp_path / "p.jpg",
                                                missing_tags=["GPSPosition"])],
                              [tmp_path / "unreadable.jpg"])
        monkeypatch.setattr(exif_resolve, "find_missing_tag",
                            lambda path, tags, parallel=False: missing)
        monkeypatch.setattr(exif_resolve, "set_position_from_kml",
                            lambda files, zip_path=None, **kwargs: BatchResult([], [files[0]]))

        result = exif_resolve.resolve_missing_gps(tmp_path)

        # 读标签阶段的失败与位置阶段的失败都要出现在最终结果里
        assert [p.name for p in result.failed] == ["unreadable.jpg", "p.jpg"]
        assert not result.ok


class TestElevationResultsAlignWithPoints:
    def test_short_batch_pads_with_none_instead_of_shifting(self, monkeypatch):
        # 一批返回空（如 ZERO_RESULTS）时，后面的点不能顶上前面的结果
        monkeypatch.setattr(googleapi, "_batch_coordinates", lambda points: [["1,1"], ["2,2", "3,3"]])
        responses = iter([
            {"status": "OK", "results": [{"elevation": 1.0}]},
            {"status": "ZERO_RESULTS"},
        ])
        monkeypatch.setattr(googleapi, "_request_json", lambda *args, **kwargs: next(responses))

        elevations = googleapi.get_altitudes([(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)], api_key="k")

        assert elevations == [1.0, None, None]

    def test_one_result_per_point(self, monkeypatch):
        points = [(float(i), float(i)) for i in range(5)]
        monkeypatch.setattr(googleapi, "_batch_coordinates", lambda pts: [["0,0", "1,1"], ["2,2", "3,3", "4,4"]])
        responses = iter([
            {"status": "OK", "results": [{"elevation": 1.0}, {"elevation": 2.0}]},
            {"status": "OK", "results": [{"elevation": 3.0}]},  # 少给一个
        ])
        monkeypatch.setattr(googleapi, "_request_json", lambda *args, **kwargs: next(responses))

        elevations = googleapi.get_altitudes(points, api_key="k")

        assert len(elevations) == len(points)
        assert elevations == [1.0, 2.0, 3.0, None, None]

    def test_empty_input_makes_no_request(self, monkeypatch):
        def fail(*args, **kwargs):
            raise AssertionError("no request expected")

        monkeypatch.setattr(googleapi, "_request_json", fail)

        assert googleapi.get_altitudes([], api_key="k") == []
