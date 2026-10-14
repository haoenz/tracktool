# tracktool

KML 轨迹归档、地图编辑与照片/视频地理标记工具。应用采用 TypeScript、Node.js 和 React，CLI 与网页共用业务服务；包管理统一使用 pnpm。

当前版本为 **2.0.0-rc.2**。本次迁移按 Linux 范围验收完成，可开始日常使用；macOS 暂不纳入范围，Windows 有需要时另行验收，跨平台 CI 配置不代表实测通过。项目采用本地服务，也可在可信局域网中访问。

## 安装与启动

需要 Node **26.11.1–26.x**（本轮固定 26.11.1）及 **pnpm 12.10.1**。Unix 媒体处理需要 Perl，视频转封装需要 ffmpeg；ExifTool 引擎随依赖提供。

从源码运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm cli setup chromium
pnpm start --archive /绝对路径/轨迹归档
```

Chromium 用于 PNG 导出；仅处理轨迹或媒体时无需安装。打开 `http://127.0.0.1:8765`，可进入地图、归档、轨迹处理、媒体、任务和设置页面。首次没有归档时，可在归档页创建或导入 ZIP。

安装打包文件：

```sh
pnpm pack --pack-destination ./dist-pack
pnpm add --global ./dist-pack/tracktool-2.0.0-rc.2.tgz --allow-build better-sqlite3 --allow-build sharp
tracktool setup chromium
tracktool-map --archive /绝对路径/轨迹归档
```

这是本地产物安装方式；本轮没有发布到公共包仓库。已有 Python 安装时，先按[升级与回退说明](docs/install-upgrade.md)备份和核对命令路径，再切换入口。

## 网页工作流

- **归档**：浏览/分类筛选、ZIP 导入、轨迹入库/取回、状态、备份、聚合导出、恢复。
- **轨迹处理**：分类/活动标签、拆分、清理漂移、合并、高程、处理结果地图检查。
- **媒体**：元数据检查、GPS 匹配、海拔/地名、时间偏移、转封装、分类与修复。
- **任务**：预览确认、排队/进度、逐文件结果、取消、重新预览、下载及刷新恢复。

可选择服务端目录或从手机/当前设备上传。上传原件保留在客户端，服务端处理暂存副本；结果下载后可清理批次。任务和事件保存在独立 SQLite 数据库，服务重启后仍可查看；中断的写任务不会自动重放。取消不回滚已完成修改。

```sh
# 指定可以在网页中浏览和处理的目录，可重复传 --files-root
pnpm start --files-root /数据 --state-dir /数据/网页状态 --no-browser
# 可信局域网：在手机上访问服务电脑的 IPv4 地址
pnpm start --host 0.0.0.0 --files-root /数据 --archive /数据/归档
```

详细参数、文件范围、上传限制和任务恢复见[使用与开发说明](docs/typescript-development.md)。

## CLI 示例

源码运行将 `tracktool` 换成 `pnpm cli` 即可，不需要启动网页服务。

```sh
tracktool archive init /数据/轨迹归档
tracktool config set archive_path /数据/轨迹归档
tracktool --dry-run kml push '/数据/输入/*.kml'
tracktool kml push '/数据/输入/*.kml' --keep
tracktool archive backup
tracktool archive recover
tracktool kml set-tag '/数据/输入/轨迹.kml' --tag 徒步 --create-tag
tracktool kml split '/数据/输入/轨迹.kml' --auto
tracktool exif geotag /数据/照片
tracktool exif shift-time /数据/照片 --by -1h
tracktool exif to-mp4 /数据/视频 --timezone-policy keep
tracktool config show --public
```

保留原有 34 个业务命令。SQLite 是主存储；ZIP/聚合 KML 显式导出。普通读取不升级数据库；旧 schema 使用 `archive migrate`，旧 ZIP 使用 `archive import-zip`。`archive undo` 已退役，`archive log` 只读已有旧日志。

`--dry-run` 不修改源文件或请求付费 Google API；公共参数可放在业务命令前后。查询写入 stdout，日志/进度进入 stderr。退出码：0 成功、1 输入错误、2 外部工具/API 失败、3 部分失败、130 用户取消。媒体默认保留首次 `_original` 备份；重跑不覆盖该备份。视频时区冲突应显式选择 `keep`/`force` 和必要的 `--time-source`。

zsh 动态补全（当前会话）：

```sh
autoload -Uz compinit && compinit
source <(tracktool completion zsh)
```

Bash 当前会话使用 `source <(tracktool completion bash)`；同样支持动态活动标签。

更多命令和兼容细节见[CLI 使用说明](docs/cli.md)。

## 程序调用

Node 可使用 `import { readTrackData, openArchive } from 'tracktool'`。其他语言可调用 `tracktool data track FILE`、`tracktool data entries ARCHIVE` 或本地 HTTP。微秒 JSON 使用十进制字符串，保留原有精度；见[API 与 Python 调用替代](docs/api.md)。

## 开发与验收

```sh
pnpm check
pnpm test:e2e
pnpm test:terminal           # Linux PTY / zsh / Bash
pnpm cities CN.zip new-cities.json
```

正式构建、测试及城市数据维护无需 Python。旧源码、测试和探针的恢复说明在[历史快照](docs/history/README.md)，现有 Python 生成的固定差分样本仍参与 TS 验收。

参考：[存储格式](docs/sqlite-storage.md)、[安装升级与发布检查](docs/install-upgrade.md)、[第三方资源](THIRD_PARTY_NOTICES.md)。
