# CLI 使用说明（2.x）

业务命令如下；程序接口见 [API](api.md)，安装与 Chromium 见 [安装说明](install-upgrade.md)。

照片和视频处理已迁至独立的 mediatool CLI，迁移方法见[媒体工具拆分说明](media-tool.md)。tracktool 不再提供 `exif` 命令。

## 快速上手

```bash
# 新建空归档；已有 ZIP 请改用 archive import-zip
tracktool archive init ~/tracks
tracktool config set archive_path ~/tracks

# 归档新轨迹（一次可给多条：SQLite 批量事务入库；默认保留原件、不创建 Backup；任一文件校验失败则整批不入库）
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

# 默认保留源文件，整批校验后一次提交；无需 Backup 目录
tracktool kml push ./2024-05-03\ 徒步.kml
# --keep 仍可使用；--move 显式启用 Backup 搬移
tracktool kml push ./2024-05-03\ 徒步.kml --move

# 日常操作后按需导出当前展示；原件、隐藏段和历史请另做 full-backup
tracktool kml download "2026-10-01 徒步" --output /downloads
tracktool --dry-run kml delete "2026-10-01 徒步"  # 查看范围与依赖
tracktool kml delete "2026-10-01 徒步"            # 删除条目及全部历史
tracktool archive status
tracktool archive backup
tracktool archive rebuild
# 中断后完成源文件搬移
tracktool archive recover
```

`kml split` 按时间差选最近的轨迹点，距离相同时选较早的时间；支持 `Z` 和时区偏移，
不带时区时按 UTC 解释。选中的点归前一段，原文件保留，结果写入同目录的
`原名-Splited-1.kml`、`原名-Splited-2.kml`。多个切分时间落在同一点时只切一次；
如果最近的是最后一个轨迹点，会报错，避免生成空的后一段。

## 网页地图

运行 `tracktool-map`，地图编辑、出图、PNG 及其他页面的启动和操作见[网页使用说明](web-usage.md)。

## 库内行程编辑

`track` 命令操作归档中的版本化行程。默认内部断开仍是一个 KML；独立行程拆分须明确使用 split_journey。原有 `kml split/prune` 属于独立文件工具，不修改库内版本。支持读取 MultiGeometry 文件。

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

operation 还支持 prune（segment_id 和半开 ranges）、draw（after_segment_id、WGS84 coordinates，可明确吸附）、compose（按序 version_id/segment_id）、presentation（完整 settings）、split_journey（每个输出 path/category/segment_ids）、restore_version（version_id/presentation_id）。完整契约见 [API](api.md) 和 `src/shared/track-edit.ts`。未知字段、重复/遗漏段、非法范围和倒向连接均拒绝。

整组撤销请求为 `{schema:1,archive_id,operation:{kind:"restore_group",operation_id,expected:[…]}}`，expected 从 `track operation` 各 effect.after 取出上述五个目标引用字段。全部成员仍与原操作结果一致才能撤销；生成的新行程保留为历史来源，原行程恢复活动状态。恢复历史版本同样先预览，不删除后续版本。

预览保存在状态目录的 tasks.sqlite3，24 小时有效，不改轨迹库；应用从该库读取并核验产物，不重新运行编辑算法。默认状态目录是 `~/.local/state/tracktool`（macOS `~/Library/Application Support/tracktool/state`，Windows `%LOCALAPPDATA%\tracktool\state`）；网页指定了 --state-dir 时，CLI 使用相同路径即可共用预览。`--archive` 可显式指定 CLI 的库，库身份必须匹配。`track preview --dry-run` 仅在内存准备，不保存预览；`track apply --dry-run` 只读检查已有清单，不提交。下载版本继续用 `kml download --entry-id ENTRY_ID --version VERSION_ID`。

## 目录比较与重复文件查找：使用 fclones

通用文件比较与去重交给 [fclones](https://github.com/pkolaczk/fclones)。fclones 独立使用，不是 tracktool 的运行依赖；可从[官方 Releases](https://github.com/pkolaczk/fclones/releases) 下载，或参照[安装说明](https://github.com/pkolaczk/fclones#installation)安装。

下面的目录比较按**文件内容是否在另一目录存在**判断，忽略文件名、目录层级和副本数量。只修改 KML 标签也会造成内容差异；它不判断轨迹几何是否相似，也不检查目录结构是否相同。

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
  "/path/to/tracks"
```

以上 `group` 命令只扫描和报告，启用 `--cache` 时另写缓存，不删除或改写输入文件。macOS、Windows 的缓存目录配置不同，`XDG_CACHE_HOME` 这段示例只适用于 Linux。

## 预演

`--dry-run` 是整次运行的模式，可写在业务子命令之前或之后，所有会改文件的命令都自动生效：

```bash
tracktool --dry-run kml push ./2024-05-01\ 徒步.kml
```

它照常读文件、照常做判断（因此能报出哪些文件会失败），只是把写入改成打印：一条条步骤列成表，磁盘一个字节都不动。写在子命令之后会被当成用法错误退 1。

## 退出码

| 码  | 含义                                                                                                |
| --- | --------------------------------------------------------------------------------------------------- |
| 0   | 全部成功                                                                                            |
| 1   | 用户输入错误（路径不存在、通配符无匹配、坐标无法解析、配置或 KML 格式错误，以及命令或选项拼写错误） |
| 2   | 外部工具或 API 失败（Google 拒绝请求或超额）                                         |
| 3   | 部分失败：逐文件隔离后仍有文件未处理完                                                              |

命令名、选项拼写错误、缺必填参数都退 1；2 表示外部依赖失败。

表里的「KML 格式错误」只对单文件命令成立：批量命令（`kml push`、`kml set-tag`）把读不出来的那个文件当作它自己的失败，其余照常处理，命令整体退 3。1 保留给「整批还没开始」的情形——路径不存在、通配符无匹配、`--type` 或 `--tag` 取值非法（类别名不在 Default/Train/Flight 里，活动名不在词表里）。

批量文件编辑会记录逐文件处理结果，存在失败时以 3 退出。轨迹入库先整批校验，在 SQLite 事务中提交；显式移动源文件时通过短期日志恢复。ZIP 和集合 KML 按需另行导出。

## 配置

配置文件放在各平台自己的用户配置目录里，文件名统一是 `config.json`：Windows 用 `%APPDATA%\tracktool\`（Roaming，变量缺席时退回 `~\AppData\Roaming\tracktool\`），macOS 用 `~/Library/Application Support/tracktool/`，其余系统用 `$XDG_CONFIG_HOME/tracktool/`（取值未设或**不是绝对路径**时退回 `~/.config/tracktool/`——XDG 规范要求忽略相对值）。放在用户目录而不是项目里，是因为设置对工具是全局的：从轨迹文件夹里跑和从项目根跑必须读到同一份。

字段：`log_level`、`archive_path`、`auto_fill_locations`、`kml_backup_dir_name`、`google_api_key`，以及三个活动词表 `track_tag.Default`、`track_tag.Train`、`track_tag.Flight`。`archive_path` 指向包含 `archive.sqlite3` 的**归档目录**；新库通过 `archive init` 创建，ZIP 通过 `archive import-zip` 导入。路径打错不会静默建立新库。显式指定 `--config` 时只使用该文件。版本历史自动保存。Google Maps API key 的解析顺序：环境变量 `TRACKTOOL_GOOGLE_API_KEY` > `--api-key` 参数 > 配置文件。

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
tracktool archive rebuild             # SQLite → 聚合 KML
tracktool archive recover             # 完成中断文件操作
```

当前版本、默认展示或状态变化使日常导出过期；历史来源变化通过 storage_revision 使完整备份过期，解析缓存不影响修订。push/delete 不改 ZIP/集合。`--archive` 可指定归档目录或 SQLite 文件。

`kml download` 不修改归档，默认下载当前版本完整原字节；`--entry-id` 可定位非活动来源条目，`--version` 指定该条目的历史版本，`--output` 为目录且不覆盖已有文件。`kml delete` 预览和执行都检查来源与待恢复操作依赖，删除只清理无引用对象。已有下载和备份保留，已删除历史只能从之前的完整备份恢复。

### 按展示导出 KML

```sh
tracktool track export-display ENTRY_ID --archive /tracks --output /exports/trip.kml
tracktool track export ENTRY_ID --version VERSION_ID --presentation PRESENTATION_ID --output /exports/history.kml
```

导出可见段、补绘及启用的连接线，保留实测时间、高程、样式和扩展字段。目标是文件，不覆盖已有目标；`--dry-run` 校验并计算输出但不创建文件。历史版本省略 `--presentation` 时使用该版本第一份展示快照；当前版本默认使用当前快照。原字节请用 `kml download`，完整历史用 `archive full-backup`。网页不再提供独立的展示 KML 入口；聚合导出和 CLI 单条导出都使用库中展示设置。

### 压缩包格式与压缩程度

`archive backup` 支持 `--format zip-deflate|zip-zstd|tar-xz` 和 `--compression store|normal|extreme`。新建导出默认 ZIP · Deflate、极致压缩；`--output` 可指定目标文件，扩展名必须与选项一致。写入完成后默认只校验压缩包结构（成员名、重复项、大小与 ZIP 中央目录），不再整包解压重读；需要逐成员字节复核时设置 `TRACKTOOL_VERIFY_EXPORT=1`，代价是再来一遍解压与哈希。tar.xz 由 xz 自身的校验与退出码保证。

| 格式        | 仅打包（store）   | 正常（normal）    | 极致（extreme）   |
| ----------- | ----------------- | ----------------- | ----------------- |
| zip-deflate | ZIP Store，`.zip` | Deflate 6，`.zip` | Deflate 9，`.zip` |
| zip-zstd    | ZIP Store，`.zip` | Zstd 3，`.zip`    | Zstd 22，`.zip`   |
| tar-xz      | 不压缩的 `.tar`   | XZ -6，`.tar.xz`  | XZ -9e，`.tar.xz` |

```sh
tracktool archive backup --format zip-zstd --compression extreme --output ./tracks.zip
tracktool archive backup --format tar-xz --compression normal --output ./tracks.tar.xz
tracktool archive backup --format tar-xz --compression store --output ./tracks.tar
```

两种 ZIP 在仅打包时使用相同的 ZIP Store 格式。Zstd ZIP 需要支持该方法的解压工具，可用 `archive import-zip` 导入；TAR/TAR.XZ 请先解包，再导入 KML。TAR.XZ 需要系统安装 `xz` 并加入 PATH；仅生成 TAR 不需要 XZ。极致使用最高预设，耗时和内存占用较高，不保证每份数据都比正常档更小；资源不足时会失败，不自动降低档位。XZ 极致压缩单线程约需 674 MiB 内存。导出期间可以取消，未完成的临时包会清理，已有目标保留。

`archive backup` 保留原命令名，用于当前库默认展示压缩包；`archive rebuild` 生成桌面和手机集合。两者不套用任何出图私有覆盖。导出的 Tracktool 元数据记录来源种类、段顺序和显式连线；再次导入时连接线不会成为实测采样，也不会重复补线。

## 轨迹起终点行政区

在项目目录中使用 `pnpm cli`：

```bash
pnpm cli track fill-locations --dry-run
pnpm cli track fill-locations --offline    # 本地升级已有结果的解析规则
pnpm cli track fill-locations --limit 3
pnpm cli track fill-locations
pnpm cli track locations ENTRY_ID
```

`fill-locations` 从当前活动轨迹展示快照取首末点，遵循段顺序和隐藏状态。段反转已体现在轨迹版本的坐标顺序中，连接线不作为独立端点。结果存入归档 SQLite，不改 KML 字节或 `PosStartName` / `PosEndName`。

网页上传或 HTTP `archive:push` 在轨迹提交成功后会默认自动补全本批新入库轨迹的起终点行政区；配置 `auto_fill_locations=false` 可关闭。该步骤在入库提交之后尽力执行，失败只写入任务日志，不回滚已入库轨迹。`kml push` CLI 不触发自动补全，仍需显式运行 `track fill-locations`。

支持 `--archive PATH`、`--entry ID`、`--limit N`（最多处理 N 条需要补全的轨迹）、`--language zh-CN`、`--api-key KEY`。密钥优先级仍为环境变量 `TRACKTOOL_GOOGLE_API_KEY` > 参数 > 配置。网络需要现有 HTTP/HTTPS 代理时，可用 `NODE_USE_ENV_PROXY=1 pnpm cli track fill-locations`。

默认跳过已有结果，精确相同坐标、语言与解析版本复用查询。每个端点单独提交，失败后重跑即可续传；`--retry-incomplete` 重查缺失层级及零结果，`--refresh` 强制查询（与 `--offline` 合用时只重新解析本地证据）。凭证或额度错误立即停止，普通单条失败继续并以非零退出码报告。`--dry-run` 不写入、不迁移、不访问付费 API，其 `queries` 为去重后的预计请求数（不含网络重试）。

输出 JSON 行包含进度与最终 summary。`track locations` 只读当前结果，`track show` 的 `endpoint_locations` 默认返回中文结果；历史快照可用 `track show --version ... --presentation ...` 读取。解析器 v2 保留新查询的完整 `raw_response`（含所有候选、组件类型及位置元数据），再产生规范字段和 `resolution`。`resolution.fields` 区分 `resolved`、`missing`、`not_applicable`、`conflict`；`resolution.hierarchy` 是可直接展示的可靠层级链，`evidence` 标出各字段的候选索引和组件类型。`complete` 表示该地区所需层级已解析（允许不适用），不是“必须填满三级”或权威边界认证。`resolution.mode=fallback` 是正常降级结果，不要求人工确认；`partial` 与网络失败分开处理。

优先选择明确的行政实体候选与自洽层级；同等证据冲突时删除分歧层及下级，保留共同上级，不按候选重复次数投票、不按行政中心距离猜归属。不跨候选随意拼接父子层级。日本区、香港行政区、泰国区等使用地区规则；香港地区中英文名称按已知别名归一。韩国直辖城市、马来西亚州与县等没有中间城市层级时标为不适用，新加坡、香港等也不硬造国内省市县结构。

`--offline` 禁止访问 API；缺少证据的端点计入 `pending`。已有完整响应可用 `--offline --refresh` 在本地重新解析，保留真实查询时间。主动刷新不完整结果可用 `--retry-incomplete`。
