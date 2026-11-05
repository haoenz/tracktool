# SQLite 归档：操作与恢复

SQLite 是日常操作的唯一主存储。`Archive.zip` 和 `Default/Train/Flight[.Mobile].kml` 是按需生成的导出文件；更改导出文件不会修改数据库。归档结构为 schema 10，读取、写入和完整备份恢复均要求该结构。

## 导入 ZIP

建议先在新目录建立库，核对后切换配置。也可以在原目录显式导入，只增加数据库；只要目标已有 `archive.sqlite3` 就拒绝，不提供覆盖开关。

```bash
tracktool archive import-zip /input/tracks/Archive.zip /new/tracks
tracktool config set archive_path /new/tracks
tracktool archive status
tracktool archive backup
```

导入只需要 ZIP。输入不依赖其他数据库或配置文件。先检查每个成员的完整路径、重复项、解压/CRC、对象 SHA-256、数据库完整性和外键，再用同目录暂存库发布。失败清理暂存文件、不发布半成品；输入 ZIP 始终只读。归档路径逐字保留、区分大小写；不重新布局文件。

首层目录 `Default` / `Train` / `Flight` 提供原分类；未知目录与 `_unclassified` 保持未分类。平面成员没有原分类可读时，只用固定内置活动词表识别，绝不使用当前机器自定义词表。原始 `TrackTags` 完整保留。无法从 ZIP 得知的自定义平面分类不能推断。

新建空库使用 `tracktool archive init /new/tracks`。已有数据库时拒绝覆盖。

## 日常操作与备份

```bash
tracktool kml push "./2026-10-01 徒步.kml"          # SQLite 入库，再收进 Backup
tracktool kml push "./2026-10-02 徒步.kml" --keep   # 保留源文件
tracktool kml push "./2026-10-03 自定义.kml" --type Train --keep
tracktool kml download "2026-10-01 徒步"           # 只读下载当前版本原字节到当前目录
tracktool --dry-run kml delete "2026-10-01 徒步"   # 查看删除范围及阻塞依赖
tracktool kml delete "2026-10-01 徒步"             # 删除条目及全部历史
tracktool archive status
tracktool archive backup                         # 默认写归档目录 / Archive.zip
tracktool archive backup --output /backup/Archive.zip
tracktool archive full-backup --output /backup/tracks-2026-10-14.sqlite3
tracktool archive restore-backup /backup/tracks-2026-10-14.sqlite3 /fresh/restored
tracktool archive rebuild                        # SQLite → 桌面/手机聚合 KML
tracktool archive recover                        # 完成上次中断的文件操作
```

使用 `--archive /tracks` 指定归档目录；CLI 默认使用 `archive_path`。

push 保留 `<类别>/<文件名年月>/<文件名>` 布局、活动词表、`--type`、通配符排序、按文件报告部分失败，以及默认移动/`--keep`。仍要求可识别分类和文件名日期；`--type` 可接收地图不支持但 XML 有效的 KML。ZIP 导入不受这些命名/解析限制。分类和解析使用原始内容，入库保存原始文件字节，绝不把 XML 重序列化后充当原件。

同一路径仍处于活动状态且字节相同为幂等重复；条目路径继续保留唯一性，非活动来源条目不能用 push 覆盖；删除整个条目后，重新入库同名文件会获得新身份。不同路径可引用同一内容对象。同路径字节不同会明确报错、整批数据库插入回滚并保留源文件。Backup 已有同内容文件可复用；不同内容则保留双方并提示。download/delete 按完整成员路径、文件名或 stem 精确查找，不接受子串；可用 `--type` 消除跨分类歧义，或用 `--entry-id` 精确定位含非活动来源在内的条目。下载可用 `--version` 指定所属历史版本、`--output` 指定目标目录；已有输出一律不覆盖。

活动指针、展示设置、状态变化及删除推进 `revision`；历史来源补录等持久变化推进 `storage_revision`。重复 push 和解析缓存不推进两者。`archive status` 显示当前修订、最近成功展示压缩包修订、聚合修订和待恢复操作。展示压缩包修订落后或目标不存在时显示 `STALE / missing`。状态是工具导出记录，不会每次遍历验证外部软件是否改写过导出文件；备份前重新执行 `archive backup` 最明确。

导出状态中的 `export_revision`、`export_target`、`export_fresh` 表示最近一次完整展示压缩包导出，涵盖 ZIP、TAR 和 TAR.XZ。`export_receipts` 中的 `kml_bundle` 同样涵盖这些格式；按目标路径记录展示修订，不记录压缩档位。网页临时下载和所选轨迹导出不会更新完整导出记录。

ZIP、TAR 和 TAR.XZ 均从同一个读事务快照生成；每个成员解压后的 SHA-256 校验成功、文件同步后才原子替换目标。失败前的旧文件保留。导出期间允许新增写入，只记录导出快照的修订，仍落后就继续显示过期；同目标并发导出不会用较旧快照替换已发布的新快照。多个输出目标分别记录发布修订，status 展示最近一次成功导出的目标。发布成功后但元数据事务提交前崩溃，记录可能保守地落后，重新导出即可。

展示 ZIP 按当前库默认展示导出：保留可见实测段和手绘段、启用的连接线及再导入元数据，不含隐藏段、历史版本或出图文件；无法解析段清单的成员保留原字节并逐项警告。完整恢复请使用 `archive full-backup`：通过 SQLite 在线备份取得包含 WAL 已提交内容的一致快照，核验完整性、外键、每个对象的字节哈希和展示设置，再发布到新的 `.sqlite3` 文件，拒绝覆盖。`restore-backup` 核验后仅恢复到新目录或空目录，保留备份源。备份和恢复都要求先完成待恢复文件操作。

完整备份保留库身份、所有版本及展示状态，按 `storage_revision` 记录快照。备份完成后可复制到异地；配置及瓦片不在数据库备份中。push/delete 不自动刷新任何导出。

聚合 KML 按原分类、文件名年月及名称组织；桌面保留年/月层次，手机版按成员分组。两者使用同一展示规则并保留混合 gx:Track / LineString、时间、高程、样式及扩展字段；跨成员 XML ID 加前缀并同步引用。逐成员解析校验后组合，全集可以大于单文件读取上限；单次再导入仍受 128 MiB 限制。未分类、无文件名日期及无法生成展示的成员明确警告，保留在数据库中。展示 KML 无法恢复被隐藏的段和版本历史。

所有聚合文件先从一个数据库快照构建，再逐文件原子替换。六个 KML 不是跨文件原子事务；发布中断可能留下不同批次的导出，修订记录不会提前更新，重跑 rebuild 即可。新旧快照并行 rebuild 后记录的是最后发布的快照，可能仍过期。

## 从展示 ZIP 建立新库

```bash
tracktool archive import-zip /backup/Archive.zip /fresh/tracks
tracktool config set archive_path /fresh/tracks
tracktool archive status
tracktool archive backup --output /fresh/verified.zip
tracktool archive rebuild
tracktool-map --archive /fresh/tracks/archive.sqlite3
```

只恢复所有归档 KML 的路径和原始字节。数据库 ID 重新生成，解析索引按需重建。不恢复出图文件、操作历史、未完成文件意图、瓦片缓存或配置。无需找到旧机器；Backup 文件夹也不是恢复前提。

删除会移除条目及其全部历史，不能用版本恢复接口找回。需要历史时，先把删除前的完整备份恢复到独立目录，再下载。以前下载的文件和备份不受删除影响。

## 中断恢复

push 在一个 SQLite 事务中写原始对象、成员和移动意图；事务提交后才处理外部文件。先在备份目标文件夹暂存、fsync，以不覆盖目标的方式发布，同步目录；确认源文件仍是同样字节后删除源。相同成员来自多个源路径时分别记录意图。

下载在只读快照内取得并校验原字节，发布到不覆盖的目标；不创建文件意图，不自动 recover，不改变展示状态或修订。删除只在数据库事务内完成，不生成下载文件；中途失败或进程中断时，条目、历史、对象及删除收据一起回滚。

push 会先尝试恢复未完成操作，也可以显式 `archive recover`。文件意图只记录入库后的源文件移动。输出被占用或源内容变化时保留文件和意图并报错；处理冲突后再 recover。

原子发布使用同文件系统临时文件 + 硬链接（不覆盖）或 rename（导出）；需要支持这些操作的本地文件系统。SQLite 使用 WAL，不支持把正在写入的库直接放在不支持可靠锁的网络文件系统。崩溃可能留下 `.archive-import-*` / `.archive-export-*` / `.tracktool-*` 暂存文件；它们不是正式库/备份，不会被日常读取。Windows 缺少同等目录 fsync 保证，不能把本机 Linux 故障验证当作所有文件系统的断电认证。

## 地图与出图

`tracktool-map --archive /tracks/archive.sqlite3` 或 `--archive /tracks`。目录浏览器选择 `archive.sqlite3`。

地图全屏、分段、取景蒙版、来源署名、PNG 和资源版本检查保持。地图样式偏好保存在用户状态目录的 `display.json`，不写入轨迹库。出图文档（标题、相机、画框、输出尺寸、样式快照和可见轨迹引用）只存在于浏览器 IndexedDB 或用户导出的 JSON，服务器不保存工程或草稿。轨迹原坐标为 WGS84，Google 中国底图的显示变换留在前端，不写回原始对象或索引。拖动、缩放和换源不调用 KML 解析；既有网络连接池、下载去重、并发限制、独立瓦片缓存与平滑换源实现保持。

## 轨迹分析缓存

`track_analysis_cache` 的联合主键为 `(sha256, parser_version, analysis_version, params_hash)`。`sha256` 外键关联 `kml_objects`，使用 `ON DELETE CASCADE`。其他字段为：

- `params_json`：规范化后的计算参数，与 `params_hash` 对应。
- `summary_json`：统计指标与完整性信息，缺失值为 `null`。
- `profile_blob`、`profile_codec`、`profile_raw_size`：zlib 压缩的抽样曲线，解压上限 8 MiB。
- `created_at`：成功计算并写入时间，UTC。

同内容的条目和历史版本共享结果；新内容、解析器、分析算法/结果格式或参数变化后按新键计算。显示设置不进入缓存键。缓存不按时间失效，旧版本记录可供历史轨迹复用；原始内容真正删除时自动清理。行政区划名称不纳入这张表。

缓存的插入、替换和清理均不推进 `revision` 或 `storage_revision`，不增加历史操作，也不影响出图草稿。实际执行的完整 SQLite 备份包含缓存；ZIP 和 KML 导出不包含缓存。读取使用只读连接，写入使用短事务；数据库只读、锁定或写入失败时仍返回本次计算结果，下次访问可以重算。

新入库和编辑后发布的新内容版本，会于发布事务内完成统计计算并写入缓存；相同内容与算法参数复用现有缓存。正常可解析轨迹的统计写入失败会回滚本次发布，避免入库成功但统计未保存。为兼容原始文件归档，无法解析的导入成员仍保留原字节，不伪造统计。

## 端点行政区

`track_endpoint_locations` 以 `(presentation_id, endpoint, provider, language, resolver_version)` 为主键。展示快照不可变，通过它关联版本和轨迹；坐标使用明确的 latitude、longitude 列，不做近似舍入。`location_json` 保存国家、省、市、区县、选中结果的地址组件与字段来源；另存完整性状态和真实查询时间。跨轨迹复用时保留原查询时间。

旧快照结果不会冒充当前结果；新快照首次补全时可复用相同端点坐标的已有结果。查询在事务外进行，提交前检查当前轨迹身份、版本和展示快照，变化则放弃该次写入并提示重试。每个端点原子提交，已完成结果在中断后保留。

结果变更推进 `storage_revision`，不推进业务 `revision`、不新建轨迹历史。完整 SQLite 备份包含此表；KML/ZIP 原件导出不包含。受控删除展示快照时通过外键级联清理对应行。

端点结果保存完整 API 响应及解析证据，只读取与当前解析器版本一致的结果。离线刷新从完整响应重新解析，保留真实查询时间；缺失、当地不适用和候选冲突分别记录。

## 中断原因标注

中断原因随展示快照保存，完整 SQLite 备份包含这些标注。未分类的中断没有标注记录；隧道和其他中断分别记录为 `tunnel`、`other`。修改原因保留历史，恢复历史状态时一并恢复。删除缺口端点后，受影响的标注需要重新确认；在缺口插入补绘轨迹后，原来的跨越标注被移除。

`track_gap_annotations` 的主键为 `(presentation_id, from_segment_id, to_segment_id)`，另有 `version_id` 和 `reason` 字段。复合外键确保快照和两端片段属于同一版本。标注不重复写入 `settings_json`，展示摘要包含标注。快照发布后不可补写或修改标注，删除随所属行程走受控删除流程。

隧道连接线的显隐不写入归档，按行程保存在应用显示设置中，出图文档也保存该选择。切换不改变轨迹点、中断原因或轨迹历史。
