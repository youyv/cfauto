# 版本更新日志

## 未发布

> KV 自动回收 · 死代码清理 · verify 防回归检查

### 🧹 KV 空间治理（本次核心）

此前写入 KV 的键分三类，只有第一类有回收机制：带 TTL 的 `SESSION_*` / `RATE_LIMIT_*` 由 Cloudflare 自动过期；数量固定的配置键不会增长；而**第三类会无界增长或变成永久孤儿，没有任何代码路径会清理它**。

- **孤儿 `VARS_<type>_ACC_<accountId>` 永久残留（新增回收）**: 该键由熔断轮换写入。账号删除后 `writeAccounts` 只覆盖账号表，遗留的覆盖键无人删除；模板下线、从别的实例恢复备份同样会留下脏键。只能人工到 Dashboard 清理。现在两条路径兜住：
  - **即时**：`writeAccounts` 比对新旧账号表，被移除账号的所有模板覆盖键立即删除（`deleteAccountVarsFor`）
  - **兜底**：新增 `lib/kv-gc.ts`，cron 每 24 小时（独立的 `lastGc` 节流，不占用 `lastCheck`）用 list 翻页枚举 `VARS_` 前缀，删除「模板类型未知」或「accountId 已不在账号表」的键
- **部署日志只截条数、不限体积**: `DEPLOY_JOURNAL` 此前 `slice(0, 100)` 只管条数，但单条 `summary` 可达 500 字符、`failed` 数组**完全无上限** —— 一次 200 目标全失败就写进一个巨大数组，100 条这种记录足以把单个 KV 值推到数百 KB，且没有任何按时间过期。现在 `pruneJournal` 三重裁剪（100 条 / 30 天 / 单条 summary 500 字符 + failed 20 项后记 `+N more`），写入侧（`finalizeDeploy`）与 GC 侧都走它
- **回收的安全闸门**: 账号表读取失败或 JSON 损坏时**放弃本轮回收**而不是拿到空集合 —— 空集合会让所有账号级覆盖被判为孤儿，一次 KV 值损坏就会删光全部熔断状态。为此新增 `readLiveAccountIds`：键不存在 = 可信的空集合，键存在但不可解析 = 返回 null 让调用方退出。回收只删可推导为孤儿的具体键，从不按前缀批量删
- **cron 拆成两段独立执行**: `handleCronJob` = `runAutoUpdate` + `maybeRunKvGc`。此前把回收写在同一函数尾部时，`if (!config.enabled) return` 之类的提前退出会连带跳过回收 —— 而「关掉了自动更新，仍在手动部署与增删账号」恰恰是最需要回收的场景。现在自动更新关闭、间隔未到、账号为空、流程抛异常，回收都照常执行
- **`kv.list` 只读第一页的隐藏缺陷**: 真实 KV 单次最多返回 1000 个键，`list_complete: false` 时必须带 cursor 续拉。`GET /api/backup` 枚举账号级变量时只读了第一页，第 1001 个键之后会**静默漏出备份**，恢复时用户得不到任何提示。新增 `listAllKeys` 自动翻页（20 页失控保护），backup 与 GC 都改用它；未列完时备份文件带 `_warning`
- **KV 用量可见**: `GET /api/diag` 增加 `__kv_usage`（总键数、会话/限流数、账号级覆盖数与其中孤儿数、日志条数与字节数、上次回收时间），工作台「🩺 诊断」渲染成一段可读报告。孤儿数 > 0 只表示还没到回收窗口，不是错误

### 🗑️ 死代码清理

- **后端未使用的 import 与参数**: `crud.ts` 的 `readAccounts` / `AppEnv`、`crud-backup.ts` 的 `getJSON`+`putJSON` 整条声明与 `AppEnv`、`crud-diag.ts` 的 `AppEnv`；`handleGetCode(env, type)` 与 `sendFuseAlert(env, ...)` 的 `env` 参数从未被读（前者拉的是匿名可读的 raw.githubusercontent.com，后者的 webhook URL 来自 config 而非环境变量）
- **`ACCOUNT_VARS_KEY_RE` 无外部消费者**: 改为模块私有，并提取出真正有用的 `parseAccountVarsKey`（回收逻辑需要拿到 type 与 accountId，而不只是布尔判定）
- **前端 26 个 `window.xxx = xxx` 导出全部删除**: 所有模块被 `build.js` 拼接进同一个脚本作用域，跨文件直接同名调用即可。全项目没有任何一处读 `window.xxx`（只有 `window.fetch` / `innerWidth` / `matchMedia` 这些平台属性被读），这些「导出」是纯噪声
- **`state.js` 的 `Object.defineProperties(window, ...)` 兼容别名删除**: 5 个别名（accounts / editingIndex / deletedVars / deployConfigs / currentHistoryType）无任何读取方；其中 `deletedVars` 与 `deployConfigs` 只有 getter，`window.deletedVars = x` 在非严格模式下会**静默失败**，留着只是埋坑
- **6 个注册了但永远不会被派发的 action**: `openModal` / `previewDiff` / `retryFailedBatch` / `showYxipModal` / `doYxipSearch` / `clearYxipSearch` —— 事件委托只按 `data-act` 属性查表，这些函数实际都是被直接调用或用 `addEventListener` 绑定的，注册它们让「action ↔ data-act」双向检查失去意义
- **5 个死 HTML 元素/id**: `#logs`（上一版日志区，功能已全部迁到 `#workbench_log`，元素本身还挂在 header 里且永久 hidden）、`#wb_status`（空 span，从未被写入）、`#btn_workbench` / `#layout_container` / `#section_accounts` / `#section_projects` / `#account_list_container`（纯布局 id，JS 与 CSS 都不引用）
- **失效的 CSS 规则**: `[data-theme="dark"] .border-gray-200` 的目标类名在 HTML/JS 里根本不存在

### 🐛 顺带修复

- **暗色规则污染亮色模式**: `[data-theme="dark"] .border-orange-100,.border-orange-200` —— 逗号后的第二段**没有主题限定**，导致亮色模式下 5 处 `border-orange-200` 元素（三个模板的「🔄 同步」按钮、收藏面板边框）被强制成暗色边框。`.border-orange-100` 同时也是个不存在的类名

### 🧪 测试与校验

- **`test/helpers.ts` 的 mock KV 补齐 list 分页语义**: 此前 `list` 一次性返回全部键且不返回 `list_complete`，任何「只读第一页」的 bug 在测试里都是绿的 —— 而 backup 正是这样漏了键。现在支持 `_listPageSize` + cursor，并记录 `_deletes`
- **新增 `test/kv-gc.test.ts`（42 个）**: 日志裁剪的四类边界（条数 / 天数 / 时间不可解析 / 体积）、孤儿判定的五种情形、`readLiveAccountIds` 的「不可信必须返回 null」、`listAllKeys` 翻页、账号删除的即时清理与「账号仍在则绝不动」、cron 的 24h 节流与「关闭自动更新仍回收」「账号表损坏则跳过」、`/api/diag` 用量报告、backup 跨页枚举。**测试总数 322 → 364**
- **`verify.js` 增加 4 项防回归检查**: ① 注册了却无 `data-act` 引用的死 action；② 无消费者的 `window.xxx =` 导出；③ 既未被 JS 引用也未被 CSS 选中的 HTML id；④ 暗色规则中无主题限定的选择器段。另外内嵌调用 `tsc --noUnusedLocals --noUnusedParameters` 拦住未使用的 import / 局部变量 / 参数（这两个开关不在默认 `strict` 里）

## V12.0.0 (2026-08-26)

> 全量优化：确定性 bug 修复 · 测试改为真实模块 · 并发策略统一 · 前端资源拆分 + CSP 收紧

### 🐛 确定性故障修复

- **ECH 自动更新彻底失效（功能性 bug）**: `cron.ts` 用 `filter(t => t.uuidField)` 筛选参与版本检查的模板，ech 的 `uuidField` 为空字符串被静默排除。UI 有 `auto_ech_toggle`、配置有 `autoEch`、`AUTO_FLAG` 也映射了 ech —— 用户打开开关后什么都不会发生。现在模板显式声明 `autoUpdate` 字段，与「能否轮换 UUID」（`fuseRotatableTypes`）彻底解耦
- **熔断波及全部账号（高危）**: `rotateUUIDAndDeploy` 不接收 accountIds，一个账号用量超阈值会把**所有**账号的 UUID 一起换掉，全部订阅链接同时失效。根因是 `VARS_<type>` 全局单份。现在新增账号级覆盖键 `VARS_<type>_ACC_<accountId>`：熔断只写超限账号的键并只对该账号重新部署，未超限账号继续用全局变量。函数强制要求非空 accountIds，空数组直接拒绝执行
- **熔断与版本更新不再互斥**: 此前 `if (!actionTaken)` 让熔断触发的那一轮完全跳过版本检查。熔断只影响超限账号的 UUID，其余账号仍应跟随上游，两者现在并行
- **部分失败的部署永不重试（高危）**: `finalizeDeploy` 只要有一个目标成功就把 `currentSha` 推进到新 SHA，于是 `localSha === remoteSha`，cron 判定「已是最新」，失败的 Worker 永远停在旧版本且无任何告警。现在**全部成功才推进 SHA**；失败目标记入 `DeployConfig.pendingTargets`（`<accountId>::<workerName>` 形式）+ `pendingSha`，cron 下一轮通过 `resolveUpdatePlan` 识别并**只重试这些目标**。`/api/check_update` 与 `/api/diff` 返回 `pending`，前端在版本区显示「N 个 Worker 部署失败，待重试」
- **fix1101 先睡后试**: 退避 `sleep` 写在上传**之前**，首次即可成功也要白等 2s，三次全失败等 14s，且对每个 Worker 都如此。改为先试一次、失败才退避（删除后仅保留 1.5s 的 CF 异步删除等待）
- **fix1101 绑定读不到仍删 Worker（高危）**: 读 bindings 失败只记一条 warning 就继续删除+重建，导致该 Worker 的 KV / secret 绑定永久丢失。现在读取失败直接中止该 Worker 的修复
- **大量缺失的 `res.ok` 检查**: `handleGetZones` / `handleGetAllWorkers` / `handleFetchBindings` / `handleGetRegionsData` / `ensureKVNamespace` 等处直接 `await res.json()`，上游返回 HTML 错误页时抛 TypeError 被 catch 吞掉，前端只看到「handleGetAllWorkers failed」这种零信息提示。新增 `readApiJson` / `readApiResult` 统一解析：非 2xx 抛出带 CF `errors[0].message` 的 Error，2xx 非 JSON 明确报错
- **优选节点源失败被当成成功**: `handleGetRegionsData` 不判 `res.ok`，`zip.cm.edu.kg` 返回 503 HTML 时把错误页当节点列表解析，然后返回 `success: true` + 空数据。现在补 `res.ok`、体积上限、以及「解析出 0 个区域」的兜底判定，全部返回 502 + 明确原因
- **alias 重复导致操作错行**: alias 是前端反查下标、部署日志标识、yxip 选账号的事实主键，但只校验非空。新增 `validateAccountsPayload` 强制 alias / accountId 唯一 + accountId 必须是 32 位十六进制；前端 `renderTable` 改用 accountId 反查下标，`saveAccount` 增加本地唯一性预检
- **`POST /api/settings` / `/api/auto_config` 零校验**: 任意 JSON 直接落 KV，写入对象而非数组后读取侧 `.map()` 会在部署时崩掉。新增 `normalizeVariables`（数组结构、变量名规则、重复检查、数量与长度上限、剥离未知字段）与 `normalizeAutoConfig`（interval 1-1440、fuseThreshold 0-100、webhook 必须 https、只保留已知模板开关键、保留 cron 的 lastCheck 不被清零）
- **`compatibility_date` 用当天日期**: 上传被管理 Worker 时用 `new Date()`，把未经验证的运行时行为变更引入用户的代理 Worker，且日期超出目标账号 workerd 支持范围时上传会被拒。改为固定常量 `MANAGED_WORKER_COMPATIBILITY_DATE`
- **`handleChangeSubdomain` 缺格式校验**: 非法子域名（大写、空格、超长、首尾连字符）会走到「删除旧子域名 → 设置新值失败」的不可恢复路径。现在前置正则校验 + 归一化小写，且恢复旧子域名失败时明确告知需手动处理
- **cron lastCheck 覆盖其他字段**: 用内存里的旧快照写回，会把本轮部署期间写入的其他配置字段覆盖掉。改为重读 KV 后只合并 lastCheck
- **账号级覆盖的生效语义**: cron 自动更新走 `accountOverrides: 'apply'`（账号级 UUID 叠加在全局变量之上，熔断刚轮换的值不会被冲掉）；用户在面板点部署走 `'clear'`（面板显示的就是全局变量，其意图是所有账号统一，因此清除覆盖）。若用量仍超限，下轮 cron 会重新熔断

### 🏗️ 并发策略统一

- **新增 `lib/concurrency.ts`**: `pooledMap` / `pooledMapSettled` 提供有界并发（默认 5）。此前项目里是两个极端：`coreDeployLogic` 全串行遍历账号（账号多必然超时），`handleBatchDeploy` 用 `Promise.allSettled` 全并发（容易撞 CF 的 1200 次/5 分钟限流与 1000 subrequest 上限），`verify_credentials` 手写了一份分批逻辑。三处 + `fetchInternalStats` 现在统一走 `pooledMap`
- **`coreDeployLogic` 展平为目标列表**: 双层循环改为 `(账号, worker)` 展平后有界并发，同时支持 `targetKeys` 过滤（pending 重试路径）

### 🔐 安全加固

- **面板 CSP 去掉 `script-src 'unsafe-inline'`**: 前端 JS/CSS 拆成外部资源 `/app.js`、`/app.css`（带 `?v=<version>` + `immutable` 长缓存），`index.html` 的 47 个 `onclick` 与 6 个 `onchange` 全部改为 `data-act` / `data-act-change` + 事件委托（`registerActions` 注册表，参数走 `data-args` JSON）。主 HTML 从约 290KB 全内联降到几 KB
- **登录页改用 CSP nonce**: 每个响应生成一次性 nonce，`script-src`/`style-src` 从 `'unsafe-inline'` 改为 `'nonce-...'`；同时补齐 `object-src 'none'`、`form-action`、`Permissions-Policy`
- **API 未认证返回 401 JSON 而非登录页 HTML**: 前端 `apiFetch` 会 `r.json()`，收到 HTML 会报「不是合法 JSON」这种误导性错误，而不是「请重新登录」
- **导出/备份带加密密钥指纹**: `secretFingerprint`（SHA-256 前 8 位 hex）写入导出文件，导入时先比对即可判断「注定解密失败」，而不是等所有 globalKey 被清空后才提示。`/api/diag` 也报告 `ENCRYPTION_SECRET` 是否启用及其指纹
- **`/api/favorites` 只保留已知字段**: 此前把前端传来的整个 item 存进 KV
- **`resolveCredentials` 增加密钥缺失检查**: 解密失败的账号不再带着空 key 去调 CF API
- **`buildYxipList` 用 `crypto.getRandomValues` 洗牌**: 替换可预测的 `Math.random()`

### 🧹 死代码与结构清理

- **`withErrorBoundary` 复活**: 该函数已导出但从未被使用，异常靠 `index.ts` 顶层 catch 兜底，代价是丢失出错路由名。现在 `route()` 注册时统一包装，并对重复注册直接抛错
- **`routes/loader.ts` 删除**: 文件名为「懒加载」实为静态导入（自己的注释也承认），合并进 `register.ts` 的 `registerBusinessRoutes`
- **前端僵尸 `window` 导出清除**: `window.accounts = accounts` 之类是**初始化时的值快照**，后续 `accounts = d.accounts` 重新绑定局部变量不会更新 `window.accounts`——它永远是那个空数组。改为单一 `state` 对象 + `Object.defineProperties` 访问器，读写都落到同一份引用
- **`dom.js` 的 `$cache` 删除**: 缓存 `getElementById` 收益可忽略，却要求每次 DOM 重建后手动 `$clear`，漏调就拿到脱离文档的僵尸节点（`renderTable` / `loadVars` 都会重建子树）
- **`workers_<type>` 字符串拼接收口**: 6 个文件里散落的 `'workers_' + type` + `as unknown as Record<...>` 断言，改为 `AccountEntry` 的模板字面量索引签名 + `getWorkerNames` / `setWorkerNames` / `addWorkerName` / `removeWorkerName` / `hasAnyWorker` 访问器
- **`stats.ts` 重复的 `Account` 接口删除**，统一用 `types.ts` 的 `AccountEntry`；`VariableBinding` 与 `VariableEntry` 合并
- **`joey_var` magic string 提为 `YXIP_TARGET_JOEY_VAR` 常量**，yxip 的 KV 模式改为按模板的 `kvBindingName` / `yxipKey` 判定（不再硬编码 cmliu/joey）
- **`mainHtml` 的恒真缓存判定简化**（`FRONTEND_VERSION` 是编译时常量）
- **starfield 重复初始化修复**: `initStarfield` 被主题切换 / visibilitychange / 系统主题变化多次调用，每次都新增 resize 监听并额外启动一个 rAF 循环（越切越卡）。改为场景只建一次 + 运行中直接返回
- **CSS 选择器转义修复**: `.hover\\:bg-indigo-100` 是内联到模板字面量时代的残留，作为独立 `.css` 文件供给浏览器时该规则整条失效，改为 `.hover\:bg-indigo-100`
- **ECH 卡片补齐 UI**: 新增版本状态区 `ver_ech`、`badge_ech`、变量增删与同步按钮、历史/收藏入口——此前 ech 有后端支持但前端缺入口
- **批量部署模板下拉补 ECH 选项**；KV 选项按模板 `kvBindingName` 自动禁用；UUID 输入对所有有 `uuidField` 的模板可见（此前 cmliu 的 UUID 输入被藏在 joey 分支里）

### 🧪 测试与 CI（这是本次最大的质量改动）

- **测试从「内联复刻」改为 import 真实模块**: 旧的 `kv-utils.test.ts` 与 `audit-regression.test.ts` 在测试文件内部重写了一份被测逻辑（注释理由是「避免 CF Workers 运行时依赖」），这类测试**永远不会因源码改动而失败**——70 个「全部通过」里含水量最大的部分。现在新增 `test/helpers.ts` 提供语义完整的内存 KV mock（含 `list` 前缀过滤与 `expirationTtl`）、CF 响应构造器、`stubFetch` 请求桩，所有测试直接 import `src/` 真实实现
- **测试规模 70 → 323**，6 个文件：
  - `kv-utils.test.ts`（40）：`mergeVariableBindings`、`getCompatibilityDate`、`kv-utils`、`getGithubUrls`、`applyTemplateTransform`、`withErrorBoundary`、路由表
  - `audit-regression.test.ts`（75）：凭证保护全链路（真实 AES-GCM 加解密）、密钥轮换、脱敏、Worker 列表访问器、restore 白名单、`resolveLimit`、模板类型派生、三个校验函数
  - `reliability.test.ts`（70）：`pooledMap` 并发上限与顺序、`readApiJson` 错误路径、`fetchWithTimeout` 超时、`fetchInternalStats` 各失败分支、`isFuseTriggered`、`mergePendingTargets`、`resolveUpdatePlan`、`rebuildBindings`、`parseRegionPools`
  - `routes.test.ts`（47）：部署部分失败语义、熔断作用域（验证只对目标账号发请求）、cron 全路径（含「ech 确实被部署」这条直接覆盖本次 bug 的断言）、CRUD 路由校验
  - `handlers.test.ts`（50）：批量部署、zones 全部 handler、yxip、fix1101、check
  - `auth-security.test.ts`（41）：会话/CSRF/限流/登录页 CSP nonce
- **新增 `.github/workflows/ci.yml`**: build → typecheck → verify → test，并检查产物非空、构建过程未改动被跟踪文件。此前四个脚本全靠手动跑
- **`verify.js` 重写**: 文件清单不再硬编码 43 条（CHANGELOG 记录过漏同步）。后端递归扫 `src/`，前端从 `build.js` 的 `jsFiles` 解析（单一真相源），并反向检查「存在但未被 build 引用」的孤儿文件。新增：真 JS 解析（`vm.Script`，替代数反引号）、`data-act` 与 `registerActions` 双向对齐、`data-args` JSON 合法性、元素 ID 可解析性、前端调用的端点是否都已注册、静态资源与 CSP 一致性、反模式扫描（裸 `res.json()` / 裸 `fetch` / 值快照式 window 导出）
- **`test/smoke.js` 扩充**: 新增资源拆分验证（`/app.js`、`/app.css` 的 Content-Type 与 immutable 缓存）、主 HTML 体积上限、CSP 无 `unsafe-inline`、API 未认证返回 JSON、`/api/*` 404 为 JSON、CSRF 三种拒绝路径
- **新增 `check.bat` 与 `pnpm run check`**: 本地一键跑完与 CI 相同的检查链

### 🔧 工程配置

- **统一到 pnpm**: 仓库一直只有 `pnpm-lock.yaml`，但 `install.bat` 用的是 `npm install`（忽略该 lockfile、解析出的版本与锁定的不一致），首版 CI 也因此在 `setup-node` 的缓存步骤直接失败（找不到 `package-lock.json`）。现在 `install.bat` / `check.bat` / CI / `wrangler.local.toml` 的 build 命令全部走 pnpm；`package.json` 增加 `packageManager: pnpm@11.22.0` 让 corepack 与 CI 锁定同一版本；`install.bat` 检测不到 pnpm 时自动 `corepack enable pnpm`
- **`pnpm-lock.yaml` 补齐缺失依赖**: lockfile 里缺 `@cloudflare/workers-types` 与新增的 `sweetalert2`，`--frozen-lockfile` 会直接失败
- **CI action 版本升级**: `actions/checkout@v5` + `actions/setup-node@v6` + `pnpm/action-setup@v4`，避开已弃用的 Node 20 runtime（GitHub 已默认改用 Node 24 执行 action）
- **构建可复现**: `build.js` 此前从 `https://cdn.jsdelivr.net/npm/sweetalert2@11`（浮动 tag）下载并内联进 worker，无版本 pin、无 hash 校验，每次构建可能拿到不同代码。现在优先从 `node_modules` 读取（`sweetalert2` 加入 pinned devDependency `11.14.5`），缺失时才回退到 **pin 了版本号**的 CDN，并打印 SHA-256 供比对
- **`build.js` 失败即退出**: 缺少前端文件时明确报错而非产出残缺 bundle；输出各资源体积便于观察
- **前端 JS 拼接加文件分隔注释**，便于在浏览器里定位来源
- **`bump-version.js` 修正**: 原本用 `replaceAll(oldTag, newTag)` 全文替换 README，会把历史说明里的版本引用一起改掉。现在只精确替换标题与「版本状态」行，找不到匹配时给出警告而非静默无操作

---

## V11.9.0 (2026-08-23)

### 🐛 真故障修复
- **删除无效的「🔐 加密迁移」功能**: 前端按钮调用 `POST /api/migrate_encrypt_keys`，但后端从未注册该路由——点击后请求落到 HTML 回退分支，`r.json()` 抛 SyntaxError，弹出无意义的 "Unexpected token" 错误。按钮、函数体、window 导出全部清除
- **未匹配的 `/api/*` 返回 404 JSON**: 原先任何拼错/废弃的 API 路径都返回 200 + 面板 HTML，导致前端 `r.json()` 崩溃且错误信息完全误导。现在 `/api/` 前缀未匹配时返回 `jsonError(404)`，非 API 路径仍正常回退面板
- **renderTable 崩溃防御**: `b.stats.total` 在 stats 缺失或 accounts 非数组时抛 TypeError，表格空白且无提示。现加 `Array.isArray` 防御 + `(x.stats && x.stats.total) || 0` 兜底
- **loadAccounts / loadStats 静默失败**: 补 `r.ok` 与数组校验，失败时 Swal 明确提示而非只 console.error
- **refreshHistory 异步竞态**: 快速切换模板类型时慢响应会覆盖快响应，显示错类型的版本历史。新增 `_historyReqId` 序号守卫（请求返回与 catch 各一处校验），并对 `success:false` / 空历史给出显式提示
- **doYxipDeploy 防重复点击**: 原先只切换图标不禁用，双击会触发两次 KV 写入/重复部署。新增 `_yxipDeploying` 锁（前置校验通过后置锁、finally 解锁）

### 🛡️ 可靠性提升
- **26 处裸 fetch 全部加超时**: zones.ts(12)、deploy.ts(5)、yxip.ts(2)、crud.ts(1)、deploy-utils.ts(1)、auto-update.ts(2)、cron.ts(1) 统一改为 `fetchWithTimeout`。Worker 脚本上传放宽到 60s，webhook 10s，其余默认 15s——避免上游挂起耗尽 Worker CPU 预算
- **用量统计修复（影响自动更新）**: GraphQL `workersInvocationsAdaptive` 的 `limit: 10000` 超出 adaptive 数据集上限，会导致所有账号 stats 恒失败 → cron 判定 `allErrored` 后永久跳过自动更新。改为 1000；同时补 `res.ok` 检查（HTTP 错误页不再抛异常）
- **dailyLimit=0 不再被 falsy 覆盖**: 新增 `resolveLimit()` 区分"未设置"与"显式设为 0"，替换 3 处 `acc.dailyLimit || 100000`
- **前端写操作全面加固**: saveAccount 补必填校验（alias/accountId/email，新增账号强制填 key）+ `r.ok` 检查 + 失败回滚本地数组 + 按钮禁用；delAccount / batchDeleteAccounts 补回滚与提示；saveAutoConfig 不再失败也弹「已保存」；toggleFavorite 补 try/catch；loadVars / checkDeployConfig 补 `r.ok`
- **verify_credentials 分批节流**: 原先 `Promise.all` 全量并发打 CF API，账号多时触发限流（1200 次/5 分钟）。改为每批 5 个 + 批间 200ms
- **restore 白名单前缀注入封堵**: `k === p || k.startsWith(p)` 会放行 `VARS_cmliuX`、`ACCOUNTS_UNIFIED_STORAGE_EVIL` 等键。改为精确匹配 + 已知模板类型枚举
- **favorites 参数校验**: 未知 action 与缺 sha 的 item 现返回 400（原本静默返回 success）
- **静默失败清零**: init_data 的 JSON.parse 失败、backup 的非 JSON 值降级均补 logger 记录；`/api/diag` 不再把 KV 底层错误消息回显给客户端

### 🧹 死代码与无效功能清理
- **5 个死接口复活为可用功能**（原本后端已实现、前端无 UI 入口）:
  - `GET /api/verify_credentials` → 账号工具栏「🔑 验证凭据」
  - `GET /api/deploy_journal` → 工作台「📜 部署日志」
  - `GET /api/deploy/preview` → 三个模板卡片各一个「🔍 预览」
  - `GET /api/diag` → 工作台「🩺 诊断」（新增 `frontend/js/diagnostics.js`）
  - `GET /api/get_code` → 工作台「📄 源码」（拉取上游模板源码摘要）
- **删除无价值死代码**: `timeAgo`（history.js 完全未用）、`isVirtualAdapter`（dns-fix.js 逻辑已内联到 PowerShell）、`generateAuthToken`（安全升级后无引用）、`src/routes/index.ts`（纯 re-export 兼容层，crud/loader 改为直接从 register.ts 导入）
- **previewDeploy 清理**: 移除收集后完全未使用的 vars 变量，补 `r.ok` 与空结果提示
- **window 导出补齐**: `deleteFromEdit` / `fetchZonesForAccount` / `updateZoneInfo` / `saveAutoConfig` 此前缺导出（当前拼接模式可用，但 module 化后会全部失效）
- **XSS 转义**: `verifyAllCredentials` 的 `x.error`（后端错误消息）补 `safeHtml`

### 🔧 工程配置修复
- **install.bat 只装 wrangler → 改为 `npm install`**: 原先遗漏 esbuild/typescript/vitest/workers-types，新克隆仓库执行 build.bat 必然失败
- **setup-secrets.bat 补 ENCRYPTION_SECRET 设置入口**: 此前无官方入口，容易把变量名拼错（如 `ENCRYPTION_SECRETS`）导致静默回退到 ACCESS_CODE 派生密钥。新增第 3 步并内置拼写与时机警告
- **build.bat 补 dns-fix**: build.js 需下载 SweetAlert2，缺 DNS 修复会失败（deploy/setup 已有）
- **package.json**: 新增 `test:smoke`（test/smoke.js 此前无任何脚本调用）、`typecheck` 改为严格 `tsc --noEmit`（不再用 `|| echo` 掩盖失败）、description 去掉过期版本号

### 🧪 测试
- 新增 `test/audit-regression.test.ts`（19 个回归测试）: writeAccounts 掩码/空值/alias+email 兜底保护 6 项、restore 白名单前缀注入 4 项、resolveLimit 边界 4 项、API 404 判定 3 项、history 竞态守卫 1 项、renderTable stats 兜底 2 项
- 测试总数 50 → **70，全部通过**；tsc 0 错误、verify 0 错误 0 警告

## V11.8.0 (2026-07-31)

### 🔒 安全架构升级（评审驱动）
- **会话 token 化**: 登录改为生成 32B 加密安全随机会话 token 存入 KV（TTL 7 天），requireCookie 改查 KV 校验；新增 POST /api/logout 登出端点 + 前端 🚪 登出按钮；ACCESS_CODE 不再直接派生 token，登出/过期可撤销
- **CSRF token 机制**: 登录发放双 cookie（__Host-auth HttpOnly + __Host-csrf 供 JS 读取），写请求必须携带 X-CSRF-Token 且与会话绑定值恒定时间比对（无头/错 token/已登出均 403）；前端 fetch 全局拦截自动附头；Sec-Fetch-Site/Origin 降级为纵深防御
- **恒定时间比较**: 登录密码与 cookie 会话校验改为 SHA-256 摘要后逐字节异或比较，消除时序侧信道
- **登录限流加固**: 速率限制计数移到密码校验之后——非法 JSON/垃圾请求不再消耗配额，防跨站表单耗尽受害者限流
- **CSP 收紧**: 面板 CSP 增加 frame-ancestors 'none'、base-uri 'none'、form-action 'self'；登录页补充完整 CSP
- **响应头补齐**: 全局移除多余 CORS Access-Control-Allow-Origin: *；所有 JSON 响应统一 X-Content-Type-Options: nosniff + X-Frame-Options: DENY + Referrer-Policy: no-referrer
- **加密安全随机数**: fix1101 子域名轮换由 Math.random() 改为 crypto.getRandomValues

### 🐛 数据安全修复
- **脱敏 key 回写丢失凭证（高危）**: 前端编辑账号不再回填脱敏 key（留空=不修改）；后端 writeAccounts 对空值/掩码值保留 KV 旧密文，杜绝掩码值加密入库覆盖真实 API Key
- **密钥变更后空值覆盖**: readAccounts 解密失败标记改精确 v1: 前缀；writeAccounts 空 key 保留旧密文，防止密钥变更后凭证永久丢失
- **import 双重加密**: 导入解密失败（密钥不匹配）时置空并返回 warning 提示，不再二次加密损坏数据
- **bindings 覆盖丢失（高危）**: 部署前 GET /bindings 失败改为中止该 Worker 部署，不再静默降级为空数组覆盖既有 KV/secret 绑定
- **fix1101 secret 丢失**: secret_text 绑定无法从 CF API 恢复时跳过并警告需手动重配，不再写入空值覆盖
- **fix1101 子域名不可回滚**: 子域名轮换移至重建成功之后且每账号只执行一次，失败不再造成 Worker 已删+子域名已改的不可恢复状态
- **changeSubdomain 回滚保护**: DELETE 旧子域名前必须先确认拿到旧域名，防止删除后无法自动恢复

### 🏗️ 可靠性修复
- **cron lastCheck 全路径兜底**: KV 读失败、账号为空、熔断单账号异常均保证更新 lastCheck；waitUntil 加 catch 防 unhandled rejection；fuseWebhook URL 掩码后入日志
- **deploy.js 按钮卡死**: settings 保存失败不再导致部署按钮永久禁用（try/catch + 警告提示）
- **批量部署密码回填**: config.admin → config.ADMIN 大小写修复，重试失败批次密码可恢复
- **变量同步 secret 保留**: fetch_bindings 返回 secret 标志，doSync 同步后 secret 标记不丢失
- **账号接口校验**: POST /api/accounts 增加数组/必填字段/500 上限校验，防止坏数据入库
- **yxip XSS 修复**: accountId 拼入 innerHTML 前 safeHtml 转义

### 🧪 工程化
- **TypeScript 全量清零**: 安装 @cloudflare/workers-types、getJSON 12 处显式泛型、res.json() 类型断言等，tsc --noEmit 从 150 个错误降到 0
- **新增 21 个安全单元测试**: test/auth-security.test.ts 覆盖会话发放/TTL/恒定时间/限流/CSRF 全链路（测试总数 50，全部通过）
- **verify.js 清单同步**: 补上 accounts-io.js / accounts-worker.js 拆分文件

## V11.7.1 (2026-07-16)

### 🐛 Bug 修复
- **构建修复**: `frontend-bundle.ts` 过期缺少 `FRONTEND_VERSION`/`FRONTEND_SWEETALERT2` 导出，导致 esbuild 构建失败
- **Secret 复选框修复**: `vars.js` 中 `secChk.onchange` 使用 `nextElementSibling` 指向错误 DOM 元素，导致 secret 标记不生效，改为 `previousElementSibling`
- **API 错误解析加固**: `zones.ts` `handleDeleteWorker` 中 `err.errors[0]` 改为 `err.errors?.[0]`，防止 Cloudflare API 返回异常 body 时 TypeError 崩溃
- **build.js 双配置修复**: `compatibility_date` 自动更新优先检查 `wrangler.local.toml` 是否存在，存在则更新它而非 `wrangler.toml`，与 `deploy.bat` 行为一致

## V11.7.0 (2026-07-16)

### 🏗️ 架构优化
- **模板驱动**: `getWorkerNames` 从硬编码 switch 改为动态属性访问，新增模板无需改此函数
- **日志统一**: 21 处 `console.error/warn` 全面迁移到结构化 `logger.*`（cloudflare-api, github, kv-utils, auth, check, crud, zones, yxip, auto-update）
- **路由提取**: 登录逻辑从 `index.ts` 提取到独立 `routes/login.ts`，保持公开路由预检流程正确
- **部署统一**: `handleBatchDeploy` 复用 `prepareDeployCode`（统一代码获取+SHA追踪）+ 部署成功后写入 journal
- **错误边界**: 新增 `withErrorBoundary` 高阶函数，提供路由级结构化错误日志

### 🧪 测试增强
- 新增 21 个单元测试：`getWorkerNames`(4) + `applyTemplateTransform`(5) + `withErrorBoundary`(3) + 现有测试扩展
- `verify.js` 更新：新增 13 个源文件检查（login.ts, account-store.ts, auto-update.ts 等）

### 🔒 安全加固
- **handleBatchDeploy**: 添加 `requireTemplateType` 模板类型白名单校验（感谢安全审查）
- **POST /api/deploy**: 手动部署路由添加模板类型校验，防止无效 type 触发 TypeError 崩溃
- **finalizeDeploy**: putJSON 写入增加 try-catch 保护，防止 KV 写入失败穿透
- **catch(_)**: 所有空 catch 块改为携带错误信息的结构化日志

## V11.6.2 (2026-07-12)

### 🔴 安全修复 (全面审计)
- **github.ts**: PROXYIP 代码注入修复 — 补充单引号/反斜杠转义，与 TOKEN 处理一致
- **XSS 修复**: yxip.js 外部数据源节点 code/cname 加入 safeHtml 转义
- **XSS 修复**: accounts.js 凭据验证结果别名加入 safeHtml 转义
- **XSS 修复**: yxip.js 账号邮箱文本内容加入 safeHtml 转义
- **IP 伪造防护**: 登录限流移除 X-Forwarded-For 回退，仅信任 CF-Connecting-IP
- **CSP 加固**: 主 HTML 页面添加 Content-Security-Policy 头

### 🟡 安全改进
- **yxip.ts**: 移除 YxipSaveRequest 中未使用的 email/globalKey 字段，消除凭据伪造攻击面
- **前端 yxip.js**: 不再向 /api/save_yxip 发送 email/globalKey

### 🟢 代码质量
- **前端日志**: 6 处静默 catch 块添加 console.error (yxip.js ×2, accounts.js ×2, vars.js, history.js)
- **日志统一**: zones.ts:113 console.warn → logger.warn
- **类型安全**: getWorkerNames 提取到 account-store.ts，crud.ts/deploy.ts 共享复用
- **类型安全**: 消除 account-store / yxip / deploy / crud / check 中的 any 标注
- **DRY**: requireTemplateType 提取到 validate.ts，消除 8 处重复验证
- **DeployBody** 等 5 个接口由 loader.ts 移至 types.ts
- **dns-fix.js** 空 catch 块添加错误日志
- **auth.ts & cloudflare-api.ts** catch 块添加原始错误日志

## V11.5.0 (2026-06-29)

### 🛡️ 安全加固 (审计驱动)
- **XSS 防护**: 修复 5 处 innerHTML 未转义注入点 (GitHub commit msg, CF Worker名, 账号别名, API错误消息)
- **信息泄露封堵**: 15 处 catch 块不再将内部错误消息返回客户端，改为通用消息 + console.error
- **后端加固**: /api/diag 只显示键存在性不暴露KV内容; /api/restore 增加 KV 键白名单; CRUD 端点 type 参数校验
- **认证修复**: 登录接口增加 ACCESS_CODE 缺失检查，防止空密钥时绕过认证
- **加密层优化**: writeAccounts 不原地修改调用方数组; 移除 yxip.ts 死 import; 导入解密守卫改为版本通配 /^v\d+:/

### 🐛 Bug 修复
- **github.ts**: 修复 applyTemplateTransform 函数代码损坏 (字符串未闭合 + CF_FALLBACK_IPS 死代码)
- **空 catch**: 3 处空 catch 块增加日志输出 (auto-update, zones, deploy)

## V11.4.0 (2026-06-29)

### DNS 自动修复
- 新增 dns-fix.js: Node.js preload hook，自动检测 127.0.0.1:53 可用性
- 智能 fallback: 当本地 DNS 代理未运行时，自动降级到系统真实 DNS
- 无硬编码: 通过 PowerShell + ipconfig 自动发现网关 DNS，适配任意网络环境
- deploy.bat 集成 NODE_OPTIONS=--require 加载 DNS 修复

### 加解密层清理
- 移除 deploy.ts 和 cron.ts 中 readAccounts 后的冗余 decryptKey 调用
- 移除 check.ts 和 fix1101.ts 中未使用的 decryptKey import
- crud.ts 导入端点仅对 import 条目解密，跳过已解密的存量条目

### 其他改进
- deploy.bat 优化: 集成 DNS 修复，移除冗余代理变量设置

## V11.3.0 (2026-06-28)

### 🔒 加密层进化
- **密钥版本化**: v1: 版本前缀，支持多版本共存 + 兼容存量无前缀密文
- **ENCRYPTION_SECRET**: 独立加密密钥，改 ACCESS_CODE 不影响已加密数据
- **CryptoKey 缓存**: WeakMap 缓存，9 账号场景 9 次 SHA-256 → 1 次
- **decryptKey 日志**: 解密失败时写 warn 日志，可观测密钥变更问题
- **KV cacheTtl**: readAccounts 30s 缓存，减少重复 KV 读取

### 🛡️ 安全修复
- **yxip.ts 凭证伪造**: API 调用强制使用服务端存储的凭证，拒绝客户端传入
- **登录限速改进**: CF-Connecting-IP 回退到 X-Forwarded-For
- **diag 信息泄露**: 移除 __kv_keys 暴露

### 🐛 Bug 修复
- **import 双重加密**: 导入已加密数据→writeAccounts 再加密→数据损坏 → 添加 decrypt→encrypt 标准化
- **重复 decryptKey**: deploy.ts/cron.ts/yxip.ts 移除 readAccounts 之后的冗余解密
- **fix1101 N+1 KV**: kvVars 从内层循环移到外层，5账号×3Worker 场景 15x→1x
- **fix1101 死代码**: 移除未使用的 ACCOUNTS_KEY
- **settings 返回值**: null→[]，前端 JSON.parse 更安全

### ⚡ 性能优化
- **verify_credentials 并行化**: 串行 for→Promise.all，9 账号延迟降低 8x
- **handleGetCode 加 Token**: 添加 GITHUB_TOKEN 认证头 + fetchWithTimeout
- **前端 init_data**: 批量加载，10+ 请求合并为 1 个

### 🧹 代码清理
- safeJson 去重到 cloudflare-api.ts（原 3 处重复）
- 4 处未使用 import 删除
- index.ts 登录处理缩进修复


---

## V11.2.0 (2026-06-28)

### 🔒 安全加固
- **API Key AES-256-GCM 加密存储**: globalKey 密文存入 KV，仅 ACCESS_CODE 可解密
- **统一数据访问层 account-store**: readAccounts/writeAccounts 自动加解密，杜绝遗漏
- **XSS 防护**: safeHtml/safeJsStr 转义 Zone 名称和 onclick 属性
- **JSON 异常处理**: 所有 POST 端点使用 safeJson()，畸形 JSON 返回 400

### 🐛 修复 (本轮 20+ 项)
- 9 处密钥解密遗漏 → 统一 readAccounts 自动解密
- 12 处 request.json() 无异常处理 → safeJson()
- fix1101 失败时 Worker 永久删除 → KV 恢复快照
- 定时任务全部 stats 错误仍消耗 API → 提前退出
- parseInt 无 radix → parseInt(x,10)
- HTTP 调用无超时 → fetchWithTimeout()
- 前端 JS 语法错误 → 修复换行符
- 空列表工具栏隐藏 → 始终渲染

### 🏗️ 架构
- shared types.ts (8 interfaces)
- migrate_encrypt_keys 端点 + UI 按钮
- 导入导出加密一致性


---

## V11.1.0 (2026-06-27)

### 🐛 关键修复

- **P0 并发安全**: `customCodeHash` 修复为函数局部变量，消除多请求数据竞态
- **异常透明**: `index.ts` 路由分发加 `await`，异常不再被 CF 运行时吞为 HTML 500
- **缺失导入**: `deploy.ts` 补回 `json` 导入 (ReferenceError)
- **前端防御**: `logs.forEach` 前加 `Array.isArray` 检查，避免错误消息被 `forEach is not a function` 掩盖
- **变量名统一**: 批量部署 `admin` → `ADMIN` (大小写一致)，消除重复变量
- **fix1101 Secret 保留**: 1101 修复后不再丢失 `secret_text` 类型

### 🛠️ 代码质量

- **部署去重**: 提取 `mergeVariableBindings` 共享函数，消除 60% 部署逻辑重复
- **前端加固**: 拼接 JS 加 `"use strict"` + 73 个 `window.xxx` 显式导出声明
- **日志统一**: 自动更新错误改用 `logger.error` 替代 `console.error`
- **缩进修正**: `yxip.ts` 缩进对齐

 (Changelog)

> 倒序排列，最新版本在前。

---

## V10.16.0 (2026-06-26)
- 🐛 CRITICAL: 修复 5 个文件 BINDING 导入缺失导致的运行时 ReferenceError (deploy/fix1101/zones/yxip/auto-update)
- 🐛 修复 addVarRow 第4参数 secret 被静默丢弃，刷新后 Secret 标记丢失
- 🐛 修复 build.bat 路径拼写错误 distworker.js → dist/worker.js
- ⚡ mainHtml() 模块级缓存，页面请求零字符串构造开销
- ⚡ fetchGithubVersion 两次 KV 读取改为 Promise.all 并行
- ⚡ loginHtml() 缓存
- 🔒 前端 XSS 加固: accounts.js/yxip.js 用户数据 innerHTML 转义
- 🔒 CSRF 新增 Sec-Fetch-Site 检测 + 畸形 Origin 头异常保护
- 🔧 build.js 启用 compatibility_date 自动同步 → wrangler.local.toml (不污染 Git)
- 🧹 cloudflare-api.ts 移除重复 CfApiResult 接口定义

## V10.15.0 (2026-06-26)
- ✨ 部署前代码差异对比 (GitHub Compare API)
- 📜 部署操作日志面板
- 🚀 /api/init_data 合并端点，首屏减少 HTTP 往返
- ⚡ DOM 缓存 $() + 表格头部缓存
- 🔒 ADMIN→secret_text, Cookie→__Host-前缀
- 🐛 修复 Joey 批量部署变量名 u vs uuid 错误
- 🔧 错误处理统一: 6处空catch→console.error + jsonError 统一
- 🧹 代码质量: 消除重复函数声明、补全边界检查

## V10.14.1 (2026-06-26)
- 🐛 修复 Joey 批量部署变量名错误：u 被误填为 uuid 导致 Worker 功能异常
- 🔧 后端 uuidField 硬编码改为动态映射，消除模板特定分支

## V10.14.0 (2026-06-24)

### 🔒 安全加固

- **Cookie 不再存储明文密码**: 登录成功后将 ACCESS_CODE 的 SHA-256 摘要写入 Cookie，原始密码不再出现在任何 Cookie/日志中

### 🐛 修复

- **子域名修改安全性**: `handleChangeSubdomain` 改为先 PUT 覆盖，仅在 CF 返回 "already has" 时才 DELETE+PUT，避免无故删除已有子域名
- **正则替换静默失败检测**: ECH 模板的 `CF_FALLBACK_IPS` 和 `token` 正则替换增加失败检测，上游代码变更时输出警告日志
- **错误响应格式统一**: 所有路由统一使用 `json()` / `jsonError()` 工具函数构建 JSON 响应，不再手写 `new Response(JSON.stringify(...))`

### 🧹 代码质量

- **模板类型约束**: 新增 `TemplateType = keyof typeof TEMPLATES` 类型，关键函数签名从 `type: string` 改为 `type: TemplateType`，编译期防止模板名拼写错误
- **消除无意义动态导入**: `loader.ts` 14 个 `await import()` 全部改为顶层静态 import，esbuild 打包后已是单文件，动态导入无实际收益
- **verify.js 修正**: 导出检查 MAP 中 MANIFEST 从 middleware/auth 移至 config/templates，消除假警告
- **KV 命名空间清理加固**: 删除 Worker 时 KV 命名空间删除改为 5 次 × 2s 轮询（409 Conflict 重试），失败时返回 `kvWarnings` 字段告知用户而非静默忽略；全类型 Worker 删除后同步清理 `VARS_*` 和 `FAVORITES_*` 残留数据


## V10.12.0 (2026-06-23)

### 🏗️ 架构重构

- **类型安全**: 全局  →  接口，编译期校验 KV/密钥访问
- **模块解耦**: cron.ts 不再动态导入 routes，核心逻辑提取到 
- **接口收敛**:  9参数 →  对象， 统一凭证传递
- **模板驱动**: 6处硬编码  →  动态生成
- **职责分离**:  → ， → 

### ✨ 新增功能

- **项目独立开关**: cmliu/joey/ech 各自控制自动更新与熔断轮换
- **部署日志查看**: 新增  端点

### 🛠️ 代码质量

- **KV 工具**: / 消除 28 处样板代码
- **部署去重**: // 提取到 
- **认证合并**: / 合并为单一函数
- **参数精简**: 消除 10 处透传的  冗余参数
- **临时文件清理**: 删除编码损坏的 

### 🐛 修复

- **版本检查**: 删除 Worker 后自动重置过期 ，不再显示已删除项目的旧版本
- **ECH Token**: 1101 修复流程保留 ECH token 变量，不再丢失
- **主从联动**: 自动更新主开关关闭时子开关自动关闭

## V10.11.1 (2026-06-20)

### 🐛 修复

- **安全加固**: Cookie 认证从子串匹配改为正则精确比对，消除密码前缀绕过风险
- **UI 增强**: 批量操作工具栏补全选中计数和按钮禁用逻辑
- **批量修复**: 批量部署重试时完整恢复所有表单配置（Worker名/KV/域名前缀等）
- **Zone 分页**: 支持 >50 个 Zone 的账号完整加载
- **1101 修复稳健性**: 删除 Worker 后加入 2 秒延迟再重建，防止 CF API 异步竞态

## V10.11.0 (2026-06-18)

### 修复
- 修复 yxip.ts 缺失 KV_KEYS/json 导入导致运行时崩溃
- 修复 5 处空 catch 静默吞错(fix1101/github/前端)
- 修复 cron.ts lastCheck 异常时未更新导致定时任务阻断
- 修复前端 JS 文件误用 TypeScript 类型注解
- 修复搜索框被 doSearch 过滤掉自身的问题

### 优化
- 删除死代码 authenticate()
- 路由表模块级缓存,不再每次请求重建
- 构建启用 minify(164KB→152KB)
- 搜索改为 Enter 触发,清除按钮始终可见,支持 Esc 清除

### 新功能
- 暗色模式自动跟随系统(prefers-color-scheme)
- 账号搜索过滤 + YXIP 地区搜索过滤
- 部署失败重试 + 部署操作日志(审计追踪)
- 账号导入/导出(JSON) + 数据备份/恢复
- 批量删除账号(复选框多选)
- 部署预览(dry-run) + 凭据预检验证
- Secret 环境变量支持
- 熔断告警 Webhook(钉钉/飞书)

## V10.10.0 (2026-02-24)

### ⚡ 反代落地部署全面升级 (YXIP Improvements)

* **Joey 部署架构多维兼容**：彻底重构 Joey 项目自动优选部署流。考虑到不同用户使用的底层架构，不仅提供了针对绑定高级 CFnew 框架大写 `C` 核心库直接注入 JSON 参数的强控直发特性（即原生有 KV 模式）；更是对极简版老字号架构提供了无缝的向下兼容：无需选取具体配置节点，在面板通过切换进入“**Joey 兼容（变量模式）**”通道后即可瞬间利用全局的系统级 `yx` 字段实现全版统一下放，一次设置所有新项目可通用！
* 为配合上述兼容变量模式特性，交互面板进行优化：当锁定纯变量覆写策略时自动停用、隐藏下方的 CF 账号选取列表和全选组件，进一步避免用户误解目标受众与操作域。
* 本次升级不仅完整统一了多种不同类型边缘业务的云端批量维护手感，还在代码层将所有的 YXIP 操作模板变量处理完全隔离原生化消除了一众运行隐患，使得稳定性大幅提高。

---

## V10.9.0 (2026-02-24)

### ⚡ 新功能：全球反代落地节点系统 (YXIP) 集成

* 中控台主面板全新加入 **“⚡ 反代落地部署”** 专属功能入口按钮。
* 复刻独立版 `yxip.js` 功能逻辑：构建暗黑毛玻璃风格全屏交互模态框，直连上游实时获取全球区域 CF 节点池，支持按任意国家/地区分组、限额并摇号随机筛选。
* **CMLiu 专属全自动直写适配**：自动检索选中 Cloudflare 账号下的全部 CMLiu 框架应用，通过底层 API 跨域提取各个应用绑定的专用 KV 空间 ID，并将摇号生成的优选节点库资源**一键批量写入为该节点的原始 `ADD.txt` 订阅池内**，无需外部链接即可无缝原生应用高性能节点！
* **Joey 方案直插适配**：同时支持生成原生 Joey 适用的角标协议资源格式，并支持瞬间覆盖式注入其全局环境变量组的专属保留字(`yx` 变量)，便于后续重新批设下发。

---

## V10.8.0 (2026-02-20)

### 🚫 新功能：ECH 禁用 workers.dev 域名开关

* ECH 配置卡片新增「🚫 禁用默认 \*.workers.dev 域名」复选框（默认不勾选）。
* 勾选后部署成功，自动调用 CF API 将该 Worker 的 workers.dev 子域名禁用。
* 不勾选则保持启用（默认行为）。
* 工作台日志显示 `🚫 默认域名已禁用` 或 `🌐 默认域名已启用` 的操作结果。

---

## V10.7.0 (2026-02-20)

### 🔑 新功能：ECH Token 鉴权开关

* ECH 配置卡片底部新增虚线框区域，包含 Toggle 开关和 Token 输入框。
* **填写 Token + 开启开关** → 部署时将 Token 注入 `ech.js` 的 `const token = '...'`，启用 WebSocket 鉴权。
* **不填 / 关闭开关** → `const token = ''`（无鉴权，默认行为），即使输入框有内容也不会注入。
* Token 值同时保存到 `VARS_ech` 中，方便下次预填。

---

## V10.6.0 (2026-02-16)

### 🚀 新功能

* 工作台改为底部弹窗显示，主页添加「📋 工作台」按钮。
* 批量部署新增「📦 采用已保存变量 (VARS)」复选框（默认开启）。
* 修复 1101 实时步骤打印到工作台。
* 一键修复 1101 新增自定义域名恢复流程：记录变量 → 删除 Worker → 随机改子域名 → 相同名称重建 → 恢复所有变量 + 域名绑定。

### 🗑️ 移除

* 删除所有混淆功能（serverSideObfuscate、JavaScriptObfuscator CDN、自动混淆开关、批量部署混淆）。

### ✨ 改进

* 所有操作日志统一输出到工作台弹窗。
* `DEPLOY_CONFIG` 更新不再依赖 SHA，修复本地时间不更新。

---

## V10.3.3 (2026-02-16)

### 🐛 修复

* 重写 `serverSideObfuscate`：仅用头部随机注释+尾部 var 声明，修复 cmliu 1101。
* 子域名修改改为 DELETE+PUT 两步操作，解决 "Account already has an associated subdomain" 错误。

---

## V10.3.2 (2026-02-16)

### 🐛 修复

* 手动部署改回服务端反指纹混淆，修复 `JavaScriptObfuscator` 对 edgetunnel 代码过于激进导致 Workers 1101 错误。
* `JavaScriptObfuscator` 仅保留给批量部署使用。

---

## V10.3.1 (2026-02-16)

### 🔐 反指纹混淆

* 重写 `serverSideObfuscate`：注入大量随机死代码，每次部署指纹完全不同，防止 CF 特征码匹配。

### 📋 文档重构

* 新增 `CHANGELOG.md` 独立版本记录文件（倒序排列）。
* `worker.js` 和 `README.md` 仅保留当前版本日志，历史版本移至本文件。

---

## V10.3.0 (2026-02-16)

### 🚀 手动部署前端混淆

* 点击「🚀 部署更新」时，若开启自动混淆，在浏览器端完整混淆后再部署。
* `coreDeployLogic` 新增 `customCode` 参数，支持接收前端预混淆代码。

---

## V10.2.3 (2026-02-16)

### 🐛 Bug 修复

* 重写 `serverSideObfuscate`，移除危险的注释删除正则（误删模板字面量中 HTML/URL 内容导致 `SyntaxError`）。

---

## V10.2.2 (2026-02-16)

### 🐛 Bug 修复

* DEPLOY_CONFIG 仅在至少一个 Worker 成功部署后才更新 SHA。
* 手动部署读取「自动混淆」开关。

---

## V10.2.1 (2026-02-16)

### 🐛 关键 Bug 修复

* 修复 `coreDeployLogic` 中 `targetSha='latest'` 被当作 git ref 导致自动更新失败。
* 修复部署后 deploy config 被错误锁定为 `fixed` 模式。
* 修复历史版本「Always Latest」部署触发 URL 构造错误。

---

## V10.2.0 (2026-02-14)

### 🌌 暗黑星空主题

* 新增暗黑星空模式 / 明亮模式主题切换。
* Canvas 动态星空背景（闪烁星星 + 流星 + 星云光晕）。
* 卡片毛玻璃半透明效果，全组件暗黑模式适配。
* 主题选择通过 localStorage 持久化。

---

## V10.1.0 (2026-02-14)

### 🌐 子域名管理

* 查看/修改 workers.dev 子域名前缀。
* 安全二次确认 + 格式校验。
* 新增 `/api/get_subdomain`、`/api/change_subdomain` 接口。

---

## V10.0.0 (2026-02-14)

### 🔐 安全加固

* 登录改为 POST 提交，Cookie 增加 Secure 标志。
* API 方法校验、CSRF 防护、统一错误响应。

### 🐛 缺陷修复

* 修复混淆正则误删 URL、checkUpdate 变量冲突、编辑账号 stats 重置。

### ⚡ 改进

* 熔断/自动更新动态化，compatibility_date 动态化。
* 前后端数据消除重复，由后端动态注入。

