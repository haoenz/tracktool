# 程序接口与 Python 调用替代

2.x 不再提供 `import tracktool` 的 Python 包。原有 34 个业务 CLI 命令继续可用；HTTP 供本地网页工作流使用。新的 Node 包入口和 `data` JSON 命令用于原只读轨迹/归档调用方。

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
| `POST /api/work/tasks/:id/retry` | 建立新预览，不自动写入 |
| `GET /api/work/tasks/:id/download?index=0` | 下载该任务登记的结果文件 |

HTTP 契约由 `src/shared/work.ts` / `contracts.ts` 定义，面向本地单用户应用，不是公网身份认证方案。上传暂存、15 分钟预览、重试及取消边界见[使用说明](typescript-development.md)。
