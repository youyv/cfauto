# Changelog

所有针对该项目的有实质性的代码与架构变动都将记录在这个文件中。
版本规则遵循：主版本.次版本.修订号

---

## [v1.6.0] - 2026-02-25

### Added
- **优选 IP 订阅系统**：主页 Token 查询通过后展示优选面板，从 `zip.cm.edu.kg/all.txt` 拉取全球优选 IP 数据
- **地区多选面板**：国旗 + 国家名卡片网格，支持全选/取消，可设置每地区数量上限
- **订阅配置生成**：一键生成 Base64 编码的订阅链接，节点别名格式 `🇯🇵 日本 01`，地址用优选 IP，SNI/Host 保持 Worker 域名
- **订阅直出端点**：`GET /sub/{token}?regions=JP,US&limit=10`，客户端可直接拉取配置
- **新增 API 接口**：
  - `GET /api/regions` - 返回可用地区列表（含国旗 emoji 和地区名称）
  - `POST /api/ipsel` - 根据地区筛选优选 IP 并生成订阅（需 Token 鉴权）

### Changed
- 移除所有外部依赖引用，实现完全自包含

---

## [v1.5.0] - 2026-02-25

### Added
- **主页 Token 查询入口**：用户输入 Token 实时查询到期时间，返回精确到年月日时分秒的剩余时间显示
- **管理后台配置链接与二维码**：每个 Token 可直接生成客户端配置链接和二维码，支持一键复制及扫码导入
- **公开查询 API**：`POST /api/check-token` 无需管理密码即可查询 Token 状态
- **UUID 随机生成**：管理面板新增 🎲 按钮，一键生成随机 UUID

### Changed
- **特征清洗**：函数名 / 注释 / HTML 中移除所有敏感协议关键词，链接协议头通过拼接避免静态检测
- **代码备份**：`ech_v1.js` 为本版本快照

---

## [v1.3.1] - 2026-02-25

### Fixed
- **环境变量硬编码回退 Bug**：`GITHUB_TOKEN`、`TOKEN_JSON_URL` 恢复从 `env` 环境变量安全读取，不再硬编码为空
- **Token 校验失败 Bug**：`checkTokenInConfig` 现在自动从 `{ global, tokens }` 嵌套结构中提取 `tokens` 数组，兼容新旧两种格式
- **TCP 连接建立**：`remoteSocket.opened` 改为直接 `await`（而非条件判断），确保连接可靠建立
- **远程断开处理**：TCP 断开后直接执行 `cleanup()`，不再发送文本 `'CLOSE'` 消息

### Added
- **双协议自动检测**：首包为二进制 `ArrayBuffer` 时走 VLESS 标准协议（兼容 v2rayNG / NekoBox），首包为文本时走 ECH 自定义协议（CONNECT / DATA / CLOSE），两套协议透明共存
- **VLESS 首包解析器**：完整实现 VLESS 协议头二进制解析（版本 / UUID / 命令 / 地址类型 / 端口），UUID 即为鉴权 Token

---

## [v1.3.0] - 2026-02-24

### Added
- **全栈内嵌 UI**：
  - 重写根路由 `/` — 玻璃拟物风格主页，含动态运行时长计时器
  - 新增管理后台 `/admin` — 包含鉴权模块、实时编辑控制台、Token CRUD 操作面板、主页运行时间重置
  - 内置 GitHub REST API Commit 能力，可从控制台直接覆盖线上配置
- **环境安全升级**：新增 `ADMIN_PASSWORD` 环境变量，保护 `/admin` 管理页和所有 `/api` 读写接口

### Changed
- 远程配置数据结构升级为包含 `global`（全局状态参数）与 `tokens`（令牌体系）的综合化数据池，实现云端无状态化架构

---

## [v1.2.0] - 2026-02-24

### Changed
- **鉴权模式变更**：完全抛弃单 `TOKEN` 常量静态鉴权，仅支持基于 `TOKEN_JSON_URL` 的动态 JSON 验证模式
- **配置变更**：新增默认的 `TOKEN_JSON_URL` 远程拉取源目标，本地增加 `token.json` 默认模版

---

## [v1.1.0] - 2026-02-24

### Added
- 新增 `README.md`，提供完整的项目背景介绍与环境变量配置指导
- 新增 `CHANGELOG.md`，开始规范化管理版本迭代历史

### Changed
- **核心重构**：取代所有硬编码常量初始化行为（如 `token`、`GITHUB_TOKEN`），全面升级为从 Cloudflare Workers `env` 环境变量上下文安全注入与读取

---

## [v1.0.0] - Initial Release

### Initial
- 构建用于 WebSocket 协议桥连代理的核心 Worker 实现
- 三级安全鉴权机制：固定字串验证、多 Token JSON 远程动态鉴定、匿名机制
- 网络故障快速重试方案，提供 Cloudflare 环境外联容错
