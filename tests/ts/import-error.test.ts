import { expect, it } from "vitest";
import { importError } from "../../src/web/import-error.js";

it("uses the conflict result even when the server supplies a different reason", () => {
  expect(importError("已有轨迹内容不同", true)).toEqual({ label: "名称冲突" });
});

it("summarizes empty geometry errors with file and segment locations", () => {
  expect(
    importError("2026-10-01 空轨迹.kml: Empty line geometry; no coordinates"),
  ).toEqual({ label: "没有有效轨迹点" });
});

it("preserves the failing point and value when summarizing invalid coordinates", () => {
  const detail =
    '2026-10-01 徒步.kml: Placemark 1 (轨迹), segment 2, point 3: Invalid latitude "91"';
  expect(importError(detail)).toEqual({ label: "轨迹坐标无效", detail });
});

it("keeps unfamiliar failures intact instead of guessing from words in filenames", () => {
  const detail = "无法打开 Invalid timestamp.kml：磁盘读取失败";
  expect(importError(detail)).toEqual({ label: "导入失败", detail });
  expect(importError("constructor")).toEqual({
    label: "导入失败",
    detail: "constructor",
  });
  expect(importError(undefined)).toEqual({ label: "导入失败" });
});
