"""End-to-end verification against real exiftool: stay_open process, tag
write/read roundtrip, GPS position matching from a KML ZIP archive."""

import shutil
import sys
import tempfile
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))  # manual script: put tests/ on the path
from fixtures.media import make_test_jpeg  # noqa: E402

from tracktool import exiftool, mediatime  # noqa: E402
from tracktool.exif.position import (  # noqa: E402
    MAX_TIME_DIFF_SECONDS,
    SetPositionOptions,
    set_position_from_kml,
)
from tracktool.exif.write import SetExifOptions, find_missing_tag, set_exif  # noqa: E402


def main() -> None:
    td = Path(tempfile.mkdtemp(prefix="tracktool-e2e-"))
    try:
        # ── 准备媒体文件（3 张照片，拍摄时间分布在轨迹内/外）──
        media_dir = td / "photos"
        media_dir.mkdir()
        photos = []
        for i, minutes in enumerate([0, 1, 30]):
            photo = media_dir / f"photo{i}.jpg"
            make_test_jpeg(photo)
            # 拍摄时间：UTC 2024-05-01 00:0X:00（photo2 = 00:30 在轨迹[00:00-00:04]外）
            t = datetime(2024, 5, 1, 0, minutes, 0, tzinfo=UTC)
            # 写成本地时间(+08:00)再由 Get-MediaTime 解析回来；格式 yyyy:MM:dd HH:mm:ss
            local = t + timedelta(hours=8)
            exiftool.invoke_persistent(
                f"-Exif:DateTimeOriginal={local.strftime('%Y:%m:%d %H:%M:%S')}",
                "-overwrite_original", str(photo))
            photos.append(photo)

        # ── 准备 KML ZIP 归档（4 个轨迹点，00:00-00:03）──
        track = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document><name>2024-05-01 hike</name><Folder><Placemark><name>t</name><gx:Track>
<when>2024-05-01T00:00:00Z</when><when>2024-05-01T00:01:00Z</when>
<when>2024-05-01T00:02:00Z</when><when>2024-05-01T00:03:00Z</when>
<gx:coord>116.000000 39.000000 100</gx:coord>
<gx:coord>116.100000 39.100000 110</gx:coord>
<gx:coord>116.200000 39.200000 120</gx:coord>
<gx:coord>116.300000 39.300000 130</gx:coord>
</gx:Track></Placemark></Folder></Document></kml>"""
        zip_path = td / "Archive.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("2024-05-01 hike.kml", track)

        # ── 验证 1：find-missing 找出全部缺失 GPS 的照片 ──
        missing = find_missing_tag(media_dir, ["GPSPosition", "GPSAltitude"])
        assert len(missing.succeeded) == 3, f"expected 3 missing, got {len(missing.succeeded)}"
        assert missing.ok

        # ── 验证 2：set_position_from_kml 写入 GPS ──
        batch = set_position_from_kml(
            media_dir, str(zip_path),
            options=SetPositionOptions(max_time_diff_seconds=MAX_TIME_DIFF_SECONDS, overwrite=True,
                                       failed_folder_name="TrackPosFailed"))
        assert [len(plan) for plan in batch.succeeded] == [1, 1]  # photo0 / photo1 各一条写入计划
        assert [p.name for p in batch.failed] == ["photo2.jpg"], batch.failed

        # photo0: 00:00 UTC 精确匹配 -> (39.0, 116.0, 100)
        pos0 = exiftool.get_media_tag(photos[0], "GPSPosition")
        alt0 = exiftool.get_media_tag(photos[0], "GPSAltitude")
        print(f"photo0 -> {pos0} | {alt0}")
        assert "39" in pos0 and "116" in pos0, pos0
        assert alt0.startswith("100"), alt0

        # photo1: 00:01 UTC 精确匹配 -> (39.1, 116.1, 110)
        pos1 = exiftool.get_media_tag(photos[1], "GPSPosition")
        print(f"photo1 -> {pos1}")
        assert pos1 == "39.1 116.1", pos1

        # photo2: 00:30 UTC 在轨迹外 27 分钟 > 60s -> 移入 TrackPosFailed
        failed_dir = media_dir / "TrackPosFailed"
        assert (failed_dir / "photo2.jpg").is_file(), "photo2 should be moved to TrackPosFailed"
        print(f"photo2 -> moved to {failed_dir}")

        # ── 验证 3：修复后 find-missing 只剩 0 个（photo2 已移走）──
        missing_after = find_missing_tag(media_dir, ["GPSPosition", "GPSAltitude"])
        assert missing_after.succeeded == [], [str(m.file) for m in missing_after.succeeded]

        # ── 验证 4：Get-MediaTime 时区解析（+08:00 默认偏移）──
        t = mediatime.get_media_time(photos[0])
        assert t is not None
        print(f"photo0 media time: {t.isoformat()}")
        assert t.astimezone(UTC) == datetime(2024, 5, 1, 0, 0, 0, tzinfo=UTC)

        # ── 验证 5：Set-Exif 十进制写入 + 数值读回 ──
        set_exif(photos[0], SetExifOptions(position="31.230416 121.473701", altitude=4.0, overwrite=True))
        pos = exiftool.get_media_tag(photos[0], "GPSPosition")
        print(f"Shanghai position -> {pos}")
        assert "31" in pos and "121" in pos

        exiftool.close_thread_process()
        print("\nALL E2E CHECKS PASSED")
    finally:
        exiftool.close_thread_process()
        shutil.rmtree(td, ignore_errors=True)


if __name__ == "__main__":
    main()
