import { AppError } from "./errors.js";
import { TAGS as T, TIMESTAMP_TAG_SETS } from "./tags.js";
import {
  formatWall,
  offsetMinutes,
  parseTimeDiff,
  resolveVideoTime,
} from "./media-time.js";
import type { Metadata } from "./media-time.js";
export const MEDIA_EXTENSIONS: Record<string, string> = {
  ".mp4": "VID",
  ".mov": "VID",
  ".avi": "VID",
  ".arw": "RAW",
  ".raf": "RAW",
  ".dng": "RAW",
  ".jpg": "IMG",
  ".jpeg": "IMG",
};
export type MediaAction =
  | { kind: "write"; file: string; tags: Metadata; overwrite: boolean }
  | {
      kind: "shift";
      file: string;
      tags: readonly string[];
      seconds: number;
      overwrite: boolean;
    }
  | { kind: "move"; file: string; output: string }
  | {
      kind: "remux";
      file: string;
      output: string;
      utc: string;
      mp4: boolean;
      quicktime: boolean;
    }
  | { kind: "skip" | "lookup"; file: string; reason: string }
  | { kind: "failed"; file: string; reason: string; quarantine: boolean };
export interface MediaFile {
  path: string;
  name: string;
  stem: string;
  extension: string;
  directory: string;
}
export function missingAltitude(value?: string): boolean {
  return value === undefined || value === "" || Number(value) === 0;
}
export function altitude(tags: Metadata): number | undefined {
  const value = tags[T.ALTITUDE];
  return !missingAltitude(value) && Number.isFinite(Number(value))
    ? Number(value)
    : undefined;
}
export function position(tags: Metadata): [number, number] | undefined {
  const lat = tags[T.LATITUDE],
    lon = tags[T.LONGITUDE];
  return lat?.trim() &&
    lon?.trim() &&
    Number.isFinite(+lat) &&
    Number.isFinite(+lon)
    ? [+lat, +lon]
    : undefined;
}
export function coordinate(text: string): [number, number] {
  const decimal = /^(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)$/.exec(text.trim());
  const dms =
    /^\s*(\d{1,2})\s*(?:deg|°)?\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*"\s*([NS北南])\s*,?\s*(\d{1,3})\s*(?:deg|°)?\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*"\s*([EW东西])\s*$/.exec(
      text,
    );
  let result: [number, number] | undefined;
  if (decimal) result = [+decimal[1]!, +decimal[2]!];
  if (dms)
    result = [
      (+dms[1]! + +dms[2]! / 60 + +dms[3]! / 3600) *
        (/[S南]/.test(dms[4]!) ? -1 : 1),
      (+dms[5]! + +dms[6]! / 60 + +dms[7]! / 3600) *
        (/[W西]/.test(dms[8]!) ? -1 : 1),
    ];
  if (!result || Math.abs(result[0]) > 90 || Math.abs(result[1]) > 180)
    throw new AppError("USER_INPUT", `Invalid coordinate: ${text}`);
  return result;
}
export function gpsTags(point?: [number, number], height?: number): Metadata {
  const tags: Metadata = {};
  if (point)
    Object.assign(tags, {
      [T.LATITUDE]: String(Math.abs(point[0])),
      [T.LONGITUDE]: String(Math.abs(point[1])),
      [T.LATITUDE_REF]: point[0] < 0 ? "S" : "N",
      [T.LONGITUDE_REF]: point[1] < 0 ? "W" : "E",
    });
  if (height !== undefined) {
    if (!Number.isFinite(height))
      throw new AppError("USER_INPUT", "Altitude must be finite");
    Object.assign(tags, {
      [T.ALTITUDE]: String(Math.abs(height)),
      [T.ALTITUDE_REF]: height < 0 ? "Below Sea Level" : "Above Sea Level",
    });
  }
  return tags;
}
export function fail(
  file: string,
  reason: string,
  quarantine = true,
): MediaAction[] {
  return [{ kind: "failed", file, reason, quarantine }];
}
export function shiftTime(
  file: MediaFile,
  tags: Metadata,
  by?: string,
  offset?: string,
  overwrite = false,
): MediaAction[] {
  if (by === undefined && offset === undefined)
    throw new AppError("USER_INPUT", "Provide --by or --offset-time");
  let seconds = by === undefined ? 0 : parseTimeDiff(by);
  const writes: Metadata = {};
  if (offset !== undefined) {
    offsetMinutes(offset);
    if (tags[T.MAKE] !== T.MAKE_SONY)
      return fail(file.path, "Timezone shifting requires SONY");
    seconds +=
      (offsetMinutes(offset) - offsetMinutes(tags[T.OFFSET_TIME] || "+08:00")) *
      60;
    for (const key of [
      T.OFFSET_TIME,
      T.OFFSET_TIME_ORIGINAL,
      T.OFFSET_TIME_DIGITIZED,
    ])
      writes[key] = offset;
  }
  const actions: MediaAction[] = [];
  if (seconds) {
    const set = TIMESTAMP_TAG_SETS.find(
      (s) => s.make === tags[T.MAKE] && s.extension === file.extension,
    );
    if (!set)
      return fail(file.path, "Unsupported camera or extension for time shift");
    actions.push({
      kind: "shift",
      file: file.path,
      tags: set.tags,
      seconds,
      overwrite,
    });
  }
  if (Object.keys(writes).length)
    actions.push({ kind: "write", file: file.path, tags: writes, overwrite });
  if (
    seconds &&
    tags[T.MAKE] === T.MAKE_INSTA360 &&
    file.extension === ".mp4"
  ) {
    const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/.exec(file.name);
    if (m) {
      const time = resolveVideoTime(
        {
          [T.QUICKTIME_CREATE_DATE]: `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
        },
        "+00:00",
      );
      const replacement =
        "_" +
        formatWall(time.wall + BigInt(seconds) * 1_000_000n, ":", false)
          .replaceAll(":", "")
          .replace(" ", "_") +
        "_";
      actions.push({
        kind: "move",
        file: file.path,
        output:
          file.directory +
          "/" +
          file.name.replace(/_\d{8}_\d{6}_/g, replacement),
      });
    }
  }
  return actions.length
    ? actions
    : [{ kind: "skip", file: file.path, reason: "No time change" }];
}
export function convertPlan(
  file: MediaFile,
  tags: Metadata,
  output: string,
  offset?: string,
  policy?: string,
  source?: string,
  make?: string,
  model?: string,
): MediaAction[] {
  try {
    const time = resolveVideoTime(tags, offset, policy, source),
      wall = formatWall(time.wall),
      zoned = wall + time.offset;
    const writes: Metadata = {
      [T.XMP_CAPTURE_TIME]: zoned,
      [T.KEYS_CAPTURE_TIME]: zoned,
    };
    for (const key of T.VIDEO_UTC_CREATE_TAGS)
      writes[key] = formatWall(time.instant, ":", false);
    for (const key of [T.USERDATA_CAPTURE_TIME, T.XMP_CREATE_DATE])
      if (tags[key]) writes[key] = zoned;
    if (tags[T.CAPTURE_TIME]) {
      writes[T.CAPTURE_TIME] = wall;
      for (const key of [
        T.OFFSET_TIME,
        T.OFFSET_TIME_ORIGINAL,
        T.OFFSET_TIME_DIGITIZED,
      ])
        writes[key] = time.offset;
    }
    if (make) writes[T.MAKE] = make;
    if (model) writes[T.MODEL] = model;
    return [
      {
        kind: "remux",
        file: file.path,
        output,
        utc: formatWall(time.instant, "-", false).replace(" ", "T") + "Z",
        mp4: file.extension === ".mp4",
        quicktime: !!tags[T.QUICKTIME_CREATE_DATE],
      },
      { kind: "write", file: output, tags: writes, overwrite: true },
    ];
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return fail(file.path, error.message, false);
  }
}
