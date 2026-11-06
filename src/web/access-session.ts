export const sessionExpiredMessage =
  "登录已过期或访问被拒绝，请刷新页面重新登录。未完成的操作不会自动重试，请先检查保存结果。";

export function checkAccessResponse(
  status: number,
  contentType: string | null,
) {
  if (status === 401 || contentType?.includes("text/html"))
    throw new Error(sessionExpiredMessage);
}
