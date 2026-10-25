import { AppError } from "./errors.js";
import {
  COMPRESSION_PRESETS,
  EXPORT_FORMATS,
  exportEncoding,
  type ExportOptions,
} from "../shared/export-format.js";

export function validateExport(output: string, options: ExportOptions = {}) {
  if (
    (options.format !== undefined &&
      !EXPORT_FORMATS.includes(options.format)) ||
    (options.compression !== undefined &&
      !COMPRESSION_PRESETS.includes(options.compression))
  )
    throw new AppError("USER_INPUT", "不支持的导出格式或压缩程度");
  const encoding = exportEncoding(options);
  if (!output.toLowerCase().endsWith(encoding.extension))
    throw new AppError(
      "USER_INPUT",
      `当前导出选项需要 ${encoding.extension} 文件，请修改输出路径`,
    );
  return encoding;
}
