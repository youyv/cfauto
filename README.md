# 🚀 CF Auto — Cloudflare Worker 智能部署中控 (V11.9.0)

> 全部代码由 Claude Code 完成，自行修改延伸功能。

> **版本状态**: V11.9.0 Stable — 全量代码审计修复（死代码清理 · 死接口复活 · 超时保护 · 竞态修复）
> **详细变更**: 见 [CHANGELOG.md](CHANGELOG.md)

---

## 📖 项目简介

**CF Auto** 是一个基于 Cloudflare Worker 构建的**多账号 Worker 部署管理平台**。它可以管理多个 Cloudflare 账号，支持**一键批量部署**、**版本回滚**、**自动化流量熔断**、**全球节点优选**以及**代码混淆加固**。

### 能做什么？

| 功能 | 说明 |
|------|------|
| 🔄 **多账号管理** | 添加多个 Cloudflare 账号，统一管理所有 Worker |
| 🚀 **批量部署** | 一键从 GitHub 拉取代理模板代码，批量部署到多个账号 |
| 🤖 **自动更新** | Cron 定时检查上游仓库更新，自动拉取最新代码部署 |
| 🛡️ **流量熔断** | 监控账号用量，超阈值自动轮换 UUID 重新部署 |
| ⚡ **节点优选** | 全球优选 IP 节点一键写入 KV，支持 CMLiu / Joey |
| 🔧 **一键修复 1101** | 自动修复 Worker 1101 错误，保留变量和域名 |
| 📜 **版本收藏** | 收藏稳定版本，支持一键回滚 |
| 🌐 **子域名管理** | 在线修改 `*.workers.dev` 子域名 |
| 🌌 **星空主题** | 暗黑星空 + 明亮模式，一键切换 |
| 🔐 **数据加密** | 所有 API Key 经 AES-256-GCM 加密存储 |

---

## 🗂️ 项目架构

```
cfauto/
├── src/                        # 服务端 (TypeScript → esbuild 打包)
│   ├── index.ts                #   入口: fetch handler + cron scheduled handler
│   ├── cron.ts                 #   定时任务: 自动更新 & 熔断轮换
│   ├── frontend-bundle.ts      #   构建时生成: 内联前端 HTML/CSS/JS
│   ├── config/
│   │   ├── env.ts              #   环境变量类型 (AppEnv)
│   │   ├── templates.ts        #   模板配置 (cmliu/joey/ech GitHub 源、变量结构)
│   │   └── login-html.ts       #   登录页 HTML 模板
│   ├── lib/
│   │   ├── account-store.ts    #   账号存储 (透明加解密)
│   │   ├── auto-update.ts      #   自动更新核心 (拉代码→部署→记录)
│   │   ├── cloudflare-api.ts   #   CF API 封装
│   │   ├── crypto-utils.ts     #   AES-256-GCM 加密工具
│   │   ├── deploy-utils.ts     #   部署工具 (上传/绑定变量)
│   │   ├── github.ts           #   GitHub API (拉代码/commits)
│   │   ├── kv-utils.ts         #   KV 读写封装
│   │   ├── logger.ts           #   结构化 JSON 日志
│   │   ├── stats.ts            #   GraphQL 用量统计
│   │   ├── types.ts            #   共享类型定义
│   │   └── validate.ts         #   输入校验
│   ├── middleware/
│   │   └── auth.ts             #   认证: ACCESS_CODE + Cookie (SHA-256) + CSRF
│   └── routes/
│       ├── index.ts            #   路由注册中心 (ROUTES Map)
│       ├── crud.ts             #   账号/配置/变量 CRUD
│       ├── deploy.ts           #   部署 (单Worker/批量)
│       ├── check.ts            #   版本检查/用量查询
│       ├── zones.ts            #   域名/子域名管理
│       ├── yxip.ts             #   优选 IP / 反代落地
│       ├── fix1101.ts          #   一键修复 1101
│       ├── login.ts            #   登录接口
│       └── loader.ts           #   懒加载路由
├── frontend/                   # 前端 (Vanilla JS + Tailwind CSS)
│   ├── index.html              #   HTML 骨架
│   ├── css/style.css           #   星空 / 毛玻璃 / 响应式样式
│   └── js/
│       ├── state.js            #   全局状态 & 初始化
│       ├── accounts.js         #   账号管理 UI
│       ├── deploy.js           #   批量部署 UI
│       ├── vars.js             #   变量管理 UI
│       ├── history.js          #   部署历史 UI
│       ├── yxip.js             #   优选 IP UI
│       ├── workbench.js        #   工作台 / 日志
│       ├── dom.js              #   DOM 工具 & 缓存
│       └── starfield.js        #   星空 Canvas 动画
├── build.js                    # 构建脚本 (拼接前端 + esbuild 打包)
├── build.bat                   # Windows 构建批处理
├── deploy.bat                  # 部署批处理 (调用 wrangler deploy)
├── install.bat                 # 依赖安装
├── setup-secrets.bat           # 密钥配置
├── wrangler.toml               # 部署配置模板
├── wrangler.local.toml         # 本地部署配置 (不入 git)
├── verify.js                   # 构建产物验证
└── test/                       # Vitest 测试
```

**技术栈**: Cloudflare Workers · TypeScript · esbuild · KV Storage · Vanilla JS · Tailwind CSS · SweetAlert2 · Canvas API

**请求处理流程**:
```
Request → KV 检查 → 公开路由 (/manifest.json, /api/login)
       → 认证中间件 (ACCESS_CODE → CSRF → Cookie)
       → 路由分发 (ROUTES Map)
       → 回退 → 管理面板 SPA HTML
```

---

## 📦 支持的代理模板

| 模板 | GitHub 源 | 类型 | 默认变量 | KV 绑定 | 优选IP |
|------|----------|------|---------|---------|--------|
| **cmliu** | `cmliu/edgetunnel` (`_worker.js`) | EdgeTunnel 代理 | UUID, PROXYIP, DOH, PATH, URL, KEY, ADMIN, TCP_CONCURRENT_DIAL, PROXY_CONCURRENT_DIAL | `KV` → `ADD.txt` | ✅ |
| **joey** | `byJoey/cfnew` | 自动修复代理 | u | `C` → `c` (JSON) | ✅ |
| **ech** | `hc990275/ech-wk` | WebSocket 代理 | PROXYIP | 无 | ❌ |

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
| **1** | 双击 `install.bat` | 安装 Node.js 依赖 |
| **2** | 修改 `wrangler.toml` | ① `name` 改成 Worker 名 ② 首次部署取消 `[[kv_namespaces]]` 注释，填入 KV ID ③ 需要时取消 `routes` / `triggers` 注释 |
| **3** | 双击 `build.bat` | 拼接前端 + esbuild 打包 → `dist/worker.js` |
| **4** | 双击 `setup-secrets.bat` | 设置面板密码和 GitHub Token (加密存储到 CF) |
| **5** | 双击 `deploy.bat` | 推送到 Cloudflare |

### 🔄 日常更新

```
build.bat → deploy.bat
```
两步完成，KV/路由/触发器不受影响；密钥永不覆盖。

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
2. 当某账号用量达到阈值时自动轮换 UUID 并重新部署
3. 可选配置 Webhook 接收熔断告警

### 🎲 刷 UUID

在变量面板点「🎲 刷 UUID」可生成新的随机 UUID，下次部署时生效。

### 🔧 一键修复 1101

遇到 Worker 1101 错误时，点击「🔧 一键修复 1101」:
1. 记录当前变量绑定和域名
2. 删除 Worker
3. 随机修改子域名
4. 用相同名称重建
5. 恢复所有变量 + 域名

---

## ❓ 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 页面显示 "KV Not Bound" | KV 未绑定 | Settings → 添加 `CONFIG_KV` KV 绑定 |
| 检查更新报错 | GitHub API 限流 | 配置 `GITHUB_TOKEN` 环境变量 |
| 修改子域名后不可用 | DNS 传播延迟 | 等待数分钟至数小时 |
| 不能用 API Token | 权限不足 | 必须使用 Global API Key |
| 部署后变量没有出现 | KV 缓存旧数据 | 刷新面板或手动点「+ 变量」添加 |

---

## 🏗️ 从零开发的完整技能清单

### 🔧 后端核心技术
- **Cloudflare Workers** — V8 隔离环境，Service Worker 格式，fetch/scheduled handler
- **Wrangler CLI** — 部署、KV 管理、密钥管理 (secret)、Cron 触发器配置
- **Cloudflare API v4** — Worker 脚本上传/删除、绑定管理 (plain_text / secret_text / kv_namespace)、域名绑定、子域名管理、KV 命名空间 CRUD
- **Cloudflare GraphQL API** — 账号用量统计查询
- **GitHub REST API** — 文件内容获取、Commit 历史、版本对比 (diff)

### 🔐 安全
- **Web Crypto API** — SHA-256 密码哈希、AES-256-GCM 加解密
- **Cookie 安全** — `__Host-` 前缀、SameSite、HttpOnly
- **CSRF 防护** — Sec-Fetch-Site / Origin 头校验
- **CSP 策略** — Content-Security-Policy 头限制脚本和样式来源
- **透明加密** — 账号密钥在写入 KV 前自动加密，读取时自动解密

### 🎨 前端
- **Vanilla JavaScript** — 零框架，纯 DOM API 操作
- **Tailwind CSS** — CDN 引入，响应式布局
- **SweetAlert2** — 弹窗确认、错误提示
- **Canvas API** — 星空主题动态背景 (星星、流星、星云光晕)
- **SPA 架构** — 单页应用，模态框切换视图，localStorage 主题持久化

### 🛠️ 构建与工具
- **esbuild** — TypeScript/JS 打包为单文件 ESM 输出
- **Node.js** — 构建脚本、内联前端资源、SweetAlert2 下载
- **Vitest** — 单元测试
- **TypeScript** — 类型安全、接口定义

---

## ⚠️ 免责声明

本项目仅供技术研究和学习使用。开发者不对使用本工具产生的任何后果负责。所有 API Key 仅保存在用户自己的 Cloudflare KV 中，请妥善保管。
