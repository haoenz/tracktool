# 程序接口

业务命令见 [CLI 说明](cli.md)。HTTP 供本地网页工作流使用，Node 包入口和 `data` JSON 命令用于只读轨迹与归档调用。

## Node API

使用 ESM，包内包含 `.d.ts` 类型声明：

```ts
import { readTrackData, openArchive, encodeTrackData } from "tracktool";

const data = await readTrackData("/数据/轨迹.kml");
for (const track of data.tracks) {
  for (const segment of track.segments) {
    console.log(segment.longitude, segment.latitude, segment.time_us);
  }
}
const archive = openArchive("/数据/归档");
try {
  const entries = await archive.listEntries();
  const bytes = await archive.readBytes(entries[0].entry);
  const { data, sha256 } = await archive.readTrackData(entries[0].entry);
  console.log(bytes.length, sha256, JSON.stringify(encodeTrackData(data)));
} finally {
  await archive.close();
}
```

归档输入接受目录或 `.sqlite3` 文件；ZIP 需显式 import，不隐式解压创建数据库。成员完整路径精确匹配。每个读取操作使用独立一致 SQLite 快照；不能把多次调用当作同一个长事务。可以写派生索引，但不改原字节或内容修订。取消会终止相关 worker，`close()` 或 `await using` 释放资源。

`TrackData` 保留 source、name、track_tags、start_name、end_name，feature 的 index/placemark_id/name 和各 segment 边界。坐标为 `Float64Array`，时间为 `BigInt64Array` UTC 微秒；无整个数组为 `null`，部分高程缺失为 `NaN`，零高程仍是零。返回数组可由调用方修改。`readTrackData` 单文件上限 128 MiB，保持 XML 严格解析；绘图另有 200 万点/200 成员限制。

包只承诺根入口的这些 API；`dist/node/infrastructure/**` 属内部实现，不作为稳定调用接口。异常 `AppError` 包含 code 与业务消息；不要依赖完整消息的字面匹配。

## JSON v1 / 其他语言

```sh
tracktool data track '/数据/轨迹.kml'
tracktool data entries '/数据/归档'
tracktool data track '/数据/归档' --entry 'Default/2026-10/2026-10-01 徒步.kml'
```

成功仅在 stdout 输出一个 JSON 对象；错误在 stderr，非零退出。`data track` 包含 `schema: 1` 和轨迹数据，归档读取额外包含同一快照的 `sha256`。`data entries` 为 `{ schema: 1, entries: [{entry,name,kind,date}] }`。

`encodeTrackData()` 使用相同 JSON 格式：typed array 转普通数组，`time_us` 为十进制字符串；局部 NaN 海拔转 `null`，整个无高程/时间数组仍为 `null`。跨语言接收方必须将微秒字符串转换为任意精度/64 位整数，不要先转浮点数。

Python 调用方只需用自己的 `subprocess.run([...], check=True, capture_output=True)` 调用上述命令并 `json.loads` 读取 stdout；写入操作使用业务 CLI。

## 本地 HTTP

网页入口为 `/map`；面板通过 `panel` 查询参数选择。访问页面后，HTML 的 `meta[name="tracktool-token"]` 提供本次进程会话 token，API 请求必须带 `X-Tracktool-Token`，同源 Host/Origin 检查不变；重启后重新取 token。

主要任务端点：

| 请求                                         | 作用                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/bootstrap`                         | 地图资源、公开配置与已保存的浏览地图样式                                                                                   |
| `POST /api/display`                          | 提交 `{style}`，保存浏览地图样式；文件位于状态目录（默认 `~/.local/state/tracktool/display.json`）                         |
| `GET /api/work/bootstrap`                    | 文件范围/归档/公开配置                                                                                                     |
| `POST /api/work/preview`                     | 提交 `{operation,inputs,archive?,output?,options}`，返回持久任务；网页 ZIP／聚合 KML 导出拒绝 `output`，由后台分配临时目录 |
| `GET /api/work/tasks/:id`                    | 状态、修订、进度、事件和结果                                                                                               |
| `POST /api/work/tasks/:id/apply`             | 确认已完成且未过期预览                                                                                                     |
| `POST /api/work/tasks/:id/cancel`            | 请求体 `{revision}`，避免取消旧状态                                                                                        |
| `POST /api/work/tasks/:id/retry`             | 普通任务建立新预览；版本编辑 apply 任务以原请求键重试，先回放已提交结果                                                    |
| `GET /api/work/tasks/:id/download?index=0`   | 下载该任务登记的结果文件；临时导出已下载或已清理后需重新导出                                                               |
| `POST /api/work/tasks/:id/download-complete` | 浏览器完整接收临时导出后提交 `{index}`，幂等记录下载完成并删除该文件                                                       |

地图样式仅包含底图、深浅配色、地图要素、叠加层和电力图层设置；轨迹样式不提供自定义配置。样式与出图文档按当前字段解析，未支持的字段不会保留到保存或导出结果中。

`archive:push` 支持 `options.importFiles: [{path, tag?, name?}]`：每个 `path` 必须唯一且属于本次 `inputs`，名称必须为不含路径分隔符的 KML 文件名，`tag` 必须是配置中已有的活动标签。逐文件标签会写入该文件的 `TrackTags`（网页上传场景即其暂存副本），并据此推导 `Default`、`Train` 或 `Flight` 分类；未指定时沿用文件原有标签。校验和实际导入使用同一设置。提交成功后，若 `auto_fill_locations` 未关闭且已配置 Google API key，会自动补全本批新入库轨迹的起终点行政区；该步骤不阻塞提交结果，失败只记录任务日志。导入结果的 `import_items` 包含 `entryId`，可直接打开轨迹详情。同一个入库预览重复调用 `apply` 会返回原提交任务，便于网络中断后查询结果。

网页 ZIP／聚合 KML 导出的 `output.temporary` 为 `true`。客户端应在完整接收文件后调用 `download-complete`，不能在仅收到响应头时确认。任务的 `downloadedFiles` 记录已确认的文件索引，`exportsCleaned` 表示整批临时文件已清理；未确认的结果保留最多 24 小时，下载中的文件暂缓清理，服务重启后继续清理到期结果。该机制不处理 CLI 输出或非临时文件。

HTTP 契约面向本地单用户应用，不是公网身份认证方案。上传暂存、预览、重试及取消方式见[网页使用说明](web-usage.md)。

## 版本化轨迹编辑

新增请求的权威 schema 在 `src/shared/track-edit.ts`。轨迹路由只访问后台固定库，拒绝请求中的 SQLite 路径；归档结构必须为 schema 10。读取历史和原字节不恢复活动状态，也不重建索引。

| 请求                                                             | 作用                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/tracks?search=…&cursor=0`                              | 活动行程目录，每页 200 条                                        |
| `GET /api/tracks/:entryId?cursor=0`                              | 当前引用、展示设置及段清单，每页 500 段                          |
| `GET /api/tracks/:entryId/tag?version_id=…`                      | 指定版本原始 KML 中的活动标签                                    |
| `GET /api/tracks/:entryId/history?cursor=0`                      | 操作时间线，每页 50 条，包含操作名称、当时完整状态和当前状态标记 |
| `GET /api/tracks/:entryId/versions?cursor=0`                     | 历史版本，每页 50 个，包含展示快照                               |
| `GET /api/tracks/:entryId/versions/:versionId?presentation_id=…` | 固定历史版本的段与展示                                           |
| `GET /api/tracks/:entryId/versions/:versionId/raw`               | 所属历史版本原字节下载                                           |
| `GET /api/tracks/:entryId/sources?cursor=0`                      | 来源位置与段来源，每类每页 100 项                                |
| `GET /api/tracks/operations/:operationId`                        | 操作组前后引用及删除失效状态                                     |
| `GET /api/tracks/:entryId/geometry`                              | 当前展示的有界几何，用于编辑地图                                 |
| `POST /api/tracks/detect`                                        | 固定目标、段及阈值的候选断点/漂移范围，不改内容                  |
| `POST /api/tracks/edit-previews`                                 | 提交 EditRequest，返回 202 `{task_id,preview_id}`                |
| `GET /api/tracks/edit-previews/:previewId`                       | 已完成的持久预览清单和 SHA                                       |
| `GET /api/tracks/edit-previews/:previewId/geometry?index=0`      | 指定输出的展示几何                                               |
| `GET /api/tracks/edit-previews/:previewId/raw?index=0`           | 指定输出完整 KML                                                 |
| `POST /api/tracks/edit-previews/:previewId/apply`                | 提交 EditApply，返回 202 `{task_id}`；结果与冲突通过任务状态读取 |

EditRequest 为 `{schema:1,archive_id,target,sources:[],operation}`；target 含 entry_id/version_id/presentation_id/generation/sha256，额外来源固定历史引用省略 generation。operation 使用 kind 判别，支持 split_segment、prune、draw、compose、presentation、split_journey、restore_version；restore_group 使用 `{schema:1,archive_id,operation:{kind:"restore_group",operation_id,expected:[完整引用]}}`。未知字段拒绝。

EditApply 只含 `{schema:1,archive_id,preview_id,preview_sha256,request_key}`，路由 ID 必须一致，不接受客户端输出 KML。预览 24 小时有效；提交后的幂等结果不随预览过期。任务错误可带 SOURCE_CHANGED、PREVIEW_EXPIRED、PREVIEW_CHANGED、IDEMPOTENCY_CONFLICT、RESTORE_DEPENDENCY_CHANGED。同步预览读取的过期为 410、冲突为 409，异步应用失败则在任务 error 中报告。

## 出图与导出

`POST /api/print` 接收 `{document}`。document 为 `tracktool-print` schema 1：`archive`、`title`、`camera`、`frame`、`output`、`style` 和 `tracks:[{entry,sha256}]`。服务端按当前轨迹库解析 tracks（仅按 entry 路径匹配），缺失轨迹跳过；然后用概览矢量瓦片渲染 PNG，不再读取完整工程或完整轨迹。返回 `{job,warnings}`；轨迹缺失、更新或 archive 路径不同时返回提示，始终使用服务当前配置的轨迹库。

| 请求                           | 作用                                |
| ------------------------------ | ----------------------------------- |
| `POST /api/print/check-title`  | 校验标题长度、控制字符和字体字形    |
| `POST /api/print`              | 提交出图文档，返回 `{job,warnings}` |
| `GET /api/jobs/:id`            | 查询导出进度和结果摘要              |
| `GET /api/jobs/:id/png`        | 下载 PNG                            |
| `GET /api/exports?archive=...` | 列出当前进程内最近的导出结果        |

导出任务为进程内结果，至多保留 5 个，已完成任务 15 分钟后清理；重启失效。出图直接使用当前地图样式和轨迹库可见性，服务器不保存工程或草稿。展示 KML 仍由轨迹库聚合导出和 CLI 单条导出提供。

### 轨迹分析缓存

`GET /api/tracks/:entryId/analysis?sha256=<内容哈希>` 返回该条目所属内容版本的统计和抽样曲线。每次请求均检查内容与条目的归属，缓存命中也不能读取其他条目的任意对象。

使用 `track_analysis_cache`，以 `(sha256, parser_version, analysis_version, params_hash)` 定位；命中不解析原始 KML。同进程并发未命中共用一次计算；独立进程由联合主键保证不重复存行。结果成功后短事务写入，计算失败不落库；损坏缓存重算后替换。写入失败也返回计算结果。

前端收到结果之前显示“计算中...”，计算成功但必要数据缺失时显示“无数据”，请求失败显示“计算失败”并允许重试。已有前端缓存的值不被加载占位覆盖。

新入库和编辑后发布的新内容版本，会于发布事务内完成统计计算并写入缓存；相同内容与算法参数复用现有缓存。正常可解析轨迹的统计写入失败会回滚本次发布，避免入库成功但统计未保存。为兼容原始文件归档，无法解析的导入成员仍保留原字节，不伪造统计。

展示设置 `settings` 包含 `{schema:1,order,ignored,gaps}`；`gaps` 每项为 `{from,to,reason}`，`reason` 只接受 `tunnel` 或 `other`。缺少记录表示未分类；不接受 `default_connect` 或逐处 `connect`。显隐偏好不属于编辑请求。
