# VPS 与 Cloudflare Tunnel 部署

适用于 Linux 单机部署。VPS 使用 nvm 安装 Node 26.11.1、pnpm 12.10.1 安装软件，systemd 管理服务。Cloudflare Access 负责整站登录，Cloudflare Tunnel 将请求转发到本机端口；无需额外安装反向代理或账号数据库。

## 准备服务器

创建专用用户 `tracktool`，主目录为 `/var/lib/tracktool`。在该用户下安装 nvm 和 Node，将 pnpm 安装到该用户的工具目录。不要使用 root 运行网页服务。

目录分配如下：

| 内容                       | 位置                                                       |
| -------------------------- | ---------------------------------------------------------- |
| 每次发布的独立安装目录     | `/opt/tracktool/releases/版本标识`                         |
| 指向当前安装目录的符号链接 | `/opt/tracktool/current`                                   |
| 配置与服务环境变量         | `/etc/tracktool/config.json`、`/etc/tracktool/service.env` |
| 归档                       | `/var/lib/tracktool/data/archive/archive.sqlite3`          |
| 网页状态与临时上传         | `/var/lib/tracktool/state/tracktool`                       |
| 地图缓存、Chromium         | `/var/cache/tracktool`                                     |
| 完整备份                   | `/var/lib/tracktool/backups`                               |

配置、数据与备份只允许服务用户和管理员读取。`config.json` 可从 `{}` 开始，不要直接套用含有本机绝对路径的配置。

## 安装发布包

在源码工作区运行 `pnpm check` 和相关浏览器测试，再执行 `pnpm pack --pack-destination ./dist-pack`。将安装包上传到服务器的独立版本目录，以专用用户运行 `pnpm add ./tracktool-版本.tgz --allow-build better-sqlite3 --allow-build sharp`。不要上传本机的 `node_modules`。

使用该安装的 CLI 执行 `setup chromium`，并设置 `PLAYWRIGHT_BROWSERS_PATH=/var/cache/tracktool/browsers`；Linux 缺少系统库时由管理员安装对应 Playwright 浏览器依赖。TAR.XZ 导出还需要 `xz`。

仓库的 `deploy/linux/` 提供启动脚本、服务单元和环境变量示例。将脚本安装到 `/opt/tracktool/`，将服务单元安装到 `/etc/systemd/system/`。脚本使用 nvm 的明确 Node 路径，不依赖交互式 shell 初始化；升级 Node 时同步修改路径。

`service.env` 中设置 `TRACKTOOL_ARCHIVE`，初次验证时指向独立测试归档。执行 `systemctl daemon-reload`、`systemctl enable --now tracktool`，通过 `systemctl status tracktool` 和 `journalctl -u tracktool` 查看状态。

服务仅监听 `127.0.0.1:8765`，可通过 SSH 本地端口转发检查。不要开放该端口到公网或修改为监听全部网卡。网页允许处理的文件目录限定在 `/var/lib/tracktool/data`。

## Cloudflare 开通与连接

1. 将计划使用的域名接入 Cloudflare，按提示在域名注册商处设置名称服务器；先核对现有 DNS 记录，保留邮件和其他服务记录。确认域名状态为已生效。
2. 开通 Cloudflare Zero Trust 免费套餐并选择团队名称。在身份提供商设置中启用邮箱一次性验证码。
3. 创建一个自托管 Access 应用，填写完整子域名（例如 `tracks.example.com`），不限定路径。允许策略只填写获准访问的完整邮箱；不要设置 `Everyone` 或认证绕过规则。选中邮箱验证码登录方式。
4. 按需设置全局和应用会话期限，例如全局七天、应用一天。全局会话仍有效时，应用令牌可续期，无需每天重新输入验证码。
5. 创建一个命名 Tunnel。在服务器安装 `cloudflared` 并以 systemd 服务运行，将隧道凭据保存在受限文件中，不提交到 Git 或粘贴到日志。
6. 为隧道增加域名路由，目标为 `http://127.0.0.1:8765`。保留原始 Host，启用 **Protect with Access** 并配置正确的团队名称与应用 AUD，使 `cloudflared` 在转发前校验 Access 令牌。先建 Access 保护再发布域名路由。
7. 在 `/etc/tracktool/service.env` 设置 `TRACKTOOL_PUBLIC_ORIGIN=https://tracks.example.com`，重启 tracktool。此配置只允许该域名和 HTTPS Origin，并显示退出入口；它本身不提供登录认证。

`cloudflared` 和 tracktool 在同机运行时无需开放公网 HTTP 端口。未来添加服务时，可复用 Tunnel、为各子域名分别建立 Access 应用与权限策略。

官方文档：[公开应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[令牌校验](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/#access)、[会话与退出](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)。

## 验收与数据迁移

先使用测试归档验证未登录拦截、允许与拒绝邮箱、Host/Origin 校验、登录过期、退出、上传、编辑、下载及 PNG 导出。浏览器后台请求收到认证错误后提示刷新，不自动重放写入。PNG 出图使用本机连接，公网 `/render` 仍应受 Access 保护。

Access 退出入口为站点的 `/cdn-cgi/access/logout`。它撤销跨应用的 Access 会话，旧令牌通常需 20–30 秒停止被接受；外部身份提供商或邮箱的登录状态需要另外退出。免费套餐的 HTTP 上传大小限制也适用于 Tunnel；大文件应通过 SSH 传输，完整归档迁移始终使用 SSH。

用 `archive full-backup --output /临时备份/完整.sqlite3` 对源归档生成一致快照，校验传输前后 SHA-256，再以 `archive restore-backup /备份/完整.sqlite3 /新归档目录` 恢复。不要单独复制正在写入的 SQLite 主文件。对比条目数、修订信息并检查数据库完整性。所有破坏性验收只对测试库执行。

正式切换前停止旧端写入，检查源归档是否发生变化，必要时重新备份并恢复到另一个新目录。切换后以 VPS 为唯一写入源；本地原库保留为旧副本，不提供双向同步。

## 备份和升级

安装 `tracktool-backup.service` 和 `.timer`，启用计时器后每天生成完整 SQLite 备份，可用 `systemctl start tracktool-backup` 手动触发。首次启用前先确认 `TRACKTOOL_ARCHIVE` 已指向正式归档。脚本不自动删除备份；定期下载到异机位置并检查磁盘容量，再根据保留需求清理已验证的旧副本。同机备份不能替代异机备份。

升级时保留旧版本目录，先创建完整备份，安装新版本并验证，再停止服务、切换 `current`、启动服务。同一数据库结构下可切回旧程序；结构变化时必须使用匹配版本的备份恢复到新目录，再调整归档位置。不要覆盖唯一备份或正在使用的数据库。
