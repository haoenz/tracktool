import { Args, Command, Flags } from "@oclif/core";
import { BusinessCommand } from "./business-commands.js";
import type { CommonFlags } from "./business-commands.js";
import { MediaService } from "../services/media-service.js";
import type {
  MediaOptions,
  ConvertOptions,
  GeotagOptions,
} from "../services/media-service.js";
import type { Context } from "../services/context.js";
import { ExifMetadata } from "../infrastructure/metadata.js";
import { LocalMediaFiles } from "../infrastructure/media-files.js";
import { GoogleElevation } from "../infrastructure/elevation.js";
import { GoogleGeocode } from "../infrastructure/geocode.js";
import { ArchiveClient } from "../infrastructure/archive/client.js";
import { FileConfigStore } from "../infrastructure/config-store.js";
import { resolveMediaPath as resolvePath } from "../infrastructure/media-files.js";
import { workspace } from "../infrastructure/kml-files.js";
import { DEFAULTS, resolveApiKey } from "../domain/config.js";
import { TAGS as T } from "../domain/tags.js";
import { coordinate, gpsTags } from "../domain/media.js";
import {
  VIDEO_SOURCES,
  parseMediaTime,
  formatWall,
} from "../domain/media-time.js";
import { AppError } from "../domain/errors.js";
abstract class MediaCommand extends BusinessCommand {
  async media(
    flags: CommonFlags,
    fn: (ctx: Context, service: MediaService) => Promise<void>,
  ) {
    await this.using(flags, async (ctx) => {
      const backend = new ExifMetadata(
          undefined,
          30_000,
          String(ctx.config.output_filters || ""),
          (message) => ctx.report({ type: "log", level: "WARNING", message }),
        ),
        archive = new ArchiveClient();
      try {
        await fn(
          ctx,
          new MediaService(
            backend,
            new LocalMediaFiles(),
            new GoogleElevation(),
            new GoogleGeocode(),
            archive,
          ),
        );
      } finally {
        await backend.close();
        await archive.close();
      }
    });
  }
}
const input = { path: Args.string({ required: true }) };
const parallel = {
  parallel: Flags.boolean({ description: "并行处理媒体；最多 4 个文件" }),
};
const batch = {
  ...parallel,
  overwrite: Flags.boolean({ description: "不创建 ExifTool 首次备份" }),
};
const google = {
  ...batch,
  "api-key": Flags.string(),
  "failed-folder": Flags.string(),
};
const timezone = {
  "offset-time": Flags.string({ default: "+08:00" }),
  "timezone-policy": Flags.string({
    options: ["auto", "keep", "force"],
    default: "auto",
  }),
  "time-source": Flags.string({ options: [...VIDEO_SOURCES] }),
  make: Flags.string(),
  model: Flags.string(),
  ...parallel,
};
const numberFlag = Flags.custom<number>({
  parse: async (v) => {
    const n = Number(v);
    if (!v.trim() || !Number.isFinite(n))
      throw new AppError("USER_INPUT", "Expected a finite number");
    return n;
  },
});
const key = (ctx: Context, value?: string) =>
  resolveApiKey(ctx.config, process.env.TRACKTOOL_GOOGLE_API_KEY, value);
function options(flags: Record<string, unknown>): MediaOptions {
  return {
    overwrite: !!flags.overwrite,
    parallel: !!flags.parallel,
    failedFolder: flags["failed-folder"] as string | undefined,
  };
}
function convertOptions(flags: Record<string, unknown>): ConvertOptions {
  return {
    ...options(flags),
    output: flags.output ? resolvePath(String(flags.output)) : undefined,
    offset: flags["offset-time"] as string,
    policy: flags["timezone-policy"] as string,
    source: flags["time-source"] as string | undefined,
    make: flags.make as string | undefined,
    model: flags.model as string | undefined,
  };
}
class SetExif extends MediaCommand {
  static description = "写入媒体元数据、坐标或海拔";
  static args = input;
  static flags = {
    ...batch,
    position: Flags.string({ char: "p" }),
    altitude: numberFlag({ char: "a" }),
    make: Flags.string(),
    model: Flags.string(),
    tag: Flags.string({
      char: "t",
      multiple: true,
      description: "任意 NAME=VALUE 标签",
    }),
  };
  async run() {
    const { args, flags } = await this.parse(SetExif);
    await this.media(flags, async (ctx, s) => {
      const tags = gpsTags(
        flags.position ? coordinate(flags.position) : undefined,
        flags.altitude,
      );
      if (flags.make) tags[T.MAKE] = flags.make;
      if (flags.model) tags[T.MODEL] = flags.model;
      for (const entry of flags.tag ?? []) {
        const at = entry.indexOf("=");
        if (at < 1 || !/^[\w:-]+$/.test(entry.slice(0, at)))
          throw new AppError("USER_INPUT", "Tags must be NAME=VALUE");
        tags[entry.slice(0, at)] = entry.slice(at + 1);
      }
      process.exitCode = (
        await s.set(ctx, resolvePath(args.path), tags, options(flags))
      ).exitCode;
    });
  }
}
class Info extends MediaCommand {
  static description = "显示媒体拍摄时间、GPS 和海拔";
  static args = input;
  async run() {
    const { args, flags } = await this.parse(Info);
    await this.media(flags, async (ctx, s) => {
      const tags = await s.backend.read(
          resolvePath(args.path),
          T.POSITION_TAGS,
          ctx.signal,
        ),
        time = parseMediaTime(tags);
      this.log(
        time ? formatWall(time.wall, "-").replace(" ", "T") + time.offset : "",
      );
      this.log([tags[T.LATITUDE], tags[T.LONGITUDE]].filter(Boolean).join(" "));
      this.log(tags[T.ALTITUDE] ?? "");
    });
  }
}
class Missing extends MediaCommand {
  static description = "列出缺少指定标签的媒体";
  static args = {
    ...input,
    tags: Args.string({ required: true, multiple: true }),
  };
  static flags = parallel;
  async run() {
    const { args, flags } = await this.parse(Missing);
    await this.media(flags, async (ctx, s) => {
      const result = await s.missing(
        ctx,
        resolvePath(args.path),
        args.tags,
        options(flags),
      );
      this.log("File\tMissing");
      for (const row of result.rows)
        this.log(`${row.file}\t${row.missing.join(", ")}`);
      process.exitCode = result.batch.exitCode;
    });
  }
}
class ShiftTime extends MediaCommand {
  static description = "调整媒体时间及 SONY 时区";
  static args = input;
  static flags = {
    ...batch,
    by: Flags.string(),
    "offset-time": Flags.string(),
  };
  async run() {
    const { args, flags } = await this.parse(ShiftTime);
    await this.media(flags, async (ctx, s) => {
      process.exitCode = (
        await s.shiftTime(
          ctx,
          resolvePath(args.path),
          flags.by,
          flags["offset-time"],
          options(flags),
        )
      ).exitCode;
    });
  }
}
class ShiftAltitude extends MediaCommand {
  static description = "调整媒体海拔";
  static args = { ...input, offset: Args.string({ required: true }) };
  static flags = batch;
  async run() {
    const { args, flags } = await this.parse(ShiftAltitude);
    await this.media(flags, async (ctx, s) => {
      process.exitCode = (
        await s.shiftAltitude(
          ctx,
          resolvePath(args.path),
          Number(args.offset),
          options(flags),
        )
      ).exitCode;
    });
  }
}
class Convert extends MediaCommand {
  static description = "转封装 MP4 并按显式时区策略整理时间";
  static args = input;
  static flags = { ...timezone, output: Flags.string({ char: "o" }) };
  async run() {
    const { args, flags } = await this.parse(Convert);
    await this.media(flags, async (ctx, s) => {
      const opts = convertOptions(flags);
      if (opts.output && !(await s.files.isDirectory(opts.output)))
        throw new AppError("USER_INPUT", "Output directory does not exist");
      process.exitCode = (
        await s.convert(ctx, resolvePath(args.path), opts)
      ).exitCode;
    });
  }
}
class FillAltitude extends MediaCommand {
  static description = "通过 Google Elevation 补全媒体海拔";
  static args = input;
  static flags = google;
  async run() {
    const { args, flags } = await this.parse(FillAltitude);
    await this.media(flags, async (ctx, s) => {
      process.exitCode = (
        await s.fillAltitude(
          ctx,
          resolvePath(args.path),
          key(ctx, flags["api-key"]),
          options(flags),
        )
      ).exitCode;
    });
  }
}
class SetLocation extends MediaCommand {
  static description = "通过 Google Geocoding 补全 IPTC 地名";
  static args = input;
  static flags = { ...google, language: Flags.string({ default: "en" }) };
  async run() {
    const { args, flags } = await this.parse(SetLocation);
    await this.media(flags, async (ctx, s) => {
      process.exitCode = (
        await s.setLocation(
          ctx,
          resolvePath(args.path),
          key(ctx, flags["api-key"]),
          flags.language,
          options(flags),
        )
      ).exitCode;
    });
  }
}
class Geotag extends MediaCommand {
  static description = "按拍摄时间从 SQLite 轨迹归档定位";
  static args = input;
  static flags = {
    ...batch,
    zip: Flags.string(),
    force: Flags.boolean(),
    verify: Flags.boolean(),
    multiday: Flags.boolean(),
    "max-time-diff": numberFlag({ default: 60 }),
    "max-distance": numberFlag({ default: 100 }),
    "failed-folder": Flags.string(),
  };
  async run() {
    const { args, flags } = await this.parse(Geotag);
    await this.media(flags, async (ctx, s) => {
      const opts: GeotagOptions = {
        ...options(flags),
        force: flags.force,
        verify: flags.verify,
        multiday: flags.multiday,
        maxSeconds: flags["max-time-diff"],
        maxDistance: flags["max-distance"],
      };
      process.exitCode = (
        await s.geotag(
          ctx,
          resolvePath(args.path),
          workspace(ctx.config, flags.zip).database,
          opts,
        )
      ).exitCode;
    });
  }
}
class Group extends MediaCommand {
  static description = "将混合媒体整理到 VID、RAW、IMG";
  static args = input;
  async run() {
    const { args, flags } = await this.parse(Group);
    await this.media(flags, async (ctx, s) => {
      process.exitCode = (await s.group(ctx, resolvePath(args.path))).exitCode;
    });
  }
}
class Repair extends MediaCommand {
  static description = "补全 GPS 和海拔，整理成功及失败媒体";
  static args = input;
  static flags = { ...parallel, zip: Flags.string() };
  async run() {
    const { args, flags } = await this.parse(Repair);
    await this.media(flags, async (ctx, s) => {
      process.exitCode = (
        await s.repair(
          ctx,
          resolvePath(args.path),
          workspace(ctx.config, flags.zip).database,
          key(ctx),
          options(flags),
        )
      ).exitCode;
    });
  }
}
class RepairVideo extends MediaCommand {
  static description = "可重跑的视频转封装与 GPS 修复流程";
  static args = input;
  static flags = { ...timezone, zip: Flags.string() };
  async run() {
    const { args, flags } = await this.parse(RepairVideo);
    await this.media(flags, async (ctx, s) => {
      process.exitCode = (
        await s.repairVideo(
          ctx,
          resolvePath(args.path),
          workspace(ctx.config, flags.zip).database,
          key(ctx),
          convertOptions(flags),
        )
      ).exitCode;
    });
  }
}
class GoogleAltitude extends BusinessCommand {
  static description = "查询一个坐标的高程";
  static args = { coordinate: Args.string({ required: true }) };
  static flags = { "api-key": Flags.string() };
  async run() {
    const { args, flags } = await this.parse(GoogleAltitude);
    await this.using(flags, async (ctx) => {
      const point = coordinate(args.coordinate);
      if (ctx.mode === "plan") {
        this.log("Would query Google Elevation");
        return;
      }
      const value = (
        await new GoogleElevation().get(
          [point],
          key(ctx, flags["api-key"]),
          ctx.signal,
        )
      )[0];
      if (value !== null && value !== undefined) this.log(String(value));
    });
  }
}
class GoogleLocation extends BusinessCommand {
  static description = "查询一个坐标的地名";
  static args = { coordinate: Args.string({ required: true }) };
  static flags = {
    "api-key": Flags.string(),
    language: Flags.string({ default: "en" }),
  };
  async run() {
    const { args, flags } = await this.parse(GoogleLocation);
    await this.using(flags, async (ctx) => {
      const point = coordinate(args.coordinate);
      if (ctx.mode === "plan") {
        this.log("Would query Google Geocoding");
        return;
      }
      this.log(
        JSON.stringify(
          await new GoogleGeocode().get(
            point,
            key(ctx, flags["api-key"]),
            flags.language,
            ctx.signal,
          ),
          null,
          2,
        ),
      );
    });
  }
}
class ConfigSet extends BusinessCommand {
  static description = "更新配置，活动标签支持 +添加、-移除及跨分类移动";
  static args = {
    key: Args.string({ required: true, options: Object.keys(DEFAULTS) }),
    value: Args.string({ required: true }),
  };
  async run() {
    const { args, flags } = await this.parse(ConfigSet);
    await this.using(flags, async (ctx) => {
      await new FileConfigStore({ path: flags.config }).set(
        args.key,
        args.value,
        ctx.mode === "plan",
      );
      this.log(`${ctx.mode === "plan" ? "Would set" : "Set"} ${args.key}`);
    });
  }
}
export const MEDIA_COMMANDS: Record<string, Command.Class> = {
  "exif:set": SetExif,
  "exif:info": Info,
  "exif:show-missing": Missing,
  "exif:geotag": Geotag,
  "exif:fill-altitude": FillAltitude,
  "exif:set-location": SetLocation,
  "exif:shift-time": ShiftTime,
  "exif:shift-altitude": ShiftAltitude,
  "exif:to-mp4": Convert,
  "exif:group": Group,
  "exif:repair": Repair,
  "exif:repair-vid": RepairVideo,
  "google:altitude": GoogleAltitude,
  "google:location": GoogleLocation,
  "config:set": ConfigSet,
};
