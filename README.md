# 🚀 CF Auto — Cloudflare Worker 智能部署中控 (V12.0.0)

> 全部代码由 Claude Code 完成，自行修改延伸功能。

> **版本状态**: V12.0.0 Stable — 全量优化（确定性 bug 修复 · 测试改为真实模块 · 并发统一 · 前端资源拆分 + CSP 收紧）
> **详细变更**: 见 [CHANGELOG.md](CHANGELOG.md)

---

## 📖 项目简介

**CF Auto** 是一个基于 Cloudflare Worker 构建的**多账号 Worker 部署管理平台**。它可以管理多个 Cloudflare 账号，支持**一键批量部署**、**版本回滚**、**自动化流量熔断**、**全球节点优选**以及**代码混淆加固**。

### 能做什么？

| 功能 | 说明 |
|------|------|
| 🔄 **多账号管理** | 添加多个 Cloudflare 账号，统一管理所有 Worker |
| 🚀 **批量部署** | 一键从 GitHub 拉取代理模板代码，批量部署到多个账号 |
| 🤖 **自动更新** | Cron 定时检查上游仓库更新，自动拉取最新代码部署（三个模板均支持） |
| 🛡️ **流量熔断** | 监控账号用量，超阈值只轮换**该账号**的 UUID 并重新部署 |
| ♻️ **失败重试** | 部分目标部署失败时不推进版本号，下轮 cron 定向重试失败目标 |
| ⚡ **节点优选** | 全球优选 IP 节点一键写入 KV，支持 CMLiu / Joey |
| 🔧 **一键修复 1101** | 自动修复 Worker 1101 错误，保留变量和域名 |
| 📜 **版本收藏** | 收藏稳定版本，支持一键回滚 |
| 🌐 **子域名管理** | 在线修改 `*.workers.dev` 子域名 |
| 🩺 **系统诊断** | 检查 KV 绑定、密钥配置、加密密钥指纹 |
| 🌌 **星空主题** | 暗黑星空 + 明亮模式，一键切换 |
| 🔐 **数据加密** | 所有 API Key 经 AES-256-GCM 加密存储 |

---

## 🗂️ 项目架构

```
cfauto/
├── src/                        # 服务端 (TypeScript → esbuild 打包)
│   ├── index.ts                #   入口: fetch handler + cron scheduled handler + 静态资源
│   ├── cron.ts                 #   定时任务: 自动更新 & 熔断轮换
│   ├── frontend-bundle.ts      #   构建时生成: 内联前端 HTML/CSS/JS (gitignored)
│   ├── config/
│   │   ├── env.ts              #   环境变量类型 (AppEnv)
│   │   ├── templates.ts        #   模板配置 + KV 键名 + 类型派生函数
│   │   └── login-html.ts       #   登录页 (CSP nonce)
│   ├── lib/
│   │   ├── account-store.ts    #   账号存储 (透明加解密 + Worker 列表访问器)
│   │   ├── auto-update.ts      #   部署编排核心 (pendingTargets / 账号级 UUID 轮换)
│   │   ├── cloudflare-api.ts   #   CF API 封装 + readApiJson 统一错误解析
│   │   ├── concurrency.ts      #   pooledMap 有界并发（全项目统一并发策略）
│   │   ├── crypto-utils.ts     #   AES-256-GCM 加密 + 密钥指纹
│   │   ├── deploy-utils.ts     #   部署工具 (上传/绑定合并/固定 compat date)
│   │   ├── github.ts           #   GitHub API (拉代码/commits/模板转换)
│   │   ├── kv-utils.ts         #   KV 读写封装
│   │   ├── logger.ts           #   结构化 JSON 日志
│   │   ├── stats.ts            #   GraphQL 用量统计
│   │   ├── types.ts            #   共享类型定义
│   │   └── validate.ts         #   输入校验 (账号/变量/自动配置)
│   ├── middleware/
│   │   └── auth.ts             #   认证: ACCESS_CODE + Cookie 会话 + CSRF
│   └── routes/
│       ├── register.ts         #   路由注册中心 (含 withErrorBoundary)
│       ├── crud.ts             #   账号/配置/变量 CRUD + 备份恢复 + 诊断
│       ├── deploy.ts           #   部署 (单Worker/批量)
│       ├── check.ts            #   版本检查/用量查询
│       ├── zones.ts            #   域名/子域名管理
│       ├── yxip.ts             #   优选 IP / 反代落地
│       ├── fix1101.ts          #   一键修复 1101
│       └── login.ts            #   登录接口
├── frontend/                   # 前端 (Vanilla JS + Tailwind CSS)
│   ├── index.html              #   HTML 骨架 (data-act 事件委托，无内联 onclick)
│   ├── css/style.css           #   星空 / 毛玻璃 / 响应式样式
│   └── js/
│       ├── dom.js              #   $ / 事件委托注册表 / apiFetch / CSRF
│       ├── state.js            #   全局 state 对象 & 初始化
│       ├── accounts.js         #   账号管理 UI
│       ├── accounts-io.js      #   导入导出 & 备份恢复
│       ├── accounts-worker.js  #   Worker 管理弹窗
│       ├── deploy.js           #   部署 / 批量部署 UI
│       ├── vars.js             #   变量管理 & 版本检查
│       ├── history.js          #   版本历史 & 收藏
│       ├── yxip.js             #   优选 IP UI
│       ├── workbench.js        #   工作台 / 日志
│       ├── diagnostics.js      #   系统诊断 / 源码查看
│       └── starfield.js        #   星空动画 + 应用入口
├── test/                       # Vitest（323 个测试，全部 import 真实模块）
│   ├── helpers.ts              #   内存 KV mock / CF 响应构造 / fetch 桩
│   ├── kv-utils.test.ts        #   工具函数 + 路由表
│   ├── audit-regression.test.ts#   凭证保护 / 白名单 / 校验
│   ├── reliability.test.ts     #   并发 / 错误路径 / 纯函数
│   ├── routes.test.ts          #   部署链路 / 熔断作用域 / cron / CRUD
│   ├── handlers.test.ts        #   批量部署 / zones / yxip / fix1101
│   ├── auth-security.test.ts   #   会话 / CSRF / 限流 / CSP
│   └── smoke.js                #   部署后端到端冒烟
├── .github/workflows/ci.yml    # CI: build → typecheck → verify → test
├── build.js                    # 构建脚本 (拼接前端 + esbuild 打包)
├── build.bat / deploy.bat      # Windows 批处理
├── check.bat                   # 本地一键跑完整检查链
├── install.bat                 # 依赖安装 (pnpm)
├── setup-secrets.bat           # 密钥配置
├── wrangler.toml               # 部署配置模板
├── wrangler.local.toml         # 本地部署配置 (不入 git)
└── verify.js                   # 源码结构 / 路由 / CSP / 反模式校验
```

**技术栈**: Cloudflare Workers · TypeScript · esbuild · KV Storage · Vanilla JS · Tailwind CSS · SweetAlert2 · Canvas API

**请求处理流程**:
```
Request → KV 检查 → 公开路由 (/manifest.json, /api/login, /api/logout)
       → 认证中间件 (ACCESS_CODE → CSRF → Cookie)
       → 静态资源 (/app.js, /app.css, /vendor/sweetalert2.js — 长缓存)
       → 路由分发 (ROUTES Map，全部套 withErrorBoundary)
       → /api/* 未匹配 → 404 JSON
       → 回退 → 管理面板 SPA HTML
```

**质量校验**（提交前建议跑 `pnpm run check` 或双击 `check.bat`）:
```
build (生成 frontend-bundle.ts) → typecheck (tsc --noEmit)
  → verify (结构/路由/CSP/反模式) → test (vitest run, 323 个)
```

> 包管理器用 **pnpm**（仓库只有 `pnpm-lock.yaml`，没有 `package-lock.json`）。
> `install.bat` 在检测不到 pnpm 时会用 corepack 自动启用；CI 同样走 pnpm。

---

## 📦 支持的代理模板

| 模板 | GitHub 源 | 类型 | 默认变量 | KV 绑定 | 优选IP | 自动更新 |
|------|----------|------|---------|---------|--------|---------|
| **cmliu** | `cmliu/edgetunnel` (`_worker.js`) | EdgeTunnel 代理 | UUID, PROXYIP, DOH, PATH, URL, KEY, ADMIN, TCP_CONCURRENT_DIAL, PROXY_CONCURRENT_DIAL | `KV` → `ADD.txt` | ✅ | ✅ |
| **joey** | `byJoey/cfnew` | 自动修复代理 | u | `C` → `c` (JSON) | ✅ | ✅ |
| **ech** | `hc990275/ech-wk` | WebSocket 代理 | PROXYIP | 无 | ❌ | ✅ |

> **熔断轮换**只对有 UUID 变量的模板生效（cmliu / joey）；**自动版本更新**三个模板都支持——由模板的 `autoUpdate` 字段独立控制，与是否有 UUID 无关。

### 🆕 cmliu 新增变量 (V11.7.2 引入)

| 变量名 | 说明 |
|--------|------|
| `TCP_CONCURRENT_DIAL` | 自定义 TCP 并发拨号数；设置后不再根据中国移动网络自动降为单路 |
| `PROXY_CONCURRENT_DIAL` | 自定义反代并发拨号数 |

> 这两个变量为**可选项**，留空则使用默认行为。在 CMliu 配置面板中会自动显示，填入数值后部署即可生效。

---

## 💻 快速开始

### 📥 第一次使用

| 步骤 | 操作 | 说明 |
|------|------|------|
| **1** | 双击 `install.bat` | 用 pnpm 安装依赖（缺 pnpm 会自动 corepack 启用） |
| **2** | 修改 `wrangler.toml` | ① `name` 改成 Worker 名 ② 首次部署取消 `[[kv_namespaces]]` 注释，填入 KV ID ③ 需要时取消 `routes` / `triggers` 注释 |
| **3** | 双击 `build.bat` | 拼接前端 + esbuild 打包 → `dist/worker.js` |
| **4** | 双击 `setup-secrets.bat` | 设置面板密码和 GitHub Token (加密存储到 CF) |
| **5** | 双击 `deploy.bat` | 推送到 Cloudflare |

### 🔄 日常更新

```
build.bat → deploy.bat
```
两步完成，KV/路由/触发器不受影响；密钥永不覆盖。

改过代码后建议先跑一次完整校验：

```
check.bat            # 或 pnpm run check
```
它按 CI 相同顺序执行 build → typecheck → verify → test（323 个测试）。任一步失败就不要部署。

---

## 🛠️ 部署教程（保姆级）

### 1️⃣ 创建主控 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. **Workers & Pages** → **Create** → **Create Worker**
3. 命名为 `manager`，点击 **Deploy**
4. 点击 **Edit code**，将 `dist/worker.js` 的完整代码粘贴覆盖
5. 点击 **Save and deploy**

### 2️⃣ 绑定 KV 存储 (核心，不绑定无法启动!)

1. Worker 编辑页 → **Settings** → **Variables**
2. **KV Namespace Bindings** → **Add binding**
3. **Variable name**: `CONFIG_KV` (必须大写)
4. **KV Namespace**: 创建新命名空间 (如 `manager_data`)
5. **Save and deploy**

### 3️⃣ 设置环境变量

| 变量名 | 必须 | 说明 |
|--------|------|------|
| `ACCESS_CODE` | ✅ 必须 | 登录密码 |
| `GITHUB_TOKEN` | 推荐 | GitHub PAT，提升 API 限额 (60→5000/小时) |
| `ENCRYPTION_SECRET` | 可选 | 独立加密密钥，更换 ACCESS_CODE 不影响已加密数据 |

### 4️⃣ 配置 Cron 触发器 (自动更新必需)

1. **Settings** → **Triggers** → **Cron Triggers** → **Add Cron Trigger**
2. 推荐 Cron 表达式: `*/5 * * * *` (每 5 分钟)
3. 在中控页面 Header 设置检查间隔 (如 30 分钟)

> **两层控制**: Cron 是外层触发频率，中控页面的间隔是内层实际执行间隔。Cron 间隔必须 ≤ 网站间隔才有意义。

### 5️⃣ 自定义域名 (可选)

在 `wrangler.toml` 中取消注释 `[[routes]]` 配置:
```toml
[[routes]]
pattern = "你的域名"
zone_name = "你的 zone 名"
custom_domain = true
```

---

## 🔑 账号凭证获取

### Account ID

登录 Cloudflare Dashboard 后，浏览器地址栏中 `dash.cloudflare.com/` 后面的 32 位字符即是。

### Global API Key (必须，不可用 API Token 替代)

1. 右上角头像 → **My Profile**
2. 左侧 **API Tokens**
3. 页面下方 **API Keys** → **Global API Key** → **View**
4. 输入密码 + hCaptcha 验证后复制

> ⚠️ Global API Key 拥有最高权限，本中控将其 AES-256-GCM 加密后存储在 KV 中。

### GitHub Token (推荐)

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token (classic)，公共仓库无需勾选任何权限
3. 复制 `ghp_` 开头的 token，填入 `GITHUB_TOKEN` 环境变量

---

## 📖 操作指南

### ✨ 批量部署

1. 点击顶部「**✨ 批量部署**」
2. 选择模板: CMliu (EdgeTunnel) / Joey (相信光) / ECH (WebSocket)
3. 设置变量值 (每个模板有不同的默认变量，面板自动展开)
4. 勾选目标账号 → 点击「🚀 开始部署」

### 🔄 变量同步

在 Cloudflare 后台手动修改了 Worker 变量后，中控面板点「🔄 同步」可从云端拉取最新配置。

### 🛡️ 流量熔断

1. Header 设置熔断阈值百分比 (如 90%)
2. 当某账号用量达到阈值时，**只对该账号**轮换 UUID 并重新部署（写入账号级变量 `VARS_<type>_ACC_<accountId>`，其他账号的订阅链接不受影响）
3. 可选配置 Webhook 接收熔断告警（必须 https）
4. 熔断触发的同一轮里，版本更新检查照常执行

### 🎲 刷 UUID

在变量面板点「🎲 刷 UUID」可生成新的随机 UUID，下次部署时生效。

### 🔧 一键修复 1101

遇到 Worker 1101 错误时，点击「🔧 一键修复 1101」:
1. 记录当前变量绑定和域名（**读不到绑定就中止**，避免删除后丢失 KV/secret）
2. 删除 Worker
3. 用相同名称重建（先试一次，失败才退避重试）
4. 恢复所有变量 + 自定义域名（`secret_text` 的值 CF 不返回，会提示需手动重配）
5. 至少一个 Worker 重建成功后，每账号轮换一次子域名

### ⚠️ 部署部分失败会怎样

如果一批部署里有目标失败：
- 本地版本号 (`currentSha`) **不会**推进，避免 cron 误判「已是最新」
- 失败目标记入 `pendingTargets`，下一次 cron 只重试这些目标
- 模板卡片的版本区会显示「⚠️ N 个 Worker 部署失败，待重试」

---

## ❓ 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 页面显示 "KV Not Bound" | KV 未绑定 | Settings → 添加 `CONFIG_KV` KV 绑定 |
| 检查更新报错 | GitHub API 限流 | 配置 `GITHUB_TOKEN` 环境变量 |
| 修改子域名后不可用 | DNS 传播延迟 | 等待数分钟至数小时 |
| 不能用 API Token | 权限不足 | 必须使用 Global API Key |
| 部署后变量没有出现 | KV 缓存旧数据 | 刷新面板或手动点「+ 变量」添加 |
| 账号列表 alias 后有 🔑 标记 | API Key 缺失或解密失败 | 编辑该账号重新填写 Global API Key |
| 改了 ACCESS_CODE 后所有 Key 失效 | 加密密钥由 ACCESS_CODE 派生 | 提前设置 `ENCRYPTION_SECRET`；已失效的只能重新填写。工作台「🩺 诊断」可查看是否已启用 |
| 导入的账号 Key 全部为空 | 导出文件来自不同的加密密钥 | 导入时会比对密钥指纹并给出警告，需重新填写 Key |
| 变量输入框清空后部署仍是旧值 | 空值 = 沿用上游默认，不代表删除 | 点变量行右侧的「×」显式删除 |
| 保存账号提示 alias 重复 | alias 是唯一标识 | 改成不同的备注名 |

---

## 🏗️ 从零开发的完整技能清单

### 🔧 后端核心技术
- **Cloudflare Workers** — V8 隔离环境，ES Module 格式，fetch/scheduled handler
- **Wrangler CLI** — 部署、KV 管理、密钥管理 (secret)、Cron 触发器配置
- **Cloudflare API v4** — Worker 脚本上传/删除、绑定管理 (plain_text / secret_text / kv_namespace)、域名绑定、子域名管理、KV 命名空间 CRUD
- **Cloudflare GraphQL API** — 账号用量统计查询
- **GitHub REST API** — 文件内容获取、Commit 历史、版本对比 (diff)
- **有界并发** — `pooledMap` 控制并发度，兼顾吞吐与上游限流（CF 1200 次/5 分钟、1000 subrequest）

### 🔐 安全
- **Web Crypto API** — SHA-256 密码哈希、AES-256-GCM 加解密、`getRandomValues` 加密安全随机
- **Cookie 安全** — `__Host-` 前缀、SameSite、HttpOnly、正则精确提取（防前缀绕过）
- **CSRF 防护** — 会话绑定的 X-CSRF-Token 恒定时间比对 + Sec-Fetch-Site / Origin 纵深校验
- **CSP 策略** — 面板无 `script-src 'unsafe-inline'`（事件委托替代内联 onclick）；登录页用一次性 nonce
- **透明加密** — 账号密钥写入 KV 前自动加密，读取时自动解密；解密失败清空而非把密文当 Key 用
- **密钥指纹** — 导出/备份带 SHA-256 前缀指纹，导入前即可判定能否解密

### 🎨 前端
- **Vanilla JavaScript** — 零框架，纯 DOM API 操作
- **事件委托** — `data-act` + `registerActions` 注册表，消除内联事件处理器
- **Tailwind CSS** — CDN 引入，响应式布局
- **SweetAlert2** — 弹窗确认、错误提示（构建时内联，版本 pin）
- **Canvas API** — 星空主题动态背景 (星星、流星、星云光晕)
- **SPA 架构** — 单页应用，模态框切换视图，localStorage 主题持久化
- **静态资源分离** — JS/CSS 走 `?v=<version>` 长缓存，主 HTML 保持 no-store

### 🛠️ 构建与工具
- **esbuild** — TypeScript/JS 打包为单文件 ESM 输出
- **Node.js** — 构建脚本、内联前端资源、可复现的依赖读取
- **Vitest** — 323 个单元与集成测试，全部 import 真实模块（内存 KV mock + fetch 桩）
- **TypeScript** — 类型安全、模板字面量索引签名消除类型断言
- **GitHub Actions** — build → typecheck → verify → test 全链路 CI
- **自定义静态校验** — `verify.js` 检查结构、路由覆盖、CSP、以及裸 `res.json()` / 裸 `fetch` 等反模式

---

## ⚠️ 免责声明

本项目仅供技术研究和学习使用。开发者不对使用本工具产生的任何后果负责。所有 API Key 仅保存在用户自己的 Cloudflare KV 中，请妥善保管。
