# 开发与测试

## 环境

- Node 需要支持 `node:sqlite`（本项目使用 Node 24.19.0 验证；CI 使用 Node 22）。
- 包管理器：`pnpm@11.22.0`；依赖以 `pnpm-lock.yaml` 为准。
- 不需要数据库、Redis 或 Workers 生产凭据即可完成本地构建与测试。

```powershell
pnpm install
node scripts/check.cjs
```

## 唯一完整门槛

`node scripts/check.cjs` 固定顺序执行一次：

1. **build**：`node build.js` 生成 `src/frontend-bundle.ts` 与 `dist/worker.js`，再写 `dist/build-manifest.json`。
2. **typecheck**：`tsc --noEmit`。
3. **verify**：`node verify.js`（构建清单/版本一致、路由与动作注册、HTML id 消费、CSP、反模式、批处理脚本等）。
4. **full**：Vitest 全量运行（`test/suites.json` 清单与实际文件一一对应，不允许 `only`/过滤/空跑）。

`pnpm check`、Windows `check.bat` 和 CI 都调用同一个入口；不要逐项跑完后再跑一次 check。

```powershell
# 同一次完整检查 + 真实本地 DO 进程重启；证据目录必须不存在
node scripts/check.cjs --runtime --evidence .wrangler/check-new-id
```

`--runtime` 已包含普通检查，不要再先跑普通 check。默认 runtime 做 **9 次真实进程重启**（9 个具名恢复 checkpoint + 大源码场景前内存复位），其余场景合并到同一进程代；设置 `RELIABILITY_RUNTIME_FULL_RESTARTS=1` 可跑完整 **35 次**。门禁只校验实际重启次数与 checkpoint 单调性，不硬编码历史数字。

## 按改动范围快速反馈

| 命令 | 场景 | 能代替完整门槛吗 |
|---|---|---|
| `node scripts/test-scope.cjs run frontend` | UI、前端协议、任务面板 | 否 |
| `node scripts/test-scope.cjs run core` | 路由、认证、公共工具 | 否 |
| `node scripts/test-scope.cjs run operations` | 公开的发布/证据解析/安全路径工具 | 否 |
| `node scripts/test-scope.cjs run reliability` | DO、事务、凭据、队列、归档、未知结果 | 否 |
| `node scripts/check.cjs` | 完整本地检查 | 仍不等于可上线 |

本公开仓库的清单为 **95 个测试文件 / 约 1,700 项**（core 15、frontend 6、operations 10、reliability 64）。生产验收、隔离升级、恢复与维护类内部工具和测试不在公开范围内；本地私有工作区可另行运行它们。

## 测试组织

- `test/suites.json` 是唯一测试清单；`scripts/test-scope.cjs` 扫描实际文件并要求一一对应，遗漏/重复/空组/越界都会失败。
- `test/reliability/*` 覆盖配置 CAS、任务接纳/规划/执行、账号队列、写前日志、unknown 屏障、凭据 v2、密封存储、大源码、归档/代际/维护、自动检查等。
- 前端测试使用 VM/静态源码检查，不启动真实浏览器；Playwright mock 回归为可选源码，不是生产验收。
- 真实本地 DO 测试使用隔离临时目录 + 随机端口起停 `wrangler dev --local`，验证重启后的持久化与恢复；不连接生产。

## 构建身份

- `build.js` 打包前生成 `src/frontend-bundle.ts`；`assets` 使用内容寻址版本（`V<version>.<8位内容哈希>`），避免长缓存不更新。
- `scripts/build-info.cjs` 收集白名单源输入（src/frontend/build 配置/锁文件）的路径+长度哈希，生成：
  - `BUILD_INFO`：版本、Git commit、dirty 状态、源输入 SHA256、Build ID；
  - `dist/build-manifest.json`：Asset 版本、Worker 字节数与 SHA256。
- Build ID 只表示“本次响应所用构建身份”，**不代表已推送或已部署**。生产状态需单独回读 Cloudflare 控制面。
- `wrangler.toml` 是占位模板：`main = "dist/worker.js"`、固定 `compatibility_date`、`[build] node build.js`。真实账号/绑定/Secret 不要提交。

## CI 与浏览器

- 仓库 `.github/workflows/ci.yml` 按 push/PR 运行完整检查；可选 mock 浏览器回归使用 Playwright，依赖安装在 CI 内完成。
- 浏览器 mock 回归不是生产验收；A5/真实浏览器/线上业务验收需要单独执行并记录。

## 安全清理

```powershell
pwsh -NoProfile -File scripts/clean-local.ps1           # 预览
pwsh -NoProfile -File scripts/clean-local.ps1 -Apply    # 仅清理列明的可再生成缓存
```

清理器只删除工作区内已解析核验的白名单缓存，不会碰 `.git`、`node_modules`、`.wrangler` 私有证据或生产归档。

## 提交卫生

- 不提交 `wrangler.local.toml`、`.wrangler/`、部署 Token、账号导出文件、恢复快照或本地绝对路径。
- 提交前可运行 `node verify.js` 与 `git diff --cached`，确认没有新增敏感字面量。
