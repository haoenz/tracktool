# 合成测试样本

所有样本均为合成数据，测试只复制到临时目录，不读取个人配置或真实归档。

`xml/` 包含 UTF-8、UTF-16、GB18030 KML，以及刻意违反 XML 规则的输入；`expected.json` 保存解析预期及原始 SHA-256。

`maps/entries.json` 保存地图样本的 KML 原件。先执行 `pnpm build`，再运行 `node scripts/build-test-fixtures.ts`，可用当前归档结构生成 `maps/archive.sqlite3`。

`m4/` 包含 KML 编辑输入、语义预期和不同压缩算法的 ZIP 输入，用于验证文件格式与数据完整性。

`tests/e2e/config.json` 仅含合成路径与测试密钥，用于验证 HTTP 页面及私有字段隔离。
