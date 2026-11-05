# 媒体处理已迁至 mediatool

tracktool 专注轨迹归档、地图编辑和出图；照片与视频的元数据、地理标记、时间修正、转封装和目录整理由独立 CLI `mediatool` 提供。tracktool 的 `exif` 命令及对应网页任务接口已经移除，轨迹相关 CLI、配置命令和 Google 查询仍然保留。

## 从原有命令切换

新项目位于同级目录 `../mediatool`，需要单独安装和构建，不会随 tracktool 安装，也无需启动 tracktool 网页服务。

```sh
cd ../mediatool
pnpm install --frozen-lockfile
pnpm build
pnpm cli --help
pnpm cli config set archive_path /绝对路径/轨迹归档
pnpm cli --dry-run exif geotag /绝对路径/照片
```

全局安装后，将原来的 `tracktool exif …` 改为 `mediatool exif …`；主要子命令与参数沿用原设计。详细功能、视频时区规则和安装方式见 mediatool 项目的 README 和 `docs/behavior.md`。

配置独立保存在 `~/.config/mediatool/config.json`（遵循 `XDG_CONFIG_HOME`），不自动读取或迁移 tracktool 配置。按需重新设置 `archive_path`、`google_api_key`、`log_level` 和 `output_filters`。环境变量改用 `MEDIATOOL_GOOGLE_API_KEY`、`MEDIATOOL_EXIFTOOL`、`MEDIATOOL_FFMPEG`。tracktool 中原有 `output_filters` 字段不再使用，无需为本次拆分修改原配置文件。

## 轨迹库

本次拆分不更改数据库结构，仍为 schema 10。mediatool 只读现有 SQLite，直接解析当前活动版本的 KML；不会创建数据库、修复归档或写回解析缓存。两者可以独立运行，没有共享包或 HTTP 依赖。未来数据库结构变化时，需要同步调整媒体工具。

## 当前状态

mediatool 是从原应用提取的初始版本，本次只做构建和基本命令验证，没有完整验收所有媒体处理分支。继续沿用预演、首次备份及冲突检查的设计；后续会针对相机时间、视频转换和批量整理单独完善。此次不会迁移原网页中的媒体任务记录，也不会处理现有媒体文件。
