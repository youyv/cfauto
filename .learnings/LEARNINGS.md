# Learnings

> Auto-captured from session 2026-06-20 · Worker V10.11.1

---

## [LRN-20260620-001] best_practice

**Status**: resolved
**Area**: config
**Pattern-Key**: wrangler.toml.source.of.truth

### Summary
wrangler.toml 是 CF Worker 配置的唯一真理源，缺失项会被 deploy 从远程删除。

### Details
- [vars] 不写 → 远程环境变量被清空
- [[kv_namespaces]] 注释 → KV 绑定被解绑
- [[routes]] 不写 → 自定义域名路由被删
- [triggers] 不写 → Cron 触发被清空
- 仅 wrangler secret 不受 toml 影响

**修复**: 非敏感配置写入 toml，密钥用 wrangler secret put。

### Metadata
- Source: error
- Related Files: wrangler.toml
- Recurrence-Count: 1
---

## [LRN-20260620-002] correction

**Status**: resolved
**Area**: security
**Pattern-Key**: cookie.auth.substring.bad

### Summary
Cookie 认证不能用 includes() 子串匹配，须正则提取值后严格比对。

### Details
原代码 cookieHeader.includes('auth=' + ACCESS_CODE) 存在前缀绕过。
修复: match(/(?:^|;\s*)auth=([^;]*)/) 提取值 → !== 严格比对。

### Metadata
- Source: code_review
- Related Files: src/middleware/auth.ts
- Recurrence-Count: 1
---

## [LRN-20260620-003] error

**Status**: resolved
**Area**: infra
**Pattern-Key**: git.filter-branch.windows.unreliable

### Summary
Windows Git Bash 上 git filter-branch --tree-filter 不修改文件内容。

### Details
node/sed 方式均不生效。最终: git reset --soft + squash + force push。

### Metadata
- Source: error
- Recurrence-Count: 1
---

## [LRN-20260620-004] best_practice

**Status**: resolved
**Area**: config
**Pattern-Key**: bat.self.locate.dp0

### Summary
Windows bat 用 %~dp0 自定位替代硬编码路径。

### Details
cd /d %~dp0 自动切到 bat 所在目录，文件夹可随意移动。

### Metadata
- Source: user_feedback
- Related Files: build.bat, deploy.bat, install.bat, setup-secrets.bat
- Recurrence-Count: 1
---

## [LRN-20260620-005] correction

**Status**: resolved
**Area**: frontend
**Pattern-Key**: line.number.replacement.fragile

### Summary
按行号替换代码极易出错，优先用精确文本匹配。

### Details
修复 auth.ts 时按行号覆盖，新函数多 3 行导致 checkCsrf 函数声明丢失。
后续所有修复改用精确文本匹配无问题。

### Metadata
- Source: error
- Related Files: src/middleware/auth.ts
- Recurrence-Count: 1
---

## [LRN-20260620-006] best_practice

**Status**: resolved
**Area**: config
**Pattern-Key**: wrangler.secret.vs.vars

### Summary
密钥用 wrangler secret put 管理，加密存储永不随 deploy 被覆盖。

### Details
wrangler.toml [vars] 每次 deploy 覆写远程。wrangler secret 加密存 CF，deploy 永不动。

### Metadata
- Source: error
- Related Files: setup-secrets.bat, wrangler.toml
- Recurrence-Count: 1
---

## [LRN-20260620-007] knowledge_gap

**Status**: resolved
**Area**: config
**Pattern-Key**: toml.section.boundary

### Summary
TOML 中 [section] 之后的所有 key=value 属于该 section，注释不打断边界。

### Details
workers_dev 写在 [build] 后被当 build 子属性报 warning。须放顶级位置。

### Metadata
- Source: error
- Related Files: wrangler.toml
- Recurrence-Count: 1
---

## [LRN-20260620-008] best_practice

**Status**: resolved
**Area**: build
**Pattern-Key**: build.auto.update.compatibility.date

### Summary
compatibility_date 在 build.js 中自动更新为当天日期。

### Metadata
- Source: user_feedback
- Related Files: build.js, wrangler.toml
- Recurrence-Count: 1
---

## [LRN-20260620-009] solution

**Status**: resolved
**Area**: frontend
**Pattern-Key**: bat.chinese.encoding.utf8.bom

### Summary
Windows CMD 中文乱码: chcp 65001 + UTF-8 BOM。

### Details
@echo off 后加 chcp 65001 >nul，文件用 UTF-8 BOM 编码。

### Metadata
- Source: error
- Related Files: *.bat
- Recurrence-Count: 1
---

## [LRN-20260620-010] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: cf.api.async.delete.rebuild.race

### Summary
CF Worker 删除异步，立即重建偶发竞态。加 2s 延迟。

### Details
1101 修复: await new Promise(r => setTimeout(r, 2000))

### Metadata
- Source: code_review
- Related Files: src/routes/fix1101.ts
- Recurrence-Count: 1
---

## [LRN-20260620-011] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: cf.api.zone.pagination

### Summary
CF Zones API per_page=50 不够，需 while 分页循环。

### Details
while(true) { fetch(&page=N) → result_info.total_pages 判定终止 }

### Metadata
- Source: code_review
- Related Files: src/routes/zones.ts
- Recurrence-Count: 1


## [LRN-20260620-012] error

**Status**: resolved
**Area**: build
**Pattern-Key**: esbuild.output.file.locked

### Summary
esbuild write dist/worker.js Access denied - file locked by wrangler/other process.

### Details
wrangler deploy may hold dist/worker.js open. Subsequent build fails.
Fix: build.bat adds del /f dist/worker.js 2>nul, build.js adds fs.unlinkSync.

### Metadata
- Source: error
- Recurrence-Count: 1
---

## [LRN-20260620-013] correction

**Status**: resolved
**Area**: config
**Pattern-Key**: bat.utf8.bom.broken

### Summary
bat files with UTF-8 BOM cause CMD garbled text. Fix: pure ASCII, no BOM, no Chinese.

### Details
BOM bytes (EF BB BF) display as gibberish in GBK terminal and break @echo off.
Fix: all bat files rewritten in ASCII-only English, no BOM, no chcp 65001 needed.

### Metadata
- Source: error
- Recurrence-Count: 1
---

## [LRN-20260620-014] best_practice

**Status**: resolved
**Area**: config
**Pattern-Key**: wrangler.local.toml.gitignore

### Summary
Dual-config pattern: wrangler.toml (template, git) + wrangler.local.toml (real values, gitignored).

### Details
deploy.bat: if exist wrangler.local.toml -> use it, else fallback to wrangler.toml.
Public repo sees only placeholders. Personal info stays local.

### Metadata
- Source: user_feedback
- Related Files: deploy.bat, .gitignore, wrangler.local.toml
- Recurrence-Count: 1
---

> Auto-captured from session 2026-08-26 · Worker V12.0.0

## [LRN-20260826-001] error

**Status**: resolved
**Area**: backend
**Pattern-Key**: derived.condition.reused.for.different.purpose

### Summary
用同一个派生条件筛选两种语义不同的集合，会让其中一种功能静默失效。

### Details
cron.ts 用 `filter(t => t.uuidField)` 同时筛选「能熔断轮换的模板」与「参与版本更新的模板」。
前者正确（无 UUID 无法轮换），后者错误——ech 的 uuidField 为空字符串，于是它的
自动更新彻底不工作，而 UI 开关、配置字段、AUTO_FLAG 映射全都存在，用户完全无法察觉。

**修复**: 在 TEMPLATES 中显式声明 `autoUpdate` 字段，两个用途各有自己的派生函数
（`autoUpdateTypes()` / `fuseRotatableTypes()`），并写测试断言两者集合大小不同。

**教训**: 任何「顺便用现成条件」的筛选都要问一句「这两件事的判据真的相同吗」。
UI 上存在开关但后端无对应逻辑，是这类 bug 的典型外部特征。

### Metadata
- Source: code_review
- Related Files: src/cron.ts, src/config/templates.ts
- Recurrence-Count: 1
---

## [LRN-20260826-002] error

**Status**: resolved
**Area**: backend
**Pattern-Key**: partial.success.advances.global.state

### Summary
批量操作里「有一个成功就推进全局进度标记」会让失败项永久停滞且无告警。

### Details
finalizeDeploy 原本 `if (logs.some(l => l.success))` 就把 currentSha 写成新 SHA。
3 个账号里 1 个成功 → localSha === remoteSha → cron 判定「已是最新」→ 那 2 个
失败的 Worker 永远停在旧版本，界面上还显示绿色 Latest。

**修复**: 全部成功才推进 SHA；失败目标以 `<accountId>::<workerName>` 记入
`pendingTargets` + `pendingSha`，cron 通过 `resolveUpdatePlan` 只重试它们。
前端在版本区显示 pending 数量。

**教训**: 进度标记的语义是「所有目标都到达了这个状态」，不是「至少一个到达」。
批量操作的成功判定必须区分 all / any，并为 partial 设计显式的续做路径。

### Metadata
- Source: code_review
- Related Files: src/lib/auto-update.ts, src/lib/types.ts
- Recurrence-Count: 1
---

## [LRN-20260826-003] correction

**Status**: resolved
**Area**: backend
**Pattern-Key**: scope.missing.in.destructive.op

### Summary
破坏性操作缺少作用域参数时，默认行为往往是「全量」——影响面远超预期。

### Details
rotateUUIDAndDeploy 不接收 accountIds，于是熔断时 `coreDeployLogic` 遍历所有账号，
一个账号超限导致**全部**账号的 UUID 被换掉，所有用户订阅链接同时失效。
根因是数据模型：VARS_<type> 是全局单份，UUID 无法按账号区分。

**修复**: 新增账号级覆盖键 `VARS_<type>_ACC_<accountId>`（读取时账号级优先、回落全局），
函数签名强制要求非空 accountIds，空数组直接拒绝并记 warning。
测试断言「只对目标账号发起 PUT 请求」。

**教训**: 破坏性函数的作用域参数应当是**必填**而非可选，让「忘记传」变成编译期或
运行期的显式失败，而不是静默的全量执行。

### Metadata
- Source: code_review
- Related Files: src/lib/auto-update.ts, src/cron.ts, src/config/templates.ts
- Recurrence-Count: 1
---

## [LRN-20260826-004] error

**Status**: resolved
**Area**: testing
**Pattern-Key**: test.inlines.logic.under.test

### Summary
在测试文件里复刻一份被测逻辑，等于测试自己写的副本——永远不会因源码改动而失败。

### Details
kv-utils.test.ts 与 audit-regression.test.ts 把 mergeVariableBindings、writeAccounts 的
key 决策、restore 白名单判定等逻辑在测试内部重写一遍（注释理由是「避免 CF Workers
运行时依赖」），然后测这份副本。70 个「全部通过」里这部分毫无保护作用：
改坏 src/ 里的真实实现，测试照样全绿。

**修复**: 新增 test/helpers.ts 提供语义完整的内存 KV mock（含 list 前缀过滤、
expirationTtl 记录）、CF 响应构造器、stubFetch 请求桩。所有测试改为 import 真实模块。
auth-security.test.ts 本来就是真 import 的，证明技术上一直可行。测试数 70 → 320。

**教训**: 「避免运行时依赖」的正确解法是给依赖做 mock，不是给被测代码做副本。
判断标准很简单：故意改坏源码，测试是否会失败？

### Metadata
- Source: code_review
- Related Files: test/helpers.ts, test/*.test.ts
- Recurrence-Count: 1
---

## [LRN-20260826-005] error

**Status**: resolved
**Area**: frontend
**Pattern-Key**: window.export.value.snapshot

### Summary
`window.x = x`（x 是模块顶层 let）导出的是初始化时的**值快照**，之后重新赋值不会同步。

### Details
state.js 里 `let accounts = []` 后 `window.accounts = accounts`。init() 中
`accounts = d.accounts` 重新绑定的是局部变量，window.accounts 永远指向那个初始空数组。
当前能正常工作纯粹因为拼接后所有文件共享同一作用域、直接引用局部变量——
任何人真按 window.accounts 写代码就是 bug。

**修复**: 改为单一 `state` 对象持有所有可变字段，配 `Object.defineProperties`
提供访问器形式的兼容别名，读写都落到同一份引用。verify.js 加检测规则防回归。

**教训**: 跨文件共享可变状态要么用对象（引用稳定），要么用 getter/setter。
直接导出原始值等于导出一个已过期的副本。

### Metadata
- Source: code_review
- Related Files: frontend/js/state.js, verify.js
- Recurrence-Count: 1
---

## [LRN-20260826-006] best_practice

**Status**: resolved
**Area**: build
**Pattern-Key**: floating.tag.breaks.reproducible.build

### Summary
构建时从浮动 tag 下载依赖并内联进产物，等于每次构建都可能得到不同代码。

### Details
build.js 从 `https://cdn.jsdelivr.net/npm/sweetalert2@11` 下载并把内容直接内联进
worker.js，没有版本 pin、没有 hash 校验。上游发新版就静默变更产物内容，
也是一条供应链攻击面。

**修复**: sweetalert2 加入 pinned devDependency（11.14.5），优先从 node_modules 读取；
仅在缺失时回退到**带明确版本号**的 CDN，并打印 SHA-256 供比对。

**教训**: 进入构建产物的任何第三方代码都应来自 lockfile 管理的依赖。
网络下载即使必要，也必须 pin 版本 + 记录校验值。

### Metadata
- Source: code_review
- Related Files: build.js, package.json
- Recurrence-Count: 1
---

## [LRN-20260826-007] best_practice

**Status**: resolved
**Area**: build
**Pattern-Key**: manifest.duplicated.from.source.of.truth

### Summary
校验脚本硬编码文件清单，与真实构建输入是两份独立数据，必然漂移。

### Details
verify.js 维护 43 条硬编码路径，build.js 另有一份 jsFiles 数组。
CHANGELOG 记录过一次「verify.js 清单同步」——就是漂移的证据。
更糟的是：新增前端文件但忘记加进 build.js 的 jsFiles，verify 完全检测不出来，
该文件会被静默排除在 bundle 之外。

**修复**: verify.js 后端文件递归扫 src/，前端文件从 build.js 的 jsFiles 数组解析
（单一真相源），并**反向检查** frontend/js 下存在但未被引用的孤儿文件。

**教训**: 校验脚本应当从真相源派生清单，而不是复制一份。
双向检查（清单→文件、文件→清单）才能同时防住漏删与漏加。

### Metadata
- Source: code_review
- Related Files: verify.js, build.js
- Recurrence-Count: 1
---

## [LRN-20260826-008] error

**Status**: resolved
**Area**: backend
**Pattern-Key**: res.json.without.ok.check

### Summary
不判 `res.ok` 直接 `await res.json()`：上游返回 HTML 错误页时抛 TypeError，
被外层 catch 吞掉后只剩一句零信息的「xxx failed」。

### Details
zones / yxip / deploy 多处存在。CF 限流或网关错误返回 HTML，json() 抛
「Unexpected token '<'」，catch 里 logger 记的是这个无关错误，返回给前端的是
「handleGetAllWorkers failed」——排障时完全不知道真实原因是 403 还是 502。
yxip 更严重：把 503 的 HTML 当节点列表解析后返回 success:true + 空数据。

**修复**: 新增 readApiJson / readApiResult 统一解析：非 2xx 抛出带 CF
`errors[0].message` 的 Error，2xx 非 JSON 也明确报错。verify.js 加反模式扫描，
把未经 try/catch 兜底的裸 res.json() 列为 error 级别。

**教训**: 错误消息的价值在于指向根因。吞掉上游状态码等于把可诊断故障变成谜题。
静态扫描能防住这类模式的回归。

### Metadata
- Source: code_review
- Related Files: src/lib/cloudflare-api.ts, src/routes/zones.ts, src/routes/yxip.ts, verify.js
- Recurrence-Count: 1
---

## [LRN-20260826-009] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: retry.sleep.before.first.attempt

### Summary
退避重试的 sleep 必须放在**重试之前**，不是每次尝试之前。

### Details
fix1101 写作 `for (attempt...) { await sleep(2000 * 2^attempt); upload(); }`，
于是首次即可成功也要先干等 2 秒；三次全失败等 14 秒；且对每个 Worker 都如此。

**修复**: `for (attempt...) { if (attempt > 0) await sleep(base * 2^(attempt-1)); upload(); }`，
CF 异步删除所需的固定等待单独前置一次（1.5s）。测试断言成功路径耗时上限。

**教训**: 退避是失败后的补偿，不是操作的前置代价。
把等待写进循环头部时要检查 attempt === 0 的分支。

### Metadata
- Source: code_review
- Related Files: src/routes/fix1101.ts
- Recurrence-Count: 1
---

## [LRN-20260826-010] best_practice

**Status**: resolved
**Area**: frontend
**Pattern-Key**: inline.handlers.block.csp.hardening

### Summary
HTML 内联 onclick 强制 CSP 保留 `script-src 'unsafe-inline'`，事件委托可彻底移除它。

### Details
index.html 有 47 个 onclick + 6 个 onchange，加上整个前端 JS 内联在 <script> 里，
使得 CSP 必须开 unsafe-inline，XSS 防护形同虚设；同时主 HTML 约 290KB 且 no-store，
每次刷新全量重传。

**修复**: 前端拆为 /app.js、/app.css（?v=version + immutable 长缓存），
所有内联处理器改为 `data-act` / `data-act-change` + 事件委托注册表，
参数走 `data-args` JSON（不存在字符串拼接注入）。登录页的内联脚本改用一次性 nonce。
verify.js 检查：无内联处理器、data-act 与 registerActions 双向对齐、CSP 无 unsafe-inline。

**教训**: CSP 收紧的阻碍通常不是「安全需求」而是「代码组织方式」。
事件委托 + 外部资源是同时改善安全与性能的一处改动。

### Metadata
- Source: code_review
- Related Files: frontend/index.html, frontend/js/dom.js, src/index.ts, src/config/login-html.ts
- Recurrence-Count: 1
---

## [LRN-20260826-011] error

**Status**: resolved
**Area**: frontend
**Pattern-Key**: css.escape.leftover.from.template.literal

### Summary
CSS 从「内联进模板字面量」改为「独立文件」时，转义层级会多一层。

### Details
style.css 里写着 `.hover\\:bg-indigo-100` —— 双反斜杠是 CSS 曾被嵌在 JS 模板字面量
里时的正确写法。作为独立 .css 文件供给浏览器后，该选择器语法非法，整条规则静默失效。

**修复**: 改为单反斜杠 `.hover\:bg-indigo-100`。

**教训**: 迁移嵌入式资源到独立文件时，要重新审视所有转义序列。
这类失效不报错、不警告，只是样式默默不生效。

### Metadata
- Source: code_review
- Related Files: frontend/css/style.css
- Recurrence-Count: 1
---

## [LRN-20260826-012] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: compatibility.date.must.be.pinned

### Summary
上传被管理 Worker 时 `compatibility_date` 用「今天」会引入未验证的运行时变更。

### Details
deploy-utils 的 getCompatibilityDate() 返回 `new Date().toISOString().split('T')[0]`，
意味着每次部署用户的代理 Worker 都换一个兼容日期，可能触发未测试的 workerd 行为变更；
日期超出目标账号支持范围时上传直接被拒。

**修复**: 改为固定常量 MANAGED_WORKER_COMPATIBILITY_DATE，附注释说明升级前须先验证。

**教训**: 兼容性/版本类参数取「当前时间」是把不确定性写进产物。
这类值应当是显式的、经过验证的常量。

### Metadata
- Source: code_review
- Related Files: src/lib/deploy-utils.ts
- Recurrence-Count: 1
---

## [LRN-20260826-013] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: exported.but.never.wired

### Summary
「已实现并导出但从未被调用」的基础设施等于零价值，还会误导后续维护者。

### Details
withErrorBoundary 在 register.ts 定义并导出，但注册路由时没有任何地方套用；
异常靠 index.ts 顶层 catch 兜住，代价是丢了 routeName 上下文。
更具误导性的是它的测试——测的是测试文件里内联复刻的另一份实现。

**修复**: 统一在 route() 注册函数里包装，并对重复注册直接抛错（而非静默覆盖）；
测试改为 import 真实实现。

**教训**: 定期检查导出符号的实际引用数。导出而未使用的「安全网」比没有网更危险，
因为它让人以为有网。

### Metadata
- Source: code_review
- Related Files: src/routes/register.ts, test/kv-utils.test.ts
- Recurrence-Count: 1
---

## [LRN-20260826-014] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: concurrency.two.extremes

### Summary
同一项目里并存「全串行」与「全并发」两个极端，说明缺少统一的并发抽象。

### Details
coreDeployLogic 串行遍历账号（账号多必然超 CPU 时间），handleBatchDeploy 用
Promise.allSettled 全并发（易撞 CF 1200 次/5 分钟限流与 1000 subrequest 上限），
verify_credentials 又手写了一份 BATCH_SIZE=5 的分批逻辑。三种策略、三处实现。

**修复**: 抽 lib/concurrency.ts 的 pooledMap / pooledMapSettled（默认并发 5），
四处调用点统一使用。测试验证并发上限与结果顺序。

**教训**: 看到同类操作在不同文件里有不同并发策略，先抽象再优化。
上游限流是全局约束，并发策略也应当全局一致。

### Metadata
- Source: code_review
- Related Files: src/lib/concurrency.ts, src/lib/auto-update.ts, src/routes/deploy.ts, src/routes/crud.ts
- Recurrence-Count: 1
---

## [LRN-20260826-015] best_practice

**Status**: resolved
**Area**: frontend
**Pattern-Key**: idempotent.init.needs.guard

### Summary
会被多处触发的初始化函数必须自带幂等守卫，否则重复注册监听与动画循环。

### Details
initStarfield 被 toggleTheme、visibilitychange、系统主题变化三处调用，
每次都 addEventListener('resize') 并额外启动一个 requestAnimationFrame 循环。
主题切换几次后就有多个循环同时绘制，越切越卡。

**修复**: 场景构建与动画启动分离，场景只建一次（监听只注册一次），
initStarfield 在 starAnimId 非空时直接返回。

**教训**: 任何可能被多次调用的 init 都要问「第二次调用会发生什么」。
资源注册（监听器、定时器、rAF）尤其需要幂等或显式清理。

### Metadata
- Source: code_review
- Related Files: frontend/js/starfield.js
- Recurrence-Count: 1
---

## [LRN-20260826-016] error

**Status**: resolved
**Area**: infra
**Pattern-Key**: ci.package.manager.mismatch.lockfile

### Summary
CI 用的包管理器必须与仓库里的 lockfile 匹配，否则第一次运行就在依赖安装步失败。

### Details
仓库只有 pnpm-lock.yaml，但 install.bat 与首版 CI 都写 `npm install` / `npm ci`。
CI 报错：`Dependencies lock file is not found ... Supported file patterns:
package-lock.json, npm-shrinkwrap.json, yarn.lock`——actions/setup-node 的
`cache: 'npm'` 找不到 npm 系 lockfile 直接 fail。

更隐蔽的是本地：`npm install` 会**忽略** pnpm-lock.yaml 重新解析版本，
于是「本地能过」与「锁定的版本」根本不是同一套依赖，可复现性形同虚设。

**修复**:
- CI 改为 pnpm/action-setup@v4 + setup-node 的 `cache: 'pnpm'`
  （pnpm 必须先装，setup-node 才能解析 store 路径）
- install.bat / check.bat / wrangler.local.toml 的 build 命令统一到 pnpm
- package.json 加 `packageManager: pnpm@<version>`，让 corepack 与 CI 锁同一版本
- 顺带发现 lockfile 缺了两个 devDependency，`--frozen-lockfile` 会失败——
  说明之前从没在「锁定模式」下装过

**教训**: lockfile 是包管理器的选择声明。仓库里有哪个 lockfile，
所有入口（本地脚本、CI、构建钩子）就都得用对应的包管理器，不能混用。

### Metadata
- Source: error
- Related Files: .github/workflows/ci.yml, install.bat, check.bat, package.json, pnpm-lock.yaml
- Recurrence-Count: 1
---

## [LRN-20260826-017] best_practice

**Status**: resolved
**Area**: infra
**Pattern-Key**: github.action.node20.deprecated

### Summary
GitHub Actions 的 Node 20 runtime 已弃用，旧 major 版本的 action 会持续告警。

### Details
CI 日志开头：`Node 20 is being deprecated. This workflow is running with
Node 24 by default.`（见 GitHub 2025-09-19 变更公告）。actions/checkout@v4 与
actions/setup-node@v4 声明的是 node20 runtime。

**修复**: 升级到 actions/checkout@v5 + actions/setup-node@v6。

**教训**: runner 侧的 runtime 弃用会波及所有 action 的 major 版本。
看到这类平台级告警就一次性把 action 版本抬上去，别逐个等它变成硬错误。

### Metadata
- Source: error
- Related Files: .github/workflows/ci.yml
- Recurrence-Count: 1
---

## [LRN-20260826-018] best_practice

**Status**: resolved
**Area**: build
**Pattern-Key**: verify.ci.locally.before.trusting

### Summary
本地校验通过不等于 CI 通过：环境、包管理器、Node 版本、平台二进制都可能不同。

### Details
V12.0.0 本地 build/typecheck/verify/323 测试全绿就推送了，CI 第一步就挂——
本地用 pnpm 装的 node_modules，CI 却被写成 npm。这类差异本地永远测不出来。

**修复**: 推送前在本地按 CI 的确切命令跑一遍
（`pnpm install --frozen-lockfile --ignore-scripts` 而非平时的 `pnpm install`），
并确认 lockfile 里有目标平台的可选依赖（@esbuild/linux-x64 等）。
CI 里加一步 `git diff --quiet` 确认构建过程没改动被跟踪文件。

**教训**: 首次引入 CI 时，先在本地模拟它的**确切**命令序列，
尤其是 install 命令的 flag——`install` 与 `install --frozen-lockfile`
是两种不同的行为。

### Metadata
- Source: error
- Related Files: .github/workflows/ci.yml
- Recurrence-Count: 1
