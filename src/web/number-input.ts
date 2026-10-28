export type NumberLimits = {
  min?: number;
  max?: number;
  precision?: number;
  required?: boolean;
};

export type NumberDraft =
  { valid: true; value: number | null } | { valid: false; error: string };

export function validateNumberDraft(
  text: string,
  { min, max, precision, required = true }: NumberLimits = {},
): NumberDraft {
  if (!text.trim())
    return required
      ? { valid: false, error: "请输入数值" }
      : { valid: true, value: null };
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()))
    return { valid: false, error: "请输入有效数值" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { valid: false, error: "请输入有效数值" };
  if ((min !== undefined && value < min) || (max !== undefined && value > max))
    return {
      valid: false,
      error:
        min !== undefined && max !== undefined
          ? `请输入 ${min} 至 ${max} 之间的数值`
          : min !== undefined
            ? `请输入不小于 ${min} 的数值`
            : `请输入不大于 ${max} 的数值`,
    };
  if (
    precision !== undefined &&
    Math.abs(value - Number(value.toFixed(precision))) >
      Number.EPSILON * Math.max(1, Math.abs(value))
  )
    return {
      valid: false,
      error: precision === 0 ? "请输入整数" : `最多保留 ${precision} 位小数`,
    };
  return { valid: true, value };
}
