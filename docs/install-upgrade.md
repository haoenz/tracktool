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

已有 schema 2/3 归档不自动升级；新库使用 schema 4，`archive migrate` 先生成完整备份再升级。地图项目 JSON schema 3 固定库和版本；schema 1/2 按 path + SHA 唯一关联基线，不自动跟随最新轨迹。渲染器资源版本不同仍需确认后另存。新版展示 ZIP 只保留可见结果，原件和隐藏历史用 full-backup 保留。PNG 的短期出图会话不跨进程恢复。配置密钥读取优先级仍为环境变量 > CLI 参数 > 文件；网页不回显密钥。

## 回退

若已升级 schema 3/4，先用 `archive restore-backup` 将迁移前的 schema 1/2 完整备份恢复到独立目录，再交给旧版本打开；旧程序不能直接使用 schema 3/4 库。

停止新服务和 CLI，保留新状态目录以便诊断；使用先前保留的 Python 环境/独立检出恢复旧命令 PATH。旧版本源码基线是 `5fa6aa97f9dd834a116fd5277f33ad6d4bae9f9e`，离线快照恢复见 [history/README.md](history/README.md)。

在独立目录恢复完整数据库备份及配置，或把 ZIP 导入一个全新归档；不要覆盖当前唯一数据库或把数据库文件单独复制到仍存在不匹配 WAL 的目录。媒体变更需从原件/首次备份恢复。回退应用程序本身不会撤销已经写入的元数据、轨迹或任务结果。

## 验收矩阵

| 平台/入口 | 本轮状态 |
| --- | --- |
| Linux x86_64 / Node 26 / pnpm | 构建、真实媒体工具、网页、独立包、PNG、配置/归档恢复已实测 |
| Linux zsh | 真实 Tab：命令、参数、中文路径、分类、动态标签；PTY 进度/取消/窄终端已实测 |
| Linux bash | 真实 Tab：命令、参数、分类、中文路径、动态标签，以及干净管道 stdout 已实测 |
| macOS / zsh | 不在本次范围；CI 已配置但没有实机结果 |
| Windows x64 / PowerShell | 用户有需要时另行验收；CI 已配置但没有实机或原生补全结果 |

`.github/workflows/release-check.yml` 运行各系统构建、集成、浏览器、打包及安装后验证，并保留报告；此文件创建不等于工作流已执行。用户已确认本次仅验收 Linux，其他平台不阻塞此次迁移完成；现有安装包保留rc.2 版本号。CI 的 pnpm/浏览器安装方式分别参考 [pnpm action](https://github.com/pnpm/action-setup) 与 [Playwright CI](https://playwright.dev/docs/ci-intro)。

本地复验：

```sh
pnpm check
pnpm cli setup chromium
pnpm test:e2e
pnpm test:terminal
pnpm pack --pack-destination sandbox/pack
node scripts/release/prepare-consumer.mjs sandbox/consumer sandbox/pack
pnpm --dir sandbox/consumer install
pnpm verify:package sandbox/consumer sandbox/release-check
# 此项使用 Linux 的独立 PATH 和外部工具位置
node scripts/release/web-smoke.mjs sandbox/consumer sandbox/release-check
node scripts/release/performance.mjs sandbox/release-performance
node --expose-gc scripts/release/lifecycle.mjs sandbox/release-performance/lifecycle.json
```

每次发布验收使用新的空 consumer/pack 目录，避免已有产物污染结果。`verify:package` 验证实际安装产物的字体 SHA、前端、API、旧库读取、项目、1920×1440 PNG、ZIP 恢复、媒体备份与真实 ffmpeg；Unix 上限制 PATH 以移除 Python。性能复验沿用 M3 的同样本和预算；联网地图源/Google API 单独记录，不以离线测试承诺外部服务持续可用。

原 pop 已移除，使用独立的 `kml download` 和 `kml delete`。下载兼容 schema 2/3/4，删除需要显式升级到 schema 4。若旧库有待完成 pop，先运行 `archive recover` 按该库原语义完成，再迁移；schema 3 的旧退出展示状态不会自动转为删除。
