# 架构与实现说明

本文描述 V12.2.0 的运行时结构、权威数据模型、任务状态机和关键实现机制。生产架构是 **Worker + SQLite Durable Objects**；旧 Workers KV 只保留登录会话与历史数据，不是配置/凭据的权威，也不作为故障回退。

## 1. 组件与数据流

```text
浏览器（原生前端）
  │ HTTPS / Cookie 会话 / CSRF / 配置修订协议
  ▼
中控 Worker：src/index.ts
  ├─ 静态资源与登录
  ├─ authority 网关（认证 + 固定路径翻译）
  ├─ 内部 HMAC RPC → Durable Objects
  └─ Cron → Global DO
        │
        ▼
Global DO（名字 reliability-global-v1，SQLite storage）
  ├─ 配置权威：generation / epoch / 域 revision / CAS
  ├─ 凭据权威：v2 信封、key ring、撤销与观察期
  ├─ 任务接纳：意图键、冻结快照、全局许可、投影
  ├─ 自动检查、Webhook outbox
  └─ 独立签名维护通道（归档/代际/排空）
        │
        ▼
Account DO（名字 reliability-account-v1-<accountId>，SQLite storage）
  ├─ 持久队列、步骤状态、执行 token
  ├─ 写前日志 execution_calls（先日志，后外部 HTTP）
  ├─ 固定 Cloudflare API 主机与账号路径
  └─ unknown 屏障、回执、排空封印
```

同一 DO namespace 内按对象名区分物理对象；Global 与 Account 不是同一个内存对象，也不是 D1/Redis/Queues。

## 2. Worker 入口与认证

`src/index.ts` 的请求顺序：

1. `/api/reliability/maintenance` 在 Cookie 之前直接交给独立签名维护入口。
2. 公开路由：`POST /api/login`、`POST /api/logout`、`GET /manifest.json`。
3. 认证链：`ACCESS_CODE` 配置检查 → CSRF 校验（写请求）→ 会话 Cookie 校验。
4. 静态资源：`/app.js`、`/app.css`、本地 SweetAlert2，内容寻址版本号 + 长缓存；HTML 不缓存。
5. `reliabilityConfigured(env)` 为真时，剩余 `/api/*` 全部进入 authority 网关；绝不回退旧 KV 业务实现。
6. 非 authority 模式仅用于旧分发/迁移兼容（显式 `CFAUTO_STORAGE_MODE=legacy` 且无任何 `RELIABILITY_*` 绑定）。

认证细节：

- `ACCESS_CODE` 双方 SHA-256 后恒定时间比较；登录成功生成 32B 随机 auth token 与 CSRF token。
- 会话存 KV `SESSION_<authToken> = <csrfToken>`（7 天 TTL）；`__Host-auth` HttpOnly，`__Host-csrf` 前端可读。
- 失败登录按 IP 计数限流（KV，固定窗口）；成功登录清理计数。
- 写请求要求 `X-CSRF-Token` 与会话内 CSRF 恒定时间一致，并在存在时校验 `Sec-Fetch-Site` 与 `Origin`。

## 3. 内部 RPC 协议

浏览器永远不能直接调用 DO。Worker 与 DO 之间使用 `CoordinatorRpc`：

- 消息：`{version, direction, account, method, at, nonce, body, signature}`。
- 方法方向固定（`global-account` / `account-global` / `gateway-global` / `scheduler-global`），方向与方法不匹配直接 403。
- HMAC 密钥由 `RELIABILITY_RPC_SECRET` 经 HKDF-SHA256 派生，按 `direction + account` 隔离。
- 签名包含 canonical JSON；±60 秒时间窗，签名校验后再次检查时间。
- 接收方先按对象名验证物理地址，再创建该角色的 store；错误地址/角色不创建业务表。
- 请求体有界流式读取；`submit_task`/`read_external` 上限 2 MiB + 16 KiB，其余 128 KiB。

RPC 期限：`submit_task`/`cron_cycle` 90 秒、`read_external` 60 秒、其余 15 秒。失败只由持久 inbox/outbox 重发协议消息，客户端不重试外部写。

## 4. 配置模型

配置以 **generation + epoch + 域 revision** 标识，`ConfigStore` 持有：

| 表 | 作用 |
|---|---|
| `config_meta` | 活动 generation、maintenance、epoch |
| `config_generations` | staging/active/retained 代际与清单摘要 |
| `config_records` | 每代每域一条记录（revision + canonical JSON） |
| `config_outbox` | 投影事件队列（只追加，ack 后再标记） |
| `authority_identity` / `authority_heads` | 安装身份与三条指针的一致性镜像 |
| `runtime_records` / `runtime_receipts` | `lastCheck`/`lastGc` 等运行数据（单调） |

数据域约定：

| 域 | 内容 |
|---|---|
| `accounts` | 账号列表与凭据密文（由 CredentialAuthority 统一提交） |
| `autoConfig` | 自动检查配置（不含 `lastCheck`/`lastGc`） |
| `deploy:<t>` / `vars:<t>` / `favorites:<t>` / `upstream:<t>` | 每个模板的部署配置、全局变量、收藏、上游文件/分支 |
| `override:<t>:<account>` | 账号级变量覆盖 |
| `template:<t>` | 可编辑的模板兼容日期（V12.2.0） |
| `deployJournal` | 部署日志（由任务账本写，不接受浏览器直接编辑） |

保存路径：

- 前端必须携带 `Idempotency-Key`、`X-Reliability-Protocol: 1` 和读取基线（generation/epoch/域 revision）。
- DO 先查意图回执（同键异意图 409），再在同一事务中校验基线、写记录与 outbox、写回执。
- 相同意图重放返回原回执与 `duplicate:true`；陈旧基线 409；旧协议 428。
- `assertBarrier` 在任务接纳事务中同时校验 generation、epoch、watermark 与每域 revision。
- `ConfigProjection` 只处理 revision 提示，不把配置值投影回 KV。

### 兼容日期（V12.2.0）

- 域 `template:<type>` 的值为严格 `{ compatibilityDate }`。
- 默认值来自 `src/config/templates.ts`；`readTemplateSettings` 负责“未保存回退默认值、损坏值拒绝”。
- 日期校验：真实日历日期、`2021-11-01` ≤ date ≤ 当天。
- 任务规划时读取该域并把日期写入每条上传类命令（见第 6 节）；已接纳任务不随后续修改变化。

## 5. Global DO 职责

Global 角色由 `ProductionCoordinator` 按对象名创建，组装：

- `ConfigStore`、`TaskDispatch`、`CredentialAuthority`、`ConfigEditor`、`TaskPreparation`；
- `GlobalCoordinatorRuntime`、`BusinessAdmission`、`ConfigProjection`；
- `AutomationCycles` / `AutomationPlanner` / `AutomationFlow` / `WebhookOutbox`；
- `TaskCatalog`、`AuthorityViews`、`ExternalReads`；
- 维护入口（独立签名）与归档/代际/排空服务。

任务许可：`TaskDispatch.reserve()` 统计 `sending/accepted` 的投递，**全局最多 3 个账号**同时持有许可；同一账号最多一条在途投递（账号内串行）。另有限制：单任务 target ≤ 100、活跃任务 ≤ 500、单账号非终态投递 ≤ 50、Account 队列非终态 ≤ 50、完成 admission ≤ 500。

## 6. 任务生命周期

```text
浏览器确认目标
  → POST /api/*（携带 X-Reliability-Protocol、Idempotency-Key）
  → authority 网关校验登录/CSRF/协议头
  → submit_task RPC
  → BusinessAdmission：意图预留 + 摘要
  → BusinessPlanner：读取权威配置、冻结目标/源码/步骤，读取兼容日期
  → TaskPreparation：密封快照 + dispatch CAS（assertBarrier）
  → 202 { id, duplicate, statusUrl }
  → Global reserve()：最多 3 个账号许可
  → deliver RPC → AccountQueue：queued/planned
  → AccountRunner claim → in_flight/running
  → ExecutionJournal：先写 execution_calls，再发 HTTP
  → verified / failed / unknown
  → progress/complete 回执 → Global BusinessEffects 写事实并更新配置
  → terminal：succeeded / partial_failed / failed / cancelled
```

关键状态字符串：

| 层 | 状态 |
|---|---|
| 投递 outbox | `pending` → `sending` → `accepted` → `terminal` |
| Account job | `queued` → `running` → `needs_review`（或终态） |
| 步骤 | `planned` → `in_flight` → `verified` / `failed` / `unknown` / `skipped` |
| 任务投影 | `queued` / `running` / `needs_review` / 终态 |
| Account 排空 | 无记录 / `probed` → `ready` → `consumed`/`released` |

### 写前日志与 unknown

- 每次外部写前，请求与上下文先密封写入 `execution_calls(in_flight)`；收到响应后写 `done`。
- 传输超时、5xx/408、响应无法证明结果、本地持久化失败等 → `unknown`，阻断该账号后续步骤并保持许可。
- 重放只回放已存响应；不会因为“再点一次”重复外部写。
- `unknown` 的推进只能通过固定 GET 观察 + 有权限维护操作员的人工裁决；设计上不允许自动化编造供应商终态。
- “日志证明没有任何 mutation 调用”的未知，可由账户执行器自动结算为 `failed/NO_MUTATION_RECORDED`；有 mutation 的仍必须人工处理。

### 1101 修复

- 规划阶段冻结目标清单（必须与整个安装一致）+ 上游源码 + 兼容日期。
- 每个目标：备份脚本/绑定/域名/子域名，删除，重传，回读校验，恢复域名。
- 账号级子域名步骤使用非破坏 `change_subdomain`：先 PUT + 回读；只有供应商明确拒绝替换才 DELETE→重建；删除必须回读确认且不重复；无法确认新名时恢复旧名并记 `ROTATION_NOT_APPLIED`。

## 7. 凭据与密封存储

### 凭据 v2

- 信封：`v2:<keyId>:base64(iv12 ‖ AES-256-GCM 密文+tag)`。
- 密钥由 key ring 材料经 HKDF-SHA256（salt `cfauto:credential:v2`）派生；AAD 绑定 `{version,keyId,accountId,field,revision}`，密文不能跨账号/字段/revision 挪用。
- key ring 有 `currentId` 与必要旧 key：写用 current，读按密文 keyId；旧 key 不能删除。
- 服务端读取后投影脱敏（前端只看到 `***` 或掩码）；账号导出只包含密文与 keyIds。
- 撤销只登记、不删除密文、不释放许可；新账号/改凭据有观察期策略。

### 密封存储与大源码

- `SealedStore` 按 48 KiB 分块 AES-GCM，AAD 绑定 id/kind/account/generation/keyId/digest/bytes/chunks/ordinal；块与元数据同事务写入且不可覆盖。
- 加密对象上限 5 MiB；解压后明文上限 16 MiB；固定上游源码读取上限 8 MiB；Worker 脚本读取/响应上限 10 MiB。
- 大于 4 MiB 且压缩确有收益时才使用版本化 gzip 帧；解压有硬上限，压缩不足直接拒绝。
- 相同源码在规划器内共享，避免多账号重复放大。

## 8. 自动检查与通知

- Cron 触发 `authorityScheduled` → `cron_cycle` RPC → `AutomationFlow`。
- `AutomationCycle` 以 5 分钟窗口先占位，再冻结依赖向量（域 revision + watermark），恢复时只读同一密文。
- `AutomationPlanner` 按已保存的 interval/模板开关/熔断阈值生成规划；与手工任务使用同一 `BusinessPlanner`，同样冻结兼容日期。
- 通知走 `webhook_outbox`：唯一 ID、固定协议主机、只认成功 errcode；重启后 `in_flight` 变 `unknown` 而不重发。

## 9. 维护与恢复（概览）

- 生产维护使用独立 HMAC 签名的维护通道（不是 Cookie 会话），具备 operator 权限划分（inspect/maintain/drain/review/attest/adjudicate/archive/migrate/activate）。
- 权威归档按固定表清单/分页加密导出，可断点续传；整组归档与排空服务用于代际切换前后的原子验证。
- 代际导入/激活在同一 SQLite 事务中写入配置/凭据/runtime 指针、维护回执与 outbox；缺少排空或未知屏障时拒绝激活。
- 完整恢复工具与操作流程不在公开仓库中；公开源码只包含协议与服务端实现。

## 10. 前端与构建

- `frontend/index.html` + 原生 JS/CSS；`frontend/modules` 放可独立测试的纯逻辑，构建期打包为 `frontendModules` 岛；`frontend/js` 是兼容适配层，按固定顺序拼接。
- 事件统一使用 `data-act` 委托；CSP 不含内联脚本；图标在构建期内联 Lucide SVG。
- 配置保存使用 revision 协议：读取头 `X-Config-*`、写请求带基线，409/428 明确提示。
- 任务面板默认收起，展开后轮询；收起只停止本页轮询，不取消服务器任务；旧序列响应不覆盖新状态。
- `build.js`：Tailwind 构建期编译 → 前端拼接 → SweetAlert2 本地内联 → esbuild 单文件 Worker → `dist/build-manifest.json`（版本、Git、源输入 SHA256、Worker SHA256）。
- 构建身份（Build ID）不等于部署事实；生产状态需单独回读。

## 11. 测试与门禁

- 单一入口 `node scripts/check.cjs`：build → typecheck → verify → 全量 Vitest，每阶段仅一次。
- 测试清单 `test/suites.json` 与实际文件一一对应；Vitest 禁用 `only`，不接受空清单或过滤运行。
- `verify.js` 静态检查：路由/动作注册、HTML id、CSP、反模式、版本一致性、构建清单与源输入一致。
- 真实本地 DO 测试：起停真实 `wrangler dev --local` 进程，验证队列/未知屏障/凭据/激活/大源码等恢复场景；默认 9 次重启，`RELIABILITY_RUNTIME_FULL_RESTARTS=1` 为完整 35 次。
- 浏览器源码保留为可选 mock 回归；不等同于真实浏览器/生产验收。
