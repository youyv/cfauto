# 新手部署教程：从空账号搭好基础面板

本教程以 **Windows 10/11 + PowerShell** 为主。每一步都有“看到什么才算成功”。命令一行一行执行；上一条报错时，先按文末的方法解决。

## 1. 确认适用范围

本教程创建一个**全新的 KV 兼容模式面板**，Worker 默认名称 `my-worker-panel`。适合第一次安装基础功能。使用免费 `workers.dev` 地址，不需要先买域名或服务器。

兼容模式可以管理账号、变量，进行旧流程的部署和更新；**没有 SQLite DO 的持久任务、配置 CAS 和可编辑兼容日期**。页面中的任务列表、兼容日期保存属于权威模式功能，在兼容模式不要使用。部署中途断网时先核对远端结果，不直接再次点击。

以下情况不要执行本教程：

- 已经有在用的中控 Worker / KV / DO，尤其是名为 `manager` 的现有生产实例。
- 希望把旧 KV 数据自动迁入 DO。
- 希望全新实例立刻具备完整持久任务能力。

这些情况走[升级与恢复](OPERATIONS.md)。当前仓库没有通用的一键 DO 初始化器。

## 2. 准备三个工具和一个账号

| 准备项 | 操作 | 成功标志 |
| --- | --- | --- |
| Cloudflare 账号 | 在 Cloudflare 注册并验证邮箱，能打开控制台 | 可以进入 Workers & Pages |
| Node.js | 从 Node.js 官网安装 **24.x**，本版本用 24.19.0 验证 | `node --version` 输出 `v24...` |
| Git | 从 Git 官网安装 Git for Windows，默认选项即可 | `git --version` 输出版本 |
| pnpm | 安装 Node 后，按下面命令安装 | `pnpm.cmd --version` 输出 `11.22.0` |

官网：<https://dash.cloudflare.com/>、<https://nodejs.org/en/download>、<https://git-scm.com/downloads/win>。

安装完成后，关闭旧终端。右键开始菜单，打开 **终端 / PowerShell**，执行：

```powershell
node --version
git --version
npm.cmd install --global pnpm@11.22.0
pnpm.cmd --version
```

`npm.cmd` 和 `pnpm.cmd` 的 `.cmd` 是为了避开 Windows 常见的 PowerShell 脚本执行策略问题。不要为了安装而关闭系统安全设置。

## 3. 下载项目并安装依赖

先回到个人文件夹，再下载一份新目录：

```powershell
Set-Location $env:USERPROFILE
git clone https://github.com/youyv/cfauto.git cfauto-panel
Set-Location .\cfauto-panel
pnpm.cmd install --frozen-lockfile --ignore-scripts
```

**成功标志**：当前目录能看到 `package.json`、`src`、`frontend`、`docs`，并且依赖安装命令成功结束。

如果已经有 `cfauto-panel` 目录，不要覆盖或删除。为新安装换一个空目录名，例如 `cfauto-panel-new`。之后的所有命令都要在这份项目目录运行。

安装报错时保留锁文件。不要用删除 `pnpm-lock.yaml` 或改用 `npm install` 的方式继续。

## 4. 登录 Cloudflare，找到账号 ID

```powershell
node node_modules/wrangler/bin/wrangler.js login
node node_modules/wrangler/bin/wrangler.js whoami
```

第一条会打开浏览器。使用准备好的 Cloudflare 账号登录并授权，再回到终端。

第二条会列出账号信息。复制你要部署到的 **Account ID（账号 ID）**，通常为 32 位十六进制字符。多个账号时，选择自己要用的那一个。

**Account ID 不是 Zone ID、不是 API Token，也不是登录密码。** 后面只把它写入本地配置的 `account_id`。

如果浏览器没有打开，使用 Wrangler 显示的授权地址登录。仍然失败时先修复登录，不继续上传。

## 5. 创建个人配置，只改一项

```powershell
Copy-Item .\wrangler.legacy.example.toml .\wrangler.legacy.local.toml
notepad .\wrangler.legacy.local.toml
```

记事本里找到：

```toml
account_id = "REPLACE_WITH_YOUR_ACCOUNT_ID"
```

把引号中的占位文字换成刚刚复制的 Account ID。**保留英文双引号**，按 `Ctrl+S` 保存，再关闭记事本。

保持以下配置原样：

```toml
name = "my-worker-panel"

[vars]
CFAUTO_STORAGE_MODE = "legacy"
```

如果账号里已经有同名 Worker，改成一个尚未使用的小写英文名称，例如 `my-worker-panel-2`。不要填现有生产的名字。

这份新配置不应包含任何 `RELIABILITY_*` 变量、密钥或 DO 绑定。所有后续命令都指定 `-c wrangler.legacy.local.toml`；不要改用仓库默认的 `wrangler.toml`。

## 6. 创建面板的 KV 存储

只执行一次：

```powershell
node node_modules/wrangler/bin/wrangler.js kv namespace create CONFIG_KV -c wrangler.legacy.local.toml --binding CONFIG_KV --update-config
```

这会在你的账号中创建 KV，并将绑定写入个人配置。

再次打开配置：

```powershell
notepad .\wrangler.legacy.local.toml
```

**成功标志**：文件中出现一组类似下面的内容，`id` 是真实值，不是示例文字：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "这里应该已经是Wrangler写入的真实ID"
```

如果自动写入没有成功，把终端返回的 `[[kv_namespaces]]` 配置块完整复制到文件末尾，并保存。只保留一组 `CONFIG_KV`。不要复制这里的中文示例 ID，也不要重复创建很多 KV。

这份 KV 用于中控面板；以后给 CMliu / Joey 业务 Worker 创建的 KV 是另一回事。

## 7. 本地打包检查，再上传代码

先进行一次不上传的检查：

```powershell
node node_modules/wrangler/bin/wrangler.js deploy -c wrangler.legacy.local.toml --dry-run
```

**成功标志**：看到构建成功，以及类似 `--dry-run: exiting now` 的提示。这里还没有上线。

然后实际上传：

```powershell
node node_modules/wrangler/bin/wrangler.js deploy -c wrangler.legacy.local.toml
```

若 Cloudflare 首次要求设置 `workers.dev` 子域名，按终端提示选择一个可用名称。这个名称属于你的 Cloudflare 账号；不要删除或改动其他已在用账号的子域名。

**成功标志**：终端显示上传成功和一个 HTTPS 地址，形如：

```text
https://my-worker-panel.你的子域名.workers.dev
```

把终端实际返回的地址保存下来。此时还没有设置登录口令，页面提示未配置 `ACCESS_CODE` 是正常的，继续下一步。

## 8. 设置两把不同的钥匙

第一把是网页登录口令：

```powershell
node node_modules/wrangler/bin/wrangler.js secret put ACCESS_CODE -c wrangler.legacy.local.toml
```

按提示输入一个自己保存得住的强口令。输入时终端可能不显示字符，输完按回车即可。不要使用 `123456`、账号 API Token 或示例值。

第二把是账号数据加密密钥：

```powershell
node node_modules/wrangler/bin/wrangler.js secret put ENCRYPTION_SECRET -c wrangler.legacy.local.toml
```

使用密码管理器生成并保存一段独立的长随机字符串，粘贴到提示里，按回车。它应与登录口令不同。**在添加任何业务账号之前就设好这把密钥，以后不要随意更换或删除**，否则已有密文可能无法解开。

确认密钥名称已存在：

```powershell
node node_modules/wrangler/bin/wrangler.js secret list -c wrangler.legacy.local.toml
```

**成功标志**：列表中有 `ACCESS_CODE`、`ENCRYPTION_SECRET`。列表只显示名称，看不到值是正常的。密钥已经直接保存在 Cloudflare，无需把值写进 Git、TOML 或聊天记录。

`GITHUB_TOKEN` 是可选项。未配置时仍可读取公开上游，但会受 GitHub 匿名接口限流；需要时按同样方式设置同名 Secret。

## 9. 打开网页，确认这次真的装好了

1. 在浏览器打开第 7 步得到的 **HTTPS** 地址。
2. 输入第 8 步的 `ACCESS_CODE` 登录。
3. 应该能看到三种项目、账号工具和变量区域，账号列表初始为空。
4. 按 `F12` 打开开发者工具，在 Console 运行下面这一行：

```javascript
fetch('/api/reliability/recovery').then(r => r.json()).then(console.log)
```

应看到 `mode: "legacy"`、`transactional: false`。这说明当前是教程指定的兼容模式。

如果看到 `503 / NOT_READY`，查看个人配置的 `CFAUTO_STORAGE_MODE`，并检查是否误装了 `RELIABILITY_*` 配置。**已有 DO 实例遇到 503 不适用这种处理**。

基础面板部署完成。下一步按[使用教程](USER_GUIDE.md)添加业务账号、先对一个目标做小范围部署。不要把“面板安装成功”当成“三个上游项目都已部署”。

## 10. 可选：自动检查与自定义域名

### 自动检查

先确认手动部署正常，再到面板保存自动检查间隔、参与模板和通知设置。然后把个人配置中的：

```toml
[triggers]
crons = []
```

改为：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

再次执行第 7 步的实际上传命令。平台每五分钟触发一次入口，程序再按面板中保存的间隔判断是否检查；不保证某一秒精确执行。

### 自定义域名

先让 `workers.dev` 地址正常工作。有托管在 Cloudflare 的域名后，可以到该 Worker 的 Domains & Routes 添加自定义域名。请同时把它记录在个人 TOML 配置，避免下一次 CLI 上传撤掉只在控制台添加的设置。

示例（将域名和 Zone ID 换成自己的）：

```toml
[[routes]]
pattern = "panel.example.com"
custom_domain = true
zone_id = "YOUR_ZONE_ID"
```

Account ID 和 Zone ID 不相同。使用自定义域名后仍通过 HTTPS 登录。

## 11. 免费计划怎么用得更稳

免费额度按 Cloudflare 实际规则执行。关键是少请求、少重复写、少无效轮询：

- 先管理少量账号；批量操作先选一个账号验证。
- 自动检查间隔不要设置得过短；不需要自动化时保持关闭。
- 兼容模式不要多页面同时保存同一份配置。
- 请求超时先核对 Cloudflare 中实际结果，不反复提交相同部署。
- 不需要查看任务时收起面板；不要长期重复刷新用量和诊断。
- 大源码、多账号、大批量操作可能超过 CPU 或请求额度；降低并发本身不会减少总子请求数。

官方资料：

- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)：免费请求、CPU、子请求等。
- [Workers KV 价格和免费额度](https://developers.cloudflare.com/kv/platform/pricing/)：兼容模式尤其要留意 KV 写入额度。
- [Durable Objects 价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)：免费计划支持 SQLite DO，但本教程没有为你安装 DO 权威模式。
- [Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/)：登录、KV、部署与密钥管理。

## 12. 以后怎样更新这个新装面板

这段只用于本教程安装的兼容模式实例。

1. 在面板中保存账号/配置备份，备份文件保存在自己的私有位置。
2. 保留个人 TOML、KV ID 和 `ENCRYPTION_SECRET`。
3. 在项目目录执行：

```powershell
git status --short
git pull --ff-only
pnpm.cmd install --frozen-lockfile --ignore-scripts
node node_modules/wrangler/bin/wrangler.js deploy -c wrangler.legacy.local.toml --dry-run
node node_modules/wrangler/bin/wrangler.js deploy -c wrangler.legacy.local.toml
```

如果 `git status` 显示你改过源码，先保存改动并处理合并；`git pull` 失败时停下来，不用强制覆盖。更新时不再创建 KV，不重新生成加密密钥。

升级已有 DO 权威模式实例请看[运维指南](OPERATIONS.md)，不能使用这里的兼容配置。

## 13. 常见卡点

| 看到什么 | 怎么做 |
| --- | --- |
| “不是内部或外部命令” / 找不到 node 或 git | 安装工具后重开终端，再执行版本检查 |
| PowerShell 禁止运行 pnpm.ps1 | 使用本教程的 `pnpm.cmd` |
| 找不到 package.json | 回到 `cfauto-panel` 项目目录 |
| Cloudflare 未登录 / 认证过期 | 重新执行 `login`，用 `whoami` 确认账号 |
| `REPLACE_WITH_YOUR_ACCOUNT_ID` 仍在文件里 | 用真实 Account ID 替换并保存 |
| `KV Not Bound (Error 1001)` | 检查本地配置里是否有真实 `CONFIG_KV`，再部署同一配置 |
| 未配置 `ACCESS_CODE` | 完成第 8 步，注意命令后的 `-c` 指向同一文件 |
| 503 / NOT_READY | 先确认新装兼容模式还是 DO 权威模式，再按第 9 步或运维指南处理 |
| 域名打不开 | 先检查 Wrangler 返回的原始 workers.dev 地址，等配置生效；排查 DNS、网络和 Workers 可用性 |
| 保存后无法解密原账号 | 检查是否换过 `ENCRYPTION_SECRET`；恢复原密钥，不覆盖原数据 |
| 兼容日期保存、任务列表报错 | 这两项不适用于 KV 兼容模式，见第 1 步能力说明 |
| 上游下载失败 / GitHub 限流 | 核对网络和上游路径，必要时设置 `GITHUB_TOKEN` |
| 提示目标 Worker 已存在 / 即将覆盖 | 停下来核对目标；全新安装换一个未使用的名称，不覆盖既有服务 |
| TOML 解析失败 | 用记事本检查英文引号、括号和重复配置块，不把命令粘进 TOML，也不把 TOML 粘进终端 |

提交问题时附上版本号、失败步骤、脱敏错误文字和 request ID；不要发送登录口令、Cloudflare Token、密钥或账号导出内容。

## 14. macOS / Linux 对照

安装同样的 Node、Git、pnpm 后，命令中的 `pnpm.cmd` / `npm.cmd` 改成 `pnpm` / `npm`。目录和文件操作使用：

```sh
cd ~
git clone https://github.com/youyv/cfauto.git cfauto-panel
cd cfauto-panel
pnpm install --frozen-lockfile --ignore-scripts
cp wrangler.legacy.example.toml wrangler.legacy.local.toml
```

用你熟悉的编辑器改 Account ID。第 4、6、7、8 步的 `node ...` 命令跨平台相同。不要在 shell 里直接输入 TOML 片段，它们应写进配置文件。
