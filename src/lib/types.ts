/**
 * 共享类型定义 — 消除 any，统一 API 响应和部署日志结构
 */

import type { TemplateType } from '../config/templates';

// ===== 部署日志 =====
export interface DeployLogEntry {
    name: string;
    success: boolean;
    msg: string;
    /** `<accountId>::<workerName>`，供 pendingTargets 精确重试；汇总类日志（如"提示"）可缺省 */
    targetKey?: string;
    /**
     * 上传后回读校验结论：
     *  - 'verified'   回读内容与本次上传一致，确认真的生效了
     *  - 'unverified' 回读失败/不可判定（网络抖动等），不据此判失败，但账本不认它是"已确认"
     *  - 'mismatch'   回读内容不一致 → 该目标已被记为失败
     */
    verify?: 'verified' | 'unverified' | 'mismatch';
}

// ===== 变量条目 =====
/** KV 中存储的变量结构。`secret` 决定绑定类型为 secret_text 还是 plain_text */
export interface VariableEntry {
    key: string;
    value: string;
    secret?: boolean;
    /** 历史数据里出现过的冗余字段（如 yxip 写入的 "plain_text"），保留以兼容读取 */
    type?: string;
}

// ===== 部署配置 =====
export interface DeployConfig {
    mode: 'latest' | 'fixed';
    currentSha?: string | null;
    deployTime?: string | null;
    commitDate?: string | null;
    /**
     * 上一次部署中失败的目标（`<accountId>::<workerName>` 形式），非空说明存在落后于
     * currentSha 的 Worker，cron 需要继续重试而不是判定「已是最新」。
     */
    pendingTargets?: string[];
    /** pendingTargets 对应的目标 SHA —— 上游前进后旧的 pending 集合自然失效 */
    pendingSha?: string | null;
    /** 上一次部署尝试的时间（无论成败），用于 UI 展示与排障 */
    lastAttempt?: string | null;
}

// ===== 自动更新全局配置 =====
export interface AutoUpdateConfig {
    enabled?: boolean;
    lastCheck?: number;
    /** 上一次 KV 回收的时间戳（cron 按 GC_INTERVAL_MS 节流，与 enabled 无关） */
    lastGc?: number;
    interval?: string | number;
    fuseThreshold?: string | number;
    fuseWebhook?: string;
    autoCmliu?: boolean;
    autoJoey?: boolean;
    autoEch?: boolean;
}

// ===== 账号结构 =====
/**
 * 账号条目。
 *
 * Worker 列表以 `workers_<templateType>` 形式平铺存储（历史 KV 格式，前端与导出文件同构，
 * 不做破坏性迁移）。类型安全靠模板字面量索引签名保证：所有 `workers_*` 键必为 string[]，
 * 因此读写不再需要 `as unknown as Record<string, unknown>` 之类的断言。
 * 实际读写请统一走 account-store 的 getWorkerNames / setWorkerNames / addWorkerName。
 */
export interface AccountEntry {
    alias: string;
    accountId: string;
    email: string;
    globalKey: string;
    /**
     * 可选：Cloudflare API Token（`Authorization: Bearer`）。
     * 与 globalKey 二选一即可；两者都存在时优先用 Token（权限更小、可单独吊销）。
     * 与 globalKey 一样加密存储，前端拿到的始终是掩码值。
     */
    apiToken?: string;
    /**
     * 账号显式选择的鉴权方式。写入时会把另一侧凭据清空，避免切换类型后旧凭据
     * 仍在 `getAuthHeaders` 里抢先生效。缺省（历史数据）表示「有 Token 用 Token，否则用 Key」。
     */
    authMode?: 'token' | 'key';
    dailyLimit?: number;
    defaultZoneName?: string;
    defaultZoneId?: string;
    stats?: { total: number; max: number; error?: string };
    workers_cmliu?: string[];
    workers_joey?: string[];
    workers_ech?: string[];
    [key: `workers_${string}`]: string[] | undefined;
}

// ===== 部署日志条目 =====
export interface JournalEntry {
    time: string;
    type: TemplateType;
    sha: string | null;
    accounts: number;
    total: number;
    summary: string;
    customSha?: string;
    /** 本次部署失败的目标名，便于事后排查（不含错误详情，详情在 summary 里） */
    failed?: string[];
}

// ===== 版本收藏 =====
export interface FavoriteItem {
    sha: string;
    alias?: string;
    type?: string;
    name?: string;
    date?: string;
    message?: string;
}

// ===== GitHub 版本信息 =====
export interface GithubVersionInfo {
    localSha: string | null;
    localTime: string | null;
    commitDate: string | null;
    remoteSha: string;
    remoteDate: string;
    remoteMsg: string;
    mode: string;
    /** 上一轮部署失败、仍待重试的目标 */
    pendingTargets?: string[];
    /** 上一次部署尝试时间（含失败） */
    lastAttempt?: string | null;
}

// ===== GitHub Commit 结构（API 返回子集）=====
export interface GithubCommit {
    sha: string;
    commit: {
        message: string;
        author: { name: string; date: string };
        committer: { date: string };
    };
}

// ===== 批量部署请求 =====
export interface BatchDeployRequest {
    template: TemplateType;
    workerName: string;
    kvName?: string;
    config: Record<string, string>;
    targetAccounts: string[];
    disableWorkersDev?: boolean;
    customDomainPrefix?: string;
    enableKV?: boolean;
    savedVars?: VariableEntry[];
}

// ===== 路由请求体类型 =====
export interface DeployBody {
    variables?: VariableEntry[];
    deletedVariables?: string[];
    targetSha?: string | null;
    customCode?: string | null;
    echTokenEnabled?: boolean;
    echDisableWorkersDev?: boolean;
    targetAccountIds?: string[] | null;
}
export interface ZoneBody { accountId: string }
export interface WorkerBody { accountId: string; workerName: string; deleteKv?: boolean }
export interface SubdomainBody { accountId: string; newSubdomain: string }
export interface Fix1101Body { type: string }
