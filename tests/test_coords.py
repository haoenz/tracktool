"""Unit tests for pure logic: coordinates, mediatime parsing, batching."""

import pytest

from tracktool import coords


class TestDecimalCoord:
    def test_english_dms(self):
        result = coords.decimal_coord("39°54'30\"N, 116°23'29\"E")
        lat, lon = result.split(",")
        assert float(lat) == pytest.approx(39.908333, abs=1e-6)
        assert float(lon) == pytest.approx(116.391389, abs=1e-6)

    def test_deg_style(self):
        result = coords.decimal_coord("39 deg 54'30\"N, 116 deg 23'29\"E")
        assert result is not None

    def test_chinese_directions(self):
        result = coords.decimal_coord("39°54'30\"北, 116°23'29\"东")
        assert result is not None
        lat, lon = result.split(",")
        assert float(lat) > 0 and float(lon) > 0

    def test_south_west_negative(self):
        result = coords.decimal_coord("33°54'30\"S, 118°23'29\"W")
        lat, lon = result.split(",")
        assert float(lat) < 0 and float(lon) < 0

    def test_invalid_returns_none(self):
        assert coords.decimal_coord("not a coord") is None

    def test_fractional_seconds(self):
        result = coords.decimal_coord("39°54'30.5\"N, 116°23'29.25\"E")
        assert result is not None


class TestGeoDistance:
    def test_same_point_is_zero(self):
        assert coords.geo_distance(39.9, 116.4, 39.9, 116.4) == 0

    def test_known_distance(self):
        # 北京天安门到北京站约 2.7km
        distance = coords.geo_distance(39.9087, 116.3975, 39.9029, 116.4279)
        assert distance == pytest.approx(2700, abs=300)

    def test_one_degree_latitude(self):
        # WGS84 椭球上赤道处 1° 纬度约 110,574 m（Haversine 球面近似为 111,195 m）
        distance = coords.geo_distance(0, 0, 1, 0)
        assert distance == pytest.approx(110574, abs=10)

    def test_geodesic_reference_value(self):
        # geopy/geographiclib 的已知参考结果（Newport RI -> Cleveland OH）
        distance = coords.geo_distance(41.49008, -71.312796, 41.499498, -81.695391)
        assert distance == pytest.approx(866455.43, abs=1)


class TestIsDecimalCoord:
    def test_decimal(self):
        assert coords.is_decimal_coord("39.908333,116.391389")

    def test_dms_is_not_decimal(self):
        assert not coords.is_decimal_coord("39°54'30\"N, 116°23'29\"E")
