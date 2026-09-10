# tracktool

旅行影像地理数据工具集：KML 轨迹管理与照片/视频 EXIF 地理标记。PowerShell 模块 `tracktool` 的 Python 重写版。

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
# 从旧 PowerShell 模块迁移配置
tracktool config import "C:\Users\yiyan\Documents\PowerShell\Modules\tracktool\config.json"

# 按轨迹给照片写入 GPS（已有 GPS 的跳过；失败文件移入 TrackPosFailed）
tracktool exif set-position ./photos --overwrite --failed-folder TrackPosFailed

# 一键修复缺失 GPSPosition/GPSAltitude 的媒体
tracktool exif resolve-missing ./VID

# 归档一条新轨迹
tracktool kml push ./2024-05-01\ 徒步.kml
```

## 命令对照（PowerShell → Python CLI）

| PowerShell | CLI |
|---|---|
| Get-KmlType / Set-KmlType | `tracktool kml type [PATH] [--set TYPE]` |
| Push-KmlArchive | `tracktool kml push PATH` |
| Pop-KmlArchive | `tracktool kml pop NAME` |
| Split-Kml | `tracktool kml split PATH POINT...` |
| Remove-KmlBadPoints | `tracktool kml remove-bad PATH POINT...` |
| Merge-Kml | `tracktool kml merge PATH... -o OUT [--connected]` |
| Convert-KmlToMultiGeometry | `tracktool kml to-multigeom PATH` |
| Set-KmlAltitudeFromGoogle | `tracktool kml set-altitude PATH` |
| Set-Exif | `tracktool exif set PATH [-p POS] [-a ALT] [-t TAG=V]` |
| Write-MediaInfo | `tracktool exif info FILE` |
| Find-MissingTag | `tracktool exif find-missing PATH TAG...` |
| Set-PositionFromKml | `tracktool exif set-position PATH` |
| Set-ExifAltitudeFromGoogle | `tracktool exif set-altitude PATH` |
| Set-ExifLocationFromGoogle | `tracktool exif set-location PATH` |
| Move-ExifTime | `tracktool exif move-time PATH --time-diff +1h30m` |
| Move-Altitude | `tracktool exif move-altitude PATH OFFSET` |
| ConvertTo-Mp4 | `tracktool exif to-mp4 PATH` |
| Group-MediaFiles | `tracktool exif group PATH` |
| Resolve-MissingGPS | `tracktool exif resolve-missing PATH` |
| Resolve-VIDExif | `tracktool exif resolve-vid PATH` |
| Get-AltitudeFromGoogle | `tracktool google altitude LAT,LON...` |
| Get-LocationFromGoogle | `tracktool google location LAT,LON` |
| Compare-Directories | `tracktool hash compare DIR... [--unique]` |
| Find-DuplicateFiles | `tracktool hash dupes DIR` |
| Get-DirectoriesHash | `tracktool hash dirs DIR...` |
| Clear-HashLog | `tracktool hash clear-log LOG` |
| Set-LogLevel | `tracktool config log-level LEVEL` |
| Set-KmlCompressedFilePath | `tracktool config set-zip-path PATH` |

未移植：`Resolve-FolderExif`（原代码标注"尚未完成"，依赖 Android `getprop`）。

## 配置

配置文件位于 `~/.tracktool/config.json`，字段与旧版一致。Google Maps API key 的解析顺序：环境变量 `TRACKTOOL_GOOGLE_API_KEY` > `--api-key` 参数 > 配置文件。

## 相对 PowerShell 版的改进

- exiftool 以 `-stay_open` 常驻进程通信（每线程一个），批量处理不再为每个文件启动一次进程
- 并行处理改为线程池（I/O 密集），替代原 runspace 函数序列化注入机制
- API key 支持环境变量注入，避免明文入库
