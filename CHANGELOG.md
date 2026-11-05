# 变更记录

## V12.2.1 (2026-11-05)

### CI 跨平台与浏览器测试修复

- 运维 curl 传输在发送请求前私有创建响应文件，避免 Linux 默认 umask 产生 0644；写入后继续核验权限、类型和大小。
- mock 浏览器服务器仅在内存中的测试副本适配 Cloudflare 模块，禁止实例化 DO，不改生产打包产物。
- 补齐兼容模式恢复协议 mock，增加 authority 模式不调用旧 KV 备份/恢复接口的浏览器回归，更新 1101 受保护子域名确认字段断言。
- CI 失败时为所有触发方式保留已有浏览器报告与 trace；不跳过原有测试。

### 文档与仓库同步

- 新增逐步新手部署教程和无密钥的 KV 兼容模式模板，每一步包含成功标志与排错方法。
- 重写架构、数据库、日常使用、开发、运维与维护协议，明确兼容模式与 SQLite DO 权威模式的差别。
- 明确当前没有通用的一键 DO 初始化器；禁止用新装兼容模板覆盖现有权威实例。
- 公开仓库同步当前源码与测试；个人配置、会话、发布回执和本地交接历史不提交。

### 后端修复与免费计划效率优化

- 修复任务回执为部分失败/部分取消、步骤投影缺失时的终态误判。
- 非法 Origin 返回 403；兼容入口校验完整 Origin（含协议）。
- authority API 在业务网关统一认证，同一请求的会话与 CSRF 检查共用一次 KV 读取；不同请求仍重新验证。
- 任务列表按页批量读取目标、步骤事实、自动化和部署结果，分页探测项不再展开详情；本地 4 账号 × 40 步骤场景由 672 条 SQL 降到 6 条。
- 拆分部署结果读取与建表初始化，查询不再加载私有执行计划；为配置投递、账号任务、执行步骤、自动化任务关联增加四个兼容索引。
- 保留配置 CAS、任务幂等、账号内串行、unknown 屏障和全部历史记录；本轮新增 13 项回归测试。
- **本版本验证**：build/typecheck/verify 通过，129 文件 / 2811 项、9 次真实本地 DO 重启通过。
- **发布**：2026-11-05 单次绑定继承式上传；Worker version `caed2271-b524-4799-9f7e-e0f5aa36239a` / deployment `2c2a1092-61fc-41eb-8620-023fa1370383`；Build `12.2.1.0f7555b2-dirty.b5f74ac7563d`；Worker SHA256 `3c644845a6eb2030c350655d8fcd89a0522ca10b4377b1d470c76a8fee2ba33d`。九项控制面检查和线上脚本逐字节比对通过，未认证登录页/manifest 200、API 401 JSON 正常。
- **范围**：未执行远端隔离、登录后业务或浏览器验收；部署器没有直接迁移业务数据，新增索引由 DO 初始化创建。回执 `.wrangler/release-v12.2.1-20261105/apply-20261105T124812Z`。

## V12.2.0 (2026-10-20)

### 2026-10-20：上游仓库兼容日期可在前端按模板分别修改（默认 Joey 2026-01-20）

- **功能**：CMliu / Joey / ECH 三个模板面板各增加一行“兼容日期”输入与保存按钮，不再把日期写死在代码里只能改源码重新发布。
- **默认值**：Joey 采用上游建议的 `2026-01-20`（原 `2024-02-20`）；CMliu / ECH 保持 `2024-04-05`。未保存过覆盖值时始终回退到模板默认值。
- **权威存储**：新增 authority 配置域 `template:<type>`，值为 `{ compatibilityDate }`；读取走 `GET /api/reliability/config?kind=template&template=<type>`，写入走 `POST /api/reliability/config` 的完整 ConfigEdit（selector 在 body 内，无 query），与其它配置一样有 generation/epoch/revision CAS、意图回执和 409/428 语义。
- **任务冻结**：任务规划时把生效日期写入 `repair_worker` / `upload` / `manual_upload` / `create_worker` / `replace_worker` 命令；执行器使用该冻结值。旧密封快照没有该字段时回退模板默认值，已接纳任务不受之后的面板修改影响。
- **校验**：必须是真实日历日期且在 `2021-11-01` 至当天之间；未知模板、未知字段、未来日期、非法日期均拒绝。
- **前端**：init_data 增加 `templateSettings`，加载即填三个输入；保存成功后更新模板提示。旧页面/legacy 模式仍显示服务端注入的模板默认值。
- **上线**：2026-10-20 单次绑定继承式代码上传；线上版本 `a23d0c65-5709-49b4-b2be-0a620cf955f6` / deployment `0d058b79-d33e-48ec-94d2-219c65e0f541`，Build `12.2.0.0f7555b2-dirty.8f25c64a98f7`，Worker 977868 bytes / SHA256 `89ed6dc0966d84543bd527e6609f54b583d1460370d797fa2173be8ad58cfce5`；上一版 `adbf6b2a-…`（V12.1.1 账号保存修复）保留可回滚。回执 `.wrangler/production-code-upgrade-2026-10-10/apply-20261020T131756Z`；控制面 8 项 checks 全 true、线上脚本逐字节一致、未认证 liveness 通过。未做登录后业务验收与浏览器。
- **验证**：129 文件 / 2798 项测试通过；build/type/verify 0 errors / 0 warnings。

## V12.1.1

应用版本相同的不同构建，以 `dist/build-manifest.json` 的 Build ID、源码和 Worker SHA256 区分。

### 2026-10-20（续）：真实本地 DO 门禁默认重启次数 35 → 9

- **原因**：`scripts/test-reliability-runtime.cjs` 原本每个恢复场景都起停一次真实 Wrangler/DO 进程，单次 runtime 门禁约 4 分钟、35 次重启（V12.2.0 起默认 9 次）；多数场景共用同一持久化 SQLite，不需要独立进程代。
- **实现**：新增重启预算。默认 light profile 在 9 个具名 checkpoint 前保留 **9 次真实重启**（另加大源码场景前的内存复位），其余 26 个场景重启点合并到同一进程代（逐条输出 `LOCAL_RESTART_COALESCED <序号>`）；`RELIABILITY_RUNTIME_FULL_RESTARTS=1` 恢复原 35 次完整覆盖。`LOCAL_RESTART_PROFILE` 输出本次 profile 与实际/合并次数，`ACTUAL_LOCAL_PROCESS_RESTARTS` 仍为门禁签名；`assertRuntimeOutput` 继续校验 checkpoint 单调性且末次等于总数。
- **判据调整**：`scripts/candidate-validation.cjs` 不再硬编码重启次数与场景文案，改为调用 `assertRuntimeOutput` 解析实际输出；`upgrade-chained-isolated.cjs` 的 modern 分支同样使用该解析（legacy 分支保留旧标记）。
- **验证**：`node scripts/check.cjs --runtime --evidence .wrangler/check-runtime-light-20261020` → 129 文件 / 2783 项、**9 次真实本地 DO 重启**（9 checkpoint 全部通过）；`RELIABILITY_RUNTIME_FULL_RESTARTS=1 node scripts/test-reliability-runtime.cjs` 为 35 次全量路径。
- **说明**：此前 2026-10-20 账号保存修复的上传回执记录的门槛仍是当时的 35 次；本改动只影响之后的新门禁运行。

### 2026-10-20：修复编辑账号后保存 400 INVALID（已上线）

- **现象**：面板中编辑账号（如修改 CMliu/Joey/ECH 的 Worker 项目名）后保存，弹窗显示“保存失败 INVALID”，请求被权威侧以 400 拒绝。
- **根因**：`/api/stats` 读模型返回的每条统计对象包含 `accountId`/`alias` 等展示字段；页面初始化会自动刷新用量，`state.accounts[].stats` 被替换成这些对象，保存整份账号配置时原样回传。权威侧 `credential-accounts.ts` 的 `stats` 白名单只允许 `total/max/error/alias`，未知字段直接 `INVALID`——这是前端读模型与权威写校验之间的契约缺口，不是 Worker 名称本身非法。
- **修复**：
  - 新增 `frontend/modules/account-payload.js::accountSavePayload`：保存/删除账号时只保留 `total/max/error/alias`，剥离 `accountId` 等运行期展示字段；统计对象缺数字 `total/max` 时不回写。
  - `frontend/js/accounts.js` 的保存与批量/单个删除统一走该载荷；`loadStats` 只把展示字段放进内存状态。
  - 权威侧 `stats` 白名单接受 `accountId` 展示字段（仅描述性元数据，不作身份依据），兼容仍开着旧页面的浏览器。
- **验证**：`node scripts/check.cjs --runtime --evidence .wrangler/check-account-save-fix-20261020` → build/type/verify 通过、129 文件 / 2783 项、35 次真实本地 DO 重启；新增回归覆盖前端载荷、后端兼容与真实 authority HTTP 账号保存。
- **上线**：2026-10-20 单次绑定继承式代码上传，线上版本 `adbf6b2a-3815-43cf-b8b7-6b89e408df31` / deployment `286699dd-1947-4c47-8a97-70eba9a8daac`，Build `12.1.1.0f7555b2-dirty.5effeed461dd`，Worker 968111 bytes / SHA256 `68375f10…be96`；上一版 `19f4bce3-…` 可回滚。上传后控制面回读 8 项全 true、线上脚本逐字节一致；未做登录后业务验收与浏览器。

### 2026-10-10（续）：旧工作区 / 备份 / 日志清理完成（用户授权后）

- 背景：早先 3 次清理请求被当时的环境策略以 `blocked by policy` 拒绝（未绕过），待清理量 895,685,034 逻辑字节一直挂着。用户授权“可以继续清理”后，按同一份冻结清单执行（`cleanup-plan.json`，未改判）。
- **删除前审计**：`cleanup-verify.cjs` 把每个待删文件与私有恢复库清单逐字节比对——旧 C 盘工作树 13,979 个文件全部命中归档且 sha256/字节一致（0 缺失、0 不一致），另 581 项属已声明的可再生成/共享项；D 盘目标 0 缺失、0 不一致。只有通过这一步才执行删除。
- **执行**（单一 shell、逐条解析+守卫：禁止逃逸工作区、禁止 reparse point、禁止受保护根）：
 - 旧 C 盘工作树 `C:\Users\fenglingjian\.codex\worktrees\c776\worker-refactor`：14,560 文件 / 825,428,343 字节。先**只删** `node_modules` junction 链接（删前删后实测活动依赖树 `D:\下载\worker-refactor\node_modules` 均为 4,778 文件 / 276,219,956 字节，未被连带删除），再删整树；`git worktree prune` 注销陈旧登记，`git worktree list` 现只剩活动工作区。
 - D 盘 45 个目标（35 个旧文档 + `OPTIMIZATION_PLAN.md` + `deploy.local.bat` + `dist/e2e-tailwind.css` + `.wrangler/readonly-auth-20261001.toml` + `.wrangler/remote-backups` + 5 个 `.wrangler/validation-20261001-*`）：210 文件 / 7,820,850 字节。
 - 6 个白名单可再生成缓存与旧浏览器报告（`.wrangler/tmp`、`test/fixtures/reliability/.wrangler/tmp`、`playwright-report`、`test-results`、`test-results-c7-prior`、`%SystemDrive%`）：484 文件 / 62,372,961 字节，使用仓库自带白名单清理器 `scripts/clean-local.ps1 -Apply`。
 - **合计 15,254 文件 / 895,622,154 字节（约 854.1 MiB）**，全部来自“已归档原件”或“明确可再生成”两类。
- **有意保留 3 个计划内目标**（均已在恢复库，可随时再删）：`wrangler.local.toml`（README 称其为真实本地生产配置，`wrangler.toml` 与 `setup-secrets.bat` 也引用它；删除还需改动冻结的门槛输入 `wrangler.toml`，收益仅 970 字节）、`.learnings/`（活的项目知识文件，本次又新增一条子域名轮换教训）、`docs/RELIABILITY_MAINTENANCE.md`（**已上线**前端文案直接引用该路径，删除会留下用户可见死链，而改源码会改变已部署产物）。
- **未部署、未改代码、未动远端数据**：清理后重跑完整门槛（`.wrangler/workspace-migration-2026-10-10/post-cleanup-validation`）→ build/type/verify 通过、129 文件 / 2778 项、35 次真实本地 DO 重启全部通过，输入 SHA256 仍为 `c6fb8558261b400859241246e9da523456ccda35306b522f62d5bf7d0642449e`（与 `fix-validation-5` 一致，线上仍是 `19f4bce3-df94-4f18-9e7f-60c5b0e797ec`）；未执行 A5/浏览器。
- 证据：`.wrangler/workspace-migration-2026-10-10/`（`cleanup-result.json`、`cleanup-verify.json`、`gate-identity.json`、`d-targets-applied.json`、`cache-cleanup-applied.json`、`source-worktree-applied.json`、`cleanup-apply.ps1`、`cleanup-source-worktree.ps1`、`retired-worktree-admin/`）；历史受阻记录 `cleanup-status.json` 保留不改。旧 C 盘容器目录 `c776\` 因仍含 Codex 的 `.codex-worktree-name` 元数据而保留（工作树本体与 git 登记已退役）。

### 2026-10-10（续）：1101 修复的子域名步骤改为非破坏性（C，已上线）

- 现象（第二轮 1101 修复的第三根因）：`rotate_subdomain` 的 DELETE→PUT 会先删掉账号现有 workers.dev 子域名；一旦随后的 PUT/回读不通过，账号就被**清空子域名**（任务 `aae2a21d-…` 的 6 个账号即例证，其中 5 个后来靠 A 步骤恢复）。
- 修复（用户授权后执行）：1101 修复的账号级步骤由 `rotate_subdomain` 改为 `change_subdomain`，并把该命令实现为“**先做无破坏 PUT，只有供应商明确拒绝替换时才 DELETE→重建，且新名字无法确认时把旧名字放回**”：
  - `src/reliability/business-planner.ts`：修复轮换改发 `change_subdomain`（名字仍是 `repair-<24hex>`，受保护账号仍不生成）。
  - `src/reliability/business-executor.ts`：`change_subdomain` 先 `PUT` + 回读（成功即 `verified`，**全程不 DELETE**）；仅当供应商**明确拒绝**（`Rejected`，例如“账号已有子域名”）才进入删除/重建；删除后必须读到“确实已无子域名”才建新名，且**不重复删除**；新名无法确认、且账号已被验证为空时，用旧名字 `PUT` 回去并回读确认，步骤记 `failed`/`ROTATION_NOT_APPLIED`（绝不让账号停在“没有子域名”）；任何传输/响应丢失仍记 `unknown`（不覆盖未知状态）。
  - `business-effects`/`task-catalog` 接受并展示 `ROTATION_NOT_APPLIED`；`deployment-plan` 把 `change_subdomain` 计入部署计划必须验证的步骤；`rename_subdomain`（旧 `/api/change_subdomain` 适配器）语义与“不自动回滚”不变。
  - 新增单测：拒绝→删除重建→验证，以及“新名不生效→恢复旧名→`ROTATION_NOT_APPLIED`”。运行时检查点的 1101 场景改判为“一次非破坏 PUT”。
- 本地门槛：`node scripts/check.cjs --runtime --evidence .wrangler/production-code-upgrade-2026-10-10/fix-validation-5` → build/type/verify 通过、**129 文件 / 2778 项**、**35 次真实本地 DO 重启**（`inputsSha256 c6fb8558261b400859241246e9da523456ccda35306b522f62d5bf7d0642449e`；上一次失败的 `fix-validation-4` 仅记录运行时断言未随本次代码更新，未用于放行）。
- 上线：新版 `19f4bce3-df94-4f18-9e7f-60c5b0e797ec` / deployment `16118240-1fea-4efe-8f6e-1563a7dae485`，Build `12.1.1.0f7555b2-dirty.440ebad94535`，966180 bytes / SHA256 `b0744c729650b4567492496cd3b712408783dfeb67af29fe6e904864d923ecfa`；**单次**绑定继承式 PUT（无自动重试），16 个绑定（含 7 个 secret）、DO namespace、CONFIG_KV、compatibility、Cron `*/5 * * * *`、自定义域名全部未变；回执 `.wrangler/production-code-upgrade-2026-10-10/apply-20261010T141632Z`。未创建资源、未改数据/密钥/路由/Cron，未做隔离验收、未执行 A5/浏览器。
- 上线后核验：从 Cloudflare API 回读线上脚本与 `dist/worker.js` **逐字节一致**（966180 bytes / SHA256 `b0744c72…ecfa`；`verify-1101-followup/live-script-readback.json`）。
- 线上验收（按值无操作的 `change_subdomain`）：对每个账号发一条 `change_subdomain`，其值**等于该账号当前已有的子域名**，因此只能 `verified`、不可能轮换/删除/清空账号；8 个非受管账号 `POST /api/reliability/tasks` 202 → 任务全部 `succeeded`、步骤 `change_subdomain:verified{"confirmed":true}`；受保护的 manager 账号（`RELIABILITY_PROTECTED_RESOURCES`）在接纳处按设计返回 400 `INVALID`；验收前后 9 个账号的子域名**逐一比对完全未变**（`amsss`/`wjqddln69`/`wwtwzp463`/`w19vavx79`/`wcd2qr444`/`woknpdn0`/`wvqr4ut4`/`wlunulv52`/`wwoqprr6`）。证据：`.wrangler/production-code-upgrade-2026-10-10/verify-1101-followup/c-change-subdomain-acceptance.json`。
- 仍未闭环（需要运营者决策）：本次**没有**做一次真实（换名）轮换，因此 Cloudflare 是否允许用 PUT 直接替换已有子域名仍未被实测；若不允许，修复会走“明确拒绝 → DELETE→重建 → 失败即恢复旧名”的分支，账号最坏情况下保留原子域名并记 `ROTATION_NOT_APPLIED`。下一次真实 1101 修复会给出答案。

### 2026-10-10：1101 `NOT_READY` 修复（已上线）

- 现象：面板的 1101 修复返回 `修复请求失败: NOT_READY`（如 `req_21eb136843e247ab991b24eb`、诊断复现 `req_a7d4e88a5802472da9a61ebb`）。
- 原因：`sendCoordinatorRpc` 对**所有**方法使用固定 15 s 客户端期限，而业务接纳要在 DO 内同步解析并密封 5,142,235 字节上游源码（9 个目标），实测 15,324 ms；网关先超时返回 503，DO 随后仍然建单（任务 `2c21c19d-…` 即由此产生）。
- 修复：`src/reliability/production-rpc.ts` 增加按方法的限期表 `RPC_DEADLINE_MS = {submit_task:90000, cron_cycle:90000, read_external:60000}`，其余方法仍为 15 s；仍是有界期限，卡住的绑定不会无限挂起。新增 `test/reliability/production-rpc.test.ts` 用例。
- 本地门槛：`node scripts/check.cjs --runtime --evidence .wrangler/production-code-upgrade-2026-10-10/fix-validation` → build/type/verify 通过、129 文件 2772 项、35 次真实本地 DO 重启。
- 上线：新版 `b6aae343-f39e-4de4-bae4-5c356d19fe6a` / deployment `a7b723bb-72e4-45b0-93b2-6fdac03bb442`，Build `12.1.1.0f7555b2-dirty.54c642113be3`，Worker 962760 bytes / SHA256 `1e0eef7d0483cb4b2e017d427949da82d04920478fd487cc02171bdf89e1eafa`；沿用单次绑定继承式上传，绑定/Cron/域名/兼容性未变。回执 `.wrangler/production-code-upgrade-2026-10-10/apply-20261010T113512Z`。
- 上线后核验：从 Cloudflare API 回读线上脚本，与 `dist/worker.js` **逐字节一致**（含 `submit_task` 90000 期限）；同一 Idempotency-Key 重放返回 `202 {"duplicate":true}`。按用户要求未做隔离/应用验收与线上验收，未执行 A5/浏览器。
- **仍未解决**：3 个 `rotate_subdomain` 未知步骤（任务 `596d3680-…` 的 `1731a0b6…`/`25cd0ce7…`/`393e714a…`）使这 3 条投递永久占满 3 个并发额度，业务派发全局停摆；新任务只能停在 `queued`。解锁必须走人工裁决。详见 `docs/OPERATIONS.md` 第 6 节。

### 2026-10-10：维护 key 扩展（用户授权后执行）

- 原 5 个 operator（`activation`/`archive`/`inspect`/`maintenance`/`migration`）的 secret 与权限逐字节保留，新增 `attestor`（`review`+`attest`）与 `adjudicator`（`adjudicate`）。
- 单次 PUT 更新 `RELIABILITY_MAINTENANCE_KEYS`；该更新自动产生新版本：先 `7519d497-…`/`946c67aa-…`，最终 `f30cf1b0-eb07-43af-bfd6-ff23d035fb78` / `245d4498-a220-4141-bc48-3204b53a1a9a`（100% 流量）。回读证明脚本 962760 bytes / SHA256 `1e0eef7d…`、16 个绑定（8 个 secret_text）、DO/KV、compatibility、Cron 全部未变。
- 校验：`status`（原 `inspect`）200；`review_observe`（`attestor`）对不存在的任务返回 409 CONFLICT（=已认证且具权限，而非 403）。`adjudicator` 只能在维护窗口内实测。
- 私密材料只落在受限 ACL 目录 `D:\下载\worker-refactor-recovery\private-ops-2026-10-10\maint-operators-mv2cjg7y\`（值 SHA256 `693d8ae5…`）。
- 只更新了这一个 Secret：未改脚本、未改 KV/DO 数据、未改路由/Cron、未做隔离或线上验收、未执行 A5/浏览器。

### 2026-10-10：1101 未知裁决执行 + 端到端复验（发现第二根因）

- 经运营者明示授权（由自动化代拟并经其确认声明文本），在一个维护窗口内完成 3 组 `review_observe` → `review_attest`（`attestor`）→ `review_close_failed`（`adjudicator`）；窗口 epoch `2→3→4`，结束后 `maintenance=0`。
- 任务 `596d3680-…` 终态 `partial_failed`、`humanSettlements: 3`，3 条 `unknown` 转为 `OPERATOR_CLOSED_UNCONFIRMED`；被取消的 `2c21c19d-…`/`25ded9c0-…` 随即变为 `cancelled`，派发额度释放。
- 端到端复验：新 Idempotency-Key 的 `POST /api/fix_1101` 返回 **202**（24.6 s，新 90 s 期限内），任务 `aae2a21d-…`——`NOT_READY` 缺陷确认修复。
- **第二根因**：`1731a0b6…`/`25cd0ce7…`/`393e714a…` 的账户级 workers.dev 子域名不存在（读回 404/面板 503），`rotate_subdomain` 前置读取不满足即判 `unknown` 且**未产生任何 mutation**（`review_candidates` 返回 `missingEvidence: true`），导致每次 1101 修复都会立刻重新占满并发额度并停摆派发。处置建议见 `docs/OPERATIONS.md` 第 6 节（先设新子域名 / 代码加固把“供应商明确无子域名”记为 failed）。

### 2026-10-10（续）：加固上线 + 子域名恢复（A+B 完成）

- **B（代码加固，已上线）**：新版 `583fb75f-48d1-4db4-8f7b-4f22ed6bd078` / deployment `7219790c-d366-4479-833e-b6cb63b2a8da`（Build `12.1.1.0f7555b2-dirty.9d6ccd04c77d`，964987 bytes / SHA256 `c9c4f4b1…e5d1`），单次绑定继承式 PUT，回读校验脚本逐字节一致、16 绑定/DO/KV/Cron/域名未变。本地门槛 129 文件 / 2776 项 + 35 次真实 DO 重启通过（`.wrangler/production-code-upgrade-2026-10-10/fix-validation-3`）。
  - `repair-executor`：`rotate_subdomain` 前置读取若得到供应商 404（明确“本账号无子域名”）→ 记 `failed`/`PROVIDER_STATE_ABSENT`（无任何写入），不再记 `unknown`。
  - `AccountRunner`：对**日志证明从未记录过 mutation 调用**的 `unknown` 步骤，自动按 `failed`/`NO_MUTATION_RECORDED` 结算（有 mutation 的未知仍必须人工裁决）；新增 `no_mutation_settlements` 审计表并纳入权威归档清单。
  - 线上实测：任务 `aae2a21d-…` 的 3 个前置型未知被自动结算为 `NO_MUTATION_RECORDED`（terminal），派发额度随即释放，其余账号继续执行。
- **A（子域名恢复，已完成）**：`change_subdomain`（纯 PUT、readback 验证）为 9 个账号全部恢复 workers.dev 子域名——`19394616-…`（`wcd2qr444`/`wwtwzp463`/`wwoqprr6`）与 5 账号任务（`w19vavx79`/`wjqddln69`/`wvqr4ut4`/`woknpdn0`/`wlunulv52`）均 `succeeded`。
- **仍待修的第三步**：`rotate_subdomain` 的 DELETE→PUT 在“本来有子域名”的账号上会在 DELETE 后失败（任务 `aae2a21d-…` 的 6 个账号即为此例，已按设计人工/机器结算并恢复子域名）。下一轮应把 1101 修复的子域名字段改用 `change_subdomain`（纯 PUT），或查清 DELETE 后 PUT/readback 不通过的原因。

### 2026-10-10：生产代码升级（已上传）

- 以单次绑定继承式上传把 Build `12.1.1.0f7555b2-dirty.85eeaad4a95b`（Worker 962676 bytes / SHA256 `733f55884fa1779b75e66a8ed502735235875daf9667ed550b39c0759be98344`）发布到 `manager`。
- 新版本 `fedb3ae8-d857-4f8b-9d64-13c7151cbdfd`，deployment `8e6866bc-570e-40e4-a556-b5ba9c783d90`；上一个已验收版本为 `6b2a7df6-a848-4f1e-a09c-d1c14865feed`。
- 回读确认：16 个绑定（含 7 个 secret）、DO namespace、CONFIG_KV、compatibility、Cron `*/5 * * * *`、自定义域名与兼容标志全部未变；未改动数据、密钥、路由或资源。
- 按用户明确要求，本次**未**执行隔离/应用验收与线上验收；只做了控制面回读和一次未认证 GET `/`。回执：`.wrangler/production-code-upgrade-2026-10-10`。

### 2026-10-10：工作区与验证整理（已随同日生产升级上传；工作区清理仍未完成）

- 从 c776 当前候选迁入 `D:\下载\worker-refactor`，保留 Git、依赖与两边独有修改。
- 重写架构/用户/开发/运维文档，归档重复长交接与旧方案原字节；实际批量清理被执行策略阻止，旧文件仍在原目录。
- 16 个前端测试文件合为 4 条流程；合并重复静态/运维夹具，保留关键安全/恢复用例。
- 用完整测试清单和具名真实 DO 恢复检查点取代新候选的旧数量门槛；统一 check.bat、package 与 CI 的检查入口。
- 修复 Windows PowerShell ACL 助手的 UTF-8 管道，支持 D 盘中文路径，未放宽 ACL；恢复提取使用规范化实际路径。
- 真 DO 临时构建移出源树，新增白名单缓存清理工具。浏览器改为显式可选流程，本次未执行。

### 2026-10-10：后续 UI / 大源码 / 1101 修复（已随上述升级上线）

- 任务列表改为图标按钮展开/收起，默认收起，并保留后台任务和原意图。
- 固定上游源码预算 8 MiB；大快照采用认证压缩帧，密文上限仍为 5 MiB，公开请求预算不扩大。
- 显式保留受保护账号子域名，继续处理确认的业务 Worker；中控 Worker/KV 保护不变。

### 2026-10-09：已完成的生产首次切换

- B1/B2/B4 的生产部署、DO 权威数据切换、凭据认证解密、服务/Cron 恢复与非浏览器验收完成。
- 该次生产为 Build `12.1.1.0f7555b2-dirty.e900a6c0ef42`；不能将其验收结果用于上述后续候选。
- 原 KV、旧/新 key 和恢复链保留。观察期与原会话身份见 `docs/OPERATIONS.md`。

完整旧 CHANGELOG、OPTIMIZATION_PLAN、设计契约与历次交接原文均在恢复库的 `source` 树中，未把历史状态改写为当前结论。
