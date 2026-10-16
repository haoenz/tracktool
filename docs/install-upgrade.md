# 安装、升级、回退与发布检查

当前候选版本 `2.0.0-rc.2`，已完成本次 Linux 范围的迁移验收，可开始使用。采用 Node 26（至少 26.11.1，本轮验证版本 26.11.1）和 pnpm 12.10.1；不再提供 Python wheel 或 uv 应用入口。尚未发布公共 registry 包。

## 安装

源码方式：`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm cli setup chromium` → `pnpm start`。仓库的 `pnpm-workspace.yaml` 仅允许 better-sqlite3 和 sharp 的安装构建脚本。

使用 nvm 时，先进入项目目录执行 `nvm install`、`nvm use`，按 `.nvmrc` 切到 26.11.1；项目当前要求 Node 26.11.1 或更新的 26.x，较早的 26.x 也需先升级。依赖安装、构建和浏览器准备在首次使用或更新后执行，日常直接 `pnpm start` 或 `pnpm cli ...`。

打包方式：运行 `pnpm pack --pack-destination ./dist-pack`，分发生成的 tgz，然后执行：

```sh
pnpm add --global ./tracktool-2.0.0-rc.2.tgz --allow-build better-sqlite3 --allow-build sharp
tracktool --help
tracktool setup chromium
tracktool-map --no-browser
```

安装目录不可位于项目自己的 `node_modules` 内。pnpm 的全局 bin 目录需位于 PATH；如果尚未配置，可按 `pnpm setup` 的输出设置并重开终端。源码方式不需要修改全局命令。

`tracktool setup chromium` 调用本包 Playwright 对应版本的安装器；`--dry-run` 可检查下载位置。Linux 缺浏览器系统库时用 `--with-deps`，这一步可能要求系统管理员权限。浏览器放在 Playwright 的用户缓存中，不内嵌在 tgz；可通过 `PLAYWRIGHT_BROWSERS_PATH` 固定位置。仅 CLI 或不导出 PNG 的网页流程不依赖 Chromium。

ExifTool 由 `exiftool-vendored` 提供，Unix 需要 Perl；`TRACKTOOL_EXIFTOOL` 可覆盖。ffmpeg 单独安装并加入 PATH，或指定 `TRACKTOOL_FFMPEG`。本轮不安装或修改用户机器上的外部工具。原生 SQLite/Sharp/LZMA 必须有匹配操作系统/CPU 的预编译包；如果安装器退回源码编译，可能需要平台编译工具或 Python/node-gyp。Linux x86_64 的预编译安装和运行已验证无需 Python；不能把这一结果外推到未测平台。

## 从 Python 切换

1. 先停止正在执行写入的旧 CLI/网页服务。保留 Python 环境作为回退入口。
2. 对归档执行旧版本 `archive backup`；需要地图项目时，在没有任何写进程的情况下另备份完整归档目录（含 SQLite/WAL）或使用 SQLite 在线备份工具。ZIP 恢复原始轨迹和成员路径，不包含数据库项目。
3. 复制配置文件和重要媒体原件/首次 `_original` 备份；配置可能含密钥，应按个人数据保管。
4. 先用源码 `pnpm cli --config /备份副本/config.json config show --public`、`pnpm start --config /备份副本/config.json --archive /备份副本/归档 --files-root /备份副本` 验证副本。已有 schema 2 库可直接读取；不因安装改变原始 KML。
5. 准备切换时，按原安装工具卸载旧 `tracktool` 命令，或调整 PATH。只保留一个默认 `tracktool` / `tracktool-map` 提供者。Linux/macOS 用 `command -v tracktool`，PowerShell 用 `Get-Command tracktool` 核对；执行 `tracktool --version` 应显示 2.0.0-rc.2。
6. 使用原归档/配置启动新入口。旧 `kml_zip_path` 自动转换为同目录 `archive_path`；正常运行可原子迁移旧配置，预演不写。不要让旧进程与新进程同时迁移配置。

配置位置沿用 Linux `$XDG_CONFIG_HOME/tracktool`（默认 `~/.config/tracktool`）、macOS `~/Library/Application Support/tracktool`、Windows `%APPDATA%/tracktool`。网页任务默认存入配置目录的 `web/tasks.sqlite3`，上传存入 `web/uploads/`；可指定 `--state-dir`。不要把状态目录当作永久文件备份。

已有 schema 2/3/4/5 归档不自动升级；新库使用 schema 6，`archive migrate` 先生成完整备份再升级。地图项目 JSON schema 3 固定库和版本；schema 1/2 按 path + SHA 唯一关联基线，不自动跟随最新轨迹。渲染器资源版本不同仍需确认后另存。新版展示 ZIP 只保留可见结果，原件和隐藏历史用 full-backup 保留。PNG 的短期出图会话不跨进程恢复。配置密钥读取优先级仍为环境变量 > CLI 参数 > 文件；网页不回显密钥。

## 回退

若已升级 schema 3/4，先用 `archive restore-backup` 将迁移前的 schema 1/2 完整备份恢复到独立目录，再交给旧版本打开；旧程序不能直接使用 schema 3/4 库。

停止新服务和 CLI，保留新状态目录以便诊断；使用先前保留的 Python 环境恢复旧命令 PATH。旧程序不能直接使用 schema 3/4 数据库。

在独立目录恢复完整数据库备份及配置，或把 ZIP 导入一个全新归档；不要覆盖当前唯一数据库或把数据库文件单独复制到仍存在不匹配 WAL 的目录。媒体变更需从原件/首次备份恢复。回退应用程序本身不会撤销已经写入的元数据、轨迹或任务结果。

轨迹详情统计在 schema 5 中按内容哈希、解析器版本、分析版本及参数哈希持久缓存。迁移仅增加空缓存表，不预计算历史数据；首次查看时回填。缓存不推进业务或存储修订号，不改变轨迹历史。旧库未迁移或无法写入时仍可按需计算。

端点行政区使用 schema 6 的独立表，迁移保留原有统计缓存和轨迹原件。升级先自动保存完整 SQLite 备份；迁移本身不访问 Google。执行 `pnpm cli track fill-locations --dry-run` 查看计划，去掉 `--dry-run` 才查询并持久化。
