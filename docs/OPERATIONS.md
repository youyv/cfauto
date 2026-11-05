# 升级、部署与恢复

本页供管理已有实例的人使用。第一次搭基础面板请读[新手部署教程](DEPLOYMENT.md)；日常添加账号和部署业务 Worker 请读[使用教程](USER_GUIDE.md)。

## 1. 先识别自己的实例

登录面板后读取 `/api/reliability/recovery`：`mode=legacy` 使用 KV 兼容路径；`mode=authority` 使用 SQLite DO。保存你的 Worker 名称、账号 ID、KV namespace ID、运行模式和当前构建身份。

**三个操作不是同一件事**：

- 更新中控源码：重新上传管理面板 Worker。
- 在面板里部署 CMliu / Joey / ECH：修改业务账号下的目标 Worker。
- 将 KV 配置切换到 DO：数据初始化/迁移，需独立来源证明与激活流程。

现有 authority 实例出错时不能切到 legacy，旧 KV 不是当前配置的备用权威。

## 2. 更新兼容模式实例

仅适用于[新手教程](DEPLOYMENT.md)安装的独立实例：备份配置和凭据，保留同一份 `wrangler.legacy.local.toml`、同一个 KV ID、同一个 `ENCRYPTION_SECRET`。

```powershell
git status --short
git pull --ff-only
pnpm.cmd install --frozen-lockfile --ignore-scripts
node scripts/check.cjs
node node_modules/wrangler/bin/wrangler.js deploy -c wrangler.legacy.local.toml --dry-run
node node_modules/wrangler/bin/wrangler.js deploy -c wrangler.legacy.local.toml
```

存在未保存源码改动或 Git 合并错误时先处理，不执行强制覆盖。更新不重新创建 KV、不替换加密密钥。

## 3. 首次安装权威模式需要什么

当前仓库包含运行时、迁移与受控验收能力，但**没有为任意新账号封装好的一键初始化安装器**。只上传 `dist/worker.js` 并绑定 DO 仍不够：空全局数据库处于未激活/维护状态，业务 API 将拒绝工作。

完整安装涉及：

| 项目 | 用途 |
| --- | --- |
| 一个中控 Worker | 托管网页与 HTTP / Cron 入口 |
| `CONFIG_KV` | 登录会话及保留旧来源 |
| `RELIABILITY_COORDINATOR` | 绑定 `ProductionCoordinator` 的 SQLite DO namespace |
| `RELIABILITY_MANAGER_ACCOUNT` / `RELIABILITY_MANAGER_WORKER` | 当前安装的账号与 Worker 身份 |
| `RELIABILITY_CONFIG_NAMESPACE` | 中控 KV 的实际 ID |
| `ACCESS_CODE` | 浏览器登录 |
| `RELIABILITY_RPC_SECRET` | 内部 RPC 签名 |
| `RELIABILITY_IDEMPOTENCY_SECRET` | 稳定意图与幂等摘要 |
| `RELIABILITY_EVIDENCE_SECRET` | 执行证据 |
| `RELIABILITY_CREDENTIAL_KEYS` | 凭据加密 key ring |
| `RELIABILITY_SNAPSHOT_KEYS` | 快照加密 key ring |
| `RELIABILITY_MAINTENANCE_KEYS` | 独立维护操作者与角色 |
| `RELIABILITY_INITIAL_CUTOVER_PIN` | 经过核验的首次来源、导入和激活约束 |
| `GITHUB_TOKEN` | 可选，上游读取 |

三个独立 Secret 和 key ring 的 key 都使用各自生成的随机 32 字节小写十六进制值，不复用。key ring 必须是规范 JSON，形如 `{"currentId":"key1","keys":{"key1":"独立生成的64位小写hex"}}`；中文示例不可直接使用。

本仓库的既有部署工具沿用 `migrations` / `new_sqlite_classes` 声明 SQLite DO。Cloudflare 也提供较新的 `exports` 生命周期声明，两套机制不能混用；既有实例应保留当前方式和 namespace，按官方迁移说明单独规划变更。不得把别人的迁移 tag 或 namespace ID 抄过来。参考 [Cloudflare DO 生命周期文档](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。

真正的首次流程是：准备安装目标与密钥 → 完整备份并验证旧来源/空来源政策 → 安装已核验的 pin → 签名上传来源包 → 导入 inactive generation → 检查完整性 → 原子激活 → 检查凭据和视图 → 按许可恢复业务及 Cron。任何未证明的步骤都不能以手工写 SQL 或把报告字段改成 `true` 代替。

相关实现：`scripts/initial-source-package.cjs`、`scripts/initial-cutover-client.cjs`、`scripts/production-release-session.cjs`、`src/reliability/maintenance-initial-cutover.ts`。其中部分生产/隔离工具绑定作者已有目标，不是新账号安装向导。需要完整权威模式的新安装应先由了解协议的人准备适配方案，再上线。

## 4. 升级已有权威模式实例

### 4.1 准备候选

1. 确定源码版本；不要覆盖本地未提交改动。
2. 使用锁文件安装依赖。
3. 为候选运行完整门槛，证据目录必须是新目录：

```powershell
node scripts/check.cjs --runtime --evidence .wrangler/check-my-release-001
```

它完成 build → typecheck → verify → Vitest → 真实本地 DO 重启。检查结束的 `LOCAL_CHECK_COMPLETE` 和 `implementation-report.json` 必须属于当前源码及当前 Worker SHA256。

`releaseAllowed:false` 表示这是本地验证报告，不代表生产发布批准，也不应手工改成 `true`。

### 4.2 备份和读取现状

上传前记录并核对：

- 当前 100% 流量的 version / deployment。
- 当前线上 Worker 原始字节与 SHA256。
- 所有绑定的名称、类型、普通值，以及 DO/KV namespace。
- compatibility date/flags、域名、workers.dev 设置、Cron、观测和其他运行设置。
- 活动 generation、epoch、维护状态、未知结果/在途任务情况。

脚本源备份与数据库归档是两种备份。`scripts/backup-worker-readonly.cjs` 备份前者；当前权威数据需独立维护归档。密钥值应在自己的受限位置保留，不会从 Git 仓库恢复。

### 4.3 先做候选验收

复用自己的隔离验收实例验证同一候选，核对绑定和数据状态，再检查登录、配置读写、任务回执及相关新功能。仓库里的 `upgrade-chained-isolated.cjs` 等工具有固定目标和历史证据约束，不能换个目录就当成适用于所有实例。

### 4.4 上传一次

部署方式必须保留现有资源与完整配置。这个仓库的默认 `wrangler.toml` 是占位模板；新手的 `wrangler.legacy.example.toml` 是兼容模式模板，**都不能直接用来升级现有 authority 实例**。`--keep-vars` 也不能替代完整的 DO/KV/路由配置。

现有生产发布使用 Cloudflare 上传 API 的绑定继承方式：

- 每个现有非密钥绑定以 `{ name, type: "inherit" }` 继承。
- 用 `keep_bindings: ["secret_text"]` 保留现有密钥绑定。
- 保留当前兼容设置、运行设置、域名和 Cron。
- 上传前落盘候选摘要、原版本身份、原始请求和稳定操作记录。
- 只发出一次 PUT。网络异常/超时后查原操作和远端版本，不换一个 ID 再上传。

这是协议约束说明，不是一条省略了账户、绑定和回执检查的可复制发布命令。仓库里没有通用生产一键发布器；维护者的本地发布回执和含凭据输入不会随 Git 分发。

### 4.5 回读再确认

上传返回成功后，仍需：

1. 读取 deployment，确认新版本的实际流量比例。
2. 下载线上脚本，与候选逐字节比对。
3. 对比所有绑定、namespace、运行设置、域名和 Cron。
4. 检查登录页、manifest、未认证 API。
5. 登录执行本次改动相关验收，记录具体完成范围。

“返回 200”“本地测试通过”“网页能打开”和“业务验收完成”必须分别记录。

## 5. 回滚与密钥管理

回滚前确认旧代码能读当前数据格式，包括加密版本、压缩帧、配置字段、索引/表和代际状态。代码回滚不会把数据库回到旧时间；不要通过删 DO、重建 KV 或替换密钥强行回滚。

- 保留需要读取旧对象的历史 key；key ring 中显式指定 `currentId`。
- 不把 `ACCESS_CODE`、RPC、凭据、快照和维护用途的密钥互相替换。
- 兼容模式中，先设置独立 `ENCRYPTION_SECRET` 再存账号；改登录密码和改数据密钥是两件事。
- 维护角色只分配所需权限。正常登录会话不具备维护权限。

## 6. 未知任务如何处理

`unknown` 表示“外部效果无法确认”。取消、唤醒、等待超时都不证明远端没有发生操作。

操作员按独立签名链路读取当前状态与原始证据，进行只读观察，再由有权限的角色作明确裁决。保留原 task ID、step、call 和证据摘要。不要删除数据库记录、释放许可或更换任务键绕开屏障。

具体角色和命令见[维护协议](RELIABILITY_MAINTENANCE.md)。

## 7. V12.2.1 发布记录

2026-11-05，维护者已将本版本上传到既有生产 `manager`：

| 项目 | 记录 |
| --- | --- |
| Worker version | `caed2271-b524-4799-9f7e-e0f5aa36239a` |
| Deployment | `2c2a1092-61fc-41eb-8620-023fa1370383`，回读时 100% |
| Build ID | `12.2.1.0f7555b2-dirty.b5f74ac7563d` |
| Worker SHA256 | `3c644845a6eb2030c350655d8fcd89a0522ca10b4377b1d470c76a8fee2ba33d` |
| 字节数 | 978930 |
| 本地门槛 | 129 文件 / 2811 项，9 次真实 DO 重启 |
| 上传 / 回读 | 一次 PUT；脚本逐字节相同；九项控制面保留检查通过 |
| 未执行 | 该次远端隔离、登录后业务和浏览器验收 |

本次索引由相应 DO 初始化创建；发布器没有直接迁移业务数据。生产实际 SQL 行数、CPU 余量及索引初始化耗时没有测量。

上述记录是一次具体发布的事实，不是未来版本的放行依据。Git 提交后构建的 Build ID 会因提交身份改变；不能把新的构建身份冒充该次已部署字节。

## 8. 哪些东西不能提交

`.wrangler/`、个人 `wrangler.*.local.*` 配置、`.env` / `.dev.vars`、账号导出、加密备份、会话 Cookie、Cloudflare Token、恢复库和原始运维材料都保留在本地受限位置。

公开仓库保留源码、无密钥示例、测试夹具和使用说明。测试夹具中的固定测试 key 不能用于生产。只推送 Git 不会更新线上实例。
