/**
 * 自动更新核心逻辑 — cron 和 routes 共享
 */

import { KV_KEYS, TEMPLATES } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders, fetchWithTimeout, readApiResult } from './cloudflare-api';
import { fetchGithubCode, applyTemplateTransform, getGithubUrls, fetchGithubCommits } from './github';
import { uploadWorker, mergeVariableBindings, verifyWorkerScript } from './deploy-utils';
import { getJSON, putJSON } from './kv-utils';
import { pruneJournal, JOURNAL_SUMMARY_MAX } from './kv-gc';
import { readAccounts, getWorkerNames, hasAnyWorker } from './account-store';
import { pooledMap } from './concurrency';
import { logger } from './logger';
import type { DeployLogEntry, JournalEntry, DeployConfig, AccountEntry, GithubVersionInfo, VariableEntry } from './types';
import type { AppEnv } from '../config/env';

/** 部署选项 */
export interface DeployOptions {
    type: TemplateType;
    variables: VariableEntry[];
    deletedVariables?: string[];
    targetSha?: string | null;
    customCode?: string | null;
    ech?: { tokenEnabled?: boolean; disableWorkersDev?: boolean };
    targetAccountIds?: string[] | null;
    /** 仅部署这些 `<accountId>::<workerName>` 目标（用于失败重试），为空表示全部 */
    targetKeys?: string[] | null;
    /**
     * 账号级变量覆盖的处理方式：
     *  - 'apply'（默认）：叠加在传入变量之上 —— cron 自动更新走这条，
     *    保证熔断刚为某账号轮换的 UUID 不被全局变量覆盖回去。
     *  - 'clear'：忽略并删除覆盖 —— 用户在面板上显式点部署时走这条，
     *    因为面板展示的就是全局变量，用户的意图是「所有账号都用这一套」。
     */
    accountOverrides?: 'apply' | 'clear';
}

interface DeployCodeResult {
    scriptContent: string;
    deployedSha: string | null;
    customCodeHash: string;
    isLatestMode: boolean;
}

/** 部署目标的稳定标识 — 用于 pendingTargets 精确重试 */
export function deployTargetKey(accountId: string, workerName: string): string {
    return accountId + '::' + workerName;
}

/** [提取] 准备部署代码 — GitHub 拉取或自定义代码 + SHA 审计 */
export async function prepareDeployCode(
    env: AppEnv, type: TemplateType,
    targetSha: string | null, customCode: string | null,
    variables: VariableEntry[] | null, echTokenEnabled: boolean
): Promise<DeployCodeResult | DeployLogEntry[]> {
    const isLatestMode = !targetSha || targetSha === 'latest';
    const shaForFetch = isLatestMode ? null : targetSha;
    let deployedSha: string | null = shaForFetch;
    let scriptContent = "";
    let customCodeHash = "";

    if (customCode) {
        scriptContent = customCode;
        if (!deployedSha) {
            try { const { sha } = await fetchGithubCode(type, 'latest', env); if (sha) deployedSha = sha; } catch (e) { logger.warn('SHA fetch for customCode fallback failed', { error: (e as Error).message, module: 'auto-update' }); }
        }
        customCodeHash = Array.from(new Uint8Array(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(customCode))
        )).map(b => b.toString(16).padStart(2, '0')).join('');
        logger.audit('customCode deploy', { sha256: customCodeHash });
    } else {
        try {
            const { code, sha } = await fetchGithubCode(type, shaForFetch, env);
            scriptContent = code;
            if (!deployedSha && sha) deployedSha = sha;
        } catch (e: any) { return [{ name: "网络错误", success: false, msg: e.message }]; }
    }

    scriptContent = applyTemplateTransform(type, scriptContent, variables, { echTokenEnabled });
    return { scriptContent, deployedSha, customCodeHash, isLatestMode };
}

/** [提取] 部署到单个 Worker */
async function deploySingleWorker(
    acc: AccountEntry, wName: string, type: TemplateType,
    scriptContent: string, deployedSha: string | null,
    variables: VariableEntry[],
    deletedVariables: string[], echDisableWorkersDev: boolean
): Promise<DeployLogEntry> {
    const logItem: DeployLogEntry = {
        name: acc.alias + ' -> [' + wName + ']',
        success: false,
        msg: "",
        targetKey: deployTargetKey(acc.accountId, wName)
    };
    try {
        const baseUrl = cf.workerScript(acc.accountId, wName);
        const jsonHeaders = getAuthHeaders(acc);
        const bindingsRes = await fetchWithTimeout(baseUrl + '/bindings', { headers: jsonHeaders });
        // 安全: bindings 读取失败必须中止，否则空数组会覆盖该 Worker 全部既有绑定（KV/secret 丢失）
        if (!bindingsRes.ok) {
            throw new Error('获取 bindings 失败 (HTTP ' + bindingsRes.status + ')，已中止部署以保护既有绑定');
        }
        const rawBindings = await readApiResult<Array<Record<string, unknown>>>(bindingsRes, '读取 bindings') || [];
        const currentBindings = variables
            ? mergeVariableBindings(rawBindings, variables, deletedVariables)
            : rawBindings;
        const { ok, error: uploadError } = await uploadWorker(acc, wName, scriptContent, currentBindings, type);
        if (ok) {
            logItem.success = true;
            const msgs = ['✅ Ver: ' + (deployedSha ? deployedSha.substring(0, 7) : 'Unknown')];
            // 上传响应成功 ≠ 脚本真的变了 —— 回读一次内容再决定成败。
            // 不一致时按失败处理：账本不会前进，cron 下一轮会把该目标当作落后继续重试。
            const verdict = await verifyWorkerScript(acc.accountId, wName, jsonHeaders, scriptContent);
            if (verdict === 'mismatch') {
                logItem.success = false;
                logItem.verify = 'mismatch';
                logItem.msg = '❌ 上传后回读校验不一致：Cloudflare 上的脚本内容与本次上传的不同（本次写入可能未生效），已按失败处理并留在重试队列';
                return logItem;
            }
            logItem.verify = verdict === 'verified' ? 'verified' : 'unverified';
            if (verdict === 'unverified') msgs.push('⚠️ 回读校验不可用');
            if (type === 'ech') {
                try {
                    await fetchWithTimeout(cf.workerSubdomain(acc.accountId, wName), {
                        method: 'POST', headers: jsonHeaders,
                        body: JSON.stringify({ enabled: !echDisableWorkersDev })
                    });
                    msgs.push(echDisableWorkersDev ? '🚫 默认域名已禁用' : '🌐 默认域名已启用');
                } catch (e) { msgs.push('⚠️ 域名状态设置失败'); }
            }
            logItem.msg = msgs.join(' | ');
        } else {
            logItem.msg = '❌ ' + (uploadError || '上传失败');
        }
    } catch (err: any) { logItem.msg = '❌ ' + err.message; }
    return logItem;
}

/**
 * 取上游最新 commit 的提交日期。
 *
 * 失败仅告警：commitDate 只用于 UI 展示「落后多久」与 diff 的 since 参数，
 * 拿不到不应阻断部署结果的落盘。
 */
async function fetchCommitDate(env: AppEnv, type: TemplateType): Promise<string | null> {
    try {
        const commits = await fetchGithubCommits(type, env, { perPage: 1 });
        return commits[0]?.commit?.committer?.date || null;
    } catch (e) {
        logger.warn('commitDate fetch after deploy failed', { error: (e as Error).message, module: 'auto-update' });
        return null;
    }
}

/**
 * [提取] 部署后写入日志和配置
 *
 * 关键语义（两条都必须满足才推进 `currentSha`）：
 *  1. **全量作用域**（`scope === 'full'`）：本轮覆盖了该模板的全部受管目标。
 *     熔断轮换、一键修复、批量部署、失败重试都只覆盖子集 —— 它们若推进账本，其余 Worker
 *     会被判成「已是最新」而永远不再更新，且没有任何告警。这正是线上出现过的那次故障。
 *  2. **全部目标成功**：任何失败都记入 `pendingTargets`，checkAndDeployUpdate 据此重试。
 *
 * 子集作用域下账本原样保留，只允许从 pending 里移除本轮真正成功的目标。
 */
export async function finalizeDeploy(
    env: AppEnv, type: TemplateType, isLatestMode: boolean,
    deployedSha: string | null, logs: DeployLogEntry[], customCodeHash: string,
    scope: 'full' | 'partial' = 'full'
): Promise<void> {
    const failedLogs = logs.filter(l => !l.success);
    const allSucceeded = failedLogs.length === 0 && logs.length > 0;
    // 账本只在「全量 + 全部成功」时前进
    const advances = allSucceeded && scope === 'full';
    const mode = isLatestMode ? 'latest' : 'fixed';
    const nowIso = new Date().toISOString();

    // 两处 KV 读取互不依赖 → 并行；commitDate 的网络请求也提前发起，
    // 避免它串行排在「读 deployConfig」之后（此前三者是完全串行的 N+1）。
    const [existing, prev, commitDate] = await Promise.all([
        getJSON<JournalEntry[]>(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, []),
        getJSON<DeployConfig>(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' }),
        advances ? fetchCommitDate(env, type) : Promise.resolve(null),
    ]);

    // 写 journal
    try {
        const journalEntry: JournalEntry = {
            time: nowIso, type, sha: deployedSha,
            accounts: logs.filter(l => l.success).length, total: logs.length,
            summary: logs.map(l => l.name + ': ' + (l.success ? 'OK' : l.msg)).join('; ').substring(0, JOURNAL_SUMMARY_MAX)
        };
        if (customCodeHash) journalEntry.customSha = customCodeHash;
        if (failedLogs.length > 0) journalEntry.failed = failedLogs.map(l => l.name);
        existing.unshift(journalEntry);
        // 写入侧就按「条数 + 保留天数 + 单条体积」裁剪，不再只截条数：
        // failed 数组此前无上限，一次 200 个目标全失败就会写进一个巨大的数组，
        // 100 条这种记录足以把单个 KV 值推到数百 KB。cron 的 GC 只是兜底。
        const { kept } = pruneJournal(existing, Date.now());
        await putJSON(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, kept);
    } catch (e) { logger.warn("deploy journal write failed", { error: (e as Error).message }); }

    // 其余情形一律保留旧账本：全量失败记 pending，子集则连 pending 也只做增量更新
    const dp: DeployConfig = advances
        ? {
            mode,
            currentSha: deployedSha || 'unknown',
            deployTime: nowIso,
            lastAttempt: nowIso,
            pendingTargets: [],
            pendingSha: null,
            commitDate: undefined
        }
        : scope === 'full'
            ? {
                ...prev,
                mode,
                lastAttempt: nowIso,
                // 目标 SHA 变了就重建 pending 集合，否则与既有 pending 求并集（本轮成功的移出）
                pendingSha: deployedSha,
                pendingTargets: mergePendingTargets(prev, deployedSha, logs)
            }
            : {
                ...prev,
                mode,
                lastAttempt: nowIso,
                // pendingSha 指向"账本当前认为已部署的版本"，让重试队列能被
                // resolveUpdatePlan 的 retry-pending 分支真正消费掉
                pendingSha: prev.pendingSha || prev.currentSha || null,
                pendingTargets: mergeSubsetPending(prev, logs)
            };

    if (advances) {
        dp.commitDate = commitDate || undefined;
        logger.audit('deploy completed', { type, sha: deployedSha, targets: logs.length });
    } else if (failedLogs.length > 0) {
        logger.warn('deploy partially failed — currentSha not advanced', {
            module: 'auto-update', type, sha: deployedSha,
            failed: failedLogs.length, total: logs.length
        });
    } else {
        // 子集部署全成功：这是正常路径（熔断轮换/重试），但账本必须原地不动
        logger.info('partial-scope deploy finished — ledger untouched', {
            module: 'auto-update', type, sha: deployedSha, targets: logs.length
        });
    }

    try {
        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), dp);
    } catch (e) { logger.warn('deployConfig write after deploy failed', { error: (e as Error).message, module: 'auto-update' }); }
}

/**
 * 合并 pendingTargets：目标 SHA 变化时丢弃旧集合，否则保留未处理项 + 本轮失败项，移除本轮成功项。
 * 导出供单元测试直接覆盖。
 */
export function mergePendingTargets(
    prev: DeployConfig, deployedSha: string | null, logs: DeployLogEntry[]
): string[] {
    const shaChanged = (prev.pendingSha || null) !== (deployedSha || null);
    const carried = shaChanged ? [] : (prev.pendingTargets || []);
    const next = new Set(carried);
    for (const l of logs) {
        if (!l.targetKey) continue;
        if (l.success) next.delete(l.targetKey);
        else next.add(l.targetKey);
    }
    return Array.from(next);
}

/**
 * 子集部署的 pending 增量合并 —— 只做两件事：移除本轮真正成功的目标、加入本轮失败的
 * 目标。**不重建整个集合**：本轮没碰到的目标状态未知，必须原样保留，否则一次熔断轮换
 * 就会把其它待重试目标从队列里抹掉。
 */
export function mergeSubsetPending(prev: DeployConfig, logs: DeployLogEntry[]): string[] {
    const succeeded = new Set<string>();
    const failed: string[] = [];
    for (const l of logs) {
        if (!l.targetKey) continue;
        if (l.success) succeeded.add(l.targetKey);
        else if (!failed.includes(l.targetKey)) failed.push(l.targetKey);
    }
    const kept = (prev.pendingTargets || []).filter(k => !succeeded.has(k));
    for (const k of failed) if (!kept.includes(k)) kept.push(k);
    return kept;
}

/** 核心部署逻辑 — 编排器 */
export async function coreDeployLogic(env: AppEnv, opts: DeployOptions): Promise<DeployLogEntry[]> {
    const {
        type, variables, deletedVariables = [], targetSha = null, customCode = null,
        ech, targetAccountIds = null, targetKeys = null, accountOverrides = 'apply'
    } = opts;
    const echTokenEnabled = ech?.tokenEnabled || false;
    const echDisableWorkersDev = ech?.disableWorkersDev || false;

    try {
        const codeResult = await prepareDeployCode(env, type, targetSha, customCode, variables, echTokenEnabled);
        if (Array.isArray(codeResult)) return codeResult; // early error from code fetch
        const { scriptContent, deployedSha, customCodeHash, isLatestMode } = codeResult;

        let accounts = await readAccounts(env);
        if (targetAccountIds && targetAccountIds.length > 0) {
            accounts = accounts.filter((a) => targetAccountIds.includes(a.accountId));
        }
        if (accounts.length === 0) return [{ name: "提示", success: false, msg: "无账号配置" }];

        // 展平成 (账号, worker) 目标列表后有界并发，替代此前的全串行双层循环
        const keyFilter = targetKeys && targetKeys.length > 0 ? new Set(targetKeys) : null;
        const targets = accounts.flatMap((acc) =>
            getWorkerNames(acc, type)
                .filter((wName) => !keyFilter || keyFilter.has(deployTargetKey(acc.accountId, wName)))
                .map((wName) => ({ acc, wName }))
        );
        if (targets.length === 0) {
            return [{ name: "提示", success: false, msg: keyFilter ? "无匹配的重试目标" : "所选账号下无该模板的 Worker" }];
        }

        // 每个账号生效的变量：账号级覆盖（熔断轮换写入的 UUID）优先于传入的全局变量。
        // 手动部署传 'clear'：用户看到的就是全局变量，其意图是让所有账号统一。
        const varsByAccount = await resolveAccountVariables(env, type, accounts, variables, accountOverrides);

        const logs = await pooledMap(targets, ({ acc, wName }) =>
            deploySingleWorker(
                acc, wName, type, scriptContent, deployedSha,
                varsByAccount.get(acc.accountId) || variables,
                deletedVariables, echDisableWorkersDev
            )
        );

        // 作用域：只有「不限账号 + 不限目标」的调用覆盖了该模板全部受管 Worker，
        // 才允许推进版本账本（见 finalizeDeploy 的注释）。
        const scope: 'full' | 'partial' =
            (keyFilter || (targetAccountIds && targetAccountIds.length > 0)) ? 'partial' : 'full';
        if (scope === 'partial') {
            logger.info('coreDeployLogic: 子集部署，版本账本保持不动', {
                module: 'auto-update', type, targets: targets.length
            });
        }

        await finalizeDeploy(env, type, isLatestMode, deployedSha, logs, customCodeHash, scope);
        return logs;
    } catch (e: any) { return [{ name: "系统错误", success: false, msg: e.message }]; }
}

/**
 * 解析每个账号生效的变量列表。
 *
 * 'apply'：账号级覆盖里的键覆盖同名全局键（其余全局键照常生效）。
 * 'clear'：删除账号级覆盖键，全部账号统一使用传入的全局变量。
 */
async function resolveAccountVariables(
    env: AppEnv, type: TemplateType, accounts: AccountEntry[],
    globalVars: VariableEntry[], mode: 'apply' | 'clear'
): Promise<Map<string, VariableEntry[]>> {
    const out = new Map<string, VariableEntry[]>();
    if (mode === 'clear') {
        await Promise.all(accounts.map(a =>
            env.CONFIG_KV.delete(KV_KEYS.accountVars(type, a.accountId)).catch((e: unknown) =>
                logger.warn('清理账号级变量覆盖失败', { module: 'auto-update', accountId: a.accountId, error: String(e) }))
        ));
        return out;
    }
    await Promise.all(accounts.map(async (a) => {
        const override = await getJSON<VariableEntry[] | null>(env.CONFIG_KV, KV_KEYS.accountVars(type, a.accountId), null);
        if (!override || !Array.isArray(override) || override.length === 0) return;
        out.set(a.accountId, mergeVarLists(globalVars, override));
    }));
    return out;
}

/** 用 override 中的同名键覆盖 base，其余保留。纯函数，供测试覆盖 */
export function mergeVarLists(base: VariableEntry[], override: VariableEntry[]): VariableEntry[] {
    const map = new Map<string, VariableEntry>();
    for (const v of base || []) if (v && v.key) map.set(v.key, v);
    for (const v of override || []) if (v && v.key) map.set(v.key, v);
    return Array.from(map.values());
}

export async function fetchGithubVersion(env: AppEnv, type: TemplateType): Promise<GithubVersionInfo> {
    const [deployConfig, accounts] = await Promise.all([
        getJSON<DeployConfig>(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' }),
        readAccounts(env),
    ]);
    const hasDeployed = hasAnyWorker(accounts, type);
    if (!hasDeployed && deployConfig.currentSha) {
        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
    }
    const localSha = hasDeployed ? (deployConfig.currentSha || null) : null;
    const localTime = hasDeployed ? (deployConfig.deployTime || null) : null;
    let commitDate = deployConfig.commitDate || null;
    // 无 commitDate 时通过 GitHub API 查询本地 SHA 的日期（自动回填 KV）
    if (!commitDate && localSha) {
        try {
            const { repoApiBase } = getGithubUrls(type);
            const h: Record<string, string> = { 'User-Agent': 'Cloudflare-Worker-Manager' };
            if (env.GITHUB_TOKEN) h['Authorization'] = 'token ' + env.GITHUB_TOKEN;
            const sr = await fetchWithTimeout(repoApiBase + '/commits/' + localSha, { headers: h });
            if (sr.ok) {
                const sd: any = await sr.json();
                commitDate = sd.commit?.committer?.date || null;
                if (commitDate) {
                    deployConfig.commitDate = commitDate;
                    await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), deployConfig);
                }
            }
        } catch (e) { logger.warn('fetchGithubVersion commit date backfill failed', { error: (e as Error).message, module: 'auto-update' }); }
    }

    const ghData = await fetchGithubCommits(type, env, { perPage: 1, cacheBust: true });
    const latestCommit = Array.isArray(ghData) ? ghData[0] : ghData;
    if (!latestCommit || !latestCommit.sha) {
        throw new Error('GitHub 未返回有效的 commit 信息');
    }

    return {
        localSha, localTime,
        commitDate,
        remoteSha: latestCommit.sha,
        remoteDate: latestCommit.commit.committer.date,
        remoteMsg: latestCommit.commit.message,
        mode: deployConfig.mode,
        pendingTargets: deployConfig.pendingTargets || [],
        lastAttempt: deployConfig.lastAttempt || null
    };
}

/**
 * 判断是否需要执行自动更新，返回需要重试的目标（null = 全量）。
 * 导出供单元测试覆盖三种情形：上游前进、pending 未清空、已是最新。
 */
export function resolveUpdatePlan(
    version: Pick<GithubVersionInfo, 'localSha' | 'remoteSha' | 'pendingTargets'>,
    pendingSha: string | null | undefined
): { shouldDeploy: boolean; targetKeys: string[] | null; reason: string } {
    if (!version.remoteSha) return { shouldDeploy: false, targetKeys: null, reason: 'no-remote-sha' };
    if (!version.localSha || version.remoteSha !== version.localSha) {
        return { shouldDeploy: true, targetKeys: null, reason: 'upstream-ahead' };
    }
    // SHA 已一致，但仍有目标停在旧版本（上一轮部分失败）→ 只重试这些目标
    const pending = version.pendingTargets || [];
    if (pending.length > 0 && (pendingSha || null) === version.remoteSha) {
        return { shouldDeploy: true, targetKeys: pending, reason: 'retry-pending' };
    }
    return { shouldDeploy: false, targetKeys: null, reason: 'up-to-date' };
}

export async function checkAndDeployUpdate(env: AppEnv, type: TemplateType) {
    try {
        const deployConfig = await getJSON<DeployConfig>(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
        if (deployConfig.mode === 'fixed') return;

        const version = await fetchGithubVersion(env, type);
        const plan = resolveUpdatePlan(version, deployConfig.pendingSha);
        if (!plan.shouldDeploy) return;

        if (plan.reason === 'retry-pending') {
            logger.info('cron: retrying previously failed deploy targets', { module: 'auto-update', type, count: plan.targetKeys?.length || 0 });
        }
        const variables = await getJSON<VariableEntry[]>(env.CONFIG_KV, KV_KEYS.vars(type), []);
        await coreDeployLogic(env, { type, variables, deletedVariables: [], targetKeys: plan.targetKeys });
    } catch (e) { logger.error('update check failed for ' + type, e as Error, { module: 'auto-update' }); }
}

/**
 * 熔断轮换 — 为指定账号更换 UUID 并重新部署。
 *
 * `accountIds` 必填且非空：此前不传导致某一个账号超限就把**所有**账号的 UUID 一起换掉，
 * 全部用户的订阅链接同时失效。UUID 现在写入账号级键 `VARS_<type>_ACC_<accountId>`，
 * 未超限账号继续使用全局 `VARS_<type>`。
 */
export async function rotateUUIDAndDeploy(env: AppEnv, type: TemplateType, accountIds: string[]) {
    const uuidField = TEMPLATES[type].uuidField;
    if (!uuidField) return;
    if (!accountIds || accountIds.length === 0) {
        logger.warn('rotateUUIDAndDeploy called without accountIds — skipped to avoid global UUID rotation', { module: 'auto-update', type });
        return;
    }

    const globalVars = await getJSON<VariableEntry[]>(env.CONFIG_KV, KV_KEYS.vars(type), []);
    const deployConfig = await getJSON<DeployConfig>(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
    const targetSha = deployConfig.mode === 'fixed' ? deployConfig.currentSha : 'latest';

    for (const accountId of accountIds) {
        const accKey = KV_KEYS.accountVars(type, accountId);
        const base = await getJSON<VariableEntry[]>(env.CONFIG_KV, accKey, globalVars);
        const rotated = rotateUuidField(base, uuidField, crypto.randomUUID());
        await putJSON(env.CONFIG_KV, accKey, rotated);
        logger.audit('fuse uuid rotated', { type, accountId, field: uuidField });
        await coreDeployLogic(env, {
            type, variables: rotated, deletedVariables: [],
            targetSha, targetAccountIds: [accountId],
            // 覆盖已在上一行写入 KV，这里直接用 rotated，不再叠加一次
            accountOverrides: 'apply'
        });
    }
}

/** 把变量列表中的 UUID 字段换成新值（缺失则追加）。纯函数，供测试直接覆盖 */
export function rotateUuidField(variables: VariableEntry[], uuidField: string, newUuid: string): VariableEntry[] {
    const next = variables.map(v => (v.key === uuidField ? { ...v, value: newUuid } : { ...v }));
    if (!next.some(v => v.key === uuidField)) next.push({ key: uuidField, value: newUuid });
    return next;
}
