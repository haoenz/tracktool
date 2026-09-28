# tracktool

旅行影像地理数据工具集：KML 轨迹管理与照片/视频 EXIF 地理标记。

## 功能

- **KML 轨迹管理**：归档（ZIP 真值分层存储 + 桌面/手机双汇总视图 + 备份）、视图状态检查与重建、拆分、删坏点、合并、Google 高程回填（只认整轨没有高程的手绘轨迹）
- **EXIF 地理标记**：按拍摄时间与 KML 轨迹二分匹配写入 GPS、Google 高程/逆地理编码补全、时间平移、海拔偏移、MP4 转封装、媒体分类、缺失修复编排
- **文件去重**：MD5 哈希日志、重复文件查找、目录对比

## 安装

```bash
uv tool install .        # 或 pip install .
```

依赖外部工具：[exiftool](https://exiftool.org/)、ffmpeg（`to-mp4` 需要）。

## 快速上手

```bash
# 首次使用：声明归档目录（并对 config.json 里的 archive_path 生效）
tracktool archive init ~/tracks

# 按轨迹给照片写入 GPS（已有 GPS 的跳过；失败文件移入 TrackPosFailed）
tracktool exif geotag ./photos --overwrite --failed-folder TrackPosFailed

# 一键修复缺失 GPSPosition/GPSAltitude 的媒体
tracktool exif repair ./VID

# 归档新轨迹（一次可给多条：聚合与压缩包各读写一次）
tracktool kml push ./2024-05-01\ 徒步.kml ./2024-05-02\ 徒步.kml
```

## 预演

`--dry-run` 是整次运行的模式，写在子命令**之前**，所有会改文件的命令都自动生效：

```bash
tracktool --dry-run kml push ./2024-05-01\ 徒步.kml
```

它照常读文件、照常做判断（因此能报出哪些文件会失败），只是把写入改成打印：一条条步骤列成表，磁盘一个字节都不动。写在子命令之后会被当成用法错误退 1。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部成功 |
| 1 | 用户输入错误（路径不存在、坐标无法解析、配置或 KML 格式错误，以及命令或选项拼写错误） |
| 2 | 外部工具或 API 失败（exiftool 报错、Google 拒绝请求或超额） |
| 3 | 部分失败：逐文件隔离后仍有文件未处理完 |

命令名、选项拼写错误、缺必填参数都退 1：typer 内部把这类用法错误记作 2，与「外部工具/API 失败」同值，入口处已把这一来源归一到 1，因此 **2 只表示外部依赖失败**。

批量命令遇到单个坏文件不会中止整批：该文件计入失败清单（给了 `--failed-folder` 就移入该目录），其余文件照常处理，命令以 3 退出，日志里给出 `N file(s) failed` 汇总。`kml push` 与修复编排（`repair`）都把整个文件列表交给批量入口，因此一次 Google 高程请求可覆盖最多 512 个坐标，KML 归档只加载解析一次，进档 N 条轨迹也只读写一次聚合与压缩包。

## 配置

配置文件是项目根目录的 `config.json`，字段：`log_level`、`archive_path`、`kml_backup_dir_name`、`output_filters`、`google_api_key`。`archive_path` 指向**归档目录**；归档是声明出来的——目录里要有 `archive.json` 身份文件，只有 `tracktool archive init` 能创建它（对已有归档文件的目录补办身份即可收编），其余命令碰到没有身份文件的目录一律报错，路径打错不会静默多出第二份归档。配置里读到旧键 `kml_zip_path` 时会在加载时自动平移为所在目录的 `archive_path` 并回写。Google Maps API key 的解析顺序：环境变量 `TRACKTOOL_GOOGLE_API_KEY` > `--api-key` 参数 > 配置文件。

## 归档：真值与视图

ZIP 压缩包是归档的**真值**，条目按 `<类型>/<yyyy-MM>/<文件名>` 分层存放（认不出类型的进 `_unclassified/`，不猜）。桌面 `<类型>.kml` 与手机 `<类型>.Mobile.kml` 是由真值派生的**视图**：

- `tracktool archive status` 报告视图与真值是否一致。`archive.json`（version 2）记着上次视图与真值同步时 ZIP 的指纹，真值一动指纹就对不上；`kml push` 在视图本来就同步的前提下会顺带前移指纹，本来落后就如实报落后。
- `tracktool archive rebuild` 从真值全量再生两个视图并刷新指纹——视图坏了、落后了都能修，不需要从备份倒腾。

## 实现说明

- exiftool 以 `-stay_open` 常驻进程通信（每线程一个），批量处理不必为每个文件启动一次进程
- 日志与标准输出里的路径按用户视角显示：优先相对当前工作目录（且至多向上一级），否则在家目录之下显示为 `~...`，再不然用绝对路径。写进文件的值（配置文件、哈希日志）不受影响，保持原样
- 并行处理使用线程池（I/O 密集负载）
- `kml fill-altitude` 只补**整轨都没有高程**的轨迹（手绘规划那种）。KML 里一条轨迹＝一个 Placemark，判据是**逐条**的：一条轨迹上只要有一个点带非零海拔，这条就整条不写（那是设备记录的真实高程，不该被 DEM 值替换），同一份文件里的手绘轨迹照补；零海拔与缺分量同义，都算没有。媒体侧的 `exif fill-altitude` 则是逐文件地只补缺失标签
- API key 支持环境变量注入，避免明文入库

## 测试

```bash
uv run pytest                       # 全部（含真实 exiftool / ffmpeg 的集成用例）
uv run pytest -m "not integration"  # 只跑内存替身，不碰外部工具
```

需要真实工具的用例打 `integration` 标记（`tests/test_e2e.py` 走完整链路：ffmpeg 造样本、exiftool 读写、轨迹从 ZIP 归档读出），工具缺席时自动跳过。`MetadataBackend` 的两套实现（真实 exiftool 与内存替身）跑同一份断言（`tests/fixtures/backend_contract.py`），替身因此不能与真身漂移。
