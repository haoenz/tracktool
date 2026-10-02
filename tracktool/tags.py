"""Every tag name this project addresses, each spelled once.

One spelling is shared by a reader, a writer and the tests at the same time,
and exiftool answers an unknown name with "absent" rather than as an error: a
typo therefore reads as a file that carries no value, and the file is then
silently skipped or filled in. Naming each tag here keeps that from happening,
makes a spelling change one edit, and answers "who reads this tag?" by grep.

The groups are what a command asks for in one call. A read costs one exiftool
round-trip no matter how many tags it names, so a command reads everything it
may need at once and picks from the result.
"""

# ── GPS 与器材 ──────────────────────────────────────────────────────────────

# 裸名（不写组名）：GPS 派生标签由 Composite 组给出，且 -n 下只有 Composite
# 那份按 GPSAltitudeRef 定了符号（GPS: 那份是无符号量值）
LATITUDE = "GPSLatitude"
LONGITUDE = "GPSLongitude"
ALTITUDE = "GPSAltitude"
LATITUDE_REF = "GPSLatitudeRef"
LONGITUDE_REF = "GPSLongitudeRef"
ALTITUDE_REF = "GPSAltitudeRef"

# 由四个 GPS 标签合成的派生值：读它，写它不起作用
POSITION = "GPSPosition"

MAKE = "Make"
MODEL = "Model"

# ── 时间标签 ────────────────────────────────────────────────────────────────

CAPTURE_TIME = "ExifIFD:DateTimeOriginal"
CREATE_DATE = "ExifIFD:CreateDate"
MODIFY_DATE = "IFD0:ModifyDate"
OFFSET_TIME = "ExifIFD:OffsetTime"
OFFSET_TIME_ORIGINAL = "ExifIFD:OffsetTimeOriginal"
OFFSET_TIME_DIGITIZED = "ExifIFD:OffsetTimeDigitized"
SONY_DATE_TIME = "Sony:SonyDateTime"
H264_CAPTURE_TIME = "H264:DateTimeOriginal"
XMP_CAPTURE_TIME = "XMP-exif:DateTimeOriginal"
XMP_CREATE_DATE = "XMP-xmp:CreateDate"
XMP_MODIFY_DATE = "XMP-xmp:ModifyDate"
QUICKTIME_CREATE_DATE = "QuickTime:CreateDate"
USERDATA_CAPTURE_TIME = "UserData:DateTimeOriginal"
KEYS_CAPTURE_TIME = "Keys:CreationDate"
QUICKTIME_MODIFY_DATE = "QuickTime:ModifyDate"
TRACK_CREATE_DATE = "Track1:TrackCreateDate"
TRACK_MODIFY_DATE = "Track1:TrackModifyDate"
MEDIA_CREATE_DATE = "Track2:MediaCreateDate"
MEDIA_MODIFY_DATE = "Track2:MediaModifyDate"

# ── IPTC 地点标签 ───────────────────────────────────────────────────────────

IPTC_CITY = "IPTC:City"
IPTC_STATE = "IPTC:Province-State"
IPTC_COUNTRY_CODE = "IPTC:Country-PrimaryLocationCode"
IPTC_COUNTRY_NAME = "IPTC:Country-PrimaryLocationName"

# ── KML ExtendedData ────────────────────────────────────────────────────────

TRACK_TAGS = "TrackTags"
POS_START_NAME = "PosStartName"
POS_END_NAME = "PosEndName"

# ── 一次读齐的标签组 ────────────────────────────────────────────────────────

# 候选时间标签的解析优先级归 mediatime（哪一份被采用）；这里是「要读哪些」，
# 因此它必须覆盖每一个候选——漏一个，那条候选就永远解析不到
TIME_TAGS: tuple[str, ...] = (
    CAPTURE_TIME,
    H264_CAPTURE_TIME,
    XMP_CAPTURE_TIME,
    QUICKTIME_CREATE_DATE,
    TRACK_CREATE_DATE,
    OFFSET_TIME_ORIGINAL,
    OFFSET_TIME,
    OFFSET_TIME_DIGITIZED,
)

# Video conversion also recognizes explicit capture timestamps in MP4 string tags.
VIDEO_TIME_TAGS: tuple[str, ...] = (*TIME_TAGS, KEYS_CAPTURE_TIME, USERDATA_CAPTURE_TIME, XMP_CREATE_DATE)
VIDEO_UTC_CREATE_TAGS: tuple[str, ...] = (
    QUICKTIME_CREATE_DATE,
    "QuickTime:TrackCreateDate",
    "QuickTime:MediaCreateDate",
)

# 判断「这个文件何时、在哪儿拍的」所需的全部
POSITION_TAGS: tuple[str, ...] = (*TIME_TAGS, LATITUDE, LONGITUDE, ALTITUDE)
# 补海拔：要坐标去查，要海拔判断缺不缺
ALTITUDE_TAGS: tuple[str, ...] = (ALTITUDE, LATITUDE, LONGITUDE)
# 反向地理编码：要坐标去查
LOCATION_TAGS: tuple[str, ...] = (LATITUDE, LONGITUDE)
# 时间平移：要 make 选标签集，要当前时区偏移算差值
SHIFT_TAGS: tuple[str, ...] = (MAKE, OFFSET_TIME)

# ── 各厂商的时间标签集 ──────────────────────────────────────────────────────

# EXIF Make 的注册值：exiftool 原样返回，精确匹配，不做大小写归一化
MAKE_SONY = "SONY"
MAKE_FUJIFILM = "FUJIFILM"
MAKE_INSTA360 = "Arashi Vision"

SONY_PHOTO_TAGS: tuple[str, ...] = (CAPTURE_TIME, SONY_DATE_TIME, MODIFY_DATE, CREATE_DATE)
SONY_MP4_TAGS: tuple[str, ...] = (
    XMP_CAPTURE_TIME,
    QUICKTIME_CREATE_DATE,
    QUICKTIME_MODIFY_DATE,
    TRACK_CREATE_DATE,
    TRACK_MODIFY_DATE,
    MEDIA_CREATE_DATE,
    MEDIA_MODIFY_DATE,
)
FUJIFILM_MP4_TAGS: tuple[str, ...] = (XMP_CAPTURE_TIME, XMP_CREATE_DATE, XMP_MODIFY_DATE)
INSTA360_MP4_TAGS: tuple[str, ...] = (
    XMP_CAPTURE_TIME,
    QUICKTIME_CREATE_DATE,
    QUICKTIME_MODIFY_DATE,
    TRACK_CREATE_DATE,
    TRACK_MODIFY_DATE,
    MEDIA_CREATE_DATE,
    MEDIA_MODIFY_DATE,
)

# (make, 扩展名) -> 要平移的时间标签集；组合缺失即该文件做不了时间平移
TIMESTAMP_TAG_SETS: dict[tuple[str, str], tuple[str, ...]] = {
    (MAKE_SONY, ".arw"): SONY_PHOTO_TAGS,
    (MAKE_SONY, ".jpg"): SONY_PHOTO_TAGS,
    (MAKE_SONY, ".jpeg"): SONY_PHOTO_TAGS,
    (MAKE_SONY, ".mp4"): SONY_MP4_TAGS,
    (MAKE_FUJIFILM, ".mp4"): FUJIFILM_MP4_TAGS,
    (MAKE_INSTA360, ".mp4"): INSTA360_MP4_TAGS,
}
