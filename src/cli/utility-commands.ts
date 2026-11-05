import { Args, Command, Flags } from "@oclif/core";
import { BusinessCommand } from "./business-commands.js";
import type { Context } from "../services/context.js";
import { GoogleElevation } from "../infrastructure/elevation.js";
import { GoogleGeocode } from "../infrastructure/geocode.js";
import { FileConfigStore } from "../infrastructure/config-store.js";
import { DEFAULTS, resolveApiKey } from "../domain/config.js";
import { coordinate } from "../domain/coordinate-input.js";
const key = (ctx: Context, value?: string) =>
  resolveApiKey(ctx.config, process.env.TRACKTOOL_GOOGLE_API_KEY, value);
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
export const UTILITY_COMMANDS: Record<string, Command.Class> = {
  "google:altitude": GoogleAltitude,
  "google:location": GoogleLocation,
  "config:set": ConfigSet,
};
