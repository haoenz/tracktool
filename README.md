# tracktool

旅行影像地理数据工具集：KML 轨迹管理与照片/视频 EXIF 地理标记。

## 功能

- **KML 轨迹管理**：归档（ZIP 真值分层存储 + 桌面/手机双汇总视图 + 备份）、视图状态检查与重建、拆分、删坏点（手动两点 + `--auto` 自动清漂移）、合并、Google 高程回填（只认整轨没有高程的手绘轨迹）
- **EXIF 地理标记**：按拍摄时间与 KML 轨迹二分匹配写入 GPS、Google 高程/逆地理编码补全、时间平移、海拔偏移、MP4 转封装、媒体分类、缺失修复编排

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

# 归档新轨迹（一次可给多条：聚合按批读写，ZIP 按批安全更新；默认把源文件收进归档的 Backup/，--keep 保留原件）
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

# 默认把源文件收进归档的 Backup/（归档里已有的轨迹按名判重跳过，也一并搬走）；
# Backup/ 里已有同内容的副本时，新那份副本清掉而不是留第二份，内容不同则两处都留并报警告；
# 想保留工作区原件就加 --keep
tracktool kml push ./2024-05-03\ 徒步.kml
tracktool kml push ./2024-05-03\ 徒步.kml --keep

# 每次改动归档的命令都记一笔；archive log 看最近几条，archive undo 撤回最近一条
tracktool archive log
tracktool archive undo
```

`kml split` 按时间差选最近的轨迹点，距离相同时选较早的时间；支持 `Z` 和时区偏移，
不带时区时按 UTC 解释。选中的点归前一段，原文件保留，结果写入同目录的
`原名-Splited-1.kml`、`原名-Splited-2.kml`。多个切分时间落在同一点时只切一次；
如果最近的是最后一个轨迹点，会报错，避免生成空的后一段。

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

`--dry-run` 是整次运行的模式，写在子命令**之前**，所有会改文件的命令都自动生效：

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

命令名、选项拼写错误、缺必填参数都退 1：typer 内部把这类用法错误记作 2，与「外部工具/API 失败」同值，入口处已把这一来源归一到 1，因此 **2 只表示外部依赖失败**。

表里的「KML 格式错误」只对单文件命令成立：批量命令（`kml push`、`kml set-tag`）把读不出来的那个文件当作它自己的失败，其余照常处理，命令整体退 3。1 保留给「整批还没开始」的情形——路径不存在、通配符无匹配、`--type` 或 `--tag` 取值非法（类别名不在 Default/Train/Flight 里，活动名不在词表里）。`archive undo` 同理：前提缺失、`archive_history` 关着，或归档已被未记账的改动推走时退 1、一个字节没动，`--force` 跳过项目或自校验不符时退 3。

批量命令遇到单个坏文件不会中止整批：该文件计入失败清单，其余文件照常处理，命令以 3 退出，日志里给出 `N file(s) failed` 汇总。指定 `--failed-folder` 后，会在处理前检查失败目录及同名目标。真实执行会提前创建目录，并创建、删除一个空临时文件检查写入能力，因此没有失败时也可能留下空目录；预演只做只读检查。任一失败目录不可用时，停用本批次的自动整理并提示，主任务继续；同名目标只影响对应文件的整理，保留双方。执行中移动失败会同时记录处理原因和整理错误，并继续后续文件；只在实际移动成功后报告移动位置。修复编排不会把留在原处的失败文件归入成功目录。

`kml push` 与修复编排（`repair`）都把整个文件列表交给批量入口，因此一次 Google 高程请求可覆盖最多 512 个坐标；`exif geotag` 按拍摄时间窗只加载解析归档里相关月份的轨迹（±1 天 multiday 跨月也覆盖）。入库时集合按批读写，ZIP 对整批执行一次追加和发布。

## 配置

配置文件放在各平台自己的用户配置目录里，文件名统一是 `config.json`：Windows 用 `%APPDATA%\tracktool\`（Roaming，变量缺席时退回 `~\AppData\Roaming\tracktool\`），macOS 用 `~/Library/Application Support/tracktool/`，其余系统用 `$XDG_CONFIG_HOME/tracktool/`（取值未设或**不是绝对路径**时退回 `~/.config/tracktool/`——XDG 规范要求忽略相对值）。放在用户目录而不是项目里，是因为设置对工具是全局的：从照片文件夹里跑和从项目根跑必须读到同一份。

字段：`log_level`、`archive_path`、`archive_history`、`kml_backup_dir_name`、`output_filters`、`google_api_key`，以及三个活动词表 `track_tag.Default`、`track_tag.Train`、`track_tag.Flight`。`archive_path` 指向**归档目录**；归档是声明出来的——目录里要有 `archive.json` 身份文件，只有 `tracktool archive init` 能创建它（对已有归档文件的目录补办身份即可收编），其余命令碰到没有身份文件的目录一律报错，路径打错不会静默多出第二份归档。它原先住在项目根的 `config.json`：新位置为空而旧位置有文件时，第一次加载就把它搬过去——先把完整一份写到新位置，确认落盘后再删旧文件，并在日志里报出落点；旧文件删不掉（被占用、权限不足）只留下一份过时的副本，新位置照常生效，此时另警告一句让你手工删。旧键 `kml_zip_path`（ZIP 文件）读到时会平移为所在目录的 `archive_path`。两类迁移都在正常运行里回写，`--dry-run` 只在内存中转换，所有文件保持原样。`archive_history`（默认 `true`）控制归档记账与撤回，代价见「归档撤回」一节。Google Maps API key 的解析顺序：环境变量 `TRACKTOOL_GOOGLE_API_KEY` > `--api-key` 参数 > 配置文件。

`track_tag.<类别>` 是活动词表：KML 里的 `TrackTags` 存的是 2bulu 的活动名（徒步、地铁），归档类别（集合文件名 `Train.kml`、ZIP 条目前缀 `Train/`、`kml push --type` 的取值域）由这张表查出来。用 `tracktool config set` 增删：

```bash
tracktool config set track_tag.Train "+滑雪"        # 加进 Train，并自动从其他类别里摘掉
tracktool config set track_tag.Train "-缆车"        # 从 Train 里删掉；删不改动其他类别
tracktool config set track_tag.Default "徒步,爬山"  # 不带符号 = 整表替换
```

一个活动只能属于一个类别，所以加词时会从其他类别里摘掉，改名归类都是一条命令；幂等，重复执行同一指令不会累积。命令报出的是这一类改完之后的样子，不是敲进去的那段词。同一个词出现在两个类别、类别名拼错、列表里出现空名字都会报错而不是静默忽略——每一种都会让「这条轨迹属于哪一类」失去唯一答案。词表是唯一的判据：加进去的词立刻被 `kml set-tag --tag` 接受，并被 `kml type` 判读成它所属的类别。

## 归档：真值与视图

ZIP 压缩包是归档的**真值**，条目按 `<类型>/<yyyy-MM>/<文件名>` 分层存放。类型不看目录、只看轨迹自己的 `TrackTags`：活动名查词表得到类别，表里没有的词一律进 `_unclassified/`，不猜。桌面 `<类型>.kml` 与手机 `<类型>.Mobile.kml` 是由真值派生的**视图**：

- `tracktool archive status` 报告视图与真值是否一致，并把「分层之前写下的扁平条目里，哪些的 TrackTags 认不出来」按值汇总一行（每个值只说一次）。`archive.json`（version 2）记着上次视图与真值同步时 ZIP 的哈希，真值一动哈希就对不上；`kml push` 与 `kml pop` 在视图本来就同步的前提下会顺带前移哈希，本来落后就如实报落后。
- `tracktool archive rebuild` 从真值全量再生两个视图并刷新哈希——视图坏了、落后了都能修，不需要从备份倒腾。真值里已经一条不剩、视图文件却还在的类型，视图会被清空：视图不能留着真值里没有的轨迹。从来就没有过视图的类型仍然不新建。放不进任何视图的条目照旧跳过，其中扁平条目里认不出值的那些同样按值汇总。

`kml push` 和 `kml merge` 的入库会先把旧 ZIP 复制到同目录临时文件，在临时文件上追加整批新条目，完成 CRC 校验和文件同步后再原子替换。替换前发生异常或进程被强制结束，旧 ZIP 保持原样；重复条目全部跳过时不复制、不替换。代价是额外容纳一份新 ZIP 的空间、一次旧 ZIP 复制和整包校验，不重新压缩旧条目。普通失败清理临时文件，强制结束可能留下 `.Archive.zip.*.tmp`；重跑使用新的临时文件。这个保护以 ZIP 为边界，失败前可能已更新集合，必要时用 `archive rebuild` 从保留的 ZIP 恢复视图。`Backup/` 仍保存 KML 源文件，不是历史 ZIP 副本。

`kml merge --output` 必须指定尚不存在的新文件路径。已有文件、目录、符号链接（含悬空链接）、输入文件的硬链接或路径别名，以及归档 ZIP/manifest/集合路径，均在写入前拒绝；`--dry-run` 执行同样检查。合并结果先写临时文件，再通过硬链接创建目标名称，期间出现同名目标也不会覆盖；文件系统不支持硬链接时安全报错。源轨迹整批归档成功后，源文件默认移入 `Backup/`（`--keep` 保留原位）。

`kml pop` 接受完整文件名或完整名称（不含 `.kml`），不再按子串查找。例如 `tracktool kml pop '2024-05-01 行程.kml' --type Train` 只选择 Train 类型。**不指定 `--type` 就在 ZIP 的全部条目里找**，命中哪一条就按哪一条自己的类型去查两个视图——分层条目以类型目录为准，旧版扁平条目按 `TrackTags` 查词表确认类型，表外的词不会自动当作 Default。所以同一文件名在两种类型下是两条不同的轨迹，跨类型重名在任何修改前拒绝，须用 `--type` 指定（提示语附在报错里）；`_unclassified/` 里以及词表认不出类型的扁平条目没有任何视图持有，不指定 `--type` 时只解压到当前目录、不动视图。同一类型匹配多个 ZIP 条目，或集合中同名记录不唯一时同样在任何修改前拒绝，`--force` 也不能绕过歧义；提取和两个集合的删除均使用同一个已解析名称。

## 归档撤回：`archive undo`

`kml push` / `kml pop` / `kml merge` 每动一次真值，就往归档目录里的 `history.jsonl` 追一行，记下这次**真的**落盘了什么：加进去与删掉的条目路径、搬进 `Backup/` 收走的每对位置（原位与 `Backup/` 里的；与 `Backup/` 里那份同内容而被清掉的副本同样记一对——它确实离开了原位，撤回也要能把它还回来）、`pop` 解压出来的那个文件，以及改动前后的 ZIP 哈希。视图一个字都不记——它们由真值派生，撤回结尾那次 `rebuild` 就把它们带回与真值一致的样子。

```bash
tracktool archive log              # 最近 10 条，倒序：#id / 时刻 / 命令 / 改动 / 待撤或已撤
tracktool archive log --last 50
tracktool archive undo             # 撤回最近一条
tracktool archive undo --steps 2   # 撤回最近两条，只 rebuild 一次
tracktool --dry-run archive undo   # 预演：逐条报出要动的每一步，磁盘一个字节不动
```

`archive undo` 先把每一条的前提全查一遍，全通过才动手；动手顺序只有一条纪律——**先造副本，后消耗副本**：文件先还原到位，再删归档里那份，中途断掉留下的是多一份副本，不是少一份。日志记的是实际落盘的条目而不是命令行：`kml push a b` 里 b 早已在归档时，撤回只摘掉 a，b 那条是上一次 push 的成果。整批判重的 push 什么都没动，也照样占一条记录。

任一条前提没了就整条拒绝退 1，此时一个字节都没动、记录仍是待撤，把占住位置的东西挪走再跑一次即可；`--force` 跳过这些项，已经动过手的改动不回滚，命令退 3，没撤成的项写进那条 tombstone 的 `not_undone`，`archive log` 相应显示 `partial`。两种前提各缺不得：`pop` 解压出来的那个文件（缺或内容被改 → 那条 pop 永久撤不回来，它是这条轨迹唯一的一份）、还原时源位置不能被占用（被占 → 条目保留不删）。被搬进 `Backup/` 的那份文件**不是前提**：`Backup/` 是近期暂存，手工清空后还原材料改用同一笔 push 落下的 ZIP 条目——push 存的是原样字节，解压回去与搬回实物等价。归档已经被没记账的改动推走时，`undo` 一律拒绝——哈希校验让它退化成「拒绝」，而不是撤错。

`config set archive_history false` 把整个功能关掉：`kml push` / `kml pop` / `kml merge` 照常改归档，但一行也不记，`archive undo` 直接拒绝退 1（`--dry-run` 也照拒——这是命令的结论，不是一个字节的差别）。关掉期间发生的改动不在账上，那段空档就撤不回来：`--steps` 跨过它会被哈希校验拒绝退 1，而只撤空档之后那些记录（`--steps 1`）仍然成立、也仍然自校验通过。重新打开后新改动照记可撤；已有的 `history.jsonl` 不会被动，关掉只是让它停止增长，`archive log` 也照读不误（末尾提醒一句记账已停）。

日志是撤回的能力，不是备份：`history.jsonl` 丢了等于没有可撤的记录（不报错）。ZIP 丢了 `undo` 救不回来——那要靠归档目录自己的备份；`Backup/` 清空则不碍撤回，条目本身就是还原材料。

## Python 只读轨迹数据接口

`tracktool.kml.trackdata` 提供数值数据提取，供后续绘图使用：

```python
from pathlib import Path
from tracktool.kml.trackdata import read_track_data, track_data_from_tree
from tracktool.kml import xmlutil

data = read_track_data(Path("2024-05-01 徒步.kml"))
# 也可复用已解析的 lxml ElementTree；source 是可选的来源/错误定位标签
tree = xmlutil.parse_file(Path("2024-05-01 徒步.kml"))
data = track_data_from_tree(tree, source="2024-05-01 徒步.kml")

print(data.source, data.name, data.track_tags, data.start_name, data.end_name)
for track in data.tracks:
    print(track.index, track.placemark_id, track.name)
    for segment in track.segments:
        longitude, latitude = segment.longitude, segment.latitude
        print(segment.kind, len(longitude), longitude[0], latitude[0])
        # longitude[i] / latitude[i] / altitude[i] / time_us[i] 对应同一点
        # 每个 segment 是独立线段，遍历时保留边界
```

返回 `KmlTrackData → TrackFeature → TrackSegment`。每个含线状几何的 Placemark 对应一个 feature，`index` 是它在全部 Placemark 中从 1 开始的序号，名称/ID 缺失或重名时也能定位；每个 `gx:Track` 或 `LineString` 对应一个 segment，保留 `kind` 和原几何的 `geometry_id`。支持多 Placemark、多 Track，以及嵌套 `MultiGeometry` / `gx:MultiTrack`；即使启用了 `gx:interpolate` 也保留段边界。文件名/来源保存在 `source`，Document 名称保存在 `name`；`track_tags`、`start_name`、`end_name` 沿用 Document/ExtendedData 中 `TrackTags`、`PosStartName`、`PosEndName` 的读取规则（去掉首尾空白），缺失为 `""`。活动标签保留原值，不映射归档类别。

- 经纬度是 64 位浮点 `array('d')`；海拔存在时也使用 `array('d')`，保留原始数值。整段没有海拔时 `altitude is None`；部分点缺失时对应值为 NaN，可用 `math.isnan(segment.altitude[i])` 判断，显式 `0`（含 `-0.0`）保留为零。
- 整段没有时间时 `time_us is None`；否则为有符号 64 位整数 `array('q')`，单位为自 **1970-01-01 00:00:00 UTC** 起的微秒。接受完整的 `YYYY-MM-DDTHH:MM:SS[.fraction]Z` 或带 `±HH:MM` 偏移的时间，按 UTC 换算；不猜测缺失时区，超过 6 位的小数秒截掉尾数、不四舍五入。逐点 datetime 仅在转换时临时使用，不留在结果中。
- 坐标和时间仅在各自 `gx:Track` 内按下标对应（也兼容历史 `gx:when`）。无时间路线正常返回；只要有时间节点，其数量必须等于本段坐标数，每个时间都必须有效。空时间、格式错误、数量不符、非法/非有限数值、越界经纬度、空线段或没有线状轨迹都抛出 `UserInputError`，尽可能给出来源、Placemark、线段和从 1 开始的点序号。

输入使用带命名空间的 KML XML 树；Point、Polygon 等非线状几何不提取，单点线段照原样保留。接口不排序、去重、清漂移、连接线段、简化、转换坐标系，也不要求时间单调。不修改源文件或 XML 树，不写配置、归档或隐式缓存；返回数组归调用方所有，可以修改。此接口不提供绘图、GeoJSON、CLI 或归档读取功能，现有照片定位、合并和集合生成仍使用原逻辑。

每点数组数据区仅经纬度占 16 字节，加海拔占 24 字节，再加时间占 32 字节：10,000 点分别为 160,000 / 240,000 / 320,000 字节（不含数组容量余量、容器和 XML 树）。解析仍使用现有完整 XML 树；提取时逐点追加数组，不先建立全量逐点字典/对象列表。

## Python 只读归档访问接口

`tracktool.kml.archive_reader.open_archive` 接受显式 **ZIP 文件路径**（`str` 或 `Path`，不是归档目录），沿用现有 `--zip` 路径规则：展开 `~`、解析相对路径，其父目录必须有 `archive.json` 身份文件。显式 ZIP 路径优先于 manifest 中的 ZIP 名称，只检查身份文件存在，不读取配置，也不初始化归档。

```python
from pathlib import Path
from tracktool.kml.archive_reader import open_archive

with open_archive(Path("/path/to/archive/Archive.zip")) as archive:
    entries = archive.list_entries()
    for entry in entries:
        print(entry.path, entry.name, entry.kind)

    # 使用列表中的完整路径精确选择；同名文件可按不同目录分别读取
    data = archive.read_track_data("Default/2026-05/2026-05-01 徒步.kml")
    print(data.source, data.track_tags)
    for track in data.tracks:
        for segment in track.segments:
            print(segment.longitude[0], segment.latitude[0], len(segment.longitude))
```

`list_entries()` 返回现有的 `ZipEntry` 列表，按完整路径的大小写敏感字符串顺序排列。`path` 是原始 ZIP 条目路径，`name` 是显示文件名；扩展名 `.kml` 不区分大小写，目录项和其他文件忽略，空归档返回 `[]`。列表只读 ZIP 目录信息，不解压或解析 KML。`kind` 仅根据首层目录识别 `Default` / `Train` / `Flight`；旧扁平条目、未知目录和 `_unclassified` 都返回 `None`，不猜测类别。原始活动名在读取后的 `data.track_tags` 中，与目录类别不同。

`read_track_data(entry.path)` 按完整路径逐字匹配，不按文件名或片段查找，也不规范化条目路径或忽略大小写。每次只解压、校验并解析选中条目，直接返回现有 `KmlTrackData`，数组、分段和缺失值约定同上。没有全归档几何缓存，也没有临时 KML 文件；再次读取会重新解析。未知类别或缺少活动标签不妨碍读取有效几何。

`with` 进入时打开 ZIP，正常或异常退出都会关闭；返回的数据和条目列表可在退出后继续使用，但归档对象的方法会报告已关闭。`data.source` 为 `<解析后的绝对 ZIP 路径>!/<完整条目路径>`，是来源位置标签，改名或移动后会变化，不是永久 ID。接口不提供并发写入期间的快照或锁定保证。

路径/身份错误、无效 ZIP、缺失条目、重复路径歧义、CRC/解压损坏、XML 或轨迹数据无效都抛出 `UserInputError`，错误带归档来源，条目错误还带完整条目路径。目录列表遇到重复 KML 路径会报错；精确读取也拒绝有重复路径的目标，但仍可读取其他唯一条目。未选中的坏 KML 不影响列目录和读取其他条目；不会静默跳过明确选中的坏轨迹，调用方可捕获错误后继续。读取不修改归档、源文件、配置、集合、备份或撤销历史。

## 实现说明

- exiftool 以 `-stay_open` 常驻进程通信（每线程一个），批量处理不必为每个文件启动一次进程
- 日志与标准输出里的路径按用户视角显示：优先相对当前工作目录（且至多向上一级），否则在家目录之下显示为 `~...`，再不然用绝对路径。写进配置和 KML 文件的值不受影响，保持原样
- 并行处理使用线程池（I/O 密集负载）
- `kml fill-altitude` 只补**整轨都没有高程**的轨迹（手绘规划那种）。KML 里一条轨迹＝一个 Placemark，判据是**逐条**的：一条轨迹上只要有一个点带非零海拔，这条就整条不写（那是设备记录的真实高程，不该被 DEM 值替换），同一份文件里的手绘轨迹照补；零海拔与缺分量同义，都算没有。媒体侧的 `exif fill-altitude` 则是逐文件地只补缺失标签
- `kml prune --auto` 自动清漂移：某步隐含速度超过 `--speed-mps`（默认 30 m/s）或单步距离超过 `--jump-meters`（默认 100 m）即触发，且轨迹须在 `--max-seconds`（默认 120 s）内回到锚点 `--return-meters`（默认 30 m）内才确认为漂移——真实的出发一去不返，不会误删。缓慢爬走式漂移每步速度都很低，不在此列，仍用手动两点 prune
- API key 支持环境变量注入，避免明文入库

## 测试

```bash
uv run pytest                       # 全部（含真实 exiftool / ffmpeg 的集成用例）
uv run pytest -m "not integration"  # 只跑内存替身，不碰外部工具
```

需要真实工具的用例打 `integration` 标记（`tests/test_e2e.py` 走完整链路：ffmpeg 造样本、exiftool 读写、轨迹从 ZIP 归档读出），工具缺席时自动跳过。`MetadataBackend` 的两套实现（真实 exiftool 与内存替身）跑同一份断言（`tests/fixtures/backend_contract.py`），替身因此不能与真身漂移。
