import { Args, Flags } from "@oclif/core";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { BusinessCommand } from "./business-commands.js";
import { FileConfigStore } from "../infrastructure/config-store.js";
import {
  databasePath,
  readTransaction,
} from "../infrastructure/archive/database.js";
import { archiveId } from "../infrastructure/archive/versions.js";
import {
  trackCatalog,
  trackDetail,
  trackHistory,
  operationDetail,
  requireVersioned,
} from "../infrastructure/archive/track-reader.js";
import { EditPreviews } from "../infrastructure/archive/edit-previews.js";
import { EditRequestSchema } from "../shared/track-edit.js";
import { AppError } from "../domain/errors.js";
import { exportDisplay } from "../infrastructure/archive/display-export.js";
import { exclusive } from "../infrastructure/durable-files.js";
import { currentEntry } from "../infrastructure/archive/versions.js";
const archive = Flags.string({ description: "SQLite 轨迹库；默认使用配置" }),
  state = Flags.string({
    description: "编辑预览状态目录；与网页共用时指定同一目录",
  });
function stateFile(config: string | undefined, stateDir: string | undefined) {
  return path.join(
    stateDir ??
      path.join(
        path.dirname(new FileConfigStore({ path: config }).path),
        "web",
      ),
    "tasks.sqlite3",
  );
}
class TrackList extends BusinessCommand {
  static description = "列出活动行程及稳定 ID（只读）";
  static flags = {
    archive,
    search: Flags.string({ default: "" }),
    cursor: Flags.integer({ default: 0, min: 0 }),
  };
  async run() {
    const { flags } = await this.parse(TrackList);
    await this.using(flags, async (ctx) => {
      this.log(
        JSON.stringify(
          trackCatalog(
            databasePath(flags.archive ?? String(ctx.config.archive_path)),
            flags.search,
            flags.cursor,
          ),
        ),
      );
    });
  }
}
class TrackShow extends BusinessCommand {
  static description = "读取行程、段和展示设置（只读）";
  static args = { entry: Args.string({ required: true }) };
  static flags = {
    archive,
    version: Flags.string(),
    presentation: Flags.string(),
    cursor: Flags.integer({ default: 0, min: 0 }),
  };
  async run() {
    const { flags, args } = await this.parse(TrackShow);
    await this.using(flags, async (ctx) => {
      this.log(
        JSON.stringify(
          trackDetail(
            databasePath(flags.archive ?? String(ctx.config.archive_path)),
            args.entry,
            flags.version,
            flags.presentation,
            flags.cursor,
          ),
        ),
      );
    });
  }
}
class TrackHistory extends BusinessCommand {
  static description = "读取行程版本和展示快照（只读）";
  static args = { entry: Args.string({ required: true }) };
  static flags = { archive, cursor: Flags.integer({ default: 0, min: 0 }) };
  async run() {
    const { flags, args } = await this.parse(TrackHistory);
    await this.using(flags, async (ctx) => {
      this.log(
        JSON.stringify(
          trackHistory(
            databasePath(flags.archive ?? String(ctx.config.archive_path)),
            args.entry,
            flags.cursor,
          ),
        ),
      );
    });
  }
}
class TrackOperation extends BusinessCommand {
  static description = "读取操作组及恢复所需的完整引用（只读）";
  static args = { operation: Args.string({ required: true }) };
  static flags = { archive };
  async run() {
    const { flags, args } = await this.parse(TrackOperation);
    await this.using(flags, async (ctx) => {
      this.log(
        JSON.stringify(
          operationDetail(
            databasePath(flags.archive ?? String(ctx.config.archive_path)),
            args.operation,
          ),
        ),
      );
    });
  }
}
class TrackPreview extends BusinessCommand {
  static description = "从明确的 JSON 请求创建轨迹编辑预览；不改轨迹库";
  static args = {
    request: Args.string({
      required: true,
      description: "编辑请求 JSON 文件（与网页契约相同）",
    }),
  };
  static flags = { archive, "state-dir": state };
  async run() {
    const { flags, args } = await this.parse(TrackPreview);
    await this.using(flags, async (ctx) => {
      if (statSync(args.request).size > 2 * 1024 * 1024)
        throw new AppError("USER_INPUT", "请求文件超过 2 MiB");
      const request = EditRequestSchema.parse(
          JSON.parse(readFileSync(args.request, "utf8")),
        ),
        id = randomUUID();
      const store = new EditPreviews(
        flags["dry-run"]
          ? ":memory:"
          : stateFile(flags.config, flags["state-dir"]),
      );
      try {
        const preview = await store.create(
          databasePath(flags.archive ?? String(ctx.config.archive_path)),
          id,
          request,
          ctx.signal,
        );
        this.log(JSON.stringify({ ...preview, persisted: !flags["dry-run"] }));
      } finally {
        store.close();
      }
    });
  }
}
class TrackApply extends BusinessCommand {
  static description = "按预览 ID 和哈希原子应用；同一请求键可安全重试";
  static args = { preview: Args.string({ required: true }) };
  static flags = {
    archive,
    "state-dir": state,
    sha: Flags.string({ required: true, description: "预览清单 SHA-256" }),
    "request-key": Flags.string({
      description: "重试保持相同的键，默认 apply:<预览 ID>",
    }),
  };
  async run() {
    const { flags, args } = await this.parse(TrackApply);
    await this.using(flags, async (ctx) => {
      const file = databasePath(
          flags.archive ?? String(ctx.config.archive_path),
        ),
        store = new EditPreviews(
          stateFile(flags.config, flags["state-dir"]),
          undefined,
          flags["dry-run"],
        );
      try {
        if (flags["dry-run"]) {
          const p = store.get(file, args.preview);
          if (p.preview_sha256 !== flags.sha)
            throw new AppError("USER_INPUT", "预览哈希不匹配");
          this.log(JSON.stringify({ would_apply: p }));
          return;
        }
        const id = readTransaction(file, (db) => {
          requireVersioned(db);
          return archiveId(db);
        });
        this.log(
          JSON.stringify(
            store.apply(
              file,
              {
                schema: 1,
                archive_id: id,
                preview_id: args.preview,
                preview_sha256: flags.sha,
                request_key: flags["request-key"] ?? `apply:${args.preview}`,
              },
              ctx.signal,
            ),
          ),
        );
      } finally {
        store.close();
      }
    });
  }
}
class TrackExport extends BusinessCommand {
  static description =
    "按固定版本和展示快照导出一个 KML；原字节请使用 archive download";
  static args = { entry: Args.string({ required: true }) };
  static flags = {
    archive,
    version: Flags.string(),
    presentation: Flags.string(),
    output: Flags.string({ char: "o", required: true }),
  };
  async run() {
    const { flags, args } = await this.parse(TrackExport);
    await this.using(flags, async (ctx) => {
      const file = databasePath(
        flags.archive ?? String(ctx.config.archive_path),
      );
      const raw = readTransaction(file, (db) => {
        requireVersioned(db);
        const current = currentEntry(db, args.entry);
        const version = flags.version ?? current.version_id;
        const row = db
          .prepare(
            "SELECT sha256 FROM track_versions WHERE id=? AND entry_id=?",
          )
          .get(version, args.entry) as { sha256: string } | undefined;
        if (!row) throw new AppError("USER_INPUT", "版本不存在");
        const presentation =
          flags.presentation ??
          (version === current.version_id
            ? current.presentation_id
            : (
                db
                  .prepare(
                    "SELECT id FROM track_presentations WHERE version_id=? ORDER BY rowid LIMIT 1",
                  )
                  .get(version) as { id: string }
              ).id);
        return exportDisplay(db, current.path, {
          entry: current.path,
          archive_id: archiveId(db),
          entry_id: args.entry,
          version_id: version,
          presentation_id: presentation,
          sha256: row.sha256,
        });
      });
      if (!flags["dry-run"]) exclusive(path.resolve(flags.output), raw);
      this.log(
        JSON.stringify({
          output: path.resolve(flags.output),
          bytes: raw.length,
          dry_run: !!flags["dry-run"],
        }),
      );
    });
  }
}
export const TRACK_COMMANDS = {
  "track:list": TrackList,
  "track:show": TrackShow,
  "track:history": TrackHistory,
  "track:operation": TrackOperation,
  "track:preview": TrackPreview,
  "track:apply": TrackApply,
  "track:export": TrackExport,
};
