# Worker 智能中控 (V12.2.0)

> **版本状态**: V12.2.0 — 多账号 Cloudflare Worker 部署中控：Durable Objects 权威状态、可配置上游、可编辑兼容日期、持久任务与自动检查。

Cloudflare 多账号 Worker 管理面板，支持 **CMliu / Joey / ECH** 三类上游项目的部署、更新、变量管理、账号迁移、任务跟踪与自动检查。

生产架构是 **Worker + SQLite Durable Objects**：中控 Worker 负责认证、协议适配与静态资源；全局 DO 保存配置、凭据、任务接纳与调度；每个业务账号一个 Account DO 负责队列、执行、写前日志与回执。KV 只保留登录会话和少量历史数据，不再是管理配置的权威。

> 安全提醒：仓库不包含任何生产 Token、Secret、`wrangler.local.toml`、`.wrangler` 私有证据或恢复材料。凭据在服务端使用 v2 认证加密保存。

## 目录

- [功能与边界](#功能与边界)
- [V12.2.0 新功能：按模板编辑兼容日期](#v1220-新功能按模板编辑兼容日期)
- [架构与实现方式](#架构与实现方式)
- [首次部署](#首次部署)
- [面板使用流程](#面板使用流程)
- [任务状态与错误处理](#任务状态与错误处理)
- [导入导出、备份与恢复](#导入导出备份与恢复)
- [开发与验证](#开发与验证)
- [安全与开源说明](#安全与开源说明)

## 功能与边界

| 能力 | 实际用途 |
|---|---|
| 多账号管理 | API Token 或 Global API Key 管理多个账号，查询用量、域名与 Worker |
| 项目配置 | CMliu / Joey / ECH 的变量、Secret、UUID、目标 Worker、上游文件/分支 |
| 兼容日期 | 每个项目单独设置 `compatibility_date`，规划任务时冻结进执行计划 |
| 部署与版本 | 预览目标、批量部署、历史版本、收藏、固定版本 |
| 持久任务 | 202 接纳、排队/执行/完成/待核对状态，断线或刷新不取消任务 |
| 1101 修复 | 目标 Worker 备份后修复、恢复域名与绑定；账号级子域名默认非破坏 |
| 自动检查 | Cron 驱动的版本检查、失败重试、UUID 熔断与通知 |
| 运维工具 | Worker 管理、子域名修改、部署日志、系统诊断与脱敏报障 |
| 数据管理 | 账号迁移；完整权威备份/恢复走独立维护通道 |

**边界说明：**

- 中控只负责“调用 Cloudflare API 部署/更新”，目标 Worker 的业务行为由上游代码决定。
- `202 Accepted` 表示任务已持久接纳，**不代表部署成功**；以任务列表里的步骤事实和终态为准。
- `unknown` 表示外部写结果未知，不会自动重试；必须通过固定 GET 观察与人工裁决推进。
- 中控备份不等于整个 Cloudflare 账号的灾备：不含目标业务 KV 全量内容与账号设置。
- 仓库是部署管理工具，不是上游项目的官方分发渠道。

## V12.2.0 新功能：按模板编辑兼容日期

此前 `compatibility_date` 硬编码在模板定义里，改日期需要改源码并重新发布。V12.2.0 起：

- 三个项目面板各有 **“兼容日期”** 一行（日期输入 + 保存）。
- 默认值来自模板：CMliu / ECH `2024-04-05`，Joey `2026-01-20`（上游建议值）。
- 保存写入权威配置域 `template:<type>`，值 `{ compatibilityDate }`，与其它配置一样有 generation/epoch/revision CAS 与幂等回执。
- 日期必须是真实日历日期，范围 `2021-11-01` 至当天；未知模板、未知字段、未来日期都会被拒绝。
- 任务规划时把**当前生效日期冻结进命令**（部署、更新、1101 修复、自动检查），已接纳任务不会因为之后面板修改而改变；旧密封快照缺少该字段时回退模板默认值。

## 架构与实现方式

### 运行时结构

```text
浏览器（原生 HTML/CSS/JS）
  │ HTTPS：Cookie 会话 + CSRF + 配置修订协议
  ▼
中控 Worker（src/index.ts）
  ├─ 静态资源：HTML、/app.js、/app.css、本地图标与 SweetAlert2
  ├─ 认证/CSRF/限流 → authority 网关 → 内部签名 RPC
  ├─ CONFIG_KV：仅会话与保留历史（不是配置权威）
  └─ Cron：转交 Global DO 的 automation cycle
        │
        ▼
Global DO（reliability-global-v1，SQLite）
  ├─ 配置权威：generation / epoch / 域 revision CAS
  ├─ 凭据权威：v2 加密信封、key ring、撤销与观察期
  ├─ 任务接纳：意图键、快照封印、全局 3 账号许可
  ├─ 自动检查编排、Webhook outbox、任务投影
  └─ 维护通道：独立 HMAC 签名的归档/代际/排空
        │ 签名 RPC（HKDF 派生、按方向隔离、±60s）
        ▼
Account DO（reliability-account-v1-<accountId>，SQLite）
  ├─ 持久队列、步骤状态
  ├─ 写前日志 execution_calls（先日志后 HTTP）
  ├─ 固定域名/账号路径的 Cloudflare API 调用
  └─ unknown 屏障、回执、排空封印
```

详细设计、数据表、RPC 方法、配置域、任务状态机与容量边界见 [架构说明](docs/ARCHITECTURE.md)。

### 请求入口

1. `/api/reliability/maintenance` 在 Cookie 之前，使用独立维护签名。
2. 公开路由：`POST /api/login`、`POST /api/logout`、`/manifest.json`。
3. 登录成功后：会话 Cookie（`__Host-auth`，HttpOnly）+ CSRF Cookie/头（`__Host-csrf` + `X-CSRF-Token`）。
4. 默认 fail-closed 到 authority 模式；只有显式 `CFAUTO_STORAGE_MODE=legacy` 且没有任何 `RELIABILITY_*` 绑定才走旧 KV 逻辑。
5. authority 模式下旧面板路径被翻译为固定 RPC：只读视图、只读外部读取、配置编辑、任务提交，不接受任意 URL/作用域/执行器。

### 配置与任务

- 配置以 **generation + epoch + 域 revision** 标识；保存必须带读取基线与 `Idempotency-Key`，服务端 CAS；冲突 409、旧客户端 428。
- 草稿只在浏览器；已保存配置在 Global DO；`lastCheck/lastGc` 等运行数据独立单调保存。
- 任务接收后返回 202；Global 冻结目标与源码快照，按 3 个账号并发许可投递到 Account DO；账号内步骤串行。
- 每次外部写之前先持久化日志；已知 ACK 可重放，未知结果进入 `unknown` 并阻断后续步骤。

## 首次部署

前置：Node 支持 `node:sqlite`（建议 24+）、pnpm、Cloudflare 账号与 API Token。

1. `pnpm install`。
2. 设置 Worker Secret（不要把密钥写入仓库）：
   - `ACCESS_CODE`：面板登录口令；
   - `RELIABILITY_RPC_SECRET`、`RELIABILITY_IDEMPOTENCY_SECRET`、`RELIABILITY_EVIDENCE_SECRET`：各自独立 32 字节随机 hex（64 字符）；
   - `RELIABILITY_CREDENTIAL_KEYS`、`RELIABILITY_SNAPSHOT_KEYS`：canonical JSON key ring；
   - `RELIABILITY_MANAGER_ACCOUNT` / `RELIABILITY_MANAGER_WORKER` / `RELIABILITY_CONFIG_NAMESPACE`：中控自身安装身份；
   - 可选：`RELIABILITY_MAINTENANCE_KEYS`、`RELIABILITY_PROTECTED_RESOURCES`、`GITHUB_TOKEN`。
3. 绑定 KV 到 `CONFIG_KV`（会话用途）与 DO 绑定 `RELIABILITY_COORDINATOR`（SQLite 类 `ProductionCoordinator`），Cron 建议 `*/5 * * * *`。
4. 构建：`node build.js`，把 `dist/worker.js` 按你的正常发布流程上传；生产升级应保持原有绑定与 Secret 不变。

`wrangler.toml` 只是占位模板；每个环境的真实配置不要提交到 Git。

## 面板使用流程

1. 打开面板，用 `ACCESS_CODE` 登录。
2. **账号列表 → 添加/导入账号**：填写 Account ID（32 位 hex）、别名、认证方式；凭据只在服务端加密保存，前端始终只看到掩码。
3. **项目面板**：选择 CMliu / Joey / ECH，编辑变量与上游文件/分支；三项项目配置互相独立。
4. **兼容日期**：在对应项目面板修改并保存；下一次部署/更新/1101 修复生效。
5. **预览 → 部署/更新**：先预览影响范围，再确认；按钮恢复或请求超时都不取消已接纳任务。
6. **任务列表**：查看排队、执行、完成或待核对；收起只停止本页轮询，服务器任务继续。
7. **自动任务设置**：保存间隔、参与模板、熔断阈值、告警 webhook；Cron 由 Cloudflare 触发，时间不精确到秒。
8. **账号工具**：刷新用量、导出/导入账号、备份配置。账号移除只删除中控配置，不删除 Cloudflare 账号/Worker/KV。

## 任务状态与错误处理

| 状态/错误 | 含义与处理 |
|---|---|
| `queued` / `running` | 未终态；继续等待或在任务详情查看步骤 |
| `succeeded` / `partial_failed` / `failed` | 终态：成功 / 部分目标失败 / 失败 |
| `needs_review` / `unknown` | 外部写结果未知，需维护人员用固定 GET 观察与人工裁决；不要重试 |
| 202 | 已接纳，不代表完成；保留任务 ID |
| 401 / 403 | 重新登录 / CSRF 校验失败，不要绕过安全校验 |
| 400 `INVALID` | 目标、类型、保护策略或大小边界不合法；看脱敏请求 ID |
| 409 / 428 | 配置基线冲突 / 客户端协议过旧：重读合并，或刷新新版前端 |
| 503 `NOT_READY` | DO/Secret/pin 等权威配置未就绪或维护中；不要回退旧 KV |
| 1101 修复 | 修复会备份、删除、重建目标；账号子域名段默认先 PUT，仅在供应商明确拒绝时才重建 |

## 导入导出、备份与恢复

| 操作 | 范围 |
|---|---|
| 账号导出/导入 | 账号与凭据密文，用于账号迁移；不是完整灾备 |
| 中控配置备份 | 面板中的备份入口；authority 模式下完整恢复需要独立维护通道 |
| 旧 KV 恢复 | authority 模式下被拒绝（409），避免把陈旧 KV 当权威回退 |

部署前建议先导出账号或做受控备份；恢复会覆盖对应配置，不能在旧 revision 上强写。

## 开发与验证

```powershell
node scripts/check.cjs                  # build → typecheck → verify → 全量 Vitest（一次跑完）
node scripts/check.cjs --runtime --evidence .wrangler/check-<新目录>  # 追加真实本地 DO 重启
node scripts/test-scope.cjs run frontend # 仅前端快速反馈
```

- 完整检查是唯一本地门槛；`--runtime` 已包含普通检查，不要重复跑。
- 默认 runtime 只做 9 次真实进程重启（9 个具名恢复 checkpoint + 大源码前内存复位）；完整 35 次用 `RELIABILITY_RUNTIME_FULL_RESTARTS=1`。
- 证据目录必须是新目录；检查脚本不会覆盖旧回执，也不会部署。
- 本公开仓库包含应用源码、构建/测试工具和核心回归；生产验收/恢复类内部运维工具与其测试不在公开范围内。
- 详见 [开发与测试](docs/DEVELOPMENT.md) 与 [UI 约定](docs/UI_CONVENTIONS.md)。

## 安全与开源说明

- 仓库中不包含 `wrangler.local.toml`、`.wrangler/` 私有证据、操作员 Token、凭据恢复材料或本地绝对路径。
- 账号凭据使用 v2 认证加密（AES-GCM + HKDF 派生密钥，AAD 绑定账号/字段/revision），服务端读取后脱敏投影。
- 配置保存使用幂等键 + 版本 CAS，冲突显式 409，不允许静默覆盖。
- 前端 CSP 不使用内联脚本；事件通过 `data-act` 委托；本地 Lucide 图标随构建内联。
- 上游代码与图标许可归各自项目所有；本仓库只提供部署管理工具。
