"""Nearest-track correctness and reusable, bounded timestamp searches."""

import random
import zipfile
from datetime import UTC, datetime, timedelta, timezone

import pytest
from conftest import InMemoryBackend, make_archive

from tracktool.context import RunMode, ctx
from tracktool.errors import UserInputError
from tracktool.exif.position import GeotagOptions, _find_best_track, _TrackLibrary, geotag_from_kml
from tracktool.kml import track as track_module
from tracktool.kml.track import Track, TrackPoint

START = datetime(2024, 5, 1, tzinfo=UTC)


def track(name, seconds, latitude=39.0):
    return Track(
        f"2024-05-01 {name}.kml",
        tuple(TrackPoint(latitude, 116.0, 100.0, START + timedelta(seconds=s)) for s in seconds),
    )


@pytest.mark.parametrize("reverse", [False, True])
def test_overlapping_sparse_track_does_not_hide_exact_match(reverse):
    sparse = track("sparse", [0, 1200])
    exact = track("exact", [590, 600, 610], latitude=40.0)
    tracks = [sparse, exact]
    best = _find_best_track(tracks[::-1] if reverse else tracks, START + timedelta(seconds=600), False)
    assert best is not None
    assert best.point == exact.points[1]
    assert best.seconds_from_nearest == 0


def test_outside_endpoint_can_be_closer_than_inside_point():
    inside = track("inside", [0, 100])
    outside = track("outside", [49], latitude=40.0)
    best = _find_best_track([inside, outside], START + timedelta(seconds=50), False)
    assert best is not None and best.point == outside.points[0]


@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("same_name", [False, True])
def test_equal_matches_are_independent_of_track_order(reverse, same_name):
    a = track("a", [0, 60], latitude=39.0)
    b = track("a" if same_name else "b", [0, 60], latitude=40.0)
    best = _find_best_track([b, a] if reverse else [a, b], START, False)
    assert best is not None and best.point == a.points[0]


def test_equal_difference_prefers_inside_duration():
    inside = track("z", [0, 60], latitude=40.0)
    outside = track("a", [0], latitude=39.0)
    best = _find_best_track([outside, inside], START + timedelta(seconds=30), False)
    assert best is not None and best.point == inside.points[1]


@pytest.mark.parametrize(
    "seconds,limit,expected",
    [
        (-60, 60, True),
        (120, 60, True),
        (-61, 60, False),
        (121, 60, False),
        (-90, 90, True),
        (150, 90, True),
        (0, 0, True),
        (1, 0, False),
    ],
)
def test_bounds_include_tolerance_and_honor_custom_limit(seconds, limit, expected):
    best = _find_best_track(
        [track("a", [0, 60])], START + timedelta(seconds=seconds), True, max_time_diff_seconds=limit
    )
    assert (best is not None) is expected


def test_track_gap_still_needs_a_point_within_tolerance():
    assert _find_best_track([track("gap", [0, 1200])], START + timedelta(seconds=600), False) is None


def test_timezones_representing_the_same_instant_match():
    local_time = START.astimezone(timezone(timedelta(hours=8)))
    best = _find_best_track([track("a", [0])], local_time, False)
    assert best is not None and best.seconds_from_nearest == 0


def test_outside_window_never_reaches_binary_search(monkeypatch):
    candidate = track("a", [3600, 7200])

    def unexpected(*args):
        pytest.fail("An out-of-window track reached binary search")

    monkeypatch.setattr(track_module, "bisect_left", unexpected)
    assert _find_best_track([candidate], START, False) is None


def test_repeated_queries_reuse_one_time_index(monkeypatch):
    candidate = track("a", [0, 60, 120])
    indexes = []
    original = track_module.bisect_left

    def record(times, time):
        indexes.append(times)
        return original(times, time)

    monkeypatch.setattr(track_module, "bisect_left", record)
    for second in (10, 70, 100):
        assert candidate.nearest(START + timedelta(seconds=second)) is not None
    assert indexes[0] is indexes[1] is indexes[2]


def test_unsorted_points_are_rejected_at_construction():
    with pytest.raises(UserInputError, match="time order"):
        track("unsorted", [60, 0])


def test_duplicate_timestamps_remain_valid():
    candidate = track("duplicate", [0, 0, 60])
    assert candidate.nearest(START).point == candidate.points[0]


@pytest.mark.parametrize("limit", [0, 60, 180])
def test_optimized_search_agrees_with_exhaustive_point_comparison(limit):
    rng = random.Random(7)
    tracks = [track(str(i), sorted(rng.sample(range(3600), 8)), latitude=30 + i) for i in range(12)]
    for second in range(0, 3600, 73):
        query = START + timedelta(seconds=second)
        closest = min(abs((p.time - query).total_seconds()) for t in tracks for p in t.points)
        rng.shuffle(tracks)
        match = _find_best_track(tracks, query, False, max_time_diff_seconds=limit)
        if closest > limit:
            assert match is None
        else:
            assert match is not None and match.seconds_from_nearest == closest
            assert abs((match.point.time - query).total_seconds()) == closest


def kml(seconds, latitude):
    times = "".join(f"<when>{(START + timedelta(seconds=s)).strftime('%Y-%m-%dT%H:%M:%SZ')}</when>" for s in seconds)
    points = "".join(f"<gx:coord>116 {latitude} 100</gx:coord>" for _ in seconds)
    return (
        '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">'
        f"<Document><Placemark><gx:Track>{times}{points}</gx:Track></Placemark></Document></kml>"
    )


def test_library_skips_unsorted_track_and_keeps_valid_track(tmp_path, caplog):
    archive = tmp_path / "Archive.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("Default/2024-05/2024-05-01 bad.kml", kml([60, 0], 39))
        zf.writestr("Default/2024-05/2024-05-01 good.kml", kml([0, 60], 40))
    tracks = _TrackLibrary(archive).tracks_for(["2024-05-01"])
    assert [t.name for t in tracks] == ["2024-05-01 good.kml"]
    assert "time order" in caplog.text


@pytest.mark.parametrize("parallel", [False, True])
@pytest.mark.parametrize("mode", [RunMode.APPLY, RunMode.PLAN])
def test_batch_uses_best_track_and_custom_tolerance(tmp_path, monkeypatch, parallel, mode):
    archive_dir = tmp_path / "archive"
    archive = make_archive(archive_dir)
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("Default/2024-05/2024-05-01 sparse.kml", kml([0, 1200], 39))
        zf.writestr("Default/2024-05/2024-05-01 exact.kml", kml([600], 40))
    files = [tmp_path / "exact.jpg", tmp_path / "endpoint.jpg"]
    backend = InMemoryBackend()
    for file, timestamp in zip(files, ["00:10:00", "00:21:30"], strict=True):
        file.touch()
        backend.tags[file] = {
            "ExifIFD:DateTimeOriginal": f"2024:05:01 {timestamp}",
            "ExifIFD:OffsetTimeOriginal": "+00:00",
        }
    monkeypatch.setattr(ctx, "backend", backend)
    monkeypatch.setattr(ctx, "mode", mode)
    monkeypatch.setattr(ctx, "reporter", lambda activity: None)

    result = geotag_from_kml(files, str(archive), GeotagOptions(max_time_diff_seconds=90), parallel)

    assert result.failed == []
    plans = {action.file: action.tags for plan in result.succeeded for action in plan}
    assert float(plans[files[0]]["GPSLatitude"]) == 40
    assert float(plans[files[1]]["GPSLatitude"]) == 39
    assert len(backend.writes) == (2 if mode is RunMode.APPLY else 0)
