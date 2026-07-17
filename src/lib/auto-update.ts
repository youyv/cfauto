/**
 * 自动更新核心逻辑 — cron 和 routes 共享
 */

import { KV_KEYS, TEMPLATES, BINDING } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders, fetchWithTimeout } from './cloudflare-api';
import { fetchGithubCode, applyTemplateTransform, getGithubUrls, fetchGithubCommits } from './github';
import { uploadWorker, parseApiError, mergeVariableBindings } from './deploy-utils';
import { getJSON, putJSON } from './kv-utils';
import { readAccounts } from './account-store';
import { logger } from './logger';
import type { DeployLogEntry, JournalEntry, DeployConfig, AccountEntry, GithubVersionInfo } from './types';
import type { AppEnv } from '../config/env';

/** 部署选项 */
export interface DeployOptions {
    type: TemplateType;
    variables: Array<{ key: string; value: string }>;
    deletedVariables?: string[];
    targetSha?: string | null;
    customCode?: string | null;
    ech?: { tokenEnabled?: boolean; disableWorkersDev?: boolean };
    targetAccountIds?: string[] | null;
}

interface DeployCodeResult {
    scriptContent: string;
    deployedSha: string | null;
    customCodeHash: string;
    isLatestMode: boolean;
}

/** [提取] 准备部署代码 — GitHub 拉取或自定义代码 + SHA 审计 */
export async function prepareDeployCode(
    env: AppEnv, type: TemplateType,
    targetSha: string | null, customCode: string | null,
    variables: Array<{ key: string; value: string }> | null, echTokenEnabled: boolean
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
    variables: Array<{ key: string; value: string }>,
    deletedVariables: string[], echDisableWorkersDev: boolean
): Promise<DeployLogEntry> {
    const logItem: DeployLogEntry = { name: acc.alias + ' -> [' + wName + ']', success: false, msg: "" };
    try {
        const baseUrl = cf.workerScript(acc.accountId, wName);
        const jsonHeaders = getAuthHeaders(acc.email, acc.globalKey);
        const bindingsRes = await fetch(baseUrl + '/bindings', { headers: jsonHeaders });
        const rawBindings = bindingsRes.ok ? (await bindingsRes.json()).result : [];
        const currentBindings = variables
            ? mergeVariableBindings(rawBindings, variables, deletedVariables)
            : rawBindings;
        const { ok, res: updateRes } = await uploadWorker(acc, wName, scriptContent, currentBindings);
        if (ok) {
            logItem.success = true;
            const msgs = ['✅ Ver: ' + (deployedSha ? deployedSha.substring(0, 7) : 'Unknown')];
            if (type === 'ech') {
                try {
                    await fetch(cf.workerSubdomain(acc.accountId, wName), {
                        method: 'POST', headers: jsonHeaders,
                        body: JSON.stringify({ enabled: !echDisableWorkersDev })
                    });
                    msgs.push(echDisableWorkersDev ? '🚫 默认域名已禁用' : '🌐 默认域名已启用');
                } catch (e) { msgs.push('⚠️ 域名状态设置失败'); }
            }
            logItem.msg = msgs.join(' | ');
        } else {
            logItem.msg = await parseApiError(updateRes);
        }
    } catch (err: any) { logItem.msg = '❌ ' + err.message; }
    return logItem;
}

/** [提取] 部署后写入日志和配置 */
export async function finalizeDeploy(
    env: AppEnv, type: TemplateType, isLatestMode: boolean,
    deployedSha: string | null, logs: DeployLogEntry[], customCodeHash: string
): Promise<void> {
    try {
        const existing = await getJSON(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, []);
        const journalEntry: JournalEntry & Record<string, unknown> = {
            time: new Date().toISOString(), type, sha: deployedSha,
            accounts: logs.filter(l => l.success).length, total: logs.length,
            summary: logs.map(l => l.name + ': ' + (l.success ? 'OK' : l.msg)).join('; ').substring(0, 500)
        };
        if (customCodeHash) journalEntry.customSha = customCodeHash;
        existing.unshift(journalEntry);
        await putJSON(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, existing.slice(0, 100));
    } catch (e) { logger.warn("deploy journal write failed", { error: (e as Error).message }); }

    const mode = isLatestMode ? 'latest' : 'fixed';
    let commitDate: string | null = null;
    try {
        const commits = await fetchGithubCommits(type, env, { perPage: 1 });
        commitDate = commits[0]?.commit?.committer?.date || null;
    } catch (e) { logger.warn('commitDate fetch after deploy failed', { error: (e as Error).message, module: 'auto-update' }); }
    const dp: DeployConfig = { mode, currentSha: deployedSha || 'unknown', deployTime: new Date().toISOString(), commitDate: commitDate || undefined };
    try {
        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), dp);
    } catch (e) { logger.warn('deployConfig write after deploy failed', { error: (e as Error).message, module: 'auto-update' }); }
}

/** 核心部署逻辑 — 编排器 */
export async function coreDeployLogic(env: AppEnv, opts: DeployOptions) {
    const { type, variables, deletedVariables = [], targetSha = null, customCode = null, ech, targetAccountIds = null } = opts;
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

        const logs: DeployLogEntry[] = [];
        for (const acc of accounts) {
            const targetWorkers = acc['workers_' + type] || [];
            for (const wName of targetWorkers) {
                logs.push(await deploySingleWorker(acc, wName as string, type, scriptContent, deployedSha, variables, deletedVariables, echDisableWorkersDev));
            }
        }

        if (logs.some(l => l.success)) {
            await finalizeDeploy(env, type, isLatestMode, deployedSha, logs, customCodeHash);
        }
        return logs;
    } catch (e: any) { return [{ name: "系统错误", success: false, msg: e.message }]; }
}

export async function fetchGithubVersion(env: AppEnv, type: TemplateType): Promise<GithubVersionInfo> {
    const [deployConfig, accounts] = await Promise.all([
        getJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' }),
        readAccounts(env),
    ]);
    const hasDeployed = accounts.some((a: any) => a['workers_' + type] && a['workers_' + type].length > 0);
    if (!hasDeployed && deployConfig.currentSha) {
        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
    }
    const localSha = hasDeployed ? deployConfig.currentSha : null;
    const localTime = hasDeployed ? deployConfig.deployTime : null;
    let commitDate = deployConfig.commitDate || null;
    // 无 commitDate 时通过 GitHub API 查询本地 SHA 的日期（自动回填 KV）
    if (!commitDate && localSha) {
        try {
            const { repoApiBase } = getGithubUrls(type);
            const h = { 'User-Agent': 'Cloudflare-Worker-Manager' };
            if (env.GITHUB_TOKEN) h['Authorization'] = 'token ' + env.GITHUB_TOKEN;
            const sr = await fetchWithTimeout(repoApiBase + '/commits/' + localSha, { headers: h });
            if (sr.ok) {
                const sd = await sr.json();
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
    
    return {
        localSha, localTime,
        commitDate,
        remoteSha: latestCommit.sha,
        remoteDate: latestCommit.commit.committer.date,
        remoteMsg: latestCommit.commit.message,
        mode: deployConfig.mode
    };
}

export async function checkAndDeployUpdate(env: AppEnv, type: TemplateType) {
    try {
        const deployConfig = await getJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
        if (deployConfig.mode === 'fixed') return;

        const version = await fetchGithubVersion(env, type);
        if (version.remoteSha && (!version.localSha || version.remoteSha !== version.localSha)) {
            const variables = await getJSON(env.CONFIG_KV, KV_KEYS.vars(type), []);
            await coreDeployLogic(env, { type, variables, deletedVariables: [] });
        }
    } catch (e) { logger.error('update check failed for ' + type, e as Error, { module: 'auto-update' }); }
}

export async function rotateUUIDAndDeploy(env: AppEnv, type: TemplateType) {
    const uuidField = TEMPLATES[type].uuidField;
    if (!uuidField) return;

    let variables: Array<{ key: string; value: string }> = await getJSON(env.CONFIG_KV, KV_KEYS.vars(type), []);
    let uuidUpdated = false;
    variables = variables.map(v => {
        if (v.key === uuidField) { v.value = crypto.randomUUID(); uuidUpdated = true; }
        return v;
    });
    if (!uuidUpdated) variables.push({ key: uuidField, value: crypto.randomUUID() });
    await putJSON(env.CONFIG_KV, KV_KEYS.vars(type), variables);

    const deployConfig = await getJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
    const targetSha = deployConfig.mode === 'fixed' ? deployConfig.currentSha : 'latest';
    await coreDeployLogic(env, { type, variables, deletedVariables: [], targetSha });
}
