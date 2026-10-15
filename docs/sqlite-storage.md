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
tracktool kml download "2026-10-01 徒步"           # 只读下载当前版本原字节到当前目录
tracktool --dry-run kml delete "2026-10-01 徒步"   # 查看删除范围及阻塞依赖
tracktool kml delete "2026-10-01 徒步"             # 删除条目及全部历史（schema 4）
tracktool archive status
tracktool archive backup                         # 默认写归档目录 / Archive.zip
tracktool archive backup --output /backup/Archive.zip
tracktool archive full-backup --output /backup/tracks-2026-10-14.sqlite3
tracktool archive restore-backup /backup/tracks-2026-10-14.sqlite3 /fresh/restored
tracktool archive migrate                        # 完整备份后升级 schema 1/2/3 → 4
tracktool archive rebuild                        # SQLite → 桌面/手机聚合 KML
tracktool archive recover                        # 完成上次中断的文件操作
```

原有 `--zip /tracks/Archive.zip` 继续作为“所在归档目录”的定位方式；即使 ZIP 不存在或过期，日常读取仍使用该目录的 `archive.sqlite3`。它不会导入或更新指定 ZIP。CLI 默认使用 `archive_path`。

push 保留 `<类别>/<文件名年月>/<文件名>` 布局、活动词表、`--type`、通配符排序、按文件报告部分失败，以及默认移动/`--keep`。仍要求可识别分类和文件名日期；`--type` 可接收地图不支持但 XML 有效的 KML。ZIP 导入不受这些命名/解析限制。分类和解析使用原始内容，入库保存原始文件字节，绝不把 XML 重序列化后充当原件。

同一路径仍处于活动状态且字节相同为幂等重复；schema 4 的条目路径继续保留唯一性，非活动来源条目不能用 push 覆盖；删除整个条目后，重新入库同名文件会获得新身份。不同路径可引用同一内容对象。同路径字节不同会明确报错、整批数据库插入回滚并保留源文件（修正旧的同名静默跳过）。Backup 已有同内容文件可复用；不同内容则保留双方并提示。download/delete 按完整成员路径、文件名或 stem 精确查找，不接受子串；可用 `--type` 消除跨分类歧义，或用 `--entry-id` 精确定位含非活动来源在内的条目。下载可用 `--version` 指定所属历史版本、`--output` 指定目标目录；已有输出一律不覆盖。

schema 4 的活动指针、展示设置、状态变化及删除推进 `revision`；历史来源补录、项目保存等持久变化推进 `storage_revision`。重复 push 和解析缓存不推进两者；项目保存不推进 `revision`。`archive status` 显示当前修订、最近成功 ZIP 修订、聚合修订和待恢复操作。ZIP 修订落后或目标不存在时显示 `STALE / missing`。状态是工具导出记录，不会每次遍历验证外部软件是否改写过 ZIP；备份前重新执行 `archive backup` 最明确。

ZIP 从同一个读事务快照生成；每个成员解压后的 SHA-256 校验成功、文件同步后才原子替换目标。失败前的旧文件保留。导出期间允许新增写入，只记录导出快照的修订，仍落后就继续显示过期；同目标并发导出不会用较旧快照替换已发布的新快照。多个输出目标分别记录发布修订，status 展示最近一次成功导出的目标。发布成功后但元数据事务提交前崩溃，记录可能保守地落后，重新导出即可。

schema 3/4 的 ZIP 按当前库默认展示导出：保留可见实测段和手绘段、启用的连接线及再导入元数据，不含隐藏段、历史版本或项目；无法解析段清单的旧成员保留原字节并逐项警告。schema 2 沿用原字节导出。完整恢复请使用 `archive full-backup`：通过 SQLite 在线备份取得包含 WAL 已提交内容的一致快照，核验完整性、外键、每个对象的字节哈希和展示设置，再发布到新的 `.sqlite3` 文件，拒绝覆盖。`restore-backup` 核验后仅恢复到新目录或空目录，保留备份源。备份、恢复及迁移都要求先完成待恢复文件操作。

完整备份保留库身份、所有版本及项目状态，按 `storage_revision` 记录快照。备份完成后可复制到异地；配置、外部媒体及瓦片不在数据库备份中。push/delete 不自动刷新任何导出。

schema 3/4 聚合 KML 按原分类、文件名年月及名称组织；桌面保留年/月层次，手机版按成员分组。两者使用同一展示规则并保留混合 gx:Track / LineString、时间、高程、样式及扩展字段；跨成员 XML ID 加前缀并同步引用。逐成员解析校验后组合，全集可以大于单文件读取上限；单次再导入仍受 128 MiB 限制。未分类、无文件名日期及无法生成展示的成员明确警告，保留在数据库中。schema 2 沿用原有聚合格式。展示 KML 无法恢复被隐藏的段和版本历史。

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

只恢复所有归档 KML 的路径和原始字节。数据库 ID 重新生成，解析索引按需重建。不恢复地图项目、操作历史、未完成文件意图、瓦片缓存或配置。无需找到旧机器；Backup 文件夹也不是恢复前提。

删除会移除条目及其全部历史，不能用版本恢复接口找回。需要历史时，先把删除前的完整备份恢复到独立目录，再下载。以前下载的文件和备份不受删除影响。`archive undo` 已退役；`archive log` 仅显示旧 history.jsonl。`archive_history` 只为兼容旧配置保留。

## 中断恢复

push 在一个 SQLite 事务中写原始对象、成员和移动意图；事务提交后才处理外部文件。先在备份目标文件夹暂存、fsync，以不覆盖目标的方式发布，同步目录；确认源文件仍是同样字节后删除源。相同成员来自多个源路径时分别记录意图。

下载在只读快照内取得并校验原字节，发布到不覆盖的目标；不创建文件意图，不自动 recover，不改变展示状态或修订。删除只在数据库事务内完成，不生成下载文件；中途失败或进程中断时，条目、历史、对象及删除收据一起回滚。

push 会先尝试恢复未完成操作，也可以显式 `archive recover`。旧 schema 1/2 的已提交 pop 仍按原来的提取后删除语义收尾；旧 schema 3 的 pop 按提取后 withdrawn 的原语义收尾。两者都须先恢复才能迁移，不能把旧意图静默改成新删除。schema 4 只允许创建 push 意图。输出被占用或源内容变化时保留文件和意图并报错；处理冲突后再 recover，不要删除数据库以“清日志”。

原子发布使用同文件系统临时文件 + 硬链接（不覆盖）或 `os.replace`（导出）；需要支持这些操作的本地文件系统。SQLite 使用 WAL，不支持把正在写入的库直接放在不支持可靠锁的网络文件系统。崩溃可能留下 `.archive-import-*` / `.archive-export-*` / `.tracktool-*` 暂存文件；它们不是正式库/备份，不会被日常读取。Windows 缺少同等目录 fsync 保证，不能把本机 Linux 故障验证当作所有文件系统的断电认证。

## 地图与项目

`tracktool-map --archive /tracks/archive.sqlite3` 或 `--archive /tracks`。目录浏览器选择 `archive.sqlite3`；旧 ZIP 路径仍可定位同目录的库，但不再读取 ZIP。

顶栏「保存」首次命名后写数据库项目，之后直接更新当前项目；「项目 → 打开项目」提供可搜索列表。「另存为」创建另一份，同名覆盖需确认；项目名称与图片标题独立。新版项目 JSON schema 3 固定 archive_id、entry_id、version_id、presentation_id 和 SHA-256，可携带独立展示覆盖及其校验值；还保存相机、底图/样式、地名模式、标题、画框、输出尺寸及既有资源版本；不存瓦片。库中产生新版本不会改变已有项目。项目段设置可覆盖连接、顺序和忽略项；“采用库中当前版本并重置项目覆盖”才会更新引用。原有状态校验和资源版本确认仍适用。

项目 JSON 兼容 schema 1/2。旧 path + sha256 仅关联唯一的首版基线，保留旧版不自动连接的画面；缺失或歧义会阻止保存和导出，需明确重新选择。schema 3 校验库身份和版本所属，即使条目已被重组替代仍可读取历史；不会仅凭同名路径跟随新库。JSON 只保存引用，跨机器复现应同时恢复完整 SQLite 备份。展示 ZIP 再导入会产生新身份，不能恢复原项目引用。

地图全屏、分段、画框预览、来源署名、PNG 和资源版本检查保持。轨迹原坐标为 WGS84，Google 中国底图的显示变换留在前端，不写回原始对象或索引。拖动、缩放、颜色、线宽和换源不调用 KML 解析；既有网络连接池、下载去重、并发限制、独立瓦片缓存与平滑换源实现保持。

## 表结构与事务边界

存储位置为 `<archive_path>/archive.sqlite3`，活动连接可能产生同目录 `-wal`/`-shm`。新库使用 `PRAGMA user_version=4`；已有 schema 2/3 可继续读取，普通打开不升级。`archive migrate` 先生成同目录、名称含 UUID 的完整备份，再在独占事务内依次执行 1→2→3→4（已有 schema 3 直接 3→4）。备份期间发生并发修改会拒绝本次迁移；DDL、基线写入、外键及字节校验失败均回滚。已有 ID、路径、分类、原对象、缓存和项目状态保留；旧条目各建一份 migration_baseline，旧段默认不连接，不自动重组轨迹。无法解析的原文仍保留并标记 manifest unavailable。迁移推进一次 revision，使旧导出及概览过期。

| 表 | 职责、约束与关联 |
| --- | --- |
| `archive_meta` | 库身份、revision、storage_revision、最近 ZIP/聚合导出记录。 |
| `kml_objects` | SHA-256 文本主键，zlib 压缩的完整原始字节、codec 检查和非负原始大小；读取原件时验证长度和哈希。 |
| `archive_entries` | 稳定身份、唯一路径、分类/日期、当前版本及展示指针、state、generation。当前元数据必须匹配版本；仅专用删除事务可删除，更新代次必须加一。 |
| `track_versions` / `track_segments` | 不可变内容版本及段清单；SHA 引用原对象，段保存 XML 元素定位、顺序、类型、点数及时间状态，不另存坐标。 |
| `track_presentations` | 不可变设置快照与规范化 SHA；全段顺序、忽略项和连接覆盖由统一校验器检查。 |
| `track_operations` / `track_operation_inputs` / `track_operation_effects` | 操作、请求幂等键、输入版本与条目前后状态；多输出同事务提交，支持组级恢复和冲突拒绝。 |
| `track_segment_sources` / `track_source_locations` | 段来源、点范围、证据、外部位置和原件哈希；约束范围及来源无环。 |
| `active_archive_entries` | 只呈现 active 条目的当前版本；目录、普通读取、总览和原字节导出共用。 |
| `kml_index` | (sha256, parser_version) 复合主键、对象外键级联删除；状态 ok/error、元数据 JSON、几何 BLOB 和错误信息。解析失败同样存状态；按需建索引，新版替换该内容的过期派生索引。 |
| `map_projects` | BINARY 名称主键；完整已验证状态 JSON、UTC 更新时间及 generation。P1 保留现有 JSON，引用仍是成员路径+内容指纹而非内部 ID；不设强外键，以便缺失成员时明确提示并重新关联。 |
| `track_deletions` / `track_operation_deletions` | 不可变删除收据及共享操作失效标记；条目 ID 不再强引用已删实体，不保留其 KML。重复删除返回原结果；涉及已删成员的操作不能重放或整组撤销。 |
| `file_operations` | 短期 UUID 意图；仅 push、成员外键、内容外键、源/目标绝对路径、expected_generation；成员索引、(entry_id, source) 唯一索引。成功完成就删除。 |
| `export_receipts` | (target, kind) 主键；区分 KML ZIP、集合、完整备份，后者保存 storage_revision。记录本身不推进修订。 |

每次操作创建自己的连接，保持默认线程检查，不跨线程共享。所有连接启用外键、30 秒 busy_timeout、FULL synchronous；WAL 允许快照读与单写者并行。读事务 `BEGIN`，写事务先 `BEGIN IMMEDIATE` 获取写入权；正常提交、异常回滚，finally 关闭连接。HTTP 工作线程和 EXIF 工作线程各自打开连接，不把连接缓存到 MapWorkspace。地图保存从编排层调用项目存储，渲染层完全不认识归档业务。

读取归档目录/几何在一个读快照中；首次派生解析通过另一个短连接写索引，原快照在并发删除后仍能读原字节。若对象已被删除，就返回本次结果但不把对象复活。多进程同时第一次解析可能重复计算，唯一键收敛为相同派生结果；日常已有索引直接读取。

解析器版本 3、序列化版本 1：zlib 压缩 JSON，分段内数组以 Base64 编码的**小端**二进制保存。经纬高程 binary64；时间 signed int64 UTC 微秒。原始更高精度时间文本仍在无损对象中，派生时间按现有规则截到微秒。整段没有海拔/时间用 null；局部缺海拔为 binary64 NaN，零高程仍为零；gx:Track 的时间与坐标数量不匹配，或数量匹配但存在空时间槽时，该段全部按无时间轨迹处理，保留全部坐标及高程，不截断、不猜测配对；其他段的有效时间不受影响。数量匹配的非空时间格式非法仍报错。原始时间标签完整保存在原文中；旧版索引（包括错误状态）在读取时自动重建。每个 Placemark 的 LineString/gx:Track 独立成段，保留顺序、标识和单点线。不为每个 GPS 点建立 SQL 行，也不使用 pickle。

派生元数据包括文档名称、原活动标签、轨迹/段/点数量、实际最早/最晚轨迹时间、是否有海拔。它与归档分类、文件名日期分开。未选中的坏 KML 不影响目录；选中失败明确报告，绝不静默丢失原件。仅有 Point/Polygon 的文件及混合文件中未支持的几何不供地图显示，但原件完整保留。

P2 已实现段编辑和展示求值核心，继续使用 schema 4，无新增表。保留段沿用内部 ID；拆分的子段获得新 ID，来源表记录父版本、父段和点范围。只改连接、顺序或忽略项时，仅新增展示快照，复用内容版本和原字节。数据库准备接口只读，发布仍由版本服务在事务中检查来源并提交。

P3 已接入网页“库内行程编辑”和 `track` CLI：持久预览保存在网页状态目录的 `tasks.sqlite3`，不改归档；应用校验清单/产物哈希，在归档事务内重查来源后切换版本。预览有效期 24 小时；成功提交结果保存在归档操作记录，预览清理后仍可用同一请求键重试。独立行程拆分一次提交所有新条目并将原条目设为 superseded；整组撤销检查全部成员，恢复原行程并将本次新增条目设为 source_only。

连接/忽略设置已统一用于编辑预览、日常全库地图、固定历史项目及展示 KML/PNG 导出。新工作流要求 schema 4，普通打开不自动迁移。`to-multigeom` 已移除，历史记录及已有产物仍可读取。

## 明确限制与验证

ZIP 导入拒绝重复完整路径、绝对路径、空段/`.`/`..`、反斜杠、控制字符、冒号、符号链接、非 KML 文件（目录项可以存在）；发现就整次失败，不悄悄跳过。非 KML 附件不属于本归档格式。ZIP 文件夹条目的元信息不保证恢复。导入不强制 XML 可解析；CRC 正确但 XML/几何坏的成员仍可完整保存，地图选择时报错。ZIP 无外部已知哈希时不能发现“内容已被他人改过且重新计算了 CRC”的修改，导入校验不等于来源认证。

地图单次最多 200 个成员、200 万点，单成员解压上限 128 MiB；原始库/ZIP 导出无该地图上限。仍需足够磁盘空间容纳暂存导出/导入；一个超大 KML 的压缩/解析目前在内存中完成。

验证记录和测量见 [SQLite 验收](sqlite-validation.md)，改造前行为见 [兼容性基线](sqlite-baseline.md)。

删除先检查其他条目的段来源、操作输入及项目引用（固定 ID 或旧 path+SHA）。存在依赖会返回具体轨迹/项目，处理后重试；自己拥有的历史不会成为永久阻塞。应用在写事务内再次核对 archive_id、generation、版本、展示、SHA 和依赖；只清理所属历史及最终无引用的内容和缓存，保留共享操作的其他成员。普通连接仍禁止直接 DELETE 历史；专用事务以连接内函数限定可删除的表和行，不在数据库中保存通用绕过开关。

整条 KML 的临时可见性继续使用勾选；没有独立退出展示操作。`superseded`、`source_only` 和兼容的 `withdrawn` 仅服务内部来源和组级恢复。旧 pop 的新请求、重试和执行入口已移除；历史任务记录和已有产物仍可读取。
