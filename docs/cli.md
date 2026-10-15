# CLI 使用说明（2.x）

以下沿用原有业务命令；新增程序接口见 [API](api.md)，安装与 Chromium 见 [升级说明](install-upgrade.md)。原有 undo 已退役，相关兼容参数不会恢复历史撤销功能。

## 快速上手

```bash
# 新建空归档；已有 ZIP 请改用 archive import-zip
tracktool archive init ~/tracks
tracktool config set archive_path ~/tracks

# 按轨迹给照片写入 GPS（已有 GPS 的跳过；失败文件移入 TrackPosFailed）
tracktool exif geotag ./photos --overwrite --failed-folder TrackPosFailed

# 一键修复缺失 GPSPosition/GPSAltitude 的媒体
tracktool exif repair ./VID

# 归档新轨迹（一次可给多条：SQLite 批量事务入库；默认把源文件收进归档的 Backup/，--keep 保留原件）
tracktool kml push ./2024-05-01\ 徒步.kml ./2024-05-02\ 徒步.kml

# 通配符由工具自己展开（只作用于最后一段路径，按路径序入库），PowerShell 里也能直接用
tracktool kml push "./tracks/2024-05-*.kml"

# 按最近的轨迹时间点拆成两段（这里是北京时间 14:30:00，不必与 when 完全一致）
tracktool kml split "./2024-05-01 徒步.kml" "2024-05-01T14:30:00+08:00"

# kml set-tag 同样吃通配符：整批交给批量入口，坏文件与没有 TrackTags 节点的派生文件计入失败，命令退 3
tracktool kml set-tag "./tracks/2024-05-*.kml" --tag 地铁

# 派生文件（split / 手绘）没有 TrackTags 节点，默认报失败；--create-tag 才把节点建出来写入
tracktool kml set-tag "./tracks/2024-05-*.kml" --tag 地铁 --create-tag

# --tag 只收活动名，且必须已在词表里；表外词会被拒绝并给出最近的词与加词的那条命令
tracktool config set track_tag.Train "+滑雪"

# kml type 打归档类别（Default/Train/Flight）；认不出来就打 Unknown，原因走日志
tracktool kml type ./2024-05-01\ 徒步.kml

# --raw 打 TrackTags 里存的原值——活动名本身，不是类别
tracktool kml type ./2024-05-01\ 徒步.kml --raw

# 通配符在进程内展开（按名排序）；一个文件只给裸值，多个文件每行「值<TAB>路径」，值留在第一列
tracktool kml type "./tracks/2024-05-*.kml"

# 默认把源文件收进归档的 Backup/（同路径同字节的归档成员幂等复用，也一并搬走）；
# Backup/ 里已有同内容的副本时，新那份副本清掉而不是留第二份，内容不同则两处都留并报警告；
# 想保留工作区原件就加 --keep
tracktool kml push ./2024-05-03\ 徒步.kml
tracktool kml push ./2024-05-03\ 徒步.kml --keep

# 日常操作后按需导出当前展示；原件、隐藏段和历史请另做 full-backup
tracktool kml download "2026-10-01 徒步" --output /downloads
tracktool --dry-run kml delete "2026-10-01 徒步"  # 查看范围与依赖
tracktool kml delete "2026-10-01 徒步"            # 删除条目及全部历史
tracktool archive status
tracktool archive backup
tracktool archive rebuild
# 中断后完成源文件搬移或已提交的旧文件操作
tracktool archive recover
```

`kml split` 按时间差选最近的轨迹点，距离相同时选较早的时间；支持 `Z` 和时区偏移，
不带时区时按 UTC 解释。选中的点归前一段，原文件保留，结果写入同目录的
`原名-Splited-1.kml`、`原名-Splited-2.kml`。多个切分时间落在同一点时只切一次；
如果最近的是最后一个轨迹点，会报错，避免生成空的后一段。

## 网页地图

运行 `tracktool-map`，地图编辑、项目、PNG 及其他页面的启动和操作见[网页使用说明](web-usage.md)。

## 库内行程编辑

`track` 命令操作 schema 4 中的版本化行程。默认内部断开仍是一个 KML；独立行程拆分须明确使用 split_journey。原有 `kml split/prune` 属于独立文件工具，不修改库内版本。`kml to-multigeom` 已移除，没有兼容别名；MultiGeometry 文件仍可正常读取。

```sh
tracktool track list --search '2026-10-01'
tracktool track show ENTRY_ID
tracktool track history ENTRY_ID
tracktool track preview edit.json --state-dir /数据/网页状态
tracktool track apply PREVIEW_ID --sha PREVIEW_SHA256 --state-dir /数据/网页状态
# 同一预览默认使用相同请求键，响应丢失时可重复上一条命令
tracktool track operation OPERATION_ID
```

以下是 edit.json 的内部断开示例。archive_id、target 各字段及 segment_id 从 `track show` 结果填写；target 只包含示例列出的字段，不包含路径、分类和状态。after_point_indices 从 0 开始，边界点属于左段。

```json
{
  "schema": 1,
  "archive_id": "轨迹库ID",
  "target": {
    "entry_id": "行程ID",
    "version_id": "当前版本ID",
    "presentation_id": "当前展示ID",
    "generation": 1,
    "sha256": "用实际64位小写十六进制SHA替换"
  },
  "sources": [],
  "operation": {
    "kind": "split_segment",
    "segment_id": "段ID",
    "after_point_indices": [120, 250]
  }
}
```

operation 还支持 prune（segment_id 和半开 ranges）、reverse（segment_id）、draw（after_segment_id、WGS84 coordinates，可明确吸附）、compose（按序 version_id/segment_id/reverse 和 default_connect）、presentation（完整 settings）、split_journey（每个输出 path/category/segment_ids）、restore_version（version_id/presentation_id）。完整契约见 [API](api.md) 和 `src/shared/track-edit.ts`。未知字段、重复/遗漏段、非法范围和倒向连接均拒绝。

整组撤销请求为 `{schema:1,archive_id,operation:{kind:"restore_group",operation_id,expected:[…]}}`，expected 从 `track operation` 各 effect.after 取出上述五个目标引用字段。全部成员仍与原操作结果一致才能撤销；生成的新行程保留为历史来源，原行程恢复活动状态。恢复历史版本同样先预览，不删除后续版本。

预览保存在状态目录的 tasks.sqlite3，24 小时有效，不改轨迹库；应用从该库读取并核验产物，不重新运行编辑算法。默认状态目录与配置文件同目录下的 web 一致；网页指定了 --state-dir 时，CLI 使用相同路径即可共用预览。`--archive` 可显式指定 CLI 的库，库身份必须匹配。`track preview --dry-run` 仅在内存准备，不保存预览；`track apply --dry-run` 只读检查已有清单，不提交。下载版本继续用 `kml download --entry-id ENTRY_ID --version VERSION_ID`。

## 目录比较与重复文件查找：使用 fclones

通用文件比较与去重交给 [fclones](https://github.com/pkolaczk/fclones)，tracktool 已移除 `hash dirs`、`hash compare`、`hash dupes` 和 `hash prune`。fclones 独立使用，不是 tracktool 的运行依赖；可从[官方 Releases](https://github.com/pkolaczk/fclones/releases) 下载，或参照[安装说明](https://github.com/pkolaczk/fclones#installation)安装。

下面的目录比较按**文件内容是否在另一目录存在**判断，忽略文件名、目录层级和副本数量。只修改 EXIF 也会造成内容差异；它不是按照片画面判断相似，也不检查目录结构是否相同。

以下命令已在 Linux、fclones 0.35.0 上验证。把示例路径换成实际绝对路径，任务缓存和报告都放在待比较目录之外：

```bash
XDG_CACHE_HOME="/path/to/compare-task-001" fclones group \
  --isolate --unique --hidden --no-ignore --min 0 \
  --hash-fn blake3 --cache \
  "/path/to/A" "/path/to/B" > "/path/to/compare-result.txt"
```

`--isolate --unique` 列出只在一边存在的内容，同一目录里的重复副本不会被当成另一边已有备份。`--hidden --no-ignore --min 0` 将隐藏文件、被忽略规则排除的文件和空文件纳入扫描。需要将硬链接和指向文件的符号链接也作为独立路径纳入时，加上 `--match-links --symbolic-links`。

缓存用于**同一次比较任务的中断恢复**：

- 开始新任务时使用全新的缓存目录，例如 `compare-task-001`；fclones 会自动创建内部缓存。
- 比较期间（包括中断等待恢复期间）保持两个输入目录不变。中断后保留缓存，重新执行相同命令，即可复用已保存的哈希。
- 文件修改后开始新比较，换用新的缓存目录，例如 `compare-task-002`。不要靠大小或修改时间判断旧缓存仍然有效，也不要复用旧的 `hash.json`。
- 恢复仍会遍历目录；尚未保存的结果可能重算，单个大文件的全文件哈希算到一半中断时，可能需要重读该文件。[官方缓存说明](https://github.com/pkolaczk/fclones#incremental-mode)

正常完成后，报告列出的路径就是另一边缺少对应内容的文件；没有读取错误且报告为 0 个差异文件，才表示按上述规则一致。fclones 遇到无法读取的文件可能警告并跳过，退出码仍为 0，因此要检查终端中的警告；有差异本身也不会使退出码变成非零。报告中的哈希字段不保证都是完整文件哈希，不要用它另建哈希清单，应直接使用分组结果。

只查找单个目录内的重复文件，可使用：

```bash
fclones group --hidden --no-ignore --min 0 --hash-fn blake3 \
  "/path/to/photos"
```

以上 `group` 命令只扫描和报告，启用 `--cache` 时另写缓存，不删除或改写输入文件。macOS、Windows 的缓存目录配置不同，`XDG_CACHE_HOME` 这段示例只适用于 Linux。

## 轨迹时间匹配

`exif geotag` 先按轨迹文件名中的日期筛选（`--multiday` 扩展到前后一天），再用轨迹首末时间加上允许误差排除不可能匹配的轨迹。剩余轨迹全部参与比较，选择与拍摄时刻时间差最小的实际记录点；`--max-time-diff` 默认为 60 秒，包含边界，也适用于轨迹中间断录的情况。

时间差相同，优先选覆盖拍摄时刻的轨迹，再按轨迹文件名、点的时间、纬度、经度和海拔升序决定，不依赖归档读取顺序。同一轨迹内两个点距离相同时保留原规则，选较晚的点。每条轨迹加载时建立一次时间索引供整批照片复用，并检查时间顺序；时间倒退的轨迹会提示并跳过，相同时间戳允许保留。这会增加少量索引内存，减少重复整理时间列表的计算；首次读取和解析 KML 仍然需要进行。

## 视频拍摄时区

`exif to-mp4` 和 `exif repair-vid` 使用同一套拍摄时区规则：

| 情况 | 默认行为（`--timezone-policy auto`） |
| --- | --- |
| 有有效拍摄时间，但没有显式时区 | 保持年月日时分秒，补 `+08:00`，或 `--offset-time` 指定的时区 |
| 已有显式时区，包括 `Z`、`+00:00`、`-00:00` | 保留文件不处理，提示用户选择 `keep` 或 `force`；退出码为 3 |
| 没有有效拍摄时间，或多个拍摄时间相互矛盾 | 保留文件并报告原因；矛盾时可用 `--time-source TAG` 明确选择时间来源 |

```bash
# 没有显式时区时补 +08:00；已有时区则跳过并提醒
tracktool exif to-mp4 ./videos

# 没有显式时区时补 +09:00；此参数单独使用不会覆盖已有时区
tracktool exif to-mp4 ./videos --offset-time +09:00

# 沿用已存储的时区及其表达的绝对时刻；缺时区仍使用默认值
tracktool exif to-mp4 ./videos --timezone-policy keep

# 保持钟面时间，强制替换为默认的 +08:00
tracktool exif to-mp4 ./videos --timezone-policy force

# 保持钟面时间，强制替换为 +09:00
tracktool exif to-mp4 ./videos --timezone-policy force --offset-time +09:00

# 时间字段相互矛盾时，明确采用其中一个
tracktool exif to-mp4 ./video.mp4 --timezone-policy keep --time-source XMP-exif:DateTimeOriginal
```

`force` 用来纠正误标：`12:00+00:00` 强制设为 `+08:00` 后是 `12:00+08:00`，不是保持同一时刻的 `20:00+08:00`。`keep` 信任已存储的偏移，即使它是零；不要仅凭偏移为零就判断它是误标。

转换读取 XMP、Keys、UserData、EXIF、H264 拍摄时间和 QuickTime 创建时间，保留时区是否显式记录的信息。QuickTime 整数时间本身不存独立的时区偏移；尽管规范按 UTC 解释，本工具在**没有显式时区可用时**按指定的拍摄时区解释它的钟面值。这是处理约定，不能自动判断相机原本是否正确使用了 UTC；若确定文件中的值是真正的 UTC，请用 `--offset-time +00:00`。

写入时，XMP/Keys 拍摄时间包含时区，QuickTime 创建时间及轨道/媒体创建时间规范化为 UTC，表达同一个时刻。明确的字符串拍摄时间优先；QuickTime 整数时间与它的 UTC 值或当地钟面值一致时可兼容读取，否则要求选择来源。`--time-source` 支持 `XMP-exif:DateTimeOriginal`、`Keys:CreationDate`、`UserData:DateTimeOriginal`、`ExifIFD:DateTimeOriginal`、`H264:DateTimeOriginal`、`XMP-xmp:CreateDate`、`QuickTime:CreateDate`、`Track1:TrackCreateDate`；它不会替代已有时区所需的 `keep`/`force` 选择。

`shift-time` 和 `to-mp4` 先读取整批文件并检查操作计划，再执行无冲突的文件。已有目标（包括目录和符号链接）、多个文件争用同一路径、改名目标也是另一个源文件、备份路径被目录或符号链接占用，都会在修改元数据前报错。冲突文件保留原状，其他文件继续，命令以 3 退出；`--dry-run` 使用同样的检查。已有普通 `_original` 备份继续保留，`--overwrite` 不允许覆盖其他同名媒体文件。

时间平移改名不增加临时视频副本。实际改名和新转换输出通过硬链接创建新名字后移除旧名字，目标若已存在就拒绝覆盖；文件系统不支持硬链接时会报错，不退回会覆盖文件的操作。预检查不能保证后续磁盘操作一定成功：如果元数据已修改、随后改名失败，文件保留在原路径，但已写入的元数据不会自动回滚。转换仍使用原有的临时输出与首次备份机制。

`to-mp4` 中待选择时区策略的文件同样不移动、不创建备份，其余文件继续。`repair-vid` 涉及整个 `VID` 目录改名，因此先检查目录内所有文件的时区和输出冲突；只要有文件尚不能处理，本次目录编排就以 3 退出，目录保持原状。重跑时，已有的普通输出文件按已完成转换跳过，目录和符号链接仍报冲突。补齐策略或解决冲突后可重新运行。

重复运行时，`auto` 会跳过已补好时区的文件，`keep` 保持原时刻，`force` 使用同一目标时区也不会累积偏移。转换保留首次创建的 `_original` 备份；已有备份不会被重复运行覆盖。

`exif shift-time --by` 接受按 `d/h/m/s` 顺序组合的整数时长，例如 `+1h30m`、`-2d`、`90m`、`0s`。可以省略某些单位，开头最多一个 `+` 或 `-`，不能含空白、小数、重复单位或其他字符。参数会在扫描及读取媒体文件之前校验，错误输入以 1 退出；空目录和预演同样检查。不传 `--by` 时仍可单独使用 `--offset-time`。

## 预演

`--dry-run` 是整次运行的模式，可写在业务子命令之前或之后，所有会改文件的命令都自动生效：

```bash
tracktool --dry-run kml push ./2024-05-01\ 徒步.kml
```

它照常读文件、照常做判断（因此能报出哪些文件会失败），只是把写入改成打印：一条条步骤列成表（`archive undo` 不走步骤表，逐条报「Would …」，`history.jsonl` 也不写一行），磁盘一个字节都不动。写在子命令之后会被当成用法错误退 1。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部成功 |
| 1 | 用户输入错误（路径不存在、通配符无匹配、坐标无法解析、配置或 KML 格式错误，以及命令或选项拼写错误） |
| 2 | 外部工具或 API 失败（exiftool 报错、Google 拒绝请求或超额） |
| 3 | 部分失败：逐文件隔离后仍有文件未处理完 |

命令名、选项拼写错误、缺必填参数都退 1；2 表示外部依赖失败。

表里的「KML 格式错误」只对单文件命令成立：批量命令（`kml push`、`kml set-tag`）把读不出来的那个文件当作它自己的失败，其余照常处理，命令整体退 3。1 保留给「整批还没开始」的情形——路径不存在、通配符无匹配、`--type` 或 `--tag` 取值非法（类别名不在 Default/Train/Flight 里，活动名不在词表里）。`archive undo` 同理：前提缺失、`archive_history` 关着，或归档已被未记账的改动推走时退 1、一个字节没动，`--force` 跳过项目或自校验不符时退 3。

批量命令遇到单个坏文件不会中止整批：该文件计入失败清单，其余文件照常处理，命令以 3 退出，日志里给出 `N file(s) failed` 汇总。指定 `--failed-folder` 后，会在处理前检查失败目录及同名目标。真实执行会提前创建目录，并创建、删除一个空临时文件检查写入能力，因此没有失败时也可能留下空目录；预演只做只读检查。任一失败目录不可用时，停用本批次的自动整理并提示，主任务继续；同名目标只影响对应文件的整理，保留双方。执行中移动失败会同时记录处理原因和整理错误，并继续后续文件；只在实际移动成功后报告移动位置。修复编排不会把留在原处的失败文件归入成功目录。

`kml push` 与修复编排（`repair`）都把整个文件列表交给批量入口，因此一次 Google 高程请求可覆盖最多 512 个坐标；`exif geotag` 按拍摄时间窗只加载解析归档里相关月份的轨迹（±1 天 multiday 跨月也覆盖）。入库时 SQLite 对整批执行一个事务，源文件移动通过短期日志恢复；ZIP/集合另行导出。

## 配置

配置文件放在各平台自己的用户配置目录里，文件名统一是 `config.json`：Windows 用 `%APPDATA%\tracktool\`（Roaming，变量缺席时退回 `~\AppData\Roaming\tracktool\`），macOS 用 `~/Library/Application Support/tracktool/`，其余系统用 `$XDG_CONFIG_HOME/tracktool/`（取值未设或**不是绝对路径**时退回 `~/.config/tracktool/`——XDG 规范要求忽略相对值）。放在用户目录而不是项目里，是因为设置对工具是全局的：从照片文件夹里跑和从项目根跑必须读到同一份。

字段：`log_level`、`archive_path`、`archive_history`、`kml_backup_dir_name`、`output_filters`、`google_api_key`，以及三个活动词表 `track_tag.Default`、`track_tag.Train`、`track_tag.Flight`。`archive_path` 指向包含 `archive.sqlite3` 的**归档目录**；新库通过 `archive init` 创建，旧 ZIP 通过 `archive import-zip` 导入。路径打错不会静默建立新库。配置文件原先住在项目根的 `config.json`：新位置为空而旧位置有文件时，第一次加载就把它搬过去——先把完整一份写到新位置，确认落盘后再删旧文件，并在日志里报出落点；旧文件删不掉（被占用、权限不足）只留下一份过时的副本，新位置照常生效，此时另警告一句让你手工删。旧键 `kml_zip_path`（ZIP 文件）读到时会平移为所在目录的 `archive_path`。两类迁移都在正常运行里回写，`--dry-run` 只在内存中转换，所有文件保持原样。`archive_history` 作为旧配置保留，但不再记录长期历史或启用 undo；设置时会明确提示。Google Maps API key 的解析顺序：环境变量 `TRACKTOOL_GOOGLE_API_KEY` > `--api-key` 参数 > 配置文件。

`track_tag.<类别>` 是活动词表：KML 里的 `TrackTags` 存的是 2bulu 的活动名（徒步、地铁），归档类别（集合文件名 `Train.kml`、ZIP 条目前缀 `Train/`、`kml push --type` 的取值域）由这张表查出来。用 `tracktool config set` 增删：

```bash
tracktool config set track_tag.Train "+滑雪"        # 加进 Train，并自动从其他类别里摘掉
tracktool config set track_tag.Train "-缆车"        # 从 Train 里删掉；删不改动其他类别
tracktool config set track_tag.Default "徒步,爬山"  # 不带符号 = 整表替换
```

一个活动只能属于一个类别，所以加词时会从其他类别里摘掉，改名归类都是一条命令；幂等，重复执行同一指令不会累积。命令报出的是这一类改完之后的样子，不是敲进去的那段词。同一个词出现在两个类别、类别名拼错、列表里出现空名字都会报错而不是静默忽略——每一种都会让「这条轨迹属于哪一类」失去唯一答案。词表是唯一的判据：加进去的词立刻被 `kml set-tag --tag` 接受，并被 `kml type` 判读成它所属的类别。

## SQLite 归档与导出

完整操作和结构说明见 [SQLite 存储文档](sqlite-storage.md)：无损原始对象、分类与活动标签、文件名日期与实际时间、事务/连接/线程模型、短期移动日志、索引序列化及数据库迁移。

```bash
tracktool archive import-zip /old/Archive.zip /new/tracks
tracktool config set archive_path /new/tracks
tracktool kml push "2026-10-01 徒步.kml" --keep
tracktool kml download "2026-10-01 徒步" --output /downloads
tracktool --dry-run kml delete "2026-10-01 徒步"  # 查看范围与依赖
tracktool kml delete "2026-10-01 徒步"            # 删除条目及全部历史
tracktool archive status
tracktool archive backup              # 当前活动 KML → Archive.zip（不含历史）
tracktool archive full-backup --output /backup/tracks.sqlite3
tracktool archive restore-backup /backup/tracks.sqlite3 /fresh/tracks
tracktool archive migrate             # 完整备份后显式升级 schema 4
tracktool archive rebuild             # SQLite → 聚合 KML
tracktool archive recover             # 完成中断文件操作
```

当前版本、默认展示或状态变化使日常导出过期；历史来源和项目变化通过 storage_revision 使完整备份过期，解析缓存不影响修订。push/delete 不改 ZIP/集合。`--zip` 保留为所在目录的定位方式，ZIP 本身可以不存在；不作为另一个可修改的真源。

`archive undo` 已退休，会明确报错并提示替代操作：download 下载当前原字节，recover 完成中断，或把旧备份 ZIP 导入另一个新目录。`archive log` 仅查看保留的旧 history.jsonl。schema 3/4 的 ZIP 包含当前可见段及连接线，导入只恢复这份展示结果；无法解析的旧成员以原字节保留并警告。恢复原件、隐藏段、项目、版本和内部 ID 请使用 full-backup / restore-backup。两种方式都不包含瓦片或配置。

`kml download` 不修改归档，默认下载当前版本完整原字节；`--entry-id` 可定位非活动来源条目，`--version` 指定该条目的历史版本，`--output` 为目录且不覆盖已有文件。`kml delete` 需要 schema 4；预览和执行都检查项目、来源与待恢复操作依赖，删除只清理无引用对象。没有 pop 命令或兼容别名。已有下载和备份保留，已删除历史只能从之前的完整备份恢复。

### 按展示导出 KML

```sh
tracktool track export ENTRY_ID --archive /tracks --output /exports/trip.kml
tracktool track export ENTRY_ID --version VERSION_ID --presentation PRESENTATION_ID --output /exports/history.kml
```

导出可见段、补绘及启用的连接线，保留实测时间、高程、样式和扩展字段。目标是文件，不覆盖已有目标；`--dry-run` 校验并计算输出但不创建文件。历史版本省略 `--presentation` 时使用该版本第一份展示快照；当前版本默认使用当前快照。原字节请用 `kml download`，完整历史用 `archive full-backup`。网页出图项目的“导出展示 KML”包含该项目的独立覆盖。

`archive backup` 保留原命令名，用于当前库默认展示 ZIP；`archive rebuild` 生成桌面和手机集合。两者不套用任何项目私有覆盖。导出的 Tracktool 元数据记录来源种类、段顺序和显式连线；再次导入时连接线不会成为实测采样，也不会重复补线。

旧成果重组也通过 `track preview REQUEST.json` / `track apply`，请求 operation.kind 为 `legacy_regroup`，具体字段见 [API](api.md)。候选需明确完整成员、段顺序、新路径、相同分类和依据；不会按名称自动归组。使用同一持久预览和组级撤销；希望重做时可撤销上一次组级撤销操作，复用原输出，不必创建同名新条目。
