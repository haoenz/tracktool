# tracktool

旅行影像地理数据工具集：KML 轨迹管理与照片/视频 EXIF 地理标记。

**SQLite 存储升级**：日常 CLI、轨迹查询和地图统一使用 `archive.sqlite3`；ZIP 和聚合 KML 改为显式导出。旧归档请先按 [迁移、备份与仅凭 ZIP 恢复说明](docs/sqlite-storage.md) 操作。普通读取不会自动迁移。实现与验收见 [验证记录](docs/sqlite-validation.md)。

## 功能

- **KML 轨迹管理**：归档（SQLite 无损主存储 + ZIP 备份导出 + 桌面/手机聚合导出）、视图状态检查与重建、拆分、删坏点（手动两点 + `--auto` 自动清漂移）、合并、Google 高程回填（只认整轨没有高程的手绘轨迹）
- **EXIF 地理标记**：按拍摄时间与 KML 轨迹二分匹配写入 GPS、Google 高程/逆地理编码补全、时间平移、海拔偏移、MP4 转封装、媒体分类、缺失修复编排

- **交互式轨迹地图**：本地浏览器选轨迹、浅/深底图、行政城市标注、固定画框与标题、项目保存/恢复、PNG 导出（见下方专节）

## 安装

```bash
uv tool install .        # 或 pip install .
```

依赖外部工具：[exiftool](https://exiftool.org/)、ffmpeg（`to-mp4` 需要）。

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

# 日常操作后按需导出；只异地备份 Archive.zip 即可恢复归档 KML
tracktool archive status
tracktool archive backup
tracktool archive rebuild
# 中断后完成源文件搬移/提取
tracktool archive recover
```

`kml split` 按时间差选最近的轨迹点，距离相同时选较早的时间；支持 `Z` 和时区偏移，
不带时区时按 UTC 解释。选中的点归前一段，原文件保留，结果写入同目录的
`原名-Splited-1.kml`、`原名-Splited-2.kml`。多个切分时间落在同一点时只切一次；
如果最近的是最后一个轨迹点，会报错，避免生成空的后一段。

## 本地交互式轨迹地图编辑器

第一版是浏览器编辑器：选择归档轨迹、拖动地图、调整样式与画框、保存项目、导出 PNG 都在界面中完成。Python 服务默认监听 `127.0.0.1`，也可显式开启局域网访问；不需要账号、云数据库、前端构建服务或 LLM。

### 安装与启动

在本仓库中运行（Python 3.14+）：

```bash
uv sync --extra maps
# 安装匹配锁定版本的浏览器；避免清理其他项目的浏览器缓存
PLAYWRIGHT_SKIP_BROWSER_GC=1 uv run --extra maps playwright install chromium --only-shell
uv run --extra maps tracktool-map
```

自动打开 `http://127.0.0.1:8765`。如浏览器未打开，手动访问此地址。按 `Ctrl+C` 停止。无需 exiftool / ffmpeg。Linux 若提示缺少 Chromium 系统库，按 Playwright 提示安装发行版对应的依赖；安装系统包需要管理员权限。

也可用 `pip install '.[maps]'`、`playwright install chromium --only-shell`、`tracktool-map`。参数：`--port 8766` 更换端口；`--no-browser` 不自动打开浏览器；`--archive /path/to/archive.sqlite3` 可选预选归档；`--cache /path/to/cache` 指定可写缓存目录。启动器独立于旧 CLI，不加载或迁移 tracktool 配置。

局域网访问：

```bash
uv run --extra maps tracktool-map --host 0.0.0.0 --port 8765
```

其他设备打开 `http://<运行服务的电脑的局域网 IPv4>:8765`，例如 `http://192.168.1.20:8765`，不要在浏览器中填 `0.0.0.0`。如无法连接，检查同一网络及服务端防火墙是否允许 TCP 8765。也可 `--host 192.168.1.20` 只绑定指定网卡地址。归档浏览/读取仍发生在服务端电脑，项目和 PNG 下载到访问页面的设备；后台导出自动使用可连接的本机地址。没有账号认证，可访问此端口的局域网用户都能浏览服务端目录和读取轨迹归档，适用于可信局域网。

### 界面操作

页面以整屏地图为工作区，轨迹库、构图与样式为浮动窗口。点顶部「轨迹」「样式与画框」或窗口右上角「−」展开、收起；小屏幕一次展开一个窗口。默认隐藏画框，按整个可见窗口筛选和排布地名，浏览字号不随画框的预览比例缩小，署名位于窗口右下角。点地图下方「显示画框」进入成片预览：细边框与框外轻微遮罩标出导出范围，标题、地名和署名按 PNG 的固定逻辑画布排版；框外地图也可以拖动。再点「隐藏画框」返回整屏浏览，标题只在成片预览和导出中显示。两种视图的地名避让范围不同，显示的地名可能不同；PNG 始终使用成片预览的布局。面板开合、视图切换均不改变已保存的构图和实际导出范围，浮窗、边框与遮罩不会进入 PNG。

1. 点击「打开本地归档」，在目录浏览器中选择 `archive.sqlite3`。可直接输入目录再点「前往」。旧 ZIP 需先显式导入；地图不写集合，持久化解析索引保存在库中。
2. 用名称、开始/结束日期、类型筛选，勾选多条轨迹，或「选择筛选结果」「取消全部」。日期取自文件名；类型来自归档首层目录（普通/火车/飞机/未分类），不是 KML 活动标签。日期筛选会排除无日期文件，但不设置日期时仍可选它们。筛选不会取消已选的其他轨迹。
3. 点击「适应所选轨迹」，拖动地图、滚轮或 `＋/−` 调整视野。浅/深底图、统一颜色、线宽、地名模式均实时生效。默认浅/深底图不包含道路、水域、乡镇或景点文字；城市为独立标注层。新增的栅格地图可能自带文字，见下方说明。
4. 在「样式与画框」选择六种画框比例、输出长边像素，填写可选标题。画框边缘就是 PNG 边缘；不会截取浮动工具窗口。切换比例保留中心与缩放，可再次「适应所选轨迹」。窗口缩放仅改变预览显示大小。
5. 「保存到归档」按名称保存项目，「打开已存项目」恢复；「导出项目 JSON」与「导入项目 JSON」继续支持独立文件。换机器后先打开新库，再导入旧 JSON 并确认关联，逐条核对原始 SHA-256。项目不进入备份 ZIP，需要备份时另存 JSON。
6. 「导出 PNG」显示进度并自动下载；完成后也可点击「重新下载 PNG」。失败时不生成成功图片，检查提示后再次点导出。地图请求失败可点「重新加载地图 / 重试资源」；字体文件缺失或校验失败需重新安装，标题含字体不支持字符需修改标题。

异常条目不会悄悄消失：完整归档路径出现在错误提示中。有效几何仍可预览，但必须处理选择错误才能保存/导出。单次选择最多 200 条、200 万点，单个 KML 解压后最多 128 MiB。不带时间戳的线、单点段均支持；段与文件之间不连线。超出 Web Mercator 纬度 ±85.05112878° 的轨迹明确拒绝，地图交互不旋转、不倾斜。

### 画框、线宽与复现

逻辑画框固定为长边 960 CSS 像素：4:3 = 960×720，3:2 = 960×640，16:9 = 960×540，1:1 = 960×960，3:4 = 720×960，2:3 = 640×960。输出长边可设 480–4096，另一边按比例四舍五入。3 像素线宽在长边 1920 的输出中为 6 像素；城市字号、描边、标题、边距、署名同样按比例缩放。地名布局使用逻辑坐标，所以提高分辨率不增加地名数量。

导出在独立 Chromium 页面使用相同 `core.js` 和逻辑画框，按目标像素比例重新绘制 WebGL / Canvas；不会截图编辑器。等待本地字体加载、MapLibre `idle`、所有瓦片和 source worker、两帧标签排版，检查 HTTP/请求/地图/脚本错误后才截图，并检查 PNG 实际尺寸。超时返回失败。导出任务串行，结果最多保留 5 个/15 分钟，仅在内存中；刷新或重启后可重新导出。

项目 schema 1 记录归档绝对路径、完整归档成员路径、**原始 KML 字节 SHA-256**，以及状态、渲染源码/字体/地名数据指纹、MapLibre/Playwright 版本、底图数据版本。实际 Chromium 版本和标签布局由导出任务报告返回。源码和资源不同的旧项目会提示，需点击「确认使用当前资源版本」后另存。规则、输入和布局可复现；不同 OS、浏览器、GPU、DPR 的抗锯齿可能不同，**不保证跨环境逐像素一致**。

### 底图、字体与数据来源

- 默认底图：[OpenFreeMap](https://openfreemap.org/)，OpenMapTiles schema，来源 OpenStreetMap。公开服务不需要 key；[官方说明](https://openfreemap.org/quick_start/)支持自定义样式。[署名要求](https://openfreemap.org/#attribution)适用于静态输出。我们的样式只定义地物层，不继承服务方地名或 POI 图层。
- 首次联网获取 `https://tiles.openfreemap.org/planet` 的 TileJSON，缓存其带日期的瓦片路径；之后复用该版本。只有当前视野所需瓦片按需请求，默认总并发 8、单资源 16 MiB、磁盘瓦片缓存 1 GiB（SQLite 索引 LRU，可配置），不下载整省/全世界。默认缓存 `~/.cache/tracktool/maps`。已有瓦片可离线复用，但没有完整离线数据包。服务不可用时会报错，不用空白底图替代。
- 服务方旧快照可能撤下。停止服务后用 `tracktool-map --refresh-basemap` 获取新版本；已有项目会出现版本变更提示。自托管或其他兼容 OpenMapTiles 的 HTTPS TileJSON 可用环境变量 `TRACKTOOL_MAP_TILEJSON` 配合 `--refresh-basemap` 配置。schema 必须相同，且需同时设置 `TRACKTOOL_MAP_VECTOR_ATTRIBUTION` 为实际提供方要求的完整署名；用户负责检查该服务许可。样式独立放在 `static/styles.js`，字体声明在 `static/fonts.css`，数据源与缓存由 `drawing/resources.py` 管理。
- MapLibre GL JS **5.6.1** 的 JS/CSS、Noto Sans CJK SC **2.004** 完整字体随包分发；SHA-256 和来源 URL 在 `tracktool/drawing/data/assets.json`，许可证在 `static/vendor/`。无运行时 CDN 字体依赖。服务端 cmap 检查与浏览器字体加载共同阻止缺字导出。
- 地名是随包附带的全国数据快照，运行时不查询地名 API。来源为 [GeoNames CN.zip](https://download.geonames.org/export/dump/)，[字段定义](https://download.geonames.org/export/dump/readme.txt)、[Feature Codes](https://www.geonames.org/export/codes.html)，CC BY 4.0。来源文件指纹、适配器版本、字段证据和每条记录来源 ID 保存在 `data/cities-cn.json`。

**地名级别的明确规则与局限**：仅对 `country=CN` 实施中国大陆适配，`PPLC/PPLA` 标注首都和省级行政驻地，`ADM2/ADM3` 对应地级/县级行政单元；不使用 `city`、`town`、人口或 rank 推断行政级别，不采纳 PPL/PPLA4/PPLA5。ADM2 可用同一行政代码的上级驻地中文名与坐标；ADM3 始终用行政单元中文名，只有匹配完整行政代码的驻地才修正坐标，绝不用驻地乡镇名替换县名。无驻地匹配时使用 GeoNames 行政记录的代表点，可能是区域中心而非建成区中心。缺少行政代码/中文名的记录及「市辖区」等集合名被计数并排除。

当前快照含首都 1、省级驻地 30、地级 359、县级 2824 条；76 条缺行政代码、39 条缺合适中文名或属于集合名称。按级别确定字号、缩放阈值与优先级，再以稳定 ID 排序、画面范围筛选、碰撞避让，邻近同名择优，画框边缘不截半个地名。**GeoNames 不是当前官方行政区名录**，可能含旧名称、行政改制滞后、代表点不准确或漏项；港澳台及境外行政级别尚未适配，不伪装成全球县级分类，也不声称覆盖所有当代县级行政区。升级数据可显式下载新的 CN.zip 后运行：

```bash
uv run python scripts/build_map_cities.py /path/to/CN.zip tracktool/drawing/data/cities-cn.json
```

**额外自定义卫星数据源接口**独立于浅/深矢量底图和内置预设；未配置时不显示该自定义选项。若你有允许静态图片导出和本地缓存的 HTTPS XYZ 卫星服务，在启动前配置：

```bash
export TRACKTOOL_MAP_SATELLITE_URL='https://your-provider.example/imagery/{z}/{x}/{y}.jpg?key=YOUR_KEY'
export TRACKTOOL_MAP_SATELLITE_ATTRIBUTION='© 实际影像提供方及其要求的完整署名'
export TRACKTOOL_MAP_SATELLITE_VERSION='供应商/图层/数据版本'
uv run --extra maps tracktool-map
```

要求 WGS84/Web Mercator XYZ、256 像素瓦片、无附带文字。不要使用 GCJ-02/BD-09 瓦片，否则会与原始轨迹错位。URL 仅由服务端请求，凭据不写入项目；项目记录配置指纹与版本，图片保留配置署名。此接口与下面已接入的 Google/Bing 预设分开，用户提供的其他 URL 需自行验证。

### 二维码中的内置地图

已将项目根目录二维码图片中的 **10 项已验证可用的**配置固化为「底图」菜单选项，无需在界面扫码或编辑配置：

| 地图 | 选项 | 坐标 / 瓦片 |
| --- | --- | --- |
| Bing | 卫星 | WGS84，256px，QuadKey |
| Google | 卫星；混合小/大字体；地图小/大字体；地形小/大字体；路网小/大字体 | 此批 `gl=CN` 图层使用 GCJ-02；256/512px |

在「样式与画框 → 底图」直接切换。加载新底图时保留可交互的旧画面，并显示加载状态；新视野的地图、轨迹与城市标签全部就绪后一起替换。失败保留旧图和原项目状态，点击「重试资源」重试刚才选择的图源。连续选择只采用最后一次选择，加载期间暂时禁用保存与导出。纯路网选项是透明道路/文字图层，显示在纯色背景上；如需道路叠加影像，请选「卫星混合」。大字体使用原配置的 512px/scale=2 图层，归一化请求坐标，避免重复除以二。地图缩放上限为 18，低于此上限的来源按其原最大级别放大。

**文字控制**：Google 地图、混合、地形、路网的文字已经烧进瓦片，不能按行政级别过滤，也不能通过「地名：不显示」清除。该开关只控制 tracktool 自己叠加的城市层。需要严格无道路名、乡镇名和 POI 的成片，请使用默认浅/深矢量底图或无字卫星图；混合图可关闭叠加城市，减少重复文字。

**坐标适配**：本批 Google 中国图层在渲染边界将 WGS84 轨迹、城市和视野转换至 GCJ-02；拖动后的中心反向转换，项目与原 KML 一直保留 WGS84。切换底图不重新读取 KML，也不合并轨迹段。使用随包固定的 [gcoord 1.0.7](https://github.com/hujiulong/gcoord)（MIT），不是测绘精度保证。其国内转换范围是矩形判定，港澳台、国境附近及矩形内的邻国未验证，可能错误偏移；这些区域优先使用 WGS84 图源。自定义卫星接口仍要求 WGS84，不自动猜测坐标系。

二维码中的 OpenCycle 验证返回 HTTP 401，已从菜单和内置源目录移除，不再请求 Thunderforest，也不再读取此前提取的本机凭据。当前保留的 10 项内置图源无需本机密钥。

**来源和稳定性**：预设来自用户提供的 [奥维自定义地图配置](https://www.ovital.com/131425-2/)，静态目录在 `tracktool/drawing/data/basemaps.json`，记录源图片指纹、原配置字段和适配后的模板。Google/Bing 使用二维码中的网页瓦片接口，不是已申请的官方商业 API，当前可访问不代表永久免费、稳定或具备任意再分发授权。保留 Google、Microsoft Bing 署名；使用和发布输出应遵守相应提供方条款。地图数据在线更新，URL 中的版本标识不保证不可变；项目记录目录指纹、坐标库版本及缓存资源配置，不承诺重新联网后逐像素相同。缓存上限和并发限制与默认底图共用，栅格图片的格式与尺寸验证失败会中止加载/导出。

### 地图下载与缓存配置

默认总下载并发为 **8**，提供方上限为 Google **8**、Bing **4**、矢量 **6**、自定义卫星 **4**；同一提供方的不同内置图层共用上限。实际并发还受浏览器同源连接数限制。启动前可调整：

```bash
TRACKTOOL_MAP_DOWNLOADS=8 \
TRACKTOOL_MAP_PROVIDER_LIMITS='{"google":6,"bing":4,"vector":4,"custom":2}' \
TRACKTOOL_MAP_CACHE_MIB=1024 \
uv run --extra maps tracktool-map --cache /path/to/map-cache
```

并发整数范围 1–32；提供方 JSON 可以只覆盖部分默认值。缓存整数范围 1–16384 MiB，默认 1024 MiB。错误配置会在启动时报错。缓存容量是瓦片有效载荷上限，SQLite 索引、空闲页和 WAL 会占用少量额外空间；关闭时会 checkpoint，淘汰后逐步回收空闲页。不要在运行中删除数据库或 WAL。

- 固定工作线程从连接池独占借用 Requests Session，复用 HTTPS 连接；不跨线程同时使用同一 Session，停止服务时回收线程、连接和数据库。连接/读超时为 5/10 秒，流式响应有 20 秒检查期限和 16 MiB 大小限制。
- 同一图源、版本、内容配置和坐标的请求在**一个服务进程内**共享下载结果，预览和后台导出复用缓存及在途请求。最多排队 512 项；HTTP 429、500/502/503/504 和网络暂时失败最多重试两次，退避有上限。较长或日期形式的 `Retry-After` 直接提示稍后重试，不提前重试。重定向不转发凭据。
- 沿用随包 MapLibre 5.6.1 的可见瓦片排序和原生取消，不另造视野或预取算法。浏览器取消 HTTP 请求后，服务端约每 50ms 检查并跳过无人等待的排队项；取消一个消费者不会取消其他预览或导出。已经开始的下载会在超时约束下完成并缓存。预览与导出交替获得可用下载槽，避免导出一直等待。离开视野且尚未开始的请求不再占用上游网络。
- `tiles.sqlite3` 使用 LRU 索引、总大小计数和事务，下载与淘汰不扫描目录。启动时仅扫描一次旧 `*.tile`，先事务写入再移除旧文件，保留旧访问时间；命中时按原 URL 指纹匹配、验证格式/尺寸，再升级缓存键。新的事务写入中断后可恢复；无效缓存会删除并重新请求。不同 TileJSON 配置分开保存元数据；原默认 OpenFreeMap 元数据可复用。多个进程可共用磁盘索引，但跨进程不共享在途下载。
- 换源期间最多存在两个地图实例，因此会短暂增加 WebGL 内存占用。新实例跟随旧地图的拖动和样式编辑；就绪后原子替换底图、显示坐标系、轨迹、标签和署名。原 KML 与项目坐标保持 WGS84。导出仍等待目标视野、字体、地图和标签就绪，任何资源错误都中止出图。

这一批没有区域缓存按钮、离线批量下载、视野外围预取或新增地图源。内置字体仍为完整本地字体；首屏计时包含浏览器加载字体及 WebGL 初始化，连接优化无法消除这些开销。源码渲染指纹已经变化，旧项目仍需确认采用当前资源版本。

### 第一批加载性能验证（2026-10-13）

对照基线为 `6c2af68`，通过只读 `git archive` 副本运行，未切换工作分支。所有测试使用 `sandbox/map-performance/` 下独立的新缓存，没有清空用户缓存。真实 Chromium 149 / SwiftShader；Google 卫星，960×720、DPR 1，初始中心 WGS84 `[102.72,25.04]`、zoom 10。首屏从页面导航计至地图 idle、字体和标签就绪；TileJSON 启动准备不计入。热缓存为同一服务下新页面导航。每阶段计时后等待遗留下载排空再统计，避免把旧请求混入下一阶段。

| 同场景对照 | 修改前 | 修改后（默认 8） |
| --- | ---: | ---: |
| 冷首屏就绪 / 上游请求 / HTTPS 建连 | 3.056 s / 20 / 20 | 2.985 s / 20 / 6 |
| 热首屏就绪 / 上游请求 | 0.964 s / 0 | 0.938 s / 0 |
| 连续拖动缩放后回到热视野：恢复 / 整段上游请求 | 0.069 s / 54 | 0.046 s / 18 |
| 连续拖动缩放后到未访问视野：恢复 / 整段上游请求 | 8.534 s / 75 | 1.773 s / 38 |
| 新区域预览与 PNG 导出重叠：完成 / 上游 / 重复 | 3.989 s / 25 / 10 | 2.800 s / 15 / 0 |

拖动场景为每 60ms 改变中心与缩放、连续 10 次；恢复时间从最后一次移动结束起计。冷目标为 `[105.72,26.04]`，随后预览/导出共同访问 `[104.5,26.5]`。这次运行累计跳过 64 项过时排队请求。额外注入 300ms 上游延迟时，回到热视野的请求数从 54 降为 14，跳过 36 项，预览/导出重复数从 14 降为 0。浏览器验收还使用了真实鼠标拖动及滚轮。

上述是本机实测样本，**不是稳定提速比例**。另一次相同首屏对照为 3.503 s → 3.508 s；优化后 6/8/10/12 总并发的冷屏分别为 2.369/3.508/5.011/3.535 s，网络波动远大于并发数的区别，单浏览器同源下载实际只有约 6 个连接。更高并发没有展示稳定收益，因此默认选 8，为重叠消费者留少量余量；不声称这是所有网络的最优值。确定可复现的改进是连接复用、相同瓦片去重和跳过过时排队请求。

复跑（输出目录必须不存在，脚本自行启动本地服务）：

```bash
PYTHONPATH=. uv run --extra maps python scripts/measure_map_loading.py \
  --cold-pan --output sandbox/map-performance/measure-new
PYTHONPATH=. uv run --extra maps python scripts/measure_map_loading.py \
  --delay-ms 300 --output sandbox/map-performance/delayed-new
PYTHONPATH=. uv run --extra maps python scripts/verify_map_loading.py \
  --output sandbox/map-performance/browser-new
```

测量脚本记录每阶段秒数、上游尝试、HTTPS 建连、去重和跳过计数，并保存实际 PNG；`--delay-ms` 是明确标注的故障/延迟注入，不是正常网络成绩。详细对照 JSON 在 `before-cold-pan/`、`after-cold-pan/`；换源验收与图片在 `browser-complete-final/`（最后一轮复用 `browser-final/cache` 独立测试缓存）；冷缓存计时仍以上述测量目录为准。关键单测覆盖连接重试边界、并发上限、共享取消、导出公平性、失败后重试、淘汰、旧缓存迁移、多连接事务及进程中断恢复。

本批检查：pytest **933 passed, 2 skipped**；ruff、格式、mypy 和 4 条架构契约通过。实际浏览器验证连续换源、加载中拖动、失败保留原图、重试、项目保存重开，未产生页面脚本错误；全屏/画框、极区与低缩放窗口调整、移动端、PNG 标签/相机一致性回归通过。瓦片或字体故障均阻止 PNG，恢复后可导出；非整数 DPR 与分段图也通过。10 个内置源中 9 个在同一轮通过，大字体路网遇到一次浏览器请求失败并保留旧图，随后单独重试通过。已打开检查实际 PNG，地图完整、中文标签与署名存在、轨迹分段之间无连线。

### 模块边界与验证

`editor` 是本地 HTTP 入口、会话和任务管理；`map_workflow` 编排 `kml.archive_reader` 与独立 `drawing` 功能包；`drawing` 不导入 KML、集合、编排或入口。`archive_reader.read_track_data_with_fingerprint()` 从同一份字节生成数组与内容指纹，可选限制解压大小；旧 `read_track_data()` 的语义保持。几何缓存保留紧凑平行数组与分段，按原始内容 SHA-256 与解析器版本失效，内存最多 128 项/200 万点；SQLite 持久化索引供重启后复用。选中轨迹在绘图边界转为 MultiLineString/MultiPoint，点没有独立属性对象。配色、线宽、标题和拖动不访问 KML。导出、重开、保存会重新检查成员内容指纹；读取使用 SQLite 一致快照，可与归档写入并行。

`pyproject.toml` 的 import-linter 同时约束层级、绘图独立性和编排归档边界。会话 token、Host/Origin 检查防止其他站点借服务读取文件；局域网模式只接受实际接收连接的服务器 IP 对应的 Host，并继续校验同源请求，不提供任意服务器文件写入接口。JSON/PNG 由浏览器下载；保存项目只修改数据库的 map_projects，解析只写派生索引，原始成员、KML、备份和桌面/手机集合不变。

常规检查：

```bash
uv run --extra maps pytest
uv run --extra maps ruff check .
uv run --extra maps ruff format --check .
uv run --extra maps mypy
uv run --extra maps lint-imports
```

关键自动化覆盖完整归档成员身份、目录列表不解析 KML、无时间戳/单点/分段、日期线、投影界限、状态往返、缓存不重复解析、源内容变化/缺失，以及行政级别与驻地修正规则。实际浏览器验收另需联网与 Chromium；测试和示例图片不作为程序数据源。

复跑浏览器验收（先启动编辑器；选择不超过 200 条轨迹的短日期范围，输出使用独立目录）：

```bash
uv run --extra maps python scripts/verify_map_editor.py \
  --archive /path/to/archive.sqlite3 --from-date 2026-10-04 --to-date 2026-10-08 \
  --output sandbox/map-editor-qa/run
uv run --extra maps python scripts/verify_map_failures.py --output sandbox/map-editor-qa/run
```

第一条实际点击界面，验证筛选、多选/取消、浅深底图、颜色线宽、地名开关、拖动缩放、比例与像素尺寸、窗口变化、项目下载/重开、横竖 PNG，以及预览/导出的标签布局和视野相同；同时验证原归档 SHA-256 不变。第二条启动独立测试服务，注入缺瓦片/缺字体，检查失败不产生 PNG、恢复后重试、缺字标题拦截、非整倍数输出尺寸、会话边界和无时间戳多段示例。会在输出目录写入测试专用归档、PNG、项目和 JSON 报告。

2026-10-13 本机 Linux 验收：从 sandbox 的云南行程选择 13 条非飞机轨迹、20,405 点，实际检查 1920×1280 深色、1440×1920 浅色 PNG，确认中文、地名、边缘裁切与署名；另检查四段互不相连的真实导出图片。原归档内容指纹保持不变。Chromium 149.0.7827.55，OpenFreeMap 快照 `20261004_113936_pt`；全套 pytest **898 passed, 2 skipped**，ruff 检查/格式、mypy、4 条 import-linter 契约通过，wheel 验证包含所有运行时资源。验收产物留在被 Git 忽略的 `sandbox/map-editor-qa/final/`，未写入原件或归档集合。

2026-10-13 二维码图源增量验收：Google 9 项和 Bing 1 项成功加载；OpenCycle 的原密钥返回 HTTP 401，之后按要求移除该不可用选项。实际导出并检查 Google 卫星、Google 混合大字体、Bing 卫星的 1920×1280 旅行地图，以及 Google/Bing 古城近景，核对坐标对齐、中文标题与署名。图源切换不重新读取 KML；分段、预览/导出标签和中心一致，项目保存重开成功。原编辑闭环、全屏/画框、手机、缺瓦片/字体阻止出图和恢复重试回归通过。全套 pytest **913 passed, 2 skipped**，ruff、mypy、4 条架构契约通过。产物位于被 Git 忽略的 `sandbox/map-source-check/` 和 `sandbox/map-editor-qa/sources-regression/`。

图源验收脚本（需先在界面保存一个有轨迹的项目；仅验证保留的 10 项图源）：

```bash
uv run --extra maps python scripts/verify_map_sources.py \
  --project /path/to/tracktool-map.json --output /tmp/map-source-qa \
  --url http://127.0.0.1:8765
```

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

完整操作和结构说明见 [SQLite 存储文档](docs/sqlite-storage.md)：无损原始对象、分类与活动标签、文件名日期与实际时间、事务/连接/线程模型、短期移动日志、索引序列化及数据库迁移。

```bash
tracktool archive import-zip /old/Archive.zip /new/tracks
tracktool config set archive_path /new/tracks
tracktool kml push "2026-10-01 徒步.kml" --keep
tracktool archive status
tracktool archive backup              # SQLite → Archive.zip
tracktool archive rebuild             # SQLite → 聚合 KML
tracktool archive recover             # 完成中断文件操作
```

只有成员变化使备份过期，项目/索引更新不影响内容修订。push/pop 不改 ZIP/集合。`--zip` 保留为所在目录的定位方式，ZIP 本身可以不存在；不作为另一个可修改的真源。

`archive undo` 已退休，会明确报错并提示替代操作：pop 取回原件，push 重新归档，recover 完成中断，或把旧备份 ZIP 导入另一个新目录。`archive log` 仅查看保留的旧 history.jsonl。只备份 ZIP 即可在全新机器恢复成员路径和原字节；不承诺恢复项目、历史、内部 ID 或瓦片。

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

`tracktool.kml.archive_reader.open_archive` 接受 SQLite 文件、归档目录，或旧 ZIP 路径定位（只读同目录 SQLite，不读取 ZIP）。不依赖配置或 archive.json。

```python
from tracktool.kml.archive_reader import open_archive

with open_archive("/path/to/archive/archive.sqlite3") as archive:
    for entry in archive.list_entries():
        print(entry.path, entry.name, entry.kind)
    data, sha256 = archive.read_track_data_with_fingerprint("Default/2026-05/2026-05-01 徒步.kml")
    original_bytes = archive.read_bytes("Default/2026-05/2026-05-01 徒步.kml")
```

历史类型名 `ZipEntry` 保留，但代表数据库成员。路径精确匹配且大小写敏感；目录只查 SQL，不解析 KML。`kind` 为导入/入库时固定的归档分类，`data.track_tags` 为原活动标签。连接提供一致读快照，异常退出也关闭；返回的元数据和数组可独立使用。来源标签是 `<SQLite 路径>!/<成员路径>`。

几何以原始 SHA-256 和解析器版本持久化索引；重开数据库可直接读取，新增其他成员不使已有索引失效。读取可能写入派生索引，但不改成员修订或原件。解析失败明确报告并保存状态，原件仍可导出。详见 [数值精度、分段和缺失值约定](docs/sqlite-storage.md#表结构与事务边界)。

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

需要真实工具的用例打 `integration` 标记（`tests/test_e2e.py` 走完整链路：ffmpeg 造样本、exiftool 读写、轨迹从显式导入的 SQLite 归档读出），工具缺席时自动跳过。`MetadataBackend` 的两套实现（真实 exiftool 与内存替身）跑同一份断言（`tests/fixtures/backend_contract.py`），替身因此不能与真身漂移。
