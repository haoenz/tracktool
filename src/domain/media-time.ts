import { AppError } from "./errors.js";
import { timestamp } from "./trackdata.js";
import { TAGS as T } from "./tags.js";
export type Metadata = Record<string, string>;
export interface MediaTime {
  wall: bigint;
  instant: bigint;
  offset: string;
}
export const VIDEO_SOURCES: readonly string[] = [
  T.XMP_CAPTURE_TIME,
  T.KEYS_CAPTURE_TIME,
  T.USERDATA_CAPTURE_TIME,
  T.CAPTURE_TIME,
  T.H264_CAPTURE_TIME,
  T.XMP_CREATE_DATE,
  T.QUICKTIME_CREATE_DATE,
  T.TRACK_CREATE_DATE,
];
export function offsetMinutes(value: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!m || +m[2]! > 23 || +m[3]! > 59)
    throw new AppError("USER_INPUT", `Invalid timezone offset: ${value}`);
  return (m[1] === "-" ? -1 : 1) * (+m[2]! * 60 + +m[3]!);
}
export function parseTimeDiff(value: string): number {
  const m = /^([+-]?)(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m || !m.slice(2).some((v) => v !== undefined))
    throw new AppError("USER_INPUT", `Invalid time difference: ${value}`);
  const n =
    (+(m[2] ?? 0) * 86400 +
      +(m[3] ?? 0) * 3600 +
      +(m[4] ?? 0) * 60 +
      +(m[5] ?? 0)) *
    (m[1] === "-" ? -1 : 1);
  if (!Number.isSafeInteger(n))
    throw new AppError("USER_INPUT", "Time difference is too large");
  return n;
}
function parseStamp(
  raw: string,
  flexible = false,
): { wall: bigint; offset?: string } {
  const m = (
    flexible
      ? /^(\d{4})[:/-](\d{2})[:/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/
      : /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/
  ).exec(raw);
  if (!m) throw new AppError("USER_INPUT", `Invalid media timestamp: ${raw}`);
  const offset = m[8] === "Z" ? "+00:00" : m[8];
  if (offset) offsetMinutes(offset);
  return {
    wall: timestamp(
      `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}Z`,
    ),
    offset,
  };
}
function separateOffset(tags: Metadata): string | undefined {
  return (
    tags[T.OFFSET_TIME_ORIGINAL] ||
    tags[T.OFFSET_TIME] ||
    tags[T.OFFSET_TIME_DIGITIZED] ||
    undefined
  );
}
function aware(wall: bigint, offset: string): MediaTime {
  return {
    wall,
    offset,
    instant: wall - BigInt(offsetMinutes(offset)) * 60_000_000n,
  };
}
export function parseMediaTime(tags: Metadata): MediaTime | undefined {
  for (const source of [
    T.CAPTURE_TIME,
    T.XMP_CAPTURE_TIME,
    T.H264_CAPTURE_TIME,
    T.QUICKTIME_CREATE_DATE,
    T.TRACK_CREATE_DATE,
  ]) {
    if (!tags[source]) continue;
    try {
      const stamp = parseStamp(tags[source]!);
      const offset =
        source === T.CAPTURE_TIME
          ? stamp.offset || separateOffset(tags) || "+08:00"
          : source === T.QUICKTIME_CREATE_DATE || source === T.TRACK_CREATE_DATE
            ? "+00:00"
            : stamp.offset;
      if (offset) return aware(stamp.wall, offset);
    } catch {
      /* Invalid candidates fall through for photo geotagging. */
    }
  }
  return undefined;
}
export function formatWall(
  us: bigint,
  separator = ":",
  fraction = true,
): string {
  const seconds = us >= 0n ? us / 1_000_000n : (us - 999_999n) / 1_000_000n;
  const date = new Date(Number(seconds) * 1000);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    throw new AppError("USER_INPUT", "Timestamp out of range");
  const base = date.toISOString().slice(0, 19).replace("T", " ");
  const micro = us - seconds * 1_000_000n;
  return (
    base.slice(0, 10).replaceAll("-", separator) +
    base.slice(10) +
    (fraction && micro ? `.${String(micro).padStart(6, "0")}` : "")
  );
}
export function resolveVideoTime(
  tags: Metadata,
  offset = "+08:00",
  policy = "auto",
  source?: string,
): MediaTime & { source: string } {
  offsetMinutes(offset);
  if (
    !["auto", "keep", "force"].includes(policy) ||
    (source && !VIDEO_SOURCES.includes(source))
  )
    throw new AppError("USER_INPUT", "Invalid timezone policy or time source");
  const stamps = VIDEO_SOURCES.flatMap((key) => {
    const raw = tags[key]?.trim();
    if (!raw || raw.startsWith("0000:") || raw.startsWith("0000-")) return [];
    const stamp = parseStamp(raw, true);
    if (key === T.CAPTURE_TIME && !stamp.offset)
      stamp.offset = separateOffset(tags);
    if (stamp.offset) offsetMinutes(stamp.offset);
    return [{ ...stamp, source: key }];
  });
  if (!stamps.length)
    throw new AppError("USER_INPUT", "No valid video timestamp");
  const explicit = stamps.some((s) => s.offset);
  if (policy === "auto" && explicit)
    throw new AppError(
      "USER_INPUT",
      "Video has timezone metadata; choose --timezone-policy keep or force",
    );
  const chosen = source
    ? stamps.find((s) => s.source === source)
    : (stamps.find((s) => s.offset) ?? stamps[0]);
  if (!chosen)
    throw new AppError("USER_INPUT", `Timestamp source is absent: ${source}`);
  const result = aware(
    chosen.wall,
    policy === "force" ? offset : (chosen.offset ?? offset),
  );
  if (!source)
    for (const other of stamps) {
      let valid: boolean;
      if (other.offset)
        valid =
          aware(other.wall, policy === "force" ? result.offset : other.offset)
            .instant === result.instant;
      else if (
        explicit &&
        [T.QUICKTIME_CREATE_DATE, T.TRACK_CREATE_DATE].includes(
          other.source as typeof T.QUICKTIME_CREATE_DATE,
        )
      ) {
        const utc = aware(chosen.wall, chosen.offset ?? result.offset).instant;
        valid =
          other.wall / 1_000_000n === chosen.wall / 1_000_000n ||
          other.wall / 1_000_000n === utc / 1_000_000n;
      } else valid = other.wall === chosen.wall;
      if (!valid)
        throw new AppError(
          "USER_INPUT",
          "Conflicting video timestamps; choose --time-source",
        );
    }
  return { ...result, source: chosen.source };
}
