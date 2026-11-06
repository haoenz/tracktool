import { AppError } from "../domain/errors.js";

export interface AccessOptions {
  publicOrigin?: string;
  cloudflareAccess?: boolean;
}

export function publicOrigin(options: AccessOptions): URL | undefined {
  if (!options.publicOrigin) {
    if (options.cloudflareAccess)
      throw new AppError(
        "USER_INPUT",
        "Cloudflare Access 模式需要配置公开访问地址",
      );
    return undefined;
  }
  try {
    const url = new URL(options.publicOrigin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid origin");
    return url;
  } catch {
    throw new AppError(
      "USER_INPUT",
      "公开访问地址必须是 HTTPS 地址，不能包含账号、路径、查询参数或片段",
    );
  }
}
