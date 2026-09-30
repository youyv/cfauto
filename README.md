# CF Auto — Cloudflare Worker 部署中控 (V12.1.1)

> **版本状态**: V12.1.1 — 多账号管理、可配置上游代码源、批量部署与自动更新。
> 更新记录：[CHANGELOG.md](CHANGELOG.md)。

CF Auto 把多个 Cloudflare 账号的 Worker 部署、变量配置、版本管理与运维操作集中到一个网页中。**中控自身运行在一个 Cloudflare Worker 上，管理数据存储在绑定的 Workers KV 中**，不需要独立服务器或传统数据库。

请区分两个角色：**中控 Worker** 负责管理和调用 API；**目标 Worker** 是实际部署到各账号的 CMliu、Joey 或 ECH 项目。部署中控不会自动创建目标项目，也不会把中控 KV 当作目标项目的业务 KV。

## 目录

- [功能与边界](#功能与边界)
- [架构与实现方式](#架构与实现方式)
- [首次部署](#首次部署)
- [面板使用流程](#面板使用流程)
- [导入导出与备份恢复](#导入导出与备份恢复)
- [开发与更新](#开发与更新)
- [常见问题](#常见问题)
- [安全与开源说明](#安全与开源说明)

## 功能与边界

| 能力 | 实际用途 |
|---|---|
| 多账号管理 | 使用 API Token 或 Global API Key 管理账号，查询用量、域名和 Worker |
| 项目配置 | 切换 CMliu / Joey / ECH，编辑变量、Secret、UUID 和目标 Worker |
| 可配置上游 | 在面板指定 CMliu / Joey 官方仓库内的脚本路径与分支或标签 |
| 部署与版本管理 | 预览影响范围、批量部署、查看历史、收藏版本、选择固定版本 |
| 自动任务 | Cron 驱动版本检查、失败目标重试、账号级熔断及 KV 管理数据回收 |
| 运维工具 | Worker 管理、子域名修改、1101 修复、部署记录、系统诊断与脱敏报障 |
| 数据管理 | 单独迁移账号，或备份/恢复中控配置 |
| 界面 | 默认折叠的账号工具、深浅色主题、响应式布局、SVG 图标与悬停提示、可双向拖动的工作台 |

**边界说明：**

- 目标项目行为由上游代码决定；本工具不保证任意上游脚本都兼容，也不替代 Cloudflare 的权限与配额管理。
- UUID 熔断用于具有对应 UUID 配置的模板；不能将其理解为所有模板通用的流量阻断器。
- KV 是最终一致性存储。当前没有跨请求事务或全局部署锁，请避免多人同时修改同一配置，以及手动部署与自动任务重叠。
- 中控备份不是整个 Cloudflare 账号的灾备：不包含目标 Worker 业务 KV 全量内容、所有线上脚本或 Cloudflare 后台设置。

## 架构与实现方式

### 1. 运行时结构

```text
浏览器面板（HTML / CSS / 原生 JavaScript）
  │ HTTPS：登录、配置、部署与诊断请求
  ▼
中控 Worker：src/index.ts
  ├─ 静态资源：HTML、/app.js、/app.css、SweetAlert2
  ├─ 认证与 CSRF 检查 → 路由注册表 → 业务处理器
  ├─ CONFIG_KV：账号密文、变量、上游选择、版本记录、收藏等
  ├─ GitHub API / 原始脚本：解析上游、读取历史和代码
  └─ Cloudflare API：上传目标 Worker、处理绑定、查询用量和域名

Cloudflare Cron Trigger
  └─ src/cron.ts → 自动更新 / UUID 熔断 / KV 管理数据回收
```

浏览器调用中控 API，由服务端读取并解密账号凭据后调用 Cloudflare API。凭据不会为了部署而回填到前端表单。登录依靠会话 Cookie，写操作配合 CSRF 校验；前端通过 `data-act` 事件委托执行操作，不依赖内联 `onclick`。

### 2. 构建方式

`node build.js` 读取前端资源，按固定顺序拼接 JavaScript，生成 `src/frontend-bundle.ts`，再使用 esbuild 将服务端和资源打包为 **`dist/worker.js`**。两个生成文件都不提交 Git。

- 前端是原生 DOM 实现，**不是 React / Vue，也不是前端 ES Module 工程**。各 JS 文件共享拼接作用域，新增文件必须加入 `build.js` 清单。
- 页面资源由同一个 Worker 提供；JS/CSS 地址带版本参数，主页面不长期缓存。
- SweetAlert2 优先使用本地依赖，缺失时构建脚本才尝试下载固定版本。
- Lucide SVG 图标本地打包，无运行时图标 CDN 请求；**Tailwind 仍使用外部 CDN，界面并非完全离线**。
- 中控 `compatibility_date` 由构建脚本固定，不随每天日期变化；目标模板各自使用模板配置中的兼容日期。

### 3. 部署链路

1. 读取项目配置、目标账号、全局变量与账号级覆盖。
2. 解析官方上游仓库的文件、引用和版本。显式指定的 CMliu / Joey 文件优先于默认探测。
3. 获取代码，按模板规则处理变量与绑定，再通过 Cloudflare API 上传。
4. 检查上传结果及相关部署状态，记录成功/失败目标和部署版本信息。
5. 部分失败保留待重试目标；不会把局部成功当作全局成功推进版本。部署记录同时跟踪自定义代码源，避免换文件但 SHA 相同时误判无需更新。

账号级 UUID 覆盖与全局变量分开存储；熔断只作用于相关账号。删除 Worker 时默认保留 KV；选择删除 KV 后，还会检查共享绑定，检查失败或发现共享时保留数据。

### 4. 数据与安全模型

| 数据 | 存放/处理方式 |
|---|---|
| API Token / Global API Key | 写入账号存储前使用 AES-256-GCM 加密 |
| 加密密钥 | 优先使用 `ENCRYPTION_SECRET`；未配置时从 `ACCESS_CODE` 派生 |
| 变量与账号覆盖 | 由 `KV_KEYS` 定义的项目键和账号级键管理，不要假定整个 KV 所有字段均被加密 |
| 上游选择 | `UPSTREAM_<type>`，包含文件路径与分支/标签 |
| 部署与收藏 | 独立项目配置及部署记录键；失败目标用于后续重试 |
| 会话和临时状态 | KV 中的会话、限流与探测缓存等，不属于完整配置恢复白名单 |
| 备份 | 白名单导出/恢复；凭据保留密文并携带加密密钥指纹 |

### 5. 目录导航

```text
src/
  index.ts                 Worker 请求入口、资源服务与 scheduled 入口
  cron.ts                  定时任务编排
  config/                  模板、环境类型、KV 键与登录页
  routes/                  路由注册、CRUD、备份、部署、域名与节点接口
  lib/
    account-store.ts       账号读取、凭据加解密与存储
    github.ts              GitHub 请求、上游路径/分支探测
    upstream.ts            自定义上游选择校验与来源标识
    deploy-utils.ts        上传、绑定合并与部署辅助逻辑
    auto-update.ts         自动部署、失败重试与账号级轮换
    crypto-utils.ts        数据加密与密钥指纹
    concurrency.ts         有界并发
frontend/
  index.html               中控页面与弹窗
  css/style.css            主题、组件与响应式样式
  js/                      账号、部署、变量、历史、诊断和工作台交互
  js/icons.js              SVG 渲染、按钮说明及选择框图标同步
  vendor/lucide/           固定版本 SVG 子集、映射与许可证
test/                      Vitest：内存 KV / API mock / 前端回归测试
build.js                   前端内联与 Worker 打包
verify.js                  路由、动作、资源、CSP 和代码结构检查
wrangler.toml              可提交的部署配置模板
```

## 首次部署

### 1. 准备环境并安装依赖

准备 Cloudflare 账号、可用的 Node.js LTS 与 pnpm。项目的 pnpm 版本以 `package.json` 的 `packageManager` 为准；Node.js 24 LTS 可用于本地构建。

```sh
git clone https://github.com/youyv/cfauto.git
cd cfauto
pnpm install --frozen-lockfile
```

Windows 也可运行 `install.bat` 安装依赖。

### 2. 配置中控 Worker 与 KV

复制 `wrangler.toml` 为 **`wrangler.local.toml`**，在本地副本中填写配置。该副本已被 Git 忽略，不要提交真实部署配置或密钥。

```toml
name = "your-control-panel"
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"
main = "dist/worker.js"
compatibility_date = "2026-07-16"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "YOUR_KV_NAMESPACE_ID"

[triggers]
crons = ["*/5 * * * *"]

[build]
command = "node build.js"
```

在 Cloudflare 控制台创建 Workers KV 命名空间后填入 ID，绑定名必须是 **`CONFIG_KV`**。也可登录 Wrangler 后运行 `pnpm exec wrangler kv namespace create CONFIG_KV -c wrangler.local.toml` 创建，并使用命令返回的 ID。

可选自定义域名配置：

```toml
[[routes]]
pattern = "panel.example.com"
custom_domain = true
zone_id = "YOUR_ZONE_ID"
```

### 3. 配置部署身份与 Secrets

**部署身份**用于 Wrangler 上传中控；**面板内账号凭据**用于中控操作目标账号。两者用途不同。

交互登录：

```sh
pnpm exec wrangler login
```

也可以通过 `CLOUDFLARE_API_TOKEN` 环境变量提供部署 Token。Windows 可使用 `setup-deploy-token.bat`，或复制 `deploy.local.example.bat` 为被 Git 忽略的 `deploy.local.bat`。

为中控设置 Secrets，命令会提示输入，不要把真实值写进命令、README 或提交记录：

```sh
pnpm exec wrangler secret put ACCESS_CODE -c wrangler.local.toml
pnpm exec wrangler secret put ENCRYPTION_SECRET -c wrangler.local.toml
# 推荐：提高 GitHub API 可用配额
pnpm exec wrangler secret put GITHUB_TOKEN -c wrangler.local.toml
```

| 名称 | 要求 | 作用 |
|---|---|---|
| `ACCESS_CODE` | 必填 | 中控登录密码，使用高强度随机值 |
| `ENCRYPTION_SECRET` | 强烈建议首次使用前设置 | 独立凭据加密密钥，稳定保存，避免改登录密码影响旧凭据 |
| `GITHUB_TOKEN` | 推荐 | 访问 GitHub API，缓解匿名请求限额 |

如果 Wrangler 提示 Worker 尚不存在，可按提示创建，或先在控制台建立同名 Worker。Windows 的 `setup-secrets.bat` 会优先使用本地配置文件。

> **重要：**已有账号数据后，不要直接更换 `ENCRYPTION_SECRET`，也不要随意从密码派生密钥切换到新密钥；这不是自动密钥迁移。应先做好备份并规划凭据重新录入。

### 4. 检查并部署

```sh
pnpm run check
pnpm exec wrangler deploy -c wrangler.local.toml
```

Windows 可运行 `check.bat`，通过后运行 `deploy.bat`。部署脚本会优先选择 `wrangler.local.toml`；直接运行 `pnpm run deploy` 则默认使用 `wrangler.toml`，不要混淆。

打开部署后的 **HTTPS** 地址，使用 `ACCESS_CODE` 登录。先打开工作台运行诊断，确认 KV 和 Secrets 配置正常。

## 面板使用流程

### 1. 添加账号

点击“添加账号”，填写备注、Account ID 和鉴权信息。优先使用权限受限的 API Token；兼容 Global API Key + 邮箱。

Token 需覆盖实际操作的账号及权限，例如 Workers 脚本和 KV 的读写、域名查询所需的 Zone Read、用量查询所需的 Analytics Read；自定义域名和路由操作可能还需要对应权限。按所用功能授予最小权限，失败时查看具体 Cloudflare 错误，而不是直接改用全权限密钥。

保存后再读取域名列表、选择默认域名，并填写各项目已有的 Worker 名称。编辑账号时凭据不会回显；留空表示不修改已有凭据。

### 2. 配置项目与上游

切换 CMliu / Joey / ECH 标签，编辑变量。Secret 复选框控制目标变量的 Secret 类型；它不代表所有中控 KV 配置都会自动加密。

CMliu / Joey 可展开“上游代码源”：

- 同时填写**仓库内相对文件路径**和**分支或标签**，例如 `src/worker.js` + `main`。
- 仓库仍固定为模板的官方仓库，不接受任意下载 URL 或 `../` 路径。
- 保存仅修改来源配置，不立即部署。自动更新开启后，后续任务会检查新来源；固定版本模式需手动操作。
- 指定文件不存在时明确报错，不悄悄回退；恢复默认后重新启用默认探测。
- 切换文件不会修改该模板的变量、KV 绑定或代码转换约定，必须选择兼容的单文件脚本。
- 不要在部署进行中切换来源；更换来源后先预览再部署。

### 3. 预览、部署与回滚

1. 确认账号和目标 Worker 范围。
2. 点击“预览”，在工作台查看影响的账号与 Worker。
3. 点击部署，或用顶部“批量”创建/部署多个目标。
4. 检查失败目标和部署记录；“请求完成”不等于所有目标成功。
5. 需要指定版本时，在“历史/收藏”选择版本，再执行部署。固定模式与跟随上游模式应按使用意图选择。

工作台可拖住标题栏上下左右移动，按钮不参与拖动；日志开头的状态符号显示为 SVG，诊断报告仍保留纯文本。管理账号时可修改子域名或删除 Worker；这些操作会影响线上资源，请仔细阅读确认提示。

### 4. 自动更新与熔断

两层配置缺一不可：

- **Cloudflare Cron** 决定外部唤醒频率，例如每 5 分钟。
- **面板自动任务设置** 决定开关、实际检查间隔、参与项目、熔断阈值与告警地址。修改后点击保存。

Cron 不是常驻进程，修改面板间隔不会自动创建 Cron Trigger。用量统计失败不应阻断独立版本检查；部分部署失败按记录重试。中控还会周期性裁剪管理日志、清理已删除账号的遗留覆盖键，并非清空目标业务 KV。

### 5. 落地节点配置

顶部“落地”面板选择策略、目标账号及节点。Joey 的 KV 模式写入键 `c`，兼容变量模式使用全局变量 `yx`；CMliu 模式写入目标 KV 的 `ADD.txt`。先核实目标 Worker 及 KV 绑定，勿将不同策略视为可互换。

## 导入导出与备份恢复

账号列表中展开“账号工具”即可找到这些操作：

| 操作 | 范围 | 写入行为 |
|---|---|---|
| 导出账号 | 账号配置与加密凭据 | 下载文件，不改线上数据 |
| 导入账号 | 账号配置 | 新增或合并账号，不恢复其他中控配置 |
| 下载备份 | 白名单内的账号、全局设置、项目变量、账号覆盖、上游选择、部署记录和收藏 | 下载中控配置快照 |
| 恢复备份 | 同上 | 确认后覆盖备份中对应配置；未出现的键保持不变，非白名单键拒绝 |

它们不是完全重复：**迁移账号用导入/导出，迁移或恢复中控配置用备份/恢复**。

- 文件中的凭据仍为密文；目标实例需使用相同的有效加密密钥。指纹用于检查兼容性，不是解密密钥。
- Secrets（登录密码、独立加密密钥、GitHub Token）、KV 绑定、Cron 和自定义域名需另行配置。
- 备份文件仍属于敏感数据，应离线妥善保管，切勿上传公开仓库。
- 恢复前先备份当前实例。不要把配置恢复误认为会自动把所有线上 Worker 回滚到历史代码。

## 开发与更新

```sh
pnpm run build        # 生成前端资源与 dist/worker.js
pnpm run typecheck    # TypeScript 检查
pnpm run test:verify  # 静态结构、路由、动作与资源一致性检查
pnpm test            # Vitest 测试
pnpm run check       # 按顺序运行上述检查
```

测试包括真实业务模块配合内存 KV / fetch mock，以及部分前端行为和源码回归检查；**通过测试不代表已用真实 Cloudflare 凭据完成线上部署验证**。

更新已有实例：先备份中控配置，再拉取代码、安装锁定依赖、运行完整检查，最后使用同一份本地 Wrangler 配置部署。检查 KV ID、域名和触发器是否与原实例一致。

前端维护约定：

- 按 `build.js` 中的顺序组织脚本，动作注册保持与 `data-act` 一致。
- 图标使用 `frontend/vendor/lucide/` 的固定 SVG 和映射，不依赖系统 Emoji 外观。
- 原生 `option` 内只放文本，选中项图标在 `select` 上绘制；模板颜色同步为 CMliu 红、Joey 蓝、ECH 绿。
- 输入框图标使用本地 SVG 背景，不能把 SVG 塞进 placeholder。
- 不对用户输入、账号名或远端源码做全局图标替换。
- 修改版本时使用 `node bump-version.js patch`，补充 CHANGELOG 后重新构建。

## 常见问题

| 问题 | 排查方式 |
|---|---|
| 无法登录 / 写请求失败 | 检查 `ACCESS_CODE`、HTTPS、Cookie 与 CSRF；更新后重新登录 |
| KV 未绑定 | 确认部署配置中绑定名为 `CONFIG_KV`，ID 属于中控账号 |
| GitHub 请求限流 | 设置 `GITHUB_TOKEN`，降低过密检查，查看工作台具体错误 |
| 自定义上游 404 | 核对路径大小写、分支/标签及文件是否存在；不会自动改拉其他文件 |
| 凭据解密失败 | 检查是否更换密码或加密密钥，确认备份来源密钥一致，必要时重新录入 |
| 自动更新不执行 | 检查 Cron、总开关、项目开关、检查间隔和固定版本模式 |
| 部署提示权限不足 | 核对 Token 的账号资源范围及所调用 API 的权限 |
| 界面样式缺失 | 检查 Tailwind CDN 网络访问与浏览器控制台；SVG 图标不需要外部图标服务 |
| 代码已更新但页面仍旧 | 确认已构建并部署到正确 Worker，再刷新页面；Git 推送不等同于 Cloudflare 部署 |
| 1101 修复或删除风险 | 修复可能重建 Worker / 轮换子域名；删除 KV 会丢数据，先备份并阅读确认提示 |

## 安全与开源说明

不要提交 `wrangler.local.toml`、`deploy.local.bat`、API Token、Secrets 或备份文件。不要在 Issue 中直接粘贴凭据或未经检查的原始日志。故障反馈优先使用工作台的脱敏报告，发送前仍需人工检查。

上游仓库、接口和权限政策可能发生变化；请遵守 Cloudflare、GitHub 及各上游项目的使用条款和许可证，仅在有权限的账号与资源上操作。

图标使用 [Lucide](https://lucide.dev/) 0.468.0，本地保留 [来源说明](frontend/vendor/lucide/README.md) 与 [ISC / 继承 MIT 许可声明](frontend/vendor/lucide/LICENSE)。上游项目入口见面板“开源仓库”以及 `src/config/templates.ts`。
