# tracktool

旅行影像地理数据工具集：KML 轨迹管理与照片/视频 EXIF 地理标记。

## 功能

- **KML 轨迹管理**：归档（桌面/手机双汇总 + ZIP + 备份）、拆分、删坏点、合并、Google 高程回填
- **EXIF 地理标记**：按拍摄时间与 KML 轨迹二分匹配写入 GPS、Google 高程/逆地理编码补全、时间平移、海拔偏移、MP4 转封装、媒体分类、缺失修复编排
- **文件去重**：MD5 哈希日志、重复文件查找、目录对比

## 安装

```bash
uv tool install .        # 或 pip install .
```

依赖外部工具：[exiftool](https://exiftool.org/)、ffmpeg（`to-mp4` 需要）。

## 快速上手

```bash
# 按轨迹给照片写入 GPS（已有 GPS 的跳过；失败文件移入 TrackPosFailed）
tracktool exif set-position ./photos --overwrite --failed-folder TrackPosFailed

# 一键修复缺失 GPSPosition/GPSAltitude 的媒体
tracktool exif resolve-missing ./VID

# 归档一条新轨迹
tracktool kml push ./2024-05-01\ 徒步.kml
```

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部成功 |
| 1 | 用户输入错误（路径不存在、坐标无法解析、配置或 KML 格式错误，以及命令或选项拼写错误） |
| 2 | 外部工具或 API 失败（exiftool 报错、Google 拒绝请求或超额） |
| 3 | 部分失败：逐文件隔离后仍有文件未处理完 |

命令名、选项拼写错误、缺必填参数都退 1：typer 内部把这类用法错误记作 2，与「外部工具/API 失败」同值，入口处已把这一来源归一到 1，因此 **2 只表示外部依赖失败**。

批量命令遇到单个坏文件不会中止整批：该文件计入失败清单（给了 `--failed-folder` 就移入该目录），其余文件照常处理，命令以 3 退出，日志里给出 `N file(s) failed` 汇总。修复编排（`resolve-missing`）把整个文件列表交给批量入口，因此一次 Google 高程请求可覆盖最多 512 个坐标，KML 归档也只加载解析一次。

## 配置

配置文件位于 `~/.tracktool/config.json`，字段：`log_level`、`kml_zip_path`、`kml_backup_dir_name`、`output_filters`、`google_api_key`。Google Maps API key 的解析顺序：环境变量 `TRACKTOOL_GOOGLE_API_KEY` > `--api-key` 参数 > 配置文件。

## 实现说明

- exiftool 以 `-stay_open` 常驻进程通信（每线程一个），批量处理不必为每个文件启动一次进程
- 日志与标准输出里的路径按用户视角显示：优先相对当前工作目录（且至多向上一级），否则在家目录之下显示为 `~...`，再不然用绝对路径。写进文件的值（配置文件、哈希日志）不受影响，保持原样
- 并行处理使用线程池（I/O 密集负载）
- API key 支持环境变量注入，避免明文入库
