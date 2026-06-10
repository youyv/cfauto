# ECH - WebSocket Proxy Server

> 基于 Cloudflare Workers 构建的轻量级 WebSocket 代理服务。内置全栈管理面板、动态 Token 鉴权、全球优选 IP 订阅生成能力。

## ✨ 核心特性

### 🔐 动态 Token 鉴权体系
- 基于远程 `token.json` 的多 Token 鉴权，支持有效期控制
- 内存级缓存（60s TTL）加速鉴权响应
- 内置兜底配置，远程拉取失败时自动降级

### 🌐 双协议 WebSocket 代理
- **二进制协议**：完整 VLESS 协议头解析（版本/UUID/命令/地址类型/端口），UUID 即为鉴权 Token，兼容 v2rayNG / NekoBox 等客户端
- **文本协议**：ECH 自定义协议（CONNECT / DATA / CLOSE 指令），支持全格式地址解析
- 首包自动检测：`ArrayBuffer` 走二进制协议，文本走 ECH 协议，两套协议透明共存
- 内置 Cloudflare 网络容错重试机制

### 🏠 主页控制台 (`/`)
- 玻璃拟物风格的服务器运行时长计时器
- Token 到期时间查询入口（精确到秒）
- 优选 IP 面板：验证 Token 后展示全球地区选择网格（国旗 + 国名卡片）
- 一键生成 Base64 编码的订阅配置链接

### ⚙️ 管理后台 (`/admin`)
- 密码保护的可视化 Token CRUD 管理面板
- 服务器启动时间重设
- Token 快速创建（预设有效期 1天/1周/1月/1年/永久/自定义）
- UUID 随机生成器
- 一键推送配置到 GitHub（自动处理 SHA 冲突）

### 🌍 优选 IP 订阅系统
- 优选 IP 采集逻辑源自 [CF-Worker-BestIP-collector](https://github.com/ethgan/CF-Worker-BestIP-collector)
- 从 `zip.cm.edu.kg/all.txt` 拉取全球优选 IP 数据
- 地区多选面板（全球 100+ 地区，含全选/取消）
- 每地区数量上限可配置
- 订阅直出端点：`GET /sub/{token}?regions=JP,US&limit=10`
- 节点别名格式：`🇯🇵 日本 01`，地址用优选 IP，SNI/Host 保持 Worker 域名

## 📁 项目结构

```
ceh/
├── ech.js          # 主程序（v1.6.0）- Cloudflare Worker 入口
├── ech_v1.js       # v1.5.0 历史备份
├── ech_v2.js       # v1.5.0 历史备份
├── _worker.js      # check.mjs 配套的 Worker
├── check.mjs       # 辅助检测模块
├── test.js         # 测试脚本
├── token.json      # Token 配置模版
├── CHANGELOG.md    # 版本变更记录
└── README.md       # 本文档
```

## 🚀 部署指南

### 1. 创建 Worker
在 Cloudflare Dashboard 创建一个新的 Worker，将 `ech.js` 的内容粘贴到编辑器中并部署。

### 2. 配置环境变量

在 Worker 设置 → 环境变量页面配置以下参数：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `ADMIN_PASSWORD` | ⚠️ 强烈推荐 | 管理后台密码。未设置时 `/admin` 返回 403 |
| `GITHUB_TOKEN` | 选填 | GitHub PAT（需 repo 写入权限），用于管理面板一键推送配置 |
| `TOKEN_JSON_URL` | 选填 | 远程 `token.json` 的直链地址，系统从此 URL 拉取 Token 列表 |

### 3. 配置 token.json

在 GitHub 仓库中维护如下格式的 JSON 配置：

```json
{
  "global": {
    "SERVER_START_TIME": "2024-01-01T00:00:00Z"
  },
  "tokens": [
    {
      "token": "your-uuid-or-token",
      "expire": "2026-12-31T23:59:59Z",
      "remark": "设备备注"
    }
  ]
}
```

- `global.SERVER_START_TIME`：主页计时器起点
- `tokens[].token`：鉴权凭证（同时作为二进制协议的 UUID）
- `tokens[].expire`：到期时间（ISO 8601），留空为永久有效
- `tokens[].remark`：可选备注

## 📡 API 参考

### 公开接口（无需管理密码）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/check-token` | Token 到期查询。Body: `{ "token": "xxx" }` |
| `GET` | `/api/regions` | 返回可用地区列表 |
| `POST` | `/api/ipsel` | 根据地区筛选优选 IP 并生成订阅。Body: `{ "token": "xxx", "regions": ["JP","US"], "limit": 10 }` |
| `GET` | `/sub/{token}?regions=JP,US&limit=10` | 订阅直出（Base64），客户端可直接拉取 |

### 管理接口（需 Authorization Header = ADMIN_PASSWORD）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/tokens` | 读取全部 Token 配置 |
| `PUT` | `/api/tokens` | 写入 Token 配置到 GitHub |

## 🛠 技术架构

- **运行时**：Cloudflare Workers（V8 Isolate）
- **语言**：纯 JavaScript（ES Module）
- **存储**：GitHub 仓库 JSON 文件（通过 REST API 读写）
- **缓存**：内存级 Token 配置缓存（60s TTL）
- **UI**：内嵌 HTML + Vanilla JS，无外部依赖
- **网络**：`cloudflare:sockets` TCP 连接 + WebSocket 双向桥接

## 📋 版本历史

详见 [CHANGELOG.md](./CHANGELOG.md)

**当前版本：v1.6.0**
