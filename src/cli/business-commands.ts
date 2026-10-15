import { randomUUID } from "node:crypto";
import { Args, Command, Flags } from "@oclif/core";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { FileConfigStore } from "../infrastructure/config-store.js";
import {
  LocalKmlFiles,
  expandPaths,
  workspace,
} from "../infrastructure/kml-files.js";
import { ArchiveClient } from "../infrastructure/archive/client.js";
import { XmlWorkers } from "../infrastructure/xml/client.js";
import { GoogleElevation } from "../infrastructure/elevation.js";
import { displayPath, resolvePath } from "../infrastructure/paths.js";
import { createContext } from "../services/context.js";
import type { Context } from "../services/context.js";
import { KmlService } from "../services/kml-service.js";
import { CATEGORIES } from "../domain/archive.js";
import type { ArchiveRequest, Category } from "../domain/archive.js";
import { AppError, errorInfo } from "../domain/errors.js";
import { resolveApiKey, tagMap } from "../domain/config.js";
import { Reporter } from "./progress.js";
const common = {
  config: Flags.string({ description: "配置文件路径" }),
  "dry-run": Flags.boolean({ description: "预演，不写文件或访问付费 API" }),
  verbose: Flags.boolean({
    char: "v",
    description: "详细日志；-vv 显示调试日志",
  }),
  quiet: Flags.boolean({ char: "q", description: "只显示警告与错误" }),
};
const zip = Flags.string({ description: "归档 ZIP 路径；数据库位于同一目录" });
const category = () =>
  Flags.string({
    options: CATEGORIES,
    description: "轨迹分类",
    completion: { options: async () => CATEGORIES },
  });
const paths = Args.string({
  required: true,
  multiple: true,
  description: "KML 路径，支持最后一级通配符",
});
const numeric = (value: number) =>
  Flags.custom<number>({
    parse: async (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0)
        throw new AppError("USER_INPUT", "Value must be a nonnegative number");
      return n;
    },
  })({ default: value });
export type CommonFlags = {
  config?: string;
  "dry-run": boolean;
  verbose: boolean;
  quiet: boolean;
};
export abstract class BusinessCommand extends Command {
  static baseFlags = common;
  async using(
    flags: CommonFlags,
    run: (ctx: Context, service: KmlService) => Promise<void>,
  ): Promise<void> {
    const xml = new XmlWorkers(),
      archive = new ArchiveClient(),
      abort = new AbortController();
    let reporter: Reporter | undefined;
    const cancel = () => abort.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      const config = await new FileConfigStore({ path: flags.config }).load({
        persistMigration: !flags["dry-run"],
      });
      const verbosity = process.argv
        .slice(2)
        .reduce(
          (sum, a) =>
            sum + (a === "--verbose" ? 1 : /^-v+$/.test(a) ? a.length - 1 : 0),
          0,
        );
      reporter = new Reporter(String(config.log_level), verbosity, flags.quiet);
      const ctx = createContext({
        config,
        mode: flags["dry-run"] ? "plan" : "apply",
        signal: abort.signal,
        report: reporter.report,
        xml,
      });
      if (verbosity >= 2)
        ctx.report({
          type: "log",
          level: "DEBUG",
          message: `${this.id} (${ctx.mode})`,
        });
      await run(
        ctx,
        new KmlService(
          new LocalKmlFiles(),
          xml,
          archive,
          new GoogleElevation(),
        ),
      );
    } catch (error) {
      reporter?.close();
      const info = errorInfo(error);
      process.stderr.write(`${JSON.stringify({ error: info })}\n`);
      process.exitCode = info.exitCode;
    } finally {
      reporter?.close();
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      await archive.close();
      await xml.close();
    }
  }
}
class ArchiveInit extends BusinessCommand {
  static description = "创建 SQLite 归档";
  static args = {
    directory: Args.string({ description: "归档目录（默认 archive_path）" }),
  };
  async run() {
    const { args, flags } = await this.parse(ArchiveInit);
    await this.using(flags, async (ctx, s) => {
      const directory = args.directory || String(ctx.config.archive_path || "");
      if (!directory)
        throw new AppError(
          "USER_INPUT",
          "Provide directory or configure archive_path",
        );
      await s.archiveOperation(ctx, {
        kind: "init",
        directory: resolvePath(directory),
      });
    });
  }
}
class ArchiveImport extends BusinessCommand {
  static description = "显式导入 ZIP，保留每个 KML 的原字节";
  static args = {
    source: Args.string({ required: true }),
    directory: Args.string({ required: true }),
  };
  async run() {
    const { args, flags } = await this.parse(ArchiveImport);
    await this.using(flags, async (ctx, s) => {
      await s.archiveOperation(ctx, {
        kind: "init",
        directory: resolvePath(args.directory),
        zip: resolvePath(args.source),
      });
    });
  }
}
function archiveCommand(
  kind: "status" | "backup" | "full-backup" | "recover" | "migrate" | "rebuild",
) {
  return class extends BusinessCommand {
    static description = {
      status: "查看归档修订、导出与待恢复状态",
      backup: "从一致快照导出当前展示 KML ZIP（不含隐藏段和历史）",
      "full-backup": "完整备份 SQLite：原件、版本、展示设置、来源及项目",
      recover: "恢复中断的文件操作",
      migrate: "完整备份后显式升级数据库到 schema 4",
      rebuild: "重新生成桌面与手机集合 KML",
    }[kind];
    static flags = {
      zip,
      ...(kind === "backup" || kind === "full-backup"
        ? {
            output: Flags.string({
              description:
                kind === "backup" ? "输出 ZIP 路径" : "新的 .sqlite3 备份路径",
              required: kind === "full-backup",
            }),
          }
        : {}),
    };
    async run() {
      const { flags } = await this.parse(this.ctor);
      await this.using(flags as unknown as CommonFlags, async (ctx, s) => {
        const w = workspace(ctx.config, flags.zip as string | undefined);
        const request: ArchiveRequest =
          kind === "backup" || kind === "full-backup"
            ? {
                kind,
                database: w.database,
                output: flags.output
                  ? resolvePath(flags.output as string)
                  : w.zip,
              }
            : kind === "rebuild"
              ? { kind, database: w.database, output: w.directory }
              : { kind, database: w.database };
        const result = await s.archiveOperation(ctx, request);
        if (result.status) this.log(JSON.stringify(result.status, null, 2));
      });
    }
  };
}
class ArchiveRestoreBackup extends BusinessCommand {
  static description = "将完整 SQLite 备份恢复到新目录或空目录";
  static args = {
    source: Args.string({ required: true }),
    directory: Args.string({ required: true }),
  };
  async run() {
    const { args, flags } = await this.parse(ArchiveRestoreBackup);
    await this.using(flags, async (ctx, s) => {
      await s.archiveOperation(ctx, {
        kind: "restore-backup",
        backup: resolvePath(args.source),
        directory: resolvePath(args.directory),
      });
    });
  }
}
class ArchiveUndo extends BusinessCommand {
  static description = "已退役：不再支持历史撤销";
  static flags = {
    zip,
    steps: Flags.integer({ min: 1, default: 1 }),
    force: Flags.boolean(),
  };
  async run() {
    const { flags } = await this.parse(ArchiveUndo);
    await this.using(flags, async () => {
      throw new AppError(
        "USER_INPUT",
        "Archive undo has been retired; use archive recover for interrupted file operations",
      );
    });
  }
}
class ArchiveLog extends BusinessCommand {
  static description = "只读查看旧版历史日志（已退役）";
  static flags = { zip, last: Flags.integer({ min: 1, default: 10 }) };
  async run() {
    const { flags } = await this.parse(ArchiveLog);
    await this.using(flags, async (ctx) => {
      ctx.report({
        type: "log",
        level: "WARNING",
        message:
          "This command displays legacy history.jsonl only; versioned archives use separate history storage",
      });
      const w = workspace(ctx.config, flags.zip);
      const file = path.join(w.directory, "history.jsonl");
      if (existsSync(file))
        this.log(
          readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .slice(-flags.last)
            .join("\n"),
        );
    });
  }
}
class KmlType extends BusinessCommand {
  static description = "读取 TrackTags 或其分类";
  static args = { paths };
  static flags = { raw: Flags.boolean() };
  async run() {
    const { args, flags } = await this.parse(KmlType);
    await this.using(flags, async (ctx, s) => {
      const files = expandPaths(args.paths);
      let unknown = 0;
      for (const file of files) {
        const { content, category } = await s.content(ctx, file);
        if (!category) unknown++;
        const value = flags.raw
          ? content.tag || "Unknown"
          : (category ?? "Unknown");
        this.log(files.length === 1 ? value : `${value}\t${displayPath(file)}`);
      }
      if (unknown && !flags.raw)
        ctx.report({
          type: "log",
          level: "WARNING",
          message: `${unknown} tracks have unknown TrackTags`,
        });
    });
  }
}
class SetTag extends BusinessCommand {
  static description = "设置活动标签；缺少标签时可显式创建";
  static args = { paths };
  static flags = {
    tag: Flags.string({
      required: true,
      completion: {
        options: async () => [
          ...tagMap(await new FileConfigStore().load()).keys(),
        ],
      },
    }),
    "create-tag": Flags.boolean(),
  };
  async run() {
    const { args, flags } = await this.parse(SetTag);
    await this.using(flags, async (ctx, s) => {
      if (!tagMap(ctx.config).has(flags.tag))
        throw new AppError("USER_INPUT", `Unknown activity: ${flags.tag}`);
      const result = await s.batch(
        ctx,
        expandPaths(args.paths),
        async (file) => {
          await s.edit(ctx, file, {
            kind: "set-tag",
            tag: flags.tag,
            create: flags["create-tag"],
          });
        },
      );
      process.exitCode = result.exitCode;
    });
  }
}
class Push extends BusinessCommand {
  static description = "归档轨迹；默认把源文件移入 Backup";
  static args = { paths };
  static flags = { type: category(), zip, keep: Flags.boolean() };
  async run() {
    const { args, flags } = await this.parse(Push);
    await this.using(flags, async (ctx, s) => {
      const w = workspace(ctx.config, flags.zip);
      const result = await s.push(
        ctx,
        expandPaths(args.paths),
        w.database,
        w.backup,
        !flags.keep,
        flags.type as Category | undefined,
      );
      process.exitCode = result.exitCode;
    });
  }
}
class Download extends BusinessCommand {
  static description = "下载当前或指定历史版本的 KML 原字节，不修改数据库";
  static args = {
    name: Args.string({ description: "完整成员路径、文件名或 stem" }),
  };
  static flags = {
    type: category(),
    zip,
    "entry-id": Flags.string(),
    version: Flags.string({ description: "该条目的历史版本 ID" }),
    output: Flags.string({
      char: "o",
      description: "下载目标目录，默认当前目录",
    }),
  };
  async run() {
    const { args, flags } = await this.parse(Download);
    await this.using(flags, async (ctx, s) => {
      const w = workspace(ctx.config, flags.zip);
      await s.archiveOperation(ctx, {
        kind: "download",
        database: w.database,
        name: args.name,
        entry_id: flags["entry-id"],
        category: flags.type as Category | undefined,
        version_id: flags.version,
        output: resolvePath(flags.output ?? process.cwd()),
      });
    });
  }
}
class DeleteTrack extends BusinessCommand {
  static description = "删除轨迹及其全部历史；--dry-run 查看范围与依赖";
  static args = {
    name: Args.string({ description: "完整成员路径、文件名或 stem" }),
  };
  static flags = { type: category(), zip, "entry-id": Flags.string() };
  async run() {
    const { args, flags } = await this.parse(DeleteTrack);
    await this.using(flags, async (ctx, s) => {
      const w = workspace(ctx.config, flags.zip);
      const result = await s.archiveOperation(ctx, {
        kind: "delete-preview",
        database: w.database,
        name: args.name,
        entry_id: flags["entry-id"],
        category: flags.type as Category | undefined,
      });
      const preview = result.deletion_preview!;
      if (ctx.mode === "plan") {
        this.log(JSON.stringify(preview, null, 2));
        return;
      }
      await s.archiveOperation(ctx, {
        kind: "delete",
        database: w.database,
        request: {
          archive_id: preview.archive_id,
          expected: preview.expected,
          request_key: randomUUID(),
        },
      });
    });
  }
}
class Split extends BusinessCommand {
  static description = "按时间、坐标或自动检测的记录间断拆分 gx:Track";
  static args = {
    path: Args.string({ required: true }),
    points: Args.string({ multiple: true }),
  };
  static flags = {
    auto: Flags.boolean(),
    "gap-seconds": numeric(300),
    "gap-meters": numeric(500),
  };
  async run() {
    const { args, flags } = await this.parse(Split);
    await this.using(flags, async (ctx, s) => {
      const points = args.points ?? [];
      if (flags.auto ? points.length : !points.length)
        throw new AppError("USER_INPUT", "Provide points or --auto, not both");
      const file = resolvePath(args.path);
      await s.edit(ctx, file, {
        kind: "split",
        stem: path.basename(file, path.extname(file)),
        points,
        auto: flags.auto,
        gapSeconds: flags["gap-seconds"],
        gapMeters: flags["gap-meters"],
      });
    });
  }
}
class Prune extends BusinessCommand {
  static description = "删除指定坏点或自动检测的漂移点";
  static args = {
    path: Args.string({ required: true }),
    points: Args.string({ multiple: true }),
  };
  static flags = {
    auto: Flags.boolean(),
    "speed-mps": numeric(30),
    "jump-meters": numeric(100),
    "return-meters": numeric(30),
    "max-seconds": numeric(120),
  };
  async run() {
    const { args, flags } = await this.parse(Prune);
    await this.using(flags, async (ctx, s) => {
      const points = args.points ?? [];
      if (flags.auto ? points.length : !points.length)
        throw new AppError("USER_INPUT", "Provide points or --auto, not both");
      const file = resolvePath(args.path);
      await s.edit(ctx, file, {
        kind: "prune",
        stem: path.basename(file, path.extname(file)),
        points,
        auto: flags.auto,
        speedMps: flags["speed-mps"],
        jumpMeters: flags["jump-meters"],
        returnMeters: flags["return-meters"],
        maxSeconds: flags["max-seconds"],
      });
    });
  }
}
class Merge extends BusinessCommand {
  static description = "合并轨迹并归档源文件";
  static args = { paths };
  static flags = {
    output: Flags.string({ char: "o", required: true }),
    connected: Flags.boolean(),
    keep: Flags.boolean(),
  };
  async run() {
    const { args, flags } = await this.parse(Merge);
    await this.using(flags, async (ctx, s) => {
      const output = path.resolve(flags.output);
      new LocalKmlFiles().checkOutput(output, []);
      const w = workspace(ctx.config);
      await s.merge(
        ctx,
        expandPaths(args.paths),
        output,
        w.database,
        w.backup,
        flags.keep,
        flags.connected,
        [
          w.database,
          w.zip,
          ...[
            "archive.json",
            "history.jsonl",
            ...CATEGORIES.flatMap((c) => [`${c}.kml`, `${c}.Mobile.kml`]),
          ].map((n) => path.join(w.directory, n)),
        ],
      );
    });
  }
}
class FillAltitude extends BusinessCommand {
  static description = "使用 Google Elevation 回填无高程的 LineString";
  static args = { path: Args.string({ required: true }) };
  static flags = { "api-key": Flags.string() };
  async run() {
    const { args, flags } = await this.parse(FillAltitude);
    await this.using(flags, async (ctx, s) => {
      await s.fillAltitude(
        ctx,
        resolvePath(args.path),
        resolveApiKey(
          ctx.config,
          process.env.TRACKTOOL_GOOGLE_API_KEY,
          flags["api-key"],
        ),
      );
    });
  }
}
export const BUSINESS_COMMANDS: Record<string, Command.Class> = {
  "archive:init": ArchiveInit,
  "archive:import-zip": ArchiveImport,
  "archive:status": archiveCommand("status"),
  "archive:backup": archiveCommand("backup"),
  "archive:full-backup": archiveCommand("full-backup"),
  "archive:restore-backup": ArchiveRestoreBackup,
  "archive:recover": archiveCommand("recover"),
  "archive:migrate": archiveCommand("migrate"),
  "archive:rebuild": archiveCommand("rebuild"),
  "archive:undo": ArchiveUndo,
  "archive:log": ArchiveLog,
  "kml:type": KmlType,
  "kml:set-tag": SetTag,
  "kml:push": Push,
  "kml:download": Download,
  "kml:delete": DeleteTrack,
  "kml:split": Split,
  "kml:prune": Prune,
  "kml:merge": Merge,
  "kml:fill-altitude": FillAltitude,
};
