# M2 合成样本

`project.json` 来自现有 Python `drawing.state.default_state({})`，用于确认项目 schema 2 的公共值契约。完整 schema 1 升级、修订与资源校验在 M3 迁移。

`xml/` 从 M1 生成样本复制而来，输入与预期在仓库内独立保存，正式测试无需读取被忽略的 `ai-notes/`、运行 Python 或安装原型依赖。三份合法 KML 分别为 UTF-8、UTF-16、GB18030；其余六份刻意违反 XML 规则。`expected.json` 保留生成时 Python/lxml 的值与原始 SHA-256。

`tests/e2e/config.json` 仅含合成路径与明显的测试密钥，用于验证真实 HTTP 页面及私有字段隔离。测试不读取个人配置或真实归档。

M3 的 `maps/archive.sqlite3` 与 `maps/python-index.zlib` 由 `scripts/migration/map-fixtures.py` 使用原 Python 存储/索引模块生成，所有内容均为合成样本。运行测试只复制它们到临时目录；不需要 Python，也不修改样本库。

M7：生成器与原 Python 实现已封存在 `docs/history/`；这些固定样本继续直接参与 TS 测试。当前构建/测试不再执行 Python 生成器。
