/**
 * 共享类型定义 — 消除 any，统一 API 响应和部署日志结构
 */

import type { TemplateType } from '../config/templates';

// ===== 部署日志 =====
export interface DeployLogEntry {
    name: string;
    success: boolean;
    msg: string;
}

// ===== 变量绑定 =====
export interface VariableBinding {
    key: string;
    value: string;
    secret?: boolean;
}

// ===== 部署配置 =====
export interface DeployConfig {
    mode: 'latest' | 'fixed';
    currentSha?: string | null;
    deployTime?: string | null;
    commitDate?: string | null;
}

// ===== 自动更新全局配置 =====
export interface AutoUpdateConfig {
    enabled?: boolean;
    lastCheck?: number;
    interval?: string | number;
    fuseThreshold?: string | number;
    fuseWebhook?: string;
    autoCmliu?: boolean;
    autoJoey?: boolean;
    autoEch?: boolean;
}

// ===== 账号结构 =====
export interface AccountEntry {
    alias: string;
    accountId: string;
    email: string;
    globalKey: string;
    dailyLimit?: number;
    defaultZoneName?: string;
    defaultZoneId?: string;
    stats?: { total: number; max: number; error?: string };
    workers_cmliu?: string[];
    workers_joey?: string[];
    workers_ech?: string[];
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
    savedVars?: VariableBinding[];
}

// ===== 路由请求体类型 =====
export interface DeployBody {
    variables?: Array<{key:string;value:string}>;
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
