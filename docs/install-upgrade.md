# 安装、升级、回退与发布检查

当前候选版本 `2.0.0-rc.2`，验收范围为 Linux。采用 Node 26（至少 26.11.1，本轮验证版本 26.11.1）和 pnpm 12.10.1。尚未发布公共 registry 包。

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

TAR.XZ 导出需要安装 XZ Utils（`xz` 命令）并加入 PATH；ZIP 导出和仅打包的 TAR 不需要它。

媒体处理已迁至独立 mediatool，tracktool 不再依赖 ExifTool、Perl 或 ffmpeg；原有 `exif` 脚本需要调整，见[拆分说明](media-tool.md)。原生 SQLite/Sharp/LZMA 必须有匹配操作系统/CPU 的预编译包；如果安装器退回源码编译，可能需要平台编译工具或 Python/node-gyp。Linux x86_64 的预编译安装和运行已验证无需 Python；不能把这一结果外推到未测平台。

## 配置与数据

Linux 配置位于 `$XDG_CONFIG_HOME/tracktool/config.json`（默认 `~/.config/tracktool/config.json`）。可用 `--config` 指定配置文件。密钥优先级为环境变量 > CLI 参数 > 配置文件，网页不回显密钥。

使用 `archive init` 创建归档，再设置 `archive_path`。程序只接受 schema 10。完整备份与恢复也要求相同结构；不匹配的数据库会明确报错，不会改写输入文件。

网页任务、上传和 `display.json` 位于 `~/.local/state/tracktool`，可用 `--state-dir` 指定目录。状态目录不应作为永久文件备份。出图文档保存在浏览器草稿或导出的 JSON 中。

## 更新与恢复

更新前停止 CLI 和网页写入，使用 `archive full-backup` 保存完整 SQLite 备份，另行备份配置和出图 JSON。更新后重新安装依赖、构建并准备 Chromium。

使用 `archive restore-backup` 将完整备份恢复到新目录或空目录，再切换 `archive_path`。备份保留轨迹原件、版本历史、展示设置及端点行政区结果。配置和瓦片不包含在数据库备份中。

不要单独复制正在写入的 SQLite 主文件；使用在线完整备份以包含 WAL 中已提交的数据。

## 从 schema 9 升级到 schema 10

源码工作区提供一次性升级工具。先停止使用旧库的程序，执行 `pnpm build`，再运行：

```sh
node scripts/upgrade-archive-schema9.ts /旧目录/archive.sqlite3 /新目录/archive.sqlite3
pnpm cli config set archive_path /新目录
```

工具通过 SQLite 一致快照生成新库，不覆盖原库，校验原件、外键和展示摘要后才发布。原始 KML、行程身份、轨迹版本及操作历史保留。旧连接设置不能证明中断原因，因此统一转为未分类，不自动标记为隧道；片段顺序与显隐保留，但历史地图中的跨段连接也会按新规则显示。需要原来的显示设置时，可用旧版程序打开保留的原库。

程序正常运行及完整备份恢复仍只接受当前 schema；不要直接修改 `PRAGMA user_version` 来绕过检查。切换归档路径后重启服务，地图概览会重新生成。
