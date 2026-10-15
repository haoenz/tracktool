# 程序接口与 Python 调用替代

2.x 不再提供 `import tracktool` 的 Python 包。业务 CLI 见 [CLI 说明](cli.md)，`pop` 与 `to-multigeom` 已移除；新增 `track` 命令用于版本化编辑。HTTP 供本地网页工作流使用。Node 包入口和 `data` JSON 命令用于只读轨迹/归档调用方。

## Node API

使用 ESM，包内包含 `.d.ts` 类型声明：

```ts
import { readTrackData, openArchive, encodeTrackData } from 'tracktool';

const data = await readTrackData('/数据/轨迹.kml');
for (const track of data.tracks) {
  for (const segment of track.segments) {
    console.log(segment.longitude, segment.latitude, segment.time_us);
  }
}
const archive = openArchive('/数据/归档');
try {
  const entries = await archive.listEntries();
  const bytes = await archive.readBytes(entries[0].entry);
  const { data, sha256 } = await archive.readTrackData(entries[0].entry);
  console.log(bytes.length, sha256, JSON.stringify(encodeTrackData(data)));
} finally {
  await archive.close();
}
```

| Python 旧接口 | 2.x 替代 |
| --- | --- |
| `read_track_data(path)` | `await readTrackData(path, signal?)` |
| `track_data_from_tree(lxmlTree)` | 将 XML 字节保存为输入文件再读取；不暴露 WASM DOM 的生命周期 |
| `open_archive(...).list_entries()` | `await openArchive(...).listEntries()` |
| `read_bytes(entry)` | `await archive.readBytes(entry, signal?)` |
| `read_track_data_with_fingerprint(entry)` | `await archive.readTrackData(entry, signal?)`，返回 `{ data, sha256 }` |

归档输入接受目录、`.sqlite3` 或旧 ZIP 所在目录定位方式；ZIP 需显式 import，不隐式解压创建数据库。成员完整路径精确匹配。每个读取操作使用独立一致 SQLite 快照；不能把多次调用当作同一个长事务。可以写派生索引，但不改原字节或内容修订。取消会终止相关 worker，`close()` 或 `await using` 释放资源。

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

Python 调用方只需用自己的 `subprocess.run([...], check=True, capture_output=True)` 调用上述命令并 `json.loads` 读取 stdout；应用本身不再依赖 Python。写入操作继续用原有业务 CLI，未给旧 Python 内部 Context/文件对象提供兼容垫片。

## 本地 HTTP

网页路由：`/map`、`/archive`、`/tracks`、`/media`、`/tasks`、`/settings`。访问页面后，HTML 的 `meta[name="tracktool-token"]` 提供本次进程会话 token，API 请求必须带 `X-Tracktool-Token`，同源 Host/Origin 检查不变；重启后重新取 token。

主要任务端点：

| 请求 | 作用 |
| --- | --- |
| `GET /api/work/bootstrap` | 文件范围/归档/公开配置 |
| `POST /api/work/preview` | 提交 `{operation,inputs,archive?,output?,options}`，返回持久任务 |
| `GET /api/work/tasks/:id` | 状态、修订、进度、事件和结果 |
| `POST /api/work/tasks/:id/apply` | 确认已完成且未过期预览 |
| `POST /api/work/tasks/:id/cancel` | 请求体 `{revision}`，避免取消旧状态 |
| `POST /api/work/tasks/:id/retry` | 普通任务建立新预览；版本编辑 apply 任务以原请求键重试，先回放已提交结果 |
| `GET /api/work/tasks/:id/download?index=0` | 下载该任务登记的结果文件 |

HTTP 契约由 `src/shared/work.ts` / `contracts.ts` 定义，面向本地单用户应用，不是公网身份认证方案。上传暂存、15 分钟预览、重试及取消边界见[使用说明](typescript-development.md)。

## 版本化轨迹编辑

新增请求的权威 schema 在 `src/shared/track-edit.ts`。轨迹路由只访问后台固定库，拒绝请求中的 SQLite 路径；需要 schema 4，不隐式升级。读取历史和原字节不恢复活动状态，也不重建索引。

| 请求 | 作用 |
| --- | --- |
| `GET /api/tracks?search=…&cursor=0` | 活动行程目录，每页 200 条 |
| `GET /api/tracks/:entryId?cursor=0` | 当前引用、展示设置及段清单，每页 500 段 |
| `GET /api/tracks/:entryId/versions?cursor=0` | 历史版本，每页 50 个，包含展示快照 |
| `GET /api/tracks/:entryId/versions/:versionId?presentation_id=…` | 固定历史版本的段与展示 |
| `GET /api/tracks/:entryId/versions/:versionId/raw` | 所属历史版本原字节下载 |
| `GET /api/tracks/:entryId/sources?cursor=0` | 来源位置与段来源，每类每页 100 项 |
| `GET /api/tracks/operations/:operationId` | 操作组前后引用及删除失效状态 |
| `GET /api/tracks/:entryId/geometry` | 当前展示的有界几何，用于编辑地图 |
| `POST /api/tracks/detect` | 固定目标、段及阈值的候选断点/漂移范围，不改内容 |
| `POST /api/tracks/edit-previews` | 提交 EditRequest，返回 202 `{task_id,preview_id}` |
| `GET /api/tracks/edit-previews/:previewId` | 已完成的持久预览清单和 SHA |
| `GET /api/tracks/edit-previews/:previewId/geometry?index=0` | 指定输出的展示几何 |
| `GET /api/tracks/edit-previews/:previewId/raw?index=0` | 指定输出完整 KML |
| `POST /api/tracks/edit-previews/:previewId/apply` | 提交 EditApply，返回 202 `{task_id}`；结果与冲突通过任务状态读取 |

EditRequest 为 `{schema:1,archive_id,target,sources:[],operation}`；target 含 entry_id/version_id/presentation_id/generation/sha256，额外来源固定历史引用省略 generation。operation 使用 kind 判别，支持 split_segment、prune、reverse、draw、compose、presentation、split_journey、restore_version；restore_group 使用 `{schema:1,archive_id,operation:{kind:"restore_group",operation_id,expected:[完整引用]}}`。未知字段拒绝。

EditApply 只含 `{schema:1,archive_id,preview_id,preview_sha256,request_key}`，路由 ID 必须一致，不接受客户端输出 KML。预览 24 小时有效；提交后的幂等结果不随预览过期。任务错误可带 SOURCE_CHANGED、PREVIEW_EXPIRED、PREVIEW_CHANGED、IDEMPOTENCY_CONFLICT、RESTORE_DEPENDENCY_CHANGED。同步预览读取的过期为 410、冲突为 409，异步应用失败则在任务 error 中报告。复用旧任务下载不表示允许执行已退役操作。

## 项目展示与导出

项目 schema 3 的每条 track 含 `entry/sha256/archive_id/entry_id/version_id/presentation_id`，可加 `override:{settings,sha256}`。`settings` 使用同一 PresentationSchema；服务端验证规范化设置哈希、内容 SHA、库身份及版本所属。schema 1/2 的 path + sha256 仅解析唯一基线，并使用不自动连接的兼容覆盖；无法关联时返回逐条错误，不静默采用当前版本。

| 请求 | 作用 |
| --- | --- |
| `POST /api/project/presentation` | `{state,entry_id,settings}` 返回重新求值后的项目；settings 为 null 时恢复固定展示快照，仅改变返回的项目，不写库默认设置 |
| `POST /api/project/update-track` | `{state,entry_id}` 显式采用该活动行程当前版本/展示，并清除该条项目覆盖 |
| `POST /api/export-kml` | 项目 state，返回 `{job}`；按固定引用及项目覆盖导出 |
| `GET /api/jobs/:id/kml` | 下载登记的展示 KML，不接受任意服务器输出路径 |

导出任务为进程内结果，至多保留 5 个，后续提交会清理超过 15 分钟的已完成任务；重启失效。项目 KML 单次最多 200 条、128 MiB。PNG 使用同一份固定项目几何。原字节读取及媒体匹配不应用展示覆盖；生成连接线没有采样时间，不参与媒体匹配。
