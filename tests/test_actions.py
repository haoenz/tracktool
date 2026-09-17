"""The action vocabulary and its executor.

Each `decide_*` rule is tested next to the module it belongs to; this file is
about the layer itself — how a plan describes itself, what applying one does,
and, most of all, what a preview must leave alone: the files, and the quota.
"""

import logging
from datetime import timedelta
from pathlib import Path

import pytest
from conftest import InMemoryBackend

from tracktool import actions
from tracktool.actions import (
    Failed,
    Lookup,
    RemuxVideo,
    Rename,
    ShiftTags,
    Skip,
    Step,
    WriteTags,
    describe,
    run,
)
from tracktool.context import ctx
from tracktool.exif import google as exif_google
from tracktool.fileutil import FileFailure


@pytest.fixture
def backend(monkeypatch) -> InMemoryBackend:
    double = InMemoryBackend()
    monkeypatch.setattr(ctx, "backend", double)
    return double


class TestDescribe:
    def test_a_write_names_every_assignment(self):
        kind, detail = describe(WriteTags(Path("a.jpg"), {"GPSAltitude": "110.0", "Make": "SONY"}))

        assert kind == "write tags"
        assert detail == "GPSAltitude=110.0, Make=SONY"

    def test_a_shift_reads_as_a_signed_amount(self):
        assert describe(ShiftTags(Path("a.jpg"), ["A", "B"], timedelta(hours=1, minutes=30))) == (
            "shift time", "2 timestamp tag(s) by +1:30:00")
        assert describe(ShiftTags(Path("a.jpg"), ["A"], timedelta(hours=-2))) == (
            "shift time", "1 timestamp tag(s) by -2:00:00")

    def test_a_remux_says_which_way_it_goes(self):
        out = Path("out") / "a.mp4"

        assert describe(RemuxVideo(Path("a.mov"), out, "2024-05-01T00:00:00", False, False)) == (
            "convert", "-> a.mp4 (ffmpeg)")
        assert describe(RemuxVideo(Path("a.mp4"), out, "2024-05-01T00:00:00", True, False)) == (
            "rewrap", "-> a.mp4 (ffmpeg)")
        assert describe(RemuxVideo(Path("a.mp4"), out, "2024-05-01T00:00:00", True, True)) == (
            "copy", "-> a.mp4 (keeping an _original)")

    def test_a_lookup_names_the_provider_and_the_point(self):
        assert describe(Lookup(Path("a.jpg"), "Google Elevation", "39.0,116.0",
                               point=(39.0, 116.0))) == (
            "query", "Google Elevation: 39.0,116.0")

    def test_skips_and_failures_read_as_reasons(self):
        assert describe(Skip(Path("a.jpg"), "nothing to do")) == ("skip", "nothing to do")
        assert describe(Failed(Path("a.jpg"), "no valid timestamp")) == ("fail", "no valid timestamp")

    def test_a_step_states_its_own_kind_and_detail(self):
        # 编排自己的动作（归档、转目录）不套用后端词汇，由计划给出两列
        step = Step(Path("a.kml"), "add to collection", "Default.kml", lambda: None)

        assert describe(step) == ("add to collection", "Default.kml")


class TestApply:
    def test_a_write_reaches_the_backend(self, backend):
        actions.apply(WriteTags(Path("a.jpg"), {"GPSAltitude": "1"}, overwrite=True))

        assert backend.writes == [(Path("a.jpg"), {"GPSAltitude": "1"}, True)]

    def test_a_shift_reaches_the_backend(self, backend):
        actions.apply(ShiftTags(Path("a.jpg"), ["ExifIFD:DateTimeOriginal"], timedelta(hours=1)))

        assert backend.shifts == [
            (Path("a.jpg"), ("ExifIFD:DateTimeOriginal",), timedelta(hours=1), False)]

    def test_a_rename_lands_on_disk(self, tmp_path: Path):
        file = tmp_path / "a.jpg"
        file.touch()

        actions.apply(Rename(file, "b.jpg"))

        assert (tmp_path / "b.jpg").is_file()
        assert not file.exists()

    def test_a_failure_raises_the_batch_contract(self):
        with pytest.raises(FileFailure) as exc_info:
            actions.apply(Failed(Path("a.jpg"), "no valid timestamp"))

        assert exc_info.value.quarantine

    def test_a_failure_can_keep_the_file_in_place(self):
        # 校验不符时文件是用户的证据，不该被搬走
        with pytest.raises(FileFailure) as exc_info:
            actions.apply(Failed(Path("a.jpg"), "GPS disagrees", quarantine=False))

        assert not exc_info.value.quarantine

    def test_skips_and_lookups_are_not_actions_to_perform(self, backend):
        actions.apply(Skip(Path("a.jpg"), "nothing to do"))
        actions.apply(Lookup(Path("a.jpg"), "Google Elevation", "1,2", point=(1.0, 2.0)))

        assert backend.reads == [] and backend.writes == [] and backend.shifts == []

    def test_a_step_runs_the_effect_it_carries(self):
        calls: list[str] = []

        actions.apply(Step(Path("a.kml"), "add to collection", "Default.kml",
                           lambda: calls.append("ran")))

        assert calls == ["ran"]


class TestRun:
    def test_a_run_applies_the_plan_and_returns_it(self, backend):
        plan = [WriteTags(Path("a.jpg"), {"Make": "SONY"})]

        assert run(plan) == plan
        assert backend.writes == [(Path("a.jpg"), {"Make": "SONY"}, False)]

    def test_a_preview_touches_nothing_but_still_returns_the_plan(self, backend, plan_mode, caplog):
        caplog.set_level(logging.INFO)
        plan = [WriteTags(Path("a.jpg"), {"Make": "SONY"}), Rename(Path("a.jpg"), "b.jpg")]

        assert run(plan) == plan
        assert backend.writes == []
        assert "write tags: Make=SONY" in caplog.text

    def test_a_preview_skips_a_steps_effect(self, plan_mode):
        calls: list[str] = []

        run([Step(Path("a.kml"), "rename", "VID -> VID_original", lambda: calls.append("ran"))])

        assert calls == []

    def test_a_preview_counts_a_failure_the_same_way(self, backend, plan_mode):
        # 预演的退出码要能预告真跑的结果，否则预览没有意义
        with pytest.raises(FileFailure):
            run([Failed(Path("a.jpg"), "no valid timestamp")])

        assert backend.writes == []

    def test_a_failure_stops_the_plan_where_it_happened(self, backend):
        plan = [WriteTags(Path("a.jpg"), {"Make": "SONY"}),
                Failed(Path("a.jpg"), "no valid timestamp"),
                Rename(Path("a.jpg"), "b.jpg")]

        with pytest.raises(FileFailure):
            run(plan)

        assert len(backend.writes) == 1

    def test_an_empty_plan_is_nothing_at_all(self, backend, plan_mode):
        assert run([]) == []


class TestPreviewStopsAtBillableWork:
    """Previewing a command that costs quota must not spend it — that is the
    whole reason the query is a step in the plan rather than a function call."""

    def test_the_elevation_query_is_planned_not_performed(self, tmp_path: Path, backend,
                                                          plan_mode, monkeypatch):
        files = [tmp_path / f"p{i}.jpg" for i in range(3)]
        for file in files:
            backend.tags[file] = {"GPSLatitude": "39.0", "GPSLongitude": "116.0"}

        def unexpected(*args: object, **kwargs: object) -> list[float]:
            raise AssertionError("a preview called the billable API")

        monkeypatch.setattr(exif_google.googleapi, "get_altitudes", unexpected)

        result = exif_google.set_altitude_from_google(files)

        plan = [action for per_file in result.succeeded for action in per_file]
        assert all(isinstance(action, Lookup) for action in plan)
        assert [action.detail for action in plan] == ["39.0,116.0"] * 3
        assert backend.writes == []

    def test_the_geocoding_query_is_planned_not_performed(self, tmp_path: Path, backend,
                                                          plan_mode, monkeypatch):
        file = tmp_path / "p.jpg"
        file.touch()
        backend.tags[file] = {"GPSLatitude": "39.0", "GPSLongitude": "116.0"}

        def unexpected(*args: object, **kwargs: object) -> object:
            raise AssertionError("a preview called the billable API")

        monkeypatch.setattr(exif_google.googleapi, "get_location", unexpected)

        result = exif_google.set_location_from_google(file)

        assert result.succeeded == [[Lookup(file, "Google Geocoding", "39.0,116.0",
                                            point=(39.0, 116.0))]]
        assert backend.writes == []
