# AGENTS.md

给自动化编码代理（CodeBuddy、Codex 等）的项目说明。面向用户的说明在 README 和 `docs/`；本文件只记录改代码时需要知道的约束。

## 项目概览

KML 轨迹归档、地图编辑与出图工具。CLI 和网页共用同一套业务服务，单一 SQLite 轨迹库为权威数据源，网页地图瓦片和概览缓存是可重建的派生数据。

- 运行时：Node.js 26.x（本项目固定 26.11.1），pnpm 12.10.1，ESM。
- 语言/框架：TypeScript、React 19、Fastify、MapLibre GL、Tailwind CSS 4、shadcn/ui、oclif、better-sqlite3、Vitest、Playwright。
- 平台：Linux 为当前验收范围；macOS/Windows 未实测，不要假设可运行。
- 完整需求与交互细节见 `README.md`、`docs/web-usage.md`、`docs/cli.md`。

## 环境与常用命令

```sh
pnpm install --frozen-lockfile
pnpm build          # 清理并生成地图资源、tsc 到 dist/node、Vite 构建网页
pnpm typecheck      # 三套 tsconfig 全量检查
pnpm lint           # ESLint + dependency-cruiser 依赖边界
pnpm format         # 用 Prettier 格式化源码与配置
pnpm test           # Vitest，仅 tests/ts
pnpm test:e2e       # Playwright，仅 tests/e2e
pnpm check          # build + typecheck + lint + format:check + test
pnpm dev            # 独立开发构建，启动 Vite(8765) 和后台(8766)，监听源码
pnpm start --archive /绝对路径/归档
pnpm cli <命令>      # 运行 dist/node/cli/main.js，需先 build
```

- 修改 `src/` 后若要用 `pnpm cli`、`pnpm start` 或 `pnpm test:e2e`，先 `pnpm build`；E2E 直接导入 `dist/node/...`。
- `pnpm dev` 用于网页开发：浏览器访问 `http://127.0.0.1:8765`，后台在 8766。
- 开发构建位于 `.dev/`，与 `dist/` 隔离；运行期间可执行 `pnpm check`。后台、共享代码和渲染资源完整构建成功后才替换后台，编译失败保留旧版本。开发验证使用临时配置、归档和状态目录。
- 媒体处理位于同级独立项目 `../mediatool`，只读本项目的轨迹库；没有共享源码或运行时依赖。
- PNG 导出需要 `pnpm cli setup chromium`。
- 仓库只允许 better-sqlite3 和 sharp 的安装构建脚本（见 `pnpm-workspace.yaml`），不要随意放开其他依赖的 build 脚本。

## 目录与依赖边界

```
src/domain          纯领域逻辑（几何、KML 编辑、时间、统计、展示规则）
src/shared          跨运行时类型与契约（前后端/CLI 共用，可移植）
src/services        业务服务，通过 ports 访问外部能力
src/infrastructure  适配器（SQLite、XML worker、文件、地图资源、概览缓存）
src/server          Fastify HTTP 服务与静态资源
src/cli             oclif 命令与 Ink 进度输出
src/web             React 网页（地图、面板、工程、编辑页）
src/drawing         网页与服务端 PNG 渲染共用的绘制代码
```

依赖方向由 `.dependency-cruiser.cjs` 强制，`pnpm lint` 会失败：

- `shared` 只能依赖 `shared`。
- `domain` 只能依赖 `domain` 和 `shared`，不得接触 Node 内置模块或 I/O。
- `services` 只能依赖 `services`、`domain`、`shared`，外部能力走 `ports.ts`。
- `infrastructure` 不得导入 `server`、`cli`、`web`。
- `web` 只能依赖 `web`、`shared`、`drawing`；网页只通过 HTTP API 使用后台能力。
- `web`、`drawing`、`shared`、`domain`、`services` 不得导入 Node 核心模块。
- `shared`、`domain`、`services`、`infrastructure` 不得导入 React/Ink。

入口文件：`src/server/main.ts`、`src/cli/main.ts`、`src/web/main.tsx`。新增模块先判断属于哪一层，不要把 I/O 塞进 domain 或把 SQL 放进 server 路由。

## 代码约定

- TypeScript `strict` + `noUncheckedIndexedAccess`，所有相对导入写 `.js` 后缀（NodeNext ESM），类型导入使用 `import type`（`verbatimModuleSyntax`）。
- 格式化由 Prettier 决定（双引号、分号、2 空格）。仓库提供 `.githooks/pre-commit` 执行 `format:check`；需要时用 `git config core.hooksPath .githooks` 启用，不要用 `--no-verify` 绕过。
- 代码注释用英文，说明“为什么”而非复述代码；用户可见文本（CLI 输出、网页文案、错误消息、文档）用中文。
- 错误统一走 `src/domain/errors.ts` 的 `AppError` 与错误码；退出码约定：0 成功、1 输入错误、2 外部工具/API 失败、3 部分失败、130 用户取消。
- 时间与坐标保持精度：时间为整数微秒，坐标为 WGS84，不要在中间层转成毫秒或浮点时间戳；显示坐标系转换与底图相关，改动时同时检查 GCJ02 和跨日期变更线。
- 归档删除、恢复是不可逆操作。测试必须使用临时目录/临时库，不能对用户归档执行删除或写入。
- 网页 UI 复用 `src/web/components/ui` 的 shadcn 基础组件和 `src/web/components/controls.tsx` 的组合控件；主题变量在 `src/web/style.css`。保持键盘可操作、中文标签和移动端底部面板行为一致，不要另起一套视觉体系。
- 新增依赖前确认它属于哪一层；浏览器依赖不能进 `services`/`infrastructure` 的公共路径。

## 测试

- `tests/ts/**/*.test.ts`：Vitest，单元与集成逻辑，使用临时目录和固定 fixture。
- `tests/e2e/*.spec.ts`：Playwright，共享一个临时归档，`workers: 1`，测试服务固定端口 18765；运行前先 `pnpm build`。
- `pnpm test:terminal`：Linux PTY、zsh/Bash 补全验证，非 Linux 不可用。
- 修改归档写入、删除、概览缓存、KML 解析/导出时，同时补对应单元的失败与边界用例；仅通过 E2E 截图不能替代数据正确性验证。
- 不要把网络请求带到测试里：E2E 服务已用本地资源替代底图；单元测试使用 fixture。

## 数据与仓库卫生

- `sandbox/`、`ai-notes/`、`dist/`、`.dev/`、`node_modules/`、`test-results/`、`playwright-report/` 均被 Git 忽略，不要提交。
- `docs/validation/**/*.png` 等验收截图也被忽略；文档中引用截图前先确认文件确实存在且被有意纳入。
- 真实归档位置由 `archive_path` 配置（本仓库的 `data/` 只是开发沙箱，不存放真实归档）；配置在 `~/.config/tracktool`，界面状态与任务库在 `~/.local/state/tracktool`。不要为了调试修改或提交这些文件。
- 用户文档面向使用者（`README.md`、`docs/*.md`），内部规划与实验结果放 `ai-notes/`（不纳入版本库）。不要把内部实现细节写进用户文档，也不要把用户文档改成内部笔记。

## 提交与发布

- 提交信息使用 Conventional Commits 英文格式（如 `feat: ...`、`fix(web): ...`、`docs: ...`），与现有历史一致。
- 不要为赶进度跳过 `pnpm check`、`--no-verify` 或格式钩子；依赖边界和格式失败都要真正修复。
- 版本号在 `package.json` 与 `docs/install-upgrade.md` 中同步；打包命令为 `pnpm pack --pack-destination ./dist-pack`，发布前运行 `pnpm verify:package`。
- 归档仅接受当前 schema。涉及结构变更时同步更新 `docs/sqlite-storage.md`、结构版本、合成测试库和备份恢复校验；不添加格式兼容分支。
