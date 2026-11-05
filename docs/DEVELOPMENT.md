# 开发与验证

## 1. 环境

- Node.js 24，本版本使用 24.19.0；测试需要 `node:sqlite`。
- pnpm 11.22.0，版本由 `package.json` 的 `packageManager` 声明。
- 使用仓库锁文件 `pnpm-lock.yaml`，不新增 npm/yarn 锁文件。

```powershell
git clone https://github.com/youyv/cfauto.git
Set-Location .\cfauto
pnpm.cmd install --frozen-lockfile --ignore-scripts
node scripts/check.cjs
```

macOS / Linux 使用 `pnpm` 和 `cd cfauto`。如果依赖安装要求删除已有目录，先确认 Node / pnpm 和锁文件是否匹配。

## 2. 一次完整检查

```powershell
node scripts/check.cjs
```

顺序为 **build → typecheck → verify → 全量 Vitest**。构建先生成 `src/frontend-bundle.ts`，所以全新克隆不能把类型检查放在构建之前。

需要验证 DO 重启恢复时，直接改用下面的入口，不要先重复跑一遍普通 check：

```powershell
node scripts/check.cjs --runtime --evidence .wrangler/check-development-001
```

目录必须不存在。默认运行 9 次真实进程重启；完整 35 次覆盖可在 PowerShell 中设置：

```powershell
$env:RELIABILITY_RUNTIME_FULL_RESTARTS = '1'
node scripts/check.cjs --runtime --evidence .wrangler/check-development-full-001
Remove-Item Env:\RELIABILITY_RUNTIME_FULL_RESTARTS
```

只有检查真正完成并生成对应报告才能判定通过。不会部署或自动安装依赖。`releaseAllowed:false` 保留本地验证的范围。

## 3. 按范围快速反馈

| 命令 | 覆盖 |
| --- | --- |
| `node scripts/test-scope.cjs run frontend` | UI、草稿、配置/任务协议、账号导入导出 |
| `node scripts/test-scope.cjs run core` | 认证、路由、公共逻辑、诊断、追踪 |
| `node scripts/test-scope.cjs run operations` | 发布/恢复工具和证据合同 |
| `node scripts/test-scope.cjs run reliability` | 配置事务、队列、凭据、归档、恢复 |
| `node node_modules/typescript/bin/tsc --noEmit` | 已构建后的 TypeScript 检查 |
| `node verify.js` | 模块、动作、路由、CSP、构建身份等静态检查 |

专项测试用于改动反馈，不能代替上线前完整检查。

`test/suites.json` 必须完整、唯一登记全部 `*.test.ts`。新增测试文件要同步登记；不要通过漏登、skip 或 only 缩小门槛。

## 4. 本地运行

默认 `wrangler.toml` 是占位模板，直接 `pnpm dev` 不会自动准备 KV、密钥或活动 DO 数据。

- 前端流程：使用下方 mock 浏览器测试。
- KV 兼容链路：用[新手模板](../wrangler.legacy.example.toml)，本地 KV 与测试凭据，显式 `wrangler dev --local`。
- 权威模式：运行 `scripts/test-reliability-runtime.cjs`，使用 `test/fixtures/reliability` 中独立的测试 Worker、数据库和合成凭据。

测试夹具包含仅本地使用的 bootstrap/probe 能力，不能部署到生产。

本版本本地 workerd 二进制支持的最新日期为 `2026-07-07`；生产中控配置使用 `2026-07-16`。本地提示不支持兼容日期时，用真实 DO 测试夹具中的已验证配置，或只对本地 smoke 使用 `--compatibility-date 2026-07-07`。不要顺手更改生产兼容日期。平台实际支持范围与本地模拟器版本不同。

## 5. 浏览器测试

本地首次安装浏览器：

```powershell
pnpm.cmd exec playwright install chromium --only-shell
pnpm.cmd test:e2e
```

也可使用 `pnpm.cmd exec playwright ...`。测试使用 `test/e2e/server.cjs` 提供的 mock API，不连接真实业务账号。

跨浏览器：

```powershell
pnpm.cmd exec playwright install firefox webkit
pnpm.cmd exec playwright test -c playwright.cross-browser.config.cjs
```

当前 CI 在 push / PR 中执行普通 check，并运行 Chromium 和跨引擎 mock 浏览器测试；默认本地 `check` 不运行浏览器。workflow 中的 `browser_regression` 输入目前只用于失败证据上传条件，不是测试步骤的开关。后续若调整，以 `.github/workflows/ci.yml` 为准。

## 6. 构建身份和发布

`build.js` 输出：

- `src/frontend-bundle.ts`：生成的前端常量，勿手改。
- `dist/worker.js`：可部署脚本。
- `dist/build-manifest.json`：版本、Git 提交/dirty、源码摘要、实际 Worker 摘要。

重新提交 Git 后，Build ID 会变化，即使业务代码没改。不要用旧候选的报告证明新候选已验收，也不要把“提交成功”等同于“上线成功”。

## 7. 代码组织约定

前端纯逻辑放 `frontend/modules/`，通过显式入口打包；已有 `frontend/js/` 仍按 `build.js` 指定顺序共享作用域。新模块必须被入口引用，孤立文件会导致构建失败。UI 约定见[UI 文档](UI_CONVENTIONS.md)。

后端新增能力优先沿现有配置/任务链扩展；读接口不要悄悄写配置或创建外部任务。数据层调整应覆盖历史记录、CAS、unknown 屏障和重启恢复。

## 8. 清理和提交

```powershell
# 预览可再生成文件，不删除
pwsh -NoProfile -File scripts/clean-local.ps1
```

需要删除时先核对脚本列出的实际路径，再使用 `-Apply`。不要删除整个 `.wrangler/`、私有恢复库或任务证据来节省空间。

推送前检查：

```powershell
git status --short
git diff --check
git diff --cached --stat
```

确认 staged 内容只有源码、测试和公开文档。`.wrangler`、个人配置与密钥不能提交。提交和推送不会重新部署 Cloudflare。
