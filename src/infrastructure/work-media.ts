import { coordinate, gpsTags } from "../domain/media.js";
import { formatWall, parseMediaTime } from "../domain/media-time.js";
import { TAGS as T } from "../domain/tags.js";
import type { Context } from "../services/context.js";
import type { KmlService } from "../services/kml-service.js";
import type { MediaService } from "../services/media-service.js";
import type { MetadataBackend, MediaFiles } from "../services/media-ports.js";
import type { BatchResult } from "../shared/contracts.js";
import type { WorkRequest } from "../shared/work.js";

export interface MediaRunOptions {
  overwrite?: boolean;
  parallel?: boolean;
  failedFolder?: string;
  force?: boolean;
  verify?: boolean;
  multiday?: boolean;
  maxSeconds?: number;
  maxDistance?: number;
}
export type MediaConversion = MediaRunOptions & {
  output?: string;
  offset?: string;
  policy?: string;
  source?: string;
  make?: string;
  model?: string;
};
export interface MediaDispatch {
  ctx: Context;
  signal: AbortSignal;
  media: MediaService;
  mediaFiles: MediaFiles;
  backend: MetadataBackend;
  kml: KmlService;
  key: string;
  database: string;
  mediaInput: string | string[];
  first: string;
  mediaOptions: MediaRunOptions;
  conversion: MediaConversion;
}

/** All exif:* work operations share this dispatch with the task runner. */
export async function dispatchMedia(
  deps: MediaDispatch,
  request: WorkRequest,
): Promise<{ result?: BatchResult; data?: unknown }> {
  const {
    ctx,
    signal,
    media,
    mediaFiles,
    backend,
    kml,
    key,
    database,
    mediaInput,
    first,
    mediaOptions,
    conversion,
  } = deps;
  const o = request.options;
  switch (request.operation) {
    case "exif:info": {
      const rows: unknown[] = [];
      await kml.batch(
        ctx,
        (await mediaFiles.discover(mediaInput)).map((file) => file.path),
        async (file) => {
          const tags = await backend.read(
              file,
              [...T.POSITION_TAGS, T.MAKE, T.MODEL, ...T.VIDEO_TIME_TAGS],
              signal,
            ),
            time = parseMediaTime(tags);
          rows.push({
            file,
            timestamp: time ? formatWall(time.wall, "-") + time.offset : null,
            tags,
          });
        },
      );
      return { data: rows };
    }
    case "exif:show-missing": {
      const value = await media.missing(
        ctx,
        mediaInput,
        o.missingTags ?? [T.POSITION, T.ALTITUDE],
        mediaOptions,
      );
      return { result: value.batch, data: value.rows };
    }
    case "exif:set":
      return {
        result: await media.set(
          ctx,
          mediaInput,
          {
            ...gpsTags(
              o.position ? coordinate(o.position) : undefined,
              o.altitude,
            ),
            ...(o.make ? { [T.MAKE]: o.make } : {}),
            ...(o.model ? { [T.MODEL]: o.model } : {}),
            ...o.tags,
          },
          mediaOptions,
        ),
      };
    case "exif:shift-time":
      return {
        result: await media.shiftTime(
          ctx,
          mediaInput,
          o.by,
          o.offset,
          mediaOptions,
        ),
      };
    case "exif:shift-altitude":
      return {
        result: await media.shiftAltitude(
          ctx,
          mediaInput,
          o.delta!,
          mediaOptions,
        ),
      };
    case "exif:geotag":
      return {
        result: await media.geotag(ctx, mediaInput, database, mediaOptions),
      };
    case "exif:fill-altitude":
      return {
        result: await media.fillAltitude(ctx, mediaInput, key, mediaOptions),
      };
    case "exif:set-location":
      return {
        result: await media.setLocation(
          ctx,
          mediaInput,
          key,
          o.language ?? "en",
          mediaOptions,
        ),
      };
    case "exif:to-mp4":
      return { result: await media.convert(ctx, mediaInput, conversion) };
    case "exif:group":
      return { result: await media.group(ctx, first) };
    case "exif:repair":
      return {
        result: await media.repair(
          ctx,
          mediaInput,
          database,
          key,
          mediaOptions,
        ),
      };
    case "exif:repair-vid":
      return {
        result: await media.repairVideo(ctx, first, database, key, conversion),
      };
  }
  return {};
}
