import { createHash } from "node:crypto";
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js";
import { AppError } from "../domain/errors.js";
function chineseName(row: string[], administrative = false) {
  const names = row[3]!.split(",").filter((s) => /^[\u3400-\u9fff·]+$/.test(s));
  if (administrative)
    return (
      names
        .filter((s) => /(市|县|区|旗|州|盟|地区)$/.test(s))
        .sort((a, b) => b.length - a.length)[0] ?? ""
    );
  return (
    names.sort(
      (a, b) =>
        Number(!a.endsWith("市")) - Number(!b.endsWith("市")) ||
        a.length - b.length ||
        (a < b ? -1 : a > b ? 1 : 0),
    )[0] ?? ""
  );
}
export async function buildGazetteer(bytes: Uint8Array) {
  const zip = new ZipReader(new Uint8ArrayReader(bytes));
  let text: string;
  try {
    const entry = (await zip.getEntries()).find((e) => e.filename === "CN.txt");
    if (!entry || entry.directory || entry.uncompressedSize > 256 * 1024 * 1024)
      throw new AppError(
        "USER_INPUT",
        "需要包含 CN.txt 的 GeoNames ZIP（最多 256 MiB）",
      );
    text = await entry.getData(new TextWriter(), { checkSignature: true });
  } finally {
    await zip.close();
  }
  const rows = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  if (rows.some((r) => r.length < 19))
    throw new AppError("USER_INPUT", "GeoNames 记录不完整");
  const seats = new Map<string, string[]>(),
    skipped: Record<string, number> = {},
    counts: Record<string, number> = {};
  for (const row of rows) {
    if (
      row[8] !== "CN" ||
      !["PPLC", "PPLA", "PPLA2", "PPLA3"].includes(row[7]!)
    )
      continue;
    for (const level of [2, 3]) {
      const admin = row.slice(10, 10 + level),
        key = JSON.stringify(admin),
        old = seats.get(key);
      if (
        admin.every(Boolean) &&
        (level === 3 || row[7] !== "PPLA3") &&
        (!old || Number(row[14]) > Number(old[14]))
      )
        seats.set(key, row);
    }
  }
  const labels = [];
  for (const row of rows) {
    const code = row[7]!,
      level = (
        { PPLC: 0, PPLA: 1, ADM2: 2, ADM3: 3 } as Record<string, number>
      )[code];
    if (row[8] !== "CN" || level === undefined) continue;
    const admin = row.slice(10, 10 + (level >= 2 ? level : 1));
    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };
    if (!admin.every(Boolean)) {
      skip("missing_admin_code");
      continue;
    }
    let name = chineseName(row, level >= 2);
    if (
      !name ||
      ["市辖区", "省直辖县级行政区划", "自治区直辖县级行政区划"].includes(name)
    ) {
      skip("missing_or_group_name");
      continue;
    }
    const seat = level >= 2 ? seats.get(JSON.stringify(admin)) : row,
      point = seat ?? row;
    if (level === 2 && seat) name = chineseName(seat) || name;
    const position = [Number(point[5]), Number(point[4])];
    if (
      !position.every(Number.isFinite) ||
      Math.abs(position[0]!) > 180 ||
      Math.abs(position[1]!) > 90
    )
      throw new AppError("USER_INPUT", "GeoNames 坐标无效");
    labels.push({
      id: row[0]!,
      name,
      level,
      code,
      admin,
      position,
      position_kind: seat ? "seat" : "administrative_point",
      position_id: point[0]!,
      modified: row[18]!,
    });
    counts[level] = (counts[level] ?? 0) + 1;
  }
  labels.sort(
    (a, b) => a.level - b.level || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    adapter: "geonames-cn-admin-v1",
    source: "https://download.geonames.org/export/dump/CN.zip",
    source_sha256: createHash("sha256").update(bytes).digest("hex"),
    license: "GeoNames CC BY 4.0",
    coverage:
      "CN only; ADM2/ADM3 plus PPLC/PPLA; not a current official registry",
    counts,
    skipped,
    labels,
  };
}
