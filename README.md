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

## 配置

配置文件位于 `~/.tracktool/config.json`，字段：`log_level`、`kml_zip_path`、`kml_backup_dir_name`、`output_filters`、`google_api_key`。Google Maps API key 的解析顺序：环境变量 `TRACKTOOL_GOOGLE_API_KEY` > `--api-key` 参数 > 配置文件。

## 实现说明

- exiftool 以 `-stay_open` 常驻进程通信（每线程一个），批量处理不必为每个文件启动一次进程
- 并行处理使用线程池（I/O 密集负载）
- API key 支持环境变量注入，避免明文入库
