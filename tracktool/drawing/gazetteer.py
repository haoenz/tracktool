"""Conservative China-only GeoNames administrative-label adapter (v1).

Never infer an administrative level from place=city/town or population/rank.
ADM2/ADM3 supply administrative names. Seats may correct their locations, but
PPLA3 town names never replace county names. Unknown/orphan records are counted.
"""

import hashlib
import json
import re
import zipfile
from collections import Counter
from pathlib import Path

HAN = re.compile(r"[\u3400-\u9fff·]+")


def chinese_name(row: list[str], *, administrative: bool = False) -> str:
    names = [s for s in row[3].split(",") if HAN.fullmatch(s)]
    if administrative:
        names = [s for s in names if s.endswith(("市", "县", "区", "旗", "州", "盟", "地区"))]
        return max(names, key=len, default="")
    return min(names, key=lambda s: (not s.endswith("市"), len(s), s), default="")


def build_gazetteer(source: Path) -> dict:
    with zipfile.ZipFile(source) as archive:
        rows = [line.split("\t") for line in archive.read("CN.txt").decode("utf-8").splitlines()]
    seats: dict[tuple, list[str]] = {}
    for row in rows:
        if row[8] != "CN" or row[7] not in ("PPLC", "PPLA", "PPLA2", "PPLA3"):
            continue
        for level in (2, 3):
            key = tuple(row[10 : 10 + level])
            if all(key) and (level == 3 or row[7] != "PPLA3"):
                old = seats.get(key)
                if old is None or int(row[14]) > int(old[14]):
                    seats[key] = row
    labels = []
    skipped: Counter = Counter()
    for row in rows:
        code = row[7]
        if row[8] != "CN" or code not in ("PPLC", "PPLA", "ADM2", "ADM3"):
            continue
        level = {"PPLC": 0, "PPLA": 1, "ADM2": 2, "ADM3": 3}[code]
        key = tuple(row[10 : 10 + level]) if level >= 2 else (row[10],)
        if not all(key):
            skipped["missing_admin_code"] += 1
            continue
        name = chinese_name(row, administrative=level >= 2)
        if not name or name in ("市辖区", "省直辖县级行政区划", "自治区直辖县级行政区划"):
            skipped["missing_or_group_name"] += 1
            continue
        seat = seats.get(key) if level >= 2 else row
        if level == 2 and seat is not None:
            name = chinese_name(seat) or name
        point = seat or row
        labels.append(
            {
                "id": row[0],
                "name": name,
                "level": level,
                "code": code,
                "admin": list(key),
                "position": [float(point[5]), float(point[4])],
                "position_kind": "seat" if seat else "administrative_point",
                "position_id": point[0],
                "modified": row[18],
            }
        )
    labels.sort(key=lambda x: (x["level"], x["id"]))
    return {
        "adapter": "geonames-cn-admin-v1",
        "source": "https://download.geonames.org/export/dump/CN.zip",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "license": "GeoNames CC BY 4.0",
        "coverage": "CN only; ADM2/ADM3 plus PPLC/PPLA; not a current official registry",
        "counts": dict(Counter(str(label["level"]) for label in labels)),
        "skipped": dict(skipped),
        "labels": labels,
    }


def write_gazetteer(source: Path, destination: Path) -> None:
    destination.write_text(json.dumps(build_gazetteer(source), ensure_ascii=False, separators=(",", ":")) + "\n")
