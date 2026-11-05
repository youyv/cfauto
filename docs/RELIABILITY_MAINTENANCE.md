# 权威模式维护协议

本文是当前协议入口说明，适用于 V12.2.1。安装/升级看[运维指南](OPERATIONS.md)，内部结构看[架构](ARCHITECTURE.md)。它不替代实例自己的密钥、来源证明或历史操作回执。

## 1. 维护入口与普通页面的区别

- 公网入口：`POST /api/reliability/maintenance`。
- 请求由独立维护密钥签名；浏览器 Cookie、ACCESS_CODE 和内部 RPC key 都不能替代。
- Worker 转发原签名，Global DO 再校验安装身份、物理对象、角色和时间窗。
- 未配置 `RELIABILITY_MAINTENANCE_KEYS` 时维护入口不可用，不会退回页面管理员权限。

请求绑定完整 account / worker / namespace、operator、command、时间和 nonce。正文有大小限制，未知字段或不支持的 action 会被拒绝。

## 2. 角色

每个 operator 具有独立 Secret 和显式权限列表，无通配 root 权限。

| 权限 | 主要操作 |
| --- | --- |
| `inspect` | status、audit、audit_list、drain_inspect、review_candidates、admission_list，以及代际/首次导入的状态读取 |
| `maintain` | set_maintenance |
| `drain` | drain_begin / drain_advance / drain_release |
| `review` | review_observe：读取外部状态和证据 |
| `attest` | review_attest：提交明确的人工证明 |
| `adjudicate` | review_close_failed：受约束裁决 |
| `recover` | admission_recover：恢复已有完整接纳记录 |
| `archive` | 归档、账户归档、归档传输 |
| `migrate` | generation / initial 的准备与导入 |
| `activate` | generation_activate / initial_activate |

角色不自动继承其他权限。维护 key、RPC key、幂等/证据 key、凭据/快照 key 之间不得复用。配置要求规范 JSON，不能用有重复字段的 JSON 绕过检查。

## 3. 稳定命令与回执

命令形状：

```json
{
  "id": "inspect_001",
  "action": "status",
  "expected": null,
  "args": {}
}
```

有状态变更时 `expected` 一般包含当前 `generation`、`epoch` 和 `maintenance`（0/1）；字段与允许值由 `src/reliability/maintenance-protocol.ts` 校验。

同一个 id 只能对应同一个 operator、目标和意图。丢失响应后核对原命令及回执；按原意图重放时仅更新签名时间/nonce，不能偷偷改参数。收到 409 先读取新状态。

### 一个只读 status 示例

管理员在受限目录准备：

- `.wrangler/operator/profile.json`：endpoint、operator、secret、target。
- `.wrangler/operator/status.json`：上面的 status 命令。

profile 形状如下；中文占位值由管理员换成自己实例的值：

```json
{
  "endpoint": "https://panel.example.com/api/reliability/maintenance",
  "operator": "reader",
  "secret": "对应reader已配置的独立64位小写hex",
  "target": {
    "account": "真实32位AccountID",
    "worker": "真实中控Worker名称",
    "namespace": "真实CONFIG_KV_ID"
  }
}
```

profile 的 operator 必须已有 `inspect` 权限。文件和父目录均需满足工具的私有权限检查；Windows 检查 ACL，POSIX 检查 owner 与权限位。不能通过修改校验函数绕过。

```powershell
node scripts/maintenance-client.cjs --profile .wrangler/operator/profile.json --intent .wrangler/operator/status.json --out .wrangler/status-001
```

输出目录必须是新的。正常输出包含 `acknowledged: true`；具体状态在新证据目录的 `response.bin`。不要把 profile 或原始响应发到公开 issue。

读取会产生维护审计回执，但不会释放 unknown、关闭维护窗口、执行业务写入或证明旧请求已排空。

## 4. 维护和排空

`set_maintenance` 是带版本基线的状态转换。进入维护阻止新的业务写入，但并不证明所有在途请求已经结束。

`drain_begin`、`drain_advance`、`drain_inspect` 和 `drain_release` 使用持久 challenge 与账号回执。需要分别核对任务、进度、取消、通知、未知结果等阻塞项。不能仅凭“等了一段时间”宣告排空。

改变维护状态和释放排空证明会影响后续恢复/激活校验；按同一操作计划继续，不重新制造另一组历史。

## 5. unknown 的只读观察与人工裁决

外部写请求超时可能已经执行成功。`unknown` 保留账号串行屏障和全局许可，不能自动重发。

处理顺序：

1. `review_candidates` 找到待核对目标。
2. `review_observe` 读取对应步骤/HTTP 调用的原始证据与当前外部状态。
3. 有权限的证明者提交 `review_attest`。
4. 有权限的裁决者在要求的维护状态下提交 `review_close_failed`。
5. 保留签名回执、原任务、观察信息和结果，不把人工结案描述成机器验证成功。

具体 action 参数必须来自已检查的任务/调用记录，不在本页提供可误用的“强制解锁”请求。`OPERATOR_CLOSED_UNCONFIRMED` 会明确显示人工裁决，不能作为部署成功依据。

## 6. 接纳恢复

`admission_list` 列出接纳阶段的不完整项；`admission_recover` 只恢复已有完整、认证的冻结材料。

缺失完整 manifest 时不能重新选择 latest、生成新 UUID 或重做另一份计划。接纳恢复不是执行未知外部写的重试按钮。

## 7. 归档与代际恢复

- `archive_*` 管理受认证的归档及分帧传输。
- `account_archive` / `archive_accounts` 收集账户范围材料。
- `generation_begin/resume/inspect` 准备 inactive generation。
- `generation_activate` 在相应证明和权限下原子切换。
- `initial_*` 用于首次来源、导入和激活，有独立 pin 和严格的空代际约束。

归档完整性、来源身份、捕获时的代际/epoch、账号清单和 key 引用需要一起验证。离线摘要不会自动证明现场仍排空。

浏览器账号导入导出与完整权威归档不是同一能力；旧 KV 备份不能作为当前 DO 活动数据的直接恢复入口。

## 8. 维护工具索引

| 文件 | 用途 |
| --- | --- |
| `scripts/maintenance-client.cjs` | 独立签名、单次请求、私有证据 |
| `scripts/archive-bundle-client.cjs` / `archive-bundle-upload.cjs` | 归档收集与上传 |
| `scripts/initial-cutover-client.cjs` | 首次来源和导入协议 |
| `scripts/prepare-recovery.cjs` | 恢复准备 |
| `scripts/release-journal.cjs` | 运维操作身份及未知结果记录 |
| `src/reliability/maintenance-protocol.ts` | action、角色、字段和签名合同 |
| `src/reliability/maintenance-service.ts` | 维护执行与幂等回执 |

历史部署会话、原始证据、恢复库和本地密钥不在公开仓库。不要把仓库测试夹具、作者的固定隔离目标或缺失的历史路径当成自己实例的配置。
