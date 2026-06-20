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
