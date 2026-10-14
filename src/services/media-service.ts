import { AppError, checkCancelled, errorInfo } from "../domain/errors.js";
import { TAGS as T } from "../domain/tags.js";
import {
  altitude,
  position,
  missingAltitude,
  gpsTags,
  fail,
  shiftTime,
  convertPlan,
  MEDIA_EXTENSIONS,
} from "../domain/media.js";
import type { MediaAction, MediaFile } from "../domain/media.js";
import {
  parseMediaTime,
  offsetMinutes,
  parseTimeDiff,
  VIDEO_SOURCES,
} from "../domain/media-time.js";
import type { Metadata } from "../domain/media-time.js";
import type { Context } from "./context.js";
import type {
  MetadataBackend,
  MediaFiles,
  MediaTracks,
  GeocodePort,
} from "./media-ports.js";
import type { ElevationPort } from "./kml-service.js";
import type { BatchResult } from "../shared/contracts.js";
import geodesic from "geographiclib-geodesic";
export interface MediaOptions {
  overwrite?: boolean;
  parallel?: boolean;
  failedFolder?: string;
}
export interface ConvertOptions extends MediaOptions {
  output?: string;
  offset?: string;
  policy?: string;
  source?: string;
  make?: string;
  model?: string;
  checkOnly?: boolean;
  skipExisting?: boolean;
}
export interface GeotagOptions extends MediaOptions {
  force?: boolean;
  verify?: boolean;
  multiday?: boolean;
  maxSeconds?: number;
  maxDistance?: number;
}
export interface MediaBatch extends BatchResult {
  plans: MediaAction[][];
}
export class MediaService {
  constructor(
    readonly backend: MetadataBackend,
    readonly files: MediaFiles,
    readonly elevation: ElevationPort,
    readonly geocode: GeocodePort,
    readonly tracks: MediaTracks,
  ) {}
  private async map<T, R>(
    ctx: Context,
    items: T[],
    parallel: boolean,
    fn: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const output: R[] = new Array(items.length);
    let next = 0,
      completed = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(items.length, parallel ? 4 : 1) },
        async () => {
          while (next < items.length) {
            checkCancelled(ctx.signal);
            const index = next++;
            output[index] = await fn(items[index]!, index);
            ctx.report({
              type: "progress",
              completed: ++completed,
              total: items.length,
            });
          }
        },
      ),
    );
    return output;
  }
  private async plan(
    ctx: Context,
    input: string | string[],
    tags: readonly string[],
    decide: (
      file: MediaFile,
      tags: Metadata,
    ) => Promise<MediaAction[]> | MediaAction[],
    options: MediaOptions,
  ): Promise<MediaAction[][]> {
    const files = await this.files.discover(input);
    return this.map(ctx, files, !!options.parallel, async (file) => {
      try {
        return await decide(
          file,
          tags.length
            ? await this.backend.read(file.path, tags, ctx.signal)
            : {},
        );
      } catch (error) {
        checkCancelled(ctx.signal);
        return fail(
          file.path,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }
  async execute(
    ctx: Context,
    plans: MediaAction[][],
    options: MediaOptions & {
      checkOnly?: boolean;
      skipExisting?: boolean;
    } = {},
  ): Promise<MediaBatch> {
    const checked = await this.files.preflight(plans, options.skipExisting);
    const items = await this.map(
      ctx,
      checked,
      !!options.parallel,
      async (actions) => {
        const file = actions[0]?.file ?? "";
        let quarantine = true;
        try {
          for (const action of actions) {
            if (action.kind === "failed") {
              quarantine = action.quarantine;
              throw new AppError("USER_INPUT", action.reason);
            }
            ctx.report({
              type: "log",
              level: ctx.mode === "plan" ? "INFO" : "VERBOSE",
              message: `${file}: ${action.kind}${"reason" in action ? ": " + action.reason : ""}`,
            });
            if (ctx.mode === "plan" || options.checkOnly) continue;
            checkCancelled(ctx.signal);
            // Recheck just before each mutation to catch changes since batch preflight.
            const current = (await this.files.preflight([[action]]))[0]![0]!;
            if (current.kind === "failed") {
              quarantine = false;
              throw new AppError("USER_INPUT", current.reason);
            }
            if (action.kind === "write")
              await this.backend.write(
                action.file,
                action.tags,
                action.overwrite,
                ctx.signal,
              );
            else if (action.kind === "shift")
              await this.backend.shift(
                action.file,
                action.tags,
                action.seconds,
                action.overwrite,
                ctx.signal,
              );
            else await this.files.apply(action, ctx.signal);
          }
          const skip = actions.find((a) => a.kind === "skip");
          return skip
            ? {
                status: "skipped" as const,
                path: file,
                reason: "reason" in skip ? skip.reason : "",
              }
            : { status: "succeeded" as const, path: file };
        } catch (error) {
          checkCancelled(ctx.signal);
          const info =
            error instanceof AppError
              ? errorInfo(error)
              : errorInfo(
                  new AppError(
                    "TOOL",
                    error instanceof Error ? error.message : String(error),
                  ),
                );
          ctx.report({
            type: "log",
            level: "WARNING",
            message: `${file}: ${info.message}`,
          });
          if (quarantine && options.failedFolder && !options.checkOnly)
            try {
              await this.files.moveFolder(
                file,
                options.failedFolder,
                ctx.mode === "plan",
              );
            } catch (e) {
              ctx.report({
                type: "log",
                level: "WARNING",
                message: `${file}: cannot quarantine: ${String(e)}`,
              });
            }
          return { status: "failed" as const, path: file, error: info };
        }
      },
    );
    return {
      items,
      exitCode: items.some((i) => i.status === "failed") ? 3 : 0,
      plans: checked,
    };
  }
  async set(
    ctx: Context,
    input: string | string[],
    tags: Metadata,
    options: MediaOptions = {},
  ): Promise<MediaBatch> {
    return this.execute(
      ctx,
      await this.plan(
        ctx,
        input,
        [],
        (file) => [
          {
            kind: "write",
            file: file.path,
            tags,
            overwrite: !!options.overwrite,
          },
        ],
        options,
      ),
      options,
    );
  }
  async missing(
    ctx: Context,
    input: string | string[],
    tags: readonly string[],
    options: MediaOptions = {},
  ): Promise<{
    batch: MediaBatch;
    rows: { file: string; missing: string[] }[];
  }> {
    const rows: { file: string; missing: string[] }[] = [];
    const plans = await this.plan(
      ctx,
      input,
      tags,
      (file, values) => {
        const missing = tags.filter((t) =>
          t === T.ALTITUDE ? missingAltitude(values[t]) : !values[t],
        );
        if (missing.length) rows.push({ file: file.path, missing });
        return [{ kind: "skip", file: file.path, reason: missing.join(", ") }];
      },
      options,
    );
    return {
      batch: await this.execute(ctx, plans, options),
      rows: rows.sort((a, b) => a.file.localeCompare(b.file)),
    };
  }
  async shiftTime(
    ctx: Context,
    input: string | string[],
    by?: string,
    offset?: string,
    options: MediaOptions = {},
  ): Promise<MediaBatch> {
    if (by === undefined && offset === undefined)
      throw new AppError("USER_INPUT", "Provide --by or --offset-time");
    if (by !== undefined) parseTimeDiff(by);
    if (offset !== undefined) offsetMinutes(offset);
    return this.execute(
      ctx,
      await this.plan(
        ctx,
        input,
        T.SHIFT_TAGS,
        (f, t) => shiftTime(f, t, by, offset, !!options.overwrite),
        options,
      ),
      options,
    );
  }
  async shiftAltitude(
    ctx: Context,
    input: string | string[],
    delta: number,
    options: MediaOptions = {},
  ): Promise<MediaBatch> {
    if (!Number.isFinite(delta))
      throw new AppError("USER_INPUT", "Altitude offset must be finite");
    return this.execute(
      ctx,
      await this.plan(
        ctx,
        input,
        [T.ALTITUDE],
        (f, t) => {
          const old = altitude(t);
          return old === undefined
            ? fail(f.path, "No valid altitude")
            : [
                {
                  kind: "write",
                  file: f.path,
                  tags: gpsTags(undefined, old + delta),
                  overwrite: !!options.overwrite,
                },
              ];
        },
        options,
      ),
      options,
    );
  }
  async convert(
    ctx: Context,
    input: string | string[],
    options: ConvertOptions = {},
  ): Promise<MediaBatch> {
    offsetMinutes(options.offset ?? "+08:00");
    if (
      !["auto", "keep", "force"].includes(options.policy ?? "auto") ||
      (options.source && !VIDEO_SOURCES.includes(options.source))
    )
      throw new AppError("USER_INPUT", "Invalid timezone policy or source");
    const files = await this.files.discover(input),
      output = options.output ?? files[0]?.directory;
    if (!files.length) return { items: [], exitCode: 0, plans: [] };
    const plans = await this.plan(
      ctx,
      files.map((f) => f.path),
      T.VIDEO_TIME_TAGS,
      (file, tags) =>
        convertPlan(
          file,
          tags,
          this.files.join(output!, file.stem + ".mp4"),
          options.offset,
          options.policy,
          options.source,
          options.make,
          options.model,
        ),
      options,
    );
    return this.execute(ctx, plans, options);
  }
  async fillAltitude(
    ctx: Context,
    input: string | string[],
    key: string,
    options: MediaOptions = {},
  ): Promise<MediaBatch> {
    const points: [number, number][] = [],
      indices: number[] = [];
    const plans = await this.plan(
      ctx,
      input,
      T.ALTITUDE_TAGS,
      (file, tags) => {
        if (!missingAltitude(tags[T.ALTITUDE]))
          return [
            {
              kind: "skip",
              file: file.path,
              reason: "Altitude already exists",
            },
          ];
        const p = position(tags);
        if (!p) return fail(file.path, "Missing GPS position");
        return [{ kind: "lookup", file: file.path, reason: JSON.stringify(p) }];
      },
      options,
    );
    for (const [i, plan] of plans.entries())
      if (plan[0]?.kind === "lookup") {
        indices.push(i);
        points.push(JSON.parse(plan[0].reason) as [number, number]);
      }
    if (ctx.mode === "apply" && points.length) {
      const values = await this.elevation.get(points, key, ctx.signal);
      for (const [i, index] of indices.entries()) {
        const file = plans[index]![0]!.file,
          value = values[i];
        plans[index] =
          value === null || value === undefined
            ? fail(file, "No elevation returned")
            : [
                {
                  kind: "write",
                  file,
                  tags: gpsTags(undefined, value),
                  overwrite: !!options.overwrite,
                },
              ];
      }
    }
    return this.execute(ctx, plans, options);
  }
  async setLocation(
    ctx: Context,
    input: string | string[],
    key: string,
    language = "en",
    options: MediaOptions = {},
  ): Promise<MediaBatch> {
    const plans = await this.plan(
      ctx,
      input,
      T.LOCATION_TAGS,
      async (file, tags) => {
        const point = position(tags);
        if (!point) return fail(file.path, "Missing GPS position");
        if (ctx.mode === "plan")
          return [
            {
              kind: "lookup",
              file: file.path,
              reason: "Google reverse geocoding",
            },
          ];
        const location = await this.geocode.get(
          point,
          key,
          language,
          ctx.signal,
        );
        const values: Metadata = {};
        for (const [key, value] of [
          [T.IPTC_CITY, location.city],
          [T.IPTC_STATE, location.state],
          [T.IPTC_COUNTRY_CODE, location.country_code_iso],
          [T.IPTC_COUNTRY_NAME, location.country],
        ])
          if (value) values[key!] = value;
        return Object.keys(values).length
          ? [
              {
                kind: "write",
                file: file.path,
                tags: values,
                overwrite: !!options.overwrite,
              },
            ]
          : fail(file.path, "No location returned");
      },
      options,
    );
    return this.execute(ctx, plans, options);
  }
  async geotag(
    ctx: Context,
    input: string | string[],
    database: string,
    options: GeotagOptions = {},
  ): Promise<MediaBatch> {
    const seconds = options.maxSeconds ?? 60,
      distance = options.maxDistance ?? 100;
    if (
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isFinite(distance) ||
      distance < 0
    )
      throw new AppError("USER_INPUT", "Matching limits must be nonnegative");
    const plans = await this.plan(
      ctx,
      input,
      T.POSITION_TAGS,
      async (file, tags) => {
        const old = position(tags),
          height = altitude(tags),
          hasHeight = !missingAltitude(tags[T.ALTITUDE]);
        if (old && hasHeight && !options.force && !options.verify)
          return [
            { kind: "skip", file: file.path, reason: "GPS already exists" },
          ];
        const time = parseMediaTime(tags);
        if (!time) return fail(file.path, "No valid timestamp");
        const best = await this.tracks.nearest(
          database,
          time,
          !!options.multiday,
          seconds,
          ctx.signal,
        );
        if (!best) return fail(file.path, "No matching GPS data in archive");
        if (options.verify && old) {
          const meters = geodesic.Geodesic.WGS84.Inverse(
            old[0],
            old[1],
            best.latitude,
            best.longitude,
          ).s12!;
          if (meters > distance && !options.force)
            return fail(file.path, "Existing GPS disagrees with KML", false);
          if (hasHeight && !options.force)
            return [
              {
                kind: "skip",
                file: file.path,
                reason: "GPS agrees with archive",
              },
            ];
        }
        return [
          {
            kind: "write",
            file: file.path,
            tags: gpsTags(
              [best.latitude, best.longitude],
              best.altitude || height,
            ),
            overwrite: !!options.overwrite,
          },
        ];
      },
      options,
    );
    return this.execute(ctx, plans, options);
  }
  async group(ctx: Context, input: string): Promise<MediaBatch> {
    const files = await this.files.discover(input);
    if (new Set(files.map((f) => f.extension)).size <= 1)
      return {
        items: files.map((f) => ({
          status: "skipped",
          path: f.path,
          reason: "Only one media extension",
        })),
        exitCode: 0,
        plans: [],
      };
    const items: BatchResult["items"] = [];
    const plans: MediaAction[][] = [];
    for (const file of files) {
      checkCancelled(ctx.signal);
      const folder = MEDIA_EXTENSIONS[file.extension];
      if (!folder) continue;
      plans.push([
        {
          kind: "move",
          file: file.path,
          output: this.files.join(file.directory, folder, file.name),
        },
      ]);
      try {
        const moved = await this.files.moveFolder(
          file.path,
          folder,
          ctx.mode === "plan",
        );
        ctx.report({
          type: "log",
          level: "INFO",
          message: `${file.path}: ${ctx.mode === "plan" ? "Would move to" : moved ? "Moved to" : "Target occupied; retained source for"} ${folder}`,
        });
        items.push(
          moved || ctx.mode === "plan"
            ? { status: "succeeded", path: file.path }
            : { status: "skipped", path: file.path, reason: "Target occupied" },
        );
      } catch (error) {
        items.push({
          status: "failed",
          path: file.path,
          error: errorInfo(
            error instanceof AppError
              ? error
              : new AppError("TOOL", String(error)),
          ),
        });
      }
    }
    return {
      items,
      plans,
      exitCode: items.some((i) => i.status === "failed") ? 3 : 0,
    };
  }
  async repair(
    ctx: Context,
    input: string | string[],
    database: string,
    key: string,
    options: MediaOptions = {},
  ): Promise<MediaBatch> {
    const { batch, rows } = await this.missing(
      ctx,
      input,
      [T.POSITION, T.ALTITUDE],
      options,
    );
    const alt = rows
        .filter((r) => !r.missing.includes(T.POSITION))
        .map((r) => r.file),
      gps = rows
        .filter((r) => r.missing.includes(T.POSITION))
        .map((r) => r.file);
    const items: BatchResult["items"] = batch.items.filter(
        (i) => i.status === "failed",
      ),
      plans: MediaAction[][] = [];
    if (alt.length) {
      const result = await this.fillAltitude(ctx, alt, key, {
        ...options,
        overwrite: true,
        failedFolder: "GoogleAltFailed",
      });
      items.push(...result.items);
      plans.push(...result.plans);
      for (const item of result.items)
        if (item.status !== "failed")
          await this.files.moveFolder(
            item.path,
            "GoogleAltOK",
            ctx.mode === "plan",
          );
    }
    if (gps.length) {
      const result = await this.geotag(ctx, gps, database, {
        ...options,
        overwrite: true,
        failedFolder: "TrackPosFailed",
      });
      items.push(...result.items);
      plans.push(...result.plans);
    }
    return {
      items,
      plans,
      exitCode: items.some((i) => i.status === "failed") ? 3 : 0,
    };
  }
  async repairVideo(
    ctx: Context,
    directory: string,
    database: string,
    key: string,
    options: ConvertOptions = {},
  ): Promise<MediaBatch> {
    const video = this.files.join(directory, "VID"),
      original = this.files.join(directory, "VID_original");
    if (
      (await this.files.exists(original)) &&
      !(await this.files.isDirectory(original))
    )
      throw new AppError("USER_INPUT", "VID_original is not a directory");
    const rerun = await this.files.isDirectory(original),
      source = rerun ? original : video;
    if (!(await this.files.isDirectory(source)))
      return { items: [], plans: [], exitCode: 0 };
    const preflight = await this.convert(ctx, source, {
      ...options,
      output: rerun ? video : original,
      checkOnly: true,
      skipExisting: true,
    });
    if (preflight.exitCode) return preflight;
    if (ctx.mode === "plan") {
      ctx.report({
        type: "log",
        level: "INFO",
        message: "Would retain VID_original, convert into VID and repair GPS",
      });
      return preflight;
    }
    if (!rerun) await this.files.renameDirectory(video, original);
    await this.files.mkdir(video);
    const converted = await this.convert(ctx, original, {
      ...options,
      output: video,
      skipExisting: true,
    });
    const repaired = await this.repair(ctx, video, database, key, options);
    return {
      items: [...converted.items, ...repaired.items],
      plans: [...converted.plans, ...repaired.plans],
      exitCode: converted.exitCode || repaired.exitCode,
    };
  }
}
