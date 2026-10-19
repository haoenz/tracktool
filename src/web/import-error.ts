type ImportError = { label: string; detail?: string };

const labels: Record<string, string> = {
  "无法识别活动标签，请选择活动标签": "未登记的活动标签",
  "无法识别活动标签，请设置 TrackTags 或选择活动标签": "未登记的活动标签",
  "请选择 KML 文件。": "不支持的文件格式（仅支持 KML）",
  "XML 格式或编码无效": "KML 格式或编码无效",
  "Expected a namespaced KML document": "不是有效的 KML 文件",
  "KML 中没有有效轨迹点": "没有有效轨迹点",
  "名称需包含行程日期，例如 2026-10-01 徒步.kml":
    "文件名缺少日期（YYYY-MM-DD）",
  无效的上传文件名: "上传文件名无效",
  "文件超过 8 GiB，请拆分后上传。": "文件超过 8 GiB",
  "单个上传文件不能超过 8 GiB": "文件超过 8 GiB",
  "XML 超过 128 MiB": "KML 内容超过 128 MiB",
  "KML exceeds 128 MiB": "KML 内容超过 128 MiB",
  "KML exceeds 2,000,000 points": "轨迹点超过 200 万个",
  "上传连接中断，请重试。": "上传连接中断",
  "Failed to fetch": "服务连接中断",
  "NetworkError when attempting to fetch resource.": "服务连接中断",
  "上传失败，请重试。": "上传失败",
  上传失败或同名文件已存在: "上传失败或文件同名",
  "未能读取轨迹，请重试。": "轨迹读取失败",
  "保存失败，请重试。": "保存失败",
  "XML 处理超时": "轨迹读取超时",
  "XML 工作队列已满": "服务繁忙，请稍后重试",
  "已有同名轨迹，但内容不同；请修改名称或移除此文件": "名称冲突",
};

export function importError(
  message: string | undefined,
  conflict = false,
): ImportError {
  if (conflict) return { label: "名称冲突" };
  if (!message) return { label: "导入失败" };
  if (Object.hasOwn(labels, message)) return { label: labels[message]! };
  if (
    message === "名称应以 .kml 结尾，不能包含路径分隔符，且不超过 240 个字符。"
  )
    return { label: "文件名格式不正确", detail: message };
  if (message.startsWith("Filename must contain YYYY-MM-DD:"))
    return { label: "文件名缺少日期（YYYY-MM-DD）" };
  if (
    message.endsWith(": No extractable line tracks (gx:Track or LineString)") ||
    message.endsWith(": Empty line geometry; no coordinates")
  )
    return { label: "没有有效轨迹点" };
  if (
    /: (?:Invalid (?:longitude|latitude|altitude) |Malformed coordinate$|Expected exactly one coordinates element$)/.test(
      message,
    )
  )
    return { label: "轨迹坐标无效", detail: message };
  if (/: Invalid timestamp /.test(message))
    return { label: "轨迹时间无效", detail: message };
  // Keep unrecognized failures available instead of guessing their cause.
  return { label: "导入失败", detail: message };
}
