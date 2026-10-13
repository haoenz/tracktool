# SQLite 归档：迁移、操作和恢复

SQLite 是日常操作的唯一主存储。`Archive.zip` 和 `Default/Train/Flight[.Mobile].kml` 是按需生成的导出文件；更改导出文件不会修改数据库。旧的原始 KML、ZIP、集合、Backup、archive.json、history.jsonl 不在迁移时改写或删除。

## 从旧 ZIP 迁移

建议先在新目录建立库，核对后切换配置。也可以在原目录显式导入，只增加数据库；只要目标已有 `archive.sqlite3` 就拒绝，不提供覆盖开关。

```bash
tracktool archive import-zip /old/tracks/Archive.zip /new/tracks
tracktool config set archive_path /new/tracks
tracktool archive status
tracktool archive backup
```

导入只需要 ZIP。不会读取旧数据库、archive.json 或原机器配置。先检查每个成员的完整路径、重复项、解压/CRC、对象 SHA-256、数据库完整性和外键，再用同目录暂存库发布。失败清理暂存文件、不发布半成品；输入 ZIP 始终只读。归档路径逐字保留、区分大小写；不重新布局文件。

首层目录 `Default` / `Train` / `Flight` 提供原分类；未知目录与 `_unclassified` 保持未分类。旧平面成员没有原分类可读时，只用固定内置活动词表识别，绝不使用当前机器自定义词表。原始 `TrackTags` 完整保留。无法从 ZIP 得知的自定义平面分类不能推断。

新建空库使用 `tracktool archive init /new/tracks`。init 遇到旧 ZIP 或身份文件会要求显式导入，不再“收编 ZIP”。普通 CLI 和地图读取绝不偷偷迁移。

## 日常操作与备份

```bash
tracktool kml push "./2026-10-01 徒步.kml"          # SQLite 入库，再收进 Backup
tracktool kml push "./2026-10-02 徒步.kml" --keep   # 保留源文件
tracktool kml push "./2026-10-03 自定义.kml" --type Train --keep
tracktool kml pop "2026-10-01 徒步"                # 原字节提取到当前目录，再从库中删除
tracktool archive status
tracktool archive backup                         # 默认写归档目录 / Archive.zip
tracktool archive backup --output /backup/Archive.zip
tracktool archive rebuild                        # SQLite → 桌面/手机聚合 KML
tracktool archive recover                        # 完成上次中断的文件操作
```

原有 `--zip /tracks/Archive.zip` 继续作为“所在归档目录”的定位方式；即使 ZIP 不存在或过期，日常读取仍使用该目录的 `archive.sqlite3`。它不会导入或更新指定 ZIP。CLI 默认使用 `archive_path`。

push 保留 `<类别>/<文件名年月>/<文件名>` 布局、活动词表、`--type`、通配符排序、按文件报告部分失败，以及默认移动/`--keep`。仍要求可识别分类和文件名日期；`--type` 可接收地图不支持但 XML 有效的 KML。ZIP 导入不受这些命名/解析限制。分类和解析使用原始内容，入库保存原始文件字节，绝不把 XML 重序列化后充当原件。

同一路径且字节相同为幂等重复；不同路径可引用同一内容对象。同路径字节不同会明确报错、整批数据库插入回滚并保留源文件（修正旧的同名静默跳过）。Backup 已有同内容文件可复用；不同内容则保留双方并提示。pop 按完整文件名或 stem 精确查找，不接受子串；可用 `--type` 消除跨分类歧义。同类型仍不唯一时拒绝。已有输出一律不覆盖；`--force` 不绕过歧义或输出冲突，也不再检查派生集合。

每次实际成员增删使内容修订号增加；重复 push、解析索引、项目保存不会增加它。`archive status` 显示当前修订、最近成功 ZIP 修订、聚合修订和待恢复操作。ZIP 修订落后或目标不存在时显示 `STALE / missing`。状态是工具导出记录，不会每次遍历验证外部软件是否改写过 ZIP；备份前重新执行 `archive backup` 最明确。

ZIP 从同一个读事务快照生成；每个成员解压后的 SHA-256 校验成功、文件同步后才原子替换目标。失败前的旧文件保留。导出期间允许新增写入，只记录导出快照的修订，仍落后就继续显示过期；同目标并发导出不会用较旧快照替换已发布的新快照。多个输出目标分别记录发布修订，status 展示最近一次成功导出的目标。发布成功后但元数据事务提交前崩溃，记录可能保守地落后，重新导出即可。

**只有已生成并异地复制的 ZIP 才覆盖相应修订。** 不要求备份主库；push/pop 不自动重写 ZIP，备份频率由使用者决定。ZIP 内只有所有归档成员 KML，保持路径和原始字节；不承诺 ZIP 容器字节、压缩算法、时间戳、权限或注释相同。

聚合 KML 按原分类、文件名年月及名称生成；桌面保留年/月层次和类别样式，手机保留 MultiGeometry。现有业务描述拼接规则保留，多个 LineString/gx:Track 分别输出，避免分段间连线。聚合不携带全部原始样式、扩展字段、时间等，不能用来恢复原件。未分类、无文件名日期、无法生成线几何的成员明确警告并不进入聚合，但仍完整存在于 SQLite/备份 ZIP。集合中名称冲突按既有规则警告去重，完整成员仍以数据库/ZIP 为准。

所有聚合文件先从一个数据库快照构建，再逐文件原子替换。六个 KML 不是跨文件原子事务；发布中断可能留下不同批次的导出，修订记录不会提前更新，重跑 rebuild 即可。新旧快照并行 rebuild 后记录的是最后发布的快照，可能仍过期。

## 仅凭异地 ZIP 在新环境恢复

```bash
tracktool archive import-zip /backup/Archive.zip /fresh/tracks
tracktool config set archive_path /fresh/tracks
tracktool archive status
tracktool archive backup --output /fresh/verified.zip
tracktool archive rebuild
tracktool-map --archive /fresh/tracks/archive.sqlite3
```

只恢复所有归档 KML 的路径和原始字节。数据库 ID 重新生成，解析索引按需重建。不恢复地图项目、操作历史、未完成文件意图、瓦片缓存或配置。无需找到旧机器；Backup 文件夹也不是恢复前提。

若误 pop，可以把提取的原件重新 push；若要取回旧备份中的文件，将该 ZIP 导入另一个新目录再 pop，避免覆盖正在使用的库。旧 `archive undo` 明确报“已退休”并给出上述替代方式；`archive log` 只显示已保留的旧历史，并提示 SQLite 不再记长期历史。`archive_history` 只为兼容旧配置保留，不再控制数据库行为。

## 中断恢复

push 在一个 SQLite 事务中写原始对象、成员和移动意图；事务提交后才处理外部文件。先在备份目标文件夹暂存、fsync，以不覆盖目标的方式发布，同步目录；确认源文件仍是同样字节后删除源。相同成员来自多个源路径时分别记录意图。

pop 先提交提取意图，成员仍在库里；原始字节成功发布并同步后，在第二个事务中删除意图和成员。若进程在任一步骤被中断，至少仍有数据库对象或已发布的外部文件。恢复处理持有写锁，防止多个进程重复完成同一意图；已完成后清理意图和不再被成员引用的对象，不保留版本库。

每次 push/pop 会先尝试恢复未完成操作，也可以显式 `archive recover`。输出被占用或源内容变化时保留文件、保留意图并报错。把冲突文件移到安全位置，或恢复意图对应的原始内容，再执行 recover；不要删除数据库以“清日志”。完成恢复后再次执行原 pop 可能提示成员已不存在，此时检查输出即可。不要在文件操作执行期间用外部程序同时修改涉及的源/目标文件。

原子发布使用同文件系统临时文件 + 硬链接（不覆盖）或 `os.replace`（导出）；需要支持这些操作的本地文件系统。SQLite 使用 WAL，不支持把正在写入的库直接放在不支持可靠锁的网络文件系统。崩溃可能留下 `.archive-import-*` / `.archive-export-*` / `.tracktool-*` 暂存文件；它们不是正式库/备份，不会被日常读取。Windows 缺少同等目录 fsync 保证，不能把本机 Linux 故障验证当作所有文件系统的断电认证。

## 地图与项目

`tracktool-map --archive /tracks/archive.sqlite3` 或 `--archive /tracks`。目录浏览器选择 `archive.sqlite3`；旧 ZIP 路径仍可定位同目录的库，但不再读取 ZIP。

顶栏「保存」首次命名后写数据库项目，之后直接更新当前项目；「项目 → 打开项目」提供可搜索列表。「另存为」创建另一份，同名覆盖需确认；项目名称与图片标题独立。项目存选择成员路径和 SHA-256、相机、底图/样式、地名模式、标题、画框、输出尺寸及既有资源版本；不存瓦片。原有状态校验、资源版本确认和内容变化阻止导出仍适用。

「项目 → 导出项目文件」/「导入项目文件」（JSON）继续支持 schema 1。旧项目引用同目录 Archive.zip 时直接定位 SQLite；换机器后先打开新归档，再导入旧 JSON，确认将轨迹关联到当前归档。逐条核对原指纹，绝不静默接受变化的内容。数据库项目不属于 ZIP 恢复承诺，需要保留时单独导出 JSON。

地图全屏、分段、画框预览、来源署名、PNG 和资源版本检查保持。轨迹原坐标为 WGS84，Google 中国底图的显示变换留在前端，不写回原始对象或索引。拖动、缩放、颜色、线宽和换源不调用 KML 解析；既有网络连接池、下载去重、并发限制、独立瓦片缓存与平滑换源实现保持。

## 表结构与事务边界

存储位置为 `<archive_path>/archive.sqlite3`，活动连接可能产生同目录 `-wal`/`-shm`。结构版本为 `PRAGMA user_version=2`；新库先按 v1 创建，再应用同一套 v1→v2 迁移。v2 增加逐目标导出记录并允许同成员多个源文件意图。`archive migrate` 在独占事务中依序迁移，失败回滚；未知版本拒绝，普通打开不自动改结构。

| 表 | 职责、约束与关联 |
| --- | --- |
| `archive_meta` | singleton=1 主键；归档 UUID、内容修订、最近 ZIP 修订/目标、聚合修订；zip_name 为初始化时的导出名称元信息。 |
| `kml_objects` | SHA-256 文本主键，zlib 压缩的完整原始字节、codec 检查和非负原始大小；读取原件时验证长度和哈希。 |
| `archive_entries` | UUID 主键；BINARY 大小写敏感 UNIQUE 路径；sha256 外键指向对象；分类与文件名日期独立列。一个成员是一份文件，不是一条折线。sha256 索引和 (category, filename_date) 索引。成员增删/内容、路径、分类变化由触发器推进修订。 |
| `kml_index` | (sha256, parser_version) 复合主键、对象外键级联删除；状态 ok/error、元数据 JSON、几何 BLOB 和错误信息。解析失败同样存状态；按需建索引，新版替换该内容的过期派生索引。 |
| `map_projects` | BINARY 名称主键；完整已验证状态 JSON、UTC 更新时间。引用是成员路径+内容指纹而非内部 ID；不设强外键，以便缺失成员时明确提示并重新关联。 |
| `file_operations` | 短期 UUID 意图；push/pop、成员外键、内容外键、源/目标绝对路径；成员索引、(entry_id, source) 唯一索引。成功完成就删除。 |
| `export_receipts` | 目标绝对路径主键、成功导出的内容修订，防止较旧并发快照覆盖更新导出；仅派生元信息，不进入 ZIP。 |

每次操作创建自己的连接，保持默认线程检查，不跨线程共享。所有连接启用外键、30 秒 busy_timeout、FULL synchronous；WAL 允许快照读与单写者并行。读事务 `BEGIN`，写事务先 `BEGIN IMMEDIATE` 获取写入权；正常提交、异常回滚，finally 关闭连接。HTTP 工作线程和 EXIF 工作线程各自打开连接，不把连接缓存到 MapWorkspace。地图保存从编排层调用项目存储，渲染层完全不认识归档业务。

读取归档目录/几何在一个读快照中；首次派生解析通过另一个短连接写索引，原快照在并发 pop 后仍能读原字节。若该对象已被删除，就返回本次结果但不把对象复活。多进程同时第一次解析可能重复计算，唯一键收敛为相同派生结果；日常已有索引直接读取。

解析器版本 2、序列化版本 1：zlib 压缩 JSON，分段内数组以 Base64 编码的**小端**二进制保存。经纬高程 binary64；时间 signed int64 UTC 微秒。原始更高精度时间文本仍在无损对象中，派生时间按现有规则截到微秒。整段没有海拔/时间用 null；局部缺海拔为 binary64 NaN，零高程仍为零；gx:Track 的时间与坐标数量不匹配时，该段全部按无时间轨迹处理，保留全部坐标及高程，不截断、不猜测配对；其他段的有效时间不受影响。数量相等但时间格式非法仍报错。原始时间标签完整保存在原文中；旧版索引（包括错误状态）在读取时自动重建。每个 Placemark 的 LineString/gx:Track 独立成段，保留顺序、标识和单点线，不连接分段。不为每个 GPS 点建立 SQL 行，也不使用 pickle。

派生元数据包括文档名称、原活动标签、轨迹/段/点数量、实际最早/最晚轨迹时间、是否有海拔。它与归档分类、文件名日期分开。未选中的坏 KML 不影响目录；选中失败明确报告，绝不静默丢失原件。仅有 Point/Polygon 的文件及混合文件中未支持的几何不供地图显示，但原件完整保留。

## 明确限制与验证

ZIP 导入拒绝重复完整路径、绝对路径、空段/`.`/`..`、反斜杠、控制字符、冒号、符号链接、非 KML 文件（目录项可以存在）；发现就整次失败，不悄悄跳过。非 KML 附件不属于本归档格式。ZIP 文件夹条目的元信息不保证恢复。导入不强制 XML 可解析；CRC 正确但 XML/几何坏的成员仍可完整保存，地图选择时报错。ZIP 无外部已知哈希时不能发现“内容已被他人改过且重新计算了 CRC”的修改，导入校验不等于来源认证。

地图单次最多 200 个成员、200 万点，单成员解压上限 128 MiB；原始库/ZIP 导出无该地图上限。仍需足够磁盘空间容纳暂存导出/导入；一个超大 KML 的压缩/解析目前在内存中完成。

验证记录和测量见 [SQLite 验收](sqlite-validation.md)，改造前行为见 [兼容性基线](sqlite-baseline.md)。
