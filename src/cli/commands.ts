import { MEDIA_COMMANDS } from "./media-commands.js";
import { DATA_COMMANDS } from "./data-commands.js";
import { ZshCompletion, CompletionTags } from "./completion.js";
import { BUSINESS_COMMANDS } from "./business-commands.js";
import { TRACK_COMMANDS } from "./track-commands.js";
import { Command, Flags } from "@oclif/core";
import { FileConfigStore } from "../infrastructure/config-store.js";
import { createContext } from "../services/context.js";
import { getPublicConfig } from "../services/config.js";
import { errorInfo } from "../domain/errors.js";

class ConfigShow extends Command {
  static description = "查看配置；--public 输出网页使用的公开摘要";
  static flags = {
    config: Flags.string({ description: "配置文件路径" }),
    public: Flags.boolean({ description: "仅输出公开配置摘要" }),
    "dry-run": Flags.boolean({ description: "预演模式" }),
    verbose: Flags.boolean({ char: "v", description: "详细日志；可重复" }),
    quiet: Flags.boolean({ char: "q", description: "只输出警告与错误" }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(ConfigShow);
    try {
      const config = await new FileConfigStore({ path: flags.config }).load({
        persistMigration: !flags["dry-run"],
      });
      const ctx = createContext({
        config,
        mode: flags["dry-run"] ? "plan" : "apply",
      });
      // Preserve config show's existing local JSON output; only the explicit public view is shared over HTTP.
      this.log(
        JSON.stringify(
          flags.public
            ? getPublicConfig(ctx, process.env.TRACKTOOL_GOOGLE_API_KEY)
            : config,
          null,
          2,
        ),
      );
    } catch (error) {
      const info = errorInfo(error);
      process.stderr.write(`${JSON.stringify({ error: info })}\n`);
      process.exitCode = info.exitCode;
    }
  }
}
export const COMMANDS: Record<string, Command.Class> = {
  "config:show": ConfigShow,
  ...BUSINESS_COMMANDS,
  ...TRACK_COMMANDS,
  ...MEDIA_COMMANDS,
  ...DATA_COMMANDS,
  completion: ZshCompletion,
  "completion:tags": CompletionTags,
};
