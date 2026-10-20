import { AppError } from "../../domain/errors.js";
import { withDocument, namespaces } from "./document.js";
import { readTrackData } from "./trackdata.js";

export function importLine(
  bytes: Uint8Array,
): ([number, number] | [number, number, number])[] {
  if (bytes.length > 8 * 1024 * 1024)
    throw new AppError("USER_INPUT", "KML 文件不能超过 8 MiB");
  return withDocument(bytes, (doc) => {
    const ns = namespaces;
    const count = (selector: string) => doc.find(selector, ns).length;
    const fail = (message: string): never => {
      throw new AppError("USER_INPUT", message);
    };
    if (doc.root.name !== "kml" || doc.root.namespaceUri !== ns.kml)
      fail("不是有效的 KML 文件");
    if (count("//*[local-name()='Track' or local-name()='MultiTrack']"))
      fail("不支持 gx:Track，请改用 LineString");
    if (
      count(
        "//*[local-name()='TimeStamp' or local-name()='TimeSpan' or local-name()='when']",
      )
    )
      fail("补绘轨迹不能包含时间信息（TimeStamp、TimeSpan 或 when）");
    if (
      count(
        "//*[local-name()='Point' or local-name()='Polygon' or local-name()='LinearRing']",
      )
    )
      fail("只支持 LineString，不能包含 Point、Polygon 或 LinearRing");
    const lines = count("//kml:LineString");
    if (lines === 0) fail("KML 中没有 LineString");
    if (lines > 1) fail(`只能上传一条 LineString，当前有 ${lines} 条`);
    const segments = readTrackData(doc).tracks.flatMap((t) => t.segments);
    if (segments.length !== 1 || segments[0]!.kind !== "LineString")
      fail("LineString 无法解析，请检查坐标格式");
    const points = segments[0]!.longitude.length;
    if (points < 2) fail(`LineString 至少需要两个点，当前有 ${points} 个`);
    const line = segments[0]!;
    return Array.from(
      line.longitude,
      (x, i): [number, number] | [number, number, number] => {
        const altitude = line.altitude?.[i];
        return altitude !== undefined && Number.isFinite(altitude)
          ? [x, line.latitude[i]!, altitude]
          : [x, line.latitude[i]!];
      },
    );
  });
}
