import { expect, it } from "vitest";
import { importLine } from "../../dist/node/infrastructure/xml/import-line.js";
import { editSegments } from "../../dist/node/infrastructure/xml/segment-edit.js";
import { readManifest } from "../../dist/node/infrastructure/xml/manifest.js";
const wrap = (body: string) =>
  `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>${body}</Document></kml>`;
const line =
  "<LineString><coordinates>179.5,30,12 -179.5,31,25</coordinates></LineString>";
const kml = wrap(`<Placemark>${line}</Placemark>`);
const bytes = (s: string) => new TextEncoder().encode(s);
it("imports a single untimed line preserving altitude and dateline coordinates", () => {
  expect(importLine(bytes(kml))).toEqual([
    [179.5, 30, 12],
    [-179.5, 31, 25],
  ]);
});
it.each([
  [
    wrap(`<Placemark>${line}${line}</Placemark>`),
    "只能上传一条 LineString，当前有 2 条",
  ],
  [
    wrap(
      `<Placemark><gx:Track><gx:coord>120 30 0</gx:coord></gx:Track></Placemark>`,
    ),
    "不支持 gx:Track，请改用 LineString",
  ],
  [
    wrap(
      `<Placemark><TimeStamp><when>2026-01-01</when></TimeStamp>${line}</Placemark>`,
    ),
    "补绘轨迹不能包含时间信息（TimeStamp、TimeSpan 或 when）",
  ],
  [
    wrap(
      `<TimeSpan><begin>2026-01-01</begin></TimeSpan><Placemark>${line}</Placemark>`,
    ),
    "补绘轨迹不能包含时间信息（TimeStamp、TimeSpan 或 when）",
  ],
  [
    wrap(
      "<Placemark><LineString><coordinates>120,30</coordinates></LineString></Placemark>",
    ),
    "LineString 至少需要两个点，当前有 1 个",
  ],
  [
    wrap(
      "<Placemark><LineString><coordinates>181,30 120,31</coordinates></LineString></Placemark>",
    ),
    /Invalid longitude/,
  ],
  [
    wrap(
      `<Placemark>${line}<Point><coordinates>120,30</coordinates></Point></Placemark>`,
    ),
    "只支持 LineString，不能包含 Point、Polygon 或 LinearRing",
  ],
  [wrap("<Placemark><name>没有线</name></Placemark>"), "KML 中没有 LineString"],
  ["<gpx></gpx>", "不是有效的 KML 文件"],
  ["<kml>", "XML 格式或编码无效"],
])("rejects invalid or timed input: %s", (xml, message) => {
  expect(() => importLine(bytes(xml))).toThrow(message);
});
it("revalidates imported XML on save and inserts original coordinates in segment order", () => {
  const raw = bytes(kml);
  const manifest = readManifest(raw, () => "original");
  const source = {
    version_id: "v1",
    raw,
    segments: manifest.segments,
    settings: {
      schema: 1 as const,
      default_connect: false,
      order: ["original"],
      ignored: [],
      connections: [],
    },
  };
  const operation = {
    kind: "draw" as const,
    after_segment_id: "original",
    coordinates: [
      [0, 0],
      [1, 1],
    ] as [number, number][],
    import_kml: kml,
  };
  const result = editSegments(source, operation, "import-test");
  expect(result.settings.order).toEqual([
    "original",
    result.segments[1]!.segment_id,
  ]);
  expect(result.segments[1]).toMatchObject({
    geometry_kind: "LineString",
    time_status: "absent",
    point_count: 2,
  });
  expect(new TextDecoder().decode(result.raw)).toContain(
    "179.5,30,12 -179.5,31,25",
  );
  expect(() =>
    editSegments(
      source,
      {
        ...operation,
        import_kml: wrap(`<Placemark>${line}${line}</Placemark>`),
      },
      "invalid",
    ),
  ).toThrow();
  expect(() =>
    editSegments(
      source,
      { ...operation, snap_start: { segment_id: "original", endpoint: "end" } },
      "snap",
    ),
  ).toThrow();
});
