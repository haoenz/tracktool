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

Chromium 用于 PNG 导出；仅处理轨迹或媒体时无需安装。打开 `http://127.0.0.1:8765`，直接进入全屏地图工作区。默认展示全库轨迹；通过“新建出图工程 / 打开已有工程”明确进入构图和导出，返回时恢复浏览上下文。左上角只有“轨迹 / 设置”两个入口；轨迹面板仅提供轨迹列表、上传轨迹、导出轨迹三个入口；导出类型可选 ZIP、聚合 KML 和 PNG 图像，选择后显示对应选项。设置仅提供底图、标注、要素和叠加层；服务配置由 CLI 或后台修改。网页固定使用后台配置的一个轨迹库，不提供 SQLite 上传、选择或路径配置入口。首次建库和旧 ZIP 导入通过 CLI 完成。

安装打包文件：

```sh
pnpm pack --pack-destination ./dist-pack
pnpm add --global ./dist-pack/tracktool-2.0.0-rc.2.tgz --allow-build better-sqlite3 --allow-build sharp
tracktool setup chromium
tracktool-map --archive /绝对路径/轨迹归档
```

这是本地产物安装方式；本轮没有发布到公共包仓库。已有 Python 安装时，先按[升级与回退说明](docs/install-upgrade.md)备份和核对命令路径，再切换入口。

源码工作目录的本地轨迹库放在 `data/archive.sqlite3`，`data/` 整个目录不纳入 Git。后台使用 `archive_path` 配置或启动参数 `--archive` 指定位置，例如 `pnpm cli config set archive_path "$PWD/data"`。KML 文件仍可通过网页导入到这个固定库。

## 网页工作流

- **轨迹库**：默认在地图展示全库，按视野加载分级轨迹。列表分页搜索，点击轨迹查看详情，重叠时选择候选；眼睛按钮控制显示，批量模式的勾选用于处理或显式加入工程。搜索和日期筛选只影响列表，地图筛选需要明确应用。网页提供 KML 上传入库、下载以及 ZIP、聚合 KML 和 PNG 导出。
- **出图工程**：新建时带入当前视野，可显式加入批量所选轨迹；已有工程可载入或导入 JSON。标题、轨迹样式、画框和 PNG 导出仅在工程中出现，使用完整轨迹精度；工程名称、保存状态与保存／另存为／退出常驻；临时添加轨迹不改变构图，退出时可保存、放弃或取消。
- **轨迹处理**：从具体行程详情的“编辑轨迹／调整显示／查看历史操作”进入，支持断开、删点、补高程、修改标签、补绘、连接/忽略设置、版本历史和整组撤销。普通修改直接保存，补高程、拆分和历史恢复等先展示结果再确认；原件及旧版本保留；明确选择“拆成独立行程”才产生多个条目。连接/忽略统一用于全库地图、项目、PNG 和展示 KML；项目固定历史版本，可独立覆盖段设置或显式更新到库中当前版本。
- **操作反馈**：在当前操作页面显示预览确认、进度和结果。

媒体处理暂时仅通过 CLI 使用。切换网页面板保留地图视角、轨迹选择和未保存编辑；旧的归档、轨迹、任务、设置地址会打开对应面板。

网页 KML 入库仅支持从手机或当前设备上传。上传原件保留在客户端，服务端处理暂存副本；入库成功、失败或取消后自动清理副本，中断后在服务重启时补做清理。成功的预览会保留副本直到确认入库或预览过期，再次处理需重新上传。任务和事件保存在独立 SQLite 数据库，服务重启后仍可查看；中断的写任务不会自动重放。取消不回滚已完成修改。

```sh
# 指定可以在网页中浏览和处理的目录，可重复传 --files-root
pnpm start --files-root /数据 --state-dir /数据/网页状态 --no-browser
# 可信局域网：在手机上访问服务电脑的 IPv4 地址
pnpm start --host 0.0.0.0 --files-root /数据 --archive /数据/归档
```

网页文件范围、上传和任务恢复见[网页地图使用说明](docs/web-usage.md)。本轮测试与截图见[地图工作区 UX 验收](docs/validation/ux-workspace.md)。

## CLI 示例

源码运行将 `tracktool` 换成 `pnpm cli` 即可，不需要启动网页服务。

```sh
tracktool archive init /数据/轨迹归档
tracktool config set archive_path /数据/轨迹归档
tracktool --dry-run kml push '/数据/输入/*.kml'
tracktool kml push '/数据/输入/*.kml'
tracktool archive backup
tracktool archive recover
tracktool kml set-tag '/数据/输入/轨迹.kml' --tag 徒步 --create-tag
tracktool kml split '/数据/输入/轨迹.kml' --auto
tracktool exif geotag /数据/照片
tracktool exif shift-time /数据/照片 --by -1h
tracktool exif to-mp4 /数据/视频 --timezone-policy keep
tracktool config show --public
```

使用 `kml download` 只读下载轨迹，`kml delete` 删除条目及其历史；原 pop 已移除。新库使用 schema 4，旧 schema 2/3 可继续读取，删除前用 `archive migrate` 完整备份后显式升级。ZIP/聚合 KML 是日常导出，完整历史与项目使用 SQLite 完整备份；旧 ZIP 使用 `archive import-zip`。`archive undo` 已退役，`archive log` 只读已有旧日志。

入库默认整批校验、事务提交，保留源文件且不创建 Backup 目录；显式 `kml push --move` 或 `kml merge --move` 才启用旧的源文件搬移流程。

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

网页 UI 使用 shadcn/ui（Radix 基础组件）与 Tailwind CSS。基础组件源码在 `src/web/components/ui`，搜索多选、任务表格等应用组合在 `src/web/components/controls.tsx`，主题变量在 `src/web/style.css`；组件配置见 `components.json`。新增控件优先复用这些组件，保持键盘交互、中文标签和移动端布局一致。组件来源与许可见 `THIRD_PARTY_NOTICES.md`。

开发网页界面时运行：

```sh
pnpm run dev
```

首次启动会先构建后台，再同时启动后台和 Vite：Vite 在 `0.0.0.0:8765` 提供网页并启用热更新，后台在本机 `127.0.0.1:8766` 提供 API。电脑浏览器访问 `http://127.0.0.1:8765`；同一局域网内的设备访问这台电脑的 IPv4 地址加 `:8765`。修改 `src/web` 下的 React、样式和页面代码后，浏览器会自动更新。按 Ctrl+C 会同时停止两项服务。

`pnpm run` 不带脚本名时只会列出可用脚本，启动开发环境请使用 `pnpm run dev`。`pnpm start` 仍用于启动构建后的常规服务。

```sh
pnpm check
pnpm test:e2e
pnpm test:terminal           # Linux PTY / zsh / Bash
pnpm cities CN.zip new-cities.json
```

正式构建、测试及城市数据维护无需 Python。

参考：[存储格式](docs/sqlite-storage.md)、[安装升级与发布检查](docs/install-upgrade.md)、[第三方资源](THIRD_PARTY_NOTICES.md)。
