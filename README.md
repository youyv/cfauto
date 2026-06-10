# 🚀 Cloudflare Worker 智能部署中控 (V10.10.0)

> 全部代码为 Claude Code 完成
> 自行修改延伸功能

> **版本状态**: V10.10.0 Stable
> **核心进化**: 内置 `yxip` 全球优选下发 + CMLiu KV直写 + Joey 双轨制并存(KV直接下发/全局架构变量覆写)。

本项目是一个基于 Cloudflare Worker 构建的深度集成化部署管理平台。它不仅能管理多个 Cloudflare 账号，还支持一键批量部署、版本回滚、自动化流量熔断以及代码级的混淆加固，是管理大规模 Worker 节点的终极工具。

---

## 🆕 V10.10.0 更新日志

### ⚡ 反代落地部署再升级 (YXIP Improvements)

* 中控台全新加入 **“⚡ 反代落地部署”** 功能按钮。
* 复刻原 `yxip.js` 功能逻辑：全屏模态框操作，直连上游获取全球国家/地区 CF 节点池，支持按地区分组摇号随机筛选。
* **CMLiu 专有强力直写**：选中账号后系统自动提取对应绑定关系并跨域操作目标原数据流空间 KV，将最新优质节点数据直接一键 PUT 写入为目标自带的 `ADD.txt`，自动接管应用内部解析。
* **Joey 双轨下发并存**：采用全新的兼容逻辑以充分满足不同版本组件架构的使用：
  1. **KV 模式 (默认推荐)**：精准识别目标大写 `C` 数据库命名，采用特定最新字段序列强效 JSON 下发。
  2. **兼容变量模式**：无缝向下面向未绑定任何独立数据库版本的项目，退避使用传统的全局核心词 `yx` 变量统一覆盖所有中控保留项！

### 📋 完整历史版本

> 见 [CHANGELOG.md](CHANGELOG.md)。

---

## ✨ 核心特性

### 🔧 一键修复 1101

* **全自动修复流程**：记录变量绑定 + 自定义域名 → 删除 Worker → 随机改子域名 → 用相同名称重建 → 恢复所有变量值 + 域名。
* **变量完整保留**：plain_text 变量值、KV 绑定引用全部恢复，Worker 名称不变。

### 🛡️ 流量熔断与自动轮换 (Auto Fuse)

* **实时监控**：自动统计各账号当日总用量。
* **阈值熔断**：可设置用量百分比（如 90%）。一旦触发，系统自动执行 **UUID 随机轮换** 并 **强制混淆部署**，快速切换节点状态以应对封锁或超额。

### 📜 收藏夹管理 (Favorites System)

* **版本锚定**：支持从 GitHub 历史中挑选稳定版本并加入"收藏"。
* **一键回滚**：即使上游代码库更新失败或被删，你依然可以从收藏夹中一键恢复到曾经锁定的稳定状态。

### 🌐 子域名管理 (Subdomain Management)

* **实时查看**：在账号管理弹窗中直接展示当前 `xxx.workers.dev` 子域名。
* **在线修改**：一键修改子域名前缀，无需进入 Cloudflare 后台。
* **安全防护**：格式校验 + 二次确认，防止误操作。

### ⚡ 全球节点优选部署 (YXIP)

* **内建节点池**：在中控台无缝拉取、筛选、限制输出全球各大区域高速 Cloudflare 节点。
* **极速下发**：无需繁琐的配置订阅服务，可一键批量将节点池**强力覆写到绑定的 KV 空间 (`ADD.txt`) 或全局环境变量中**，与 `cmliu` 及 `joey` 分支项目深度耦合。

### 🌌 暗黑星空主题 (Starfield Theme)

* **动态星空**：Canvas 绘制闪烁星星 + 流星 + 星云光晕。
* **毛玻璃效果**：卡片半透明，透出星空背景。
* **一键切换**：🌙/☀️ 按钮切换，localStorage 持久化。

### 🔧 自动化运维

* **Zone 智能识别**：一键拉取账号下所有域名，支持自动化绑定自定义二级域名。
* **级联资源清理**：删除 Worker 时可选择同步清理关联的 KV 命名空间，拒绝资源浪费。

---

## 📖 核心操作说明

### 🛰️ 账号管理

* **添加账号**：需提供 `Account ID`、`Email` 和 `Global API Key`。
* **读取域名**：点击"读取"会自动填充该账号下的 Zone，用于后续的批量域名绑定。

### ✨ 批量部署 (Batch Deploy)

1. 点击顶部"批量部署"。
2. **选择模板**：支持 `CMliu` (EdgeTunnel)、`Joey` (相信光) 等主流模板。
3. **开启混淆**：勾选"启用代码混淆"，系统将通过前端加密后再上传。
4. **域名绑定**：输入前缀，系统会自动在所选账号的预设域名下生成子域名。

### 🌐 修改子域名

1. 点击账号右侧的「**📂 管理**」。
2. 弹窗顶部显示当前子域名（如 `myprefix.workers.dev`）。
3. 点击「**✏️ 修改**」，输入新的子域名前缀。
4. 经过二次确认后，系统调用 Cloudflare API 完成修改。

> ⚠️ 修改子域名可能需要数分钟生效，且会影响所有使用 `*.workers.dev` 域名的 Worker。

### 🌌 切换主题

1. Header 工具栏点击 **🌙** 按钮切换到暗黑星空模式。
2. 再次点击 **☀️** 按钮切换回明亮模式。
3. 选择自动保存，下次打开自动恢复。

---

## 🛠️ 部署教程 (保姆级)

只需简单 4 步，即可拥有自己的 Worker 中控台。

### 1️⃣ 第一步：创建主控 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Workers & Pages** -> **Overview** -> **Create Application** -> **Create Worker**。
3. 命名为 `manager` (建议)，点击 **Deploy**。
4. 点击 **Edit code**，将本项目提供的 `worker.js` (V10.3.0) **完整代码** 粘贴覆盖。
5. 点击 **Save and deploy**。

### 2️⃣ 第二步：绑定 KV 存储 (⚠️ 核心)

**中控本身需要一个 KV 来存储账号数据，不绑定无法启动！**

1. 在 Worker 编辑页面的 **Settings** (设置) -> **Variables** (变量)。
2. 找到 **KV Namespace Bindings**，点击 **Add binding**。
3. **Variable name**: 填写 `CONFIG_KV` (**必须大写，完全一致**)
4. **KV Namespace**: 点击 "Create new KV namespace"，命名为 `manager_data`，点击 **Add**。
5. 点击 **Save and deploy**。

### 3️⃣ 第三步：设置安全密码

1. 同样在 **Settings** -> **Variables** -> **Environment Variables**。
2. 点击 **Add variable**：
   * **Variable name**: `ACCESS_CODE`
   * **Value**: 设置你的登录密码（如 `admin888`）。

3. *(可选但推荐)* 防止 GitHub API 限流：
   * **Variable name**: `GITHUB_TOKEN`
   * **Value**: 你的 GitHub PAT (获取方式见下方 [GitHub Token 获取教程](#-github-token-获取教程图文))。

4. 点击 **Save and deploy**。

### 4️⃣ 第四步：配置 Cron 定时触发器（自动更新必需）

如果需要**自动检测更新**和**流量熔断**功能，必须配置 Cron Trigger：

1. 进入 Worker 的 **Settings** → **Triggers** → **Cron Triggers**。
2. 点击 **Add Cron Trigger**，输入 Cron 表达式，推荐 `*/5 * * * *`（每 5 分钟）。
3. 点击 **Save**。

#### ⏱️ 两层时间控制机制

系统有**两层**间隔控制，需要配合使用：

| 层级 | 配置位置 | 作用 |
|---|---|---|
| **Cron Trigger**（外层） | Cloudflare Dashboard → Triggers | 决定多久调用一次 `scheduled()` 函数 |
| **网站间隔**（内层） | 中控页面 Header 的 "XX 分" 输入框 | 在 Cron 触发后，距上次检查超过此间隔才真正执行 |

**流程**：`Cron 触发 → handleCronJob() → 检查网站间隔 → 超过则执行更新/跳过`

#### 推荐配置

| 场景 | Cron 表达式 | 网站间隔 | 说明 |
|---|---|---|---|
| 日常使用 | `*/5 * * * *` | 30 分 | 每 5 分钟触发，实际每 30 分钟检查一次 |
| 省资源 | `*/30 * * * *` | 30 分 | 触发和间隔一致，最省请求量 |
| 高频监控 | `*/1 * * * *` | 5 分 | 约 5 分钟检查一次，响应最快 |

> ⚠️ **注意**：Cron 间隔必须 ≤ 网站间隔才有意义。例如 Cron 设为每小时触发，网站设 5 分钟间隔是无效的——因为 `scheduled()` 本身一小时才被调用一次。

### 5️⃣ 第五步：开始使用

访问你的 Worker 域名（如 `https://manager.你的前缀.workers.dev`），输入密码即可进入控制台。

---

## 🔑 Cloudflare 账号信息获取教程（图文）

在添加账号时需要填写以下三项信息，全部在 Cloudflare Dashboard 中获取：

### 📧 Email (登录邮箱)

直接使用你注册 Cloudflare 时的邮箱地址。

### 🆔 Account ID (账号 ID)

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 登录成功后，看浏览器**地址栏** URL：
   ```
   https://dash.cloudflare.com/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
3. `dash.cloudflare.com/` 后面的那串 **32 位字符** 就是你的 `Account ID`。
4. **另一种方式**：点击左侧边栏任意一个域名 -> 右侧往下滚动 -> 找到 **API** 区域 -> 可以看到 `Account ID`，点击旁边的 **复制** 按钮即可。

> 💡 **提示**：每个 Cloudflare 账号有一个唯一的 Account ID，如果你有多个账号，需要分别获取。

### 🔐 Global API Key (全局 API 密钥)

> ⚠️ **重要**：必须使用 **Global API Key**，不能使用普通的 API Token！普通 Token 权限不足以创建 KV、绑定域名等操作。

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 点击页面**右上角头像** -> 选择 **My Profile** (我的个人资料)。
3. 在左侧菜单中选择 **API Tokens** (API 令牌)。
4. 页面下方找到 **API Keys** 区域（注意不是上方的 API Tokens）。
5. 找到 **Global API Key** 那一行，点击右侧的 **View** (查看) 按钮。
6. 系统会要求你输入 **Cloudflare 登录密码** + **hCaptcha 验证**。
7. 验证通过后会显示你的 Global API Key，**复制保存**。

> ⚠️ **安全提醒**：Global API Key 拥有你账号的最高权限，请妥善保管，切勿泄露。本中控将其加密存储在你自己的 KV 命名空间中。

---

## 🔑 GitHub Token 获取教程（图文）

### 为什么需要 GitHub Token？

中控会调用 GitHub API 来检查模板更新、拉取历史版本。**未配置 Token 时**，GitHub 对匿名请求限制为 **每小时 60 次**，在频繁检查更新或版本回滚时容易触发限流，导致功能异常。**配置 Token 后**，限额提升至 **每小时 5000 次**。

### 获取步骤

1. 登录 [GitHub](https://github.com/) 你的账号。

2. 点击页面**右上角头像** -> 选择 **Settings** (设置)。

3. 在左侧菜单中，滚动到最下方，找到 **Developer settings** (开发者设置) 并点击进入。

4. 在左侧菜单选择 **Personal access tokens** -> **Tokens (classic)**。

5. 点击右上角 **Generate new token** -> 选择 **Generate new token (classic)**。

6. 填写 Token 信息：
   * **Note** (备注)：随便写，如 `worker-manager`
   * **Expiration** (有效期)：建议选择 **No expiration** (永不过期)，或者根据需要选择
   * **Select scopes** (权限范围)：
     * 如果你只用**公共仓库**的模板（如 `cmliu/edgetunnel`），**不需要勾选任何权限**，全部留空即可！
     * 如果你需要访问**私有仓库**，则勾选 `repo` 权限

7. 滚动到页面底部，点击 **Generate token** (生成令牌)。

8. ⚠️ **重要**：生成后会显示一个以 `ghp_` 开头的字符串，**立即复制保存**！页面关闭后无法再次查看！

   ```
   ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

9. 将复制的 Token 填入 Worker 的环境变量 `GITHUB_TOKEN` 中（参见上方 [第三步：设置安全密码](#3️⃣-第三步设置安全密码)）。

> 💡 **提示**：如果 Token 过期或泄露，可以随时在 GitHub Settings -> Developer settings -> Personal access tokens 中删除旧的并重新生成。

---

## 📖 常用操作指南

### ✨ 批量部署新项目

1. 点击顶部「**✨ 批量部署**」。
2. **模板选择**：
   * `CMliu`: 经典 EdgeTunnel，建议开启 KV。
   * `Joey`: 推荐关闭 KV (取消勾选 "绑定 KV 存储")，使用纯变量模式。
3. **KV 设置**：如果开启 KV，请填写 KV 名称（中控会自动创建）。
4. **域名设置**：
   * 勾选 `禁用默认域名` 可提高隐蔽性。
   * 填写 `自定义域名` 前缀（前提：账号已读取到预设域名）。
5. 勾选目标账号 -> **🚀 开始部署**。

### 🔄 变量同步 (反向更新)

如果你在 Cloudflare 后台手动修改了某个 Worker 的变量：

1. 在中控面板找到该项目。
2. 点击「**🔄 同步**」。
3. 中控会将云端的最新配置拉取回本地数据库，确保数据一致。

### 🗑️ 安全删除

1. 点击账号右侧的「**📂 管理**」。
2. 点击「**🗑️ 删除**」。
3. **勾选 "同时删除绑定的 KV"** (推荐)，系统将自动清理残留资源。

---

## 📝 内置模板说明

| 模板代码 | 项目名称 | 特性说明 | 建议配置 |
| --- | --- | --- | --- |
| **cmliu** | EdgeTunnel (Beta 2.0) | 功能最全，支持订阅 | 开启 KV |
| **joey** | 少年你相信光吗 | 自动修复，极简 | **关闭 KV** (变量模式) |
| **ech** | ECH Proxy | 无需维护，WebSocket，支持 Token 鉴权 | 关闭 KV |

---

## ❓ 常见问题

### Q: 打开中控页面显示 "KV 未绑定" 怎么办？

A: 请确认已完成 [第二步：绑定 KV 存储](#2️⃣-第二步绑定-kv-存储-️-核心)，变量名必须是 `CONFIG_KV`（大写）。

### Q: 点击 "检查更新" 报错或没反应？

A: 大概率是 GitHub API 限流了。请配置 `GITHUB_TOKEN` 环境变量，参见 [GitHub Token 获取教程](#-github-token-获取教程图文)。

### Q: 为什么不能用 API Token 代替 Global API Key？

A: 因为中控需要执行创建 KV、绑定域名、管理 Worker 脚本等多种操作，普通 API Token 的精细权限无法覆盖所有场景。Global API Key 是唯一能确保所有功能正常运行的凭证。

### Q: 修改子域名后 Worker 访问不了？

A: 子域名修改后需要 **数分钟** 到 **数小时** 才能生效（DNS 传播延迟）。修改期间旧域名和新域名都可能不可用，请耐心等待。

---

## ⚠️ 免责声明

本项目仅供技术研究和学习使用，请勿用于任何非法用途。开发者不对使用本工具产生的任何后果负责。您的 API Key 仅保存在您自己的 Cloudflare KV 中，请妥善保管。
