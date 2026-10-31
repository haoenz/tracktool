# 文件编辑与压缩输入样本

KML 输入与 JSON 预期用于验证拆分、删点和合并后的几何、时间及扩展字段。ZIP 样本覆盖 stored、deflate、bzip2、LZMA、Zstandard、ZIP64 与 CP437 文件名。

测试直接读取提交的样本，不依赖外部生成器或网络。
