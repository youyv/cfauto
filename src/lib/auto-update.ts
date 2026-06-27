/**
 * 自动更新核心逻辑 — cron 和 routes 共享
 */

import { KV_KEYS, TEMPLATES, BINDING } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders } from './cloudflare-api';
import { fetchGithubCode, applyTemplateTransform, getGithubUrls } from './github';
import { uploadWorker, parseApiError } from './deploy-utils';
import { getJSON, putJSON } from './kv-utils';
import { logger } from './logger';
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


// NOTE: handleBatchDeploy and coreDeployLogic share ~60% logic.
// Future refactor: extract shared deploySteps() taking accounts + code + bindings.
export async function coreDeployLogic(env: AppEnv, opts: DeployOptions) {
    const type = opts.type;
    const variables = opts.variables;
    const deletedVariables = opts.deletedVariables || [];
    const targetSha = opts.targetSha || null;
    const customCode = opts.customCode || null;
    const echTokenEnabled = opts.ech?.tokenEnabled || false;
    const echDisableWorkersDev = opts.ech?.disableWorkersDev || false;
    const targetAccountIds = opts.targetAccountIds || null;

    try {
        const isLatestMode = !targetSha || targetSha === 'latest';
        const shaForFetch = isLatestMode ? null : targetSha;

        let accounts = await getJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);
        if (targetAccountIds && targetAccountIds.length > 0) {
            accounts = accounts.filter((a: any) => targetAccountIds.includes(a.accountId));
        }
        if (accounts.length === 0) return [{ name: "提示", success: false, msg: "无账号配置" }];

        let githubScriptContent = "";
        let deployedSha: string | null = shaForFetch;

        if (customCode) {
            githubScriptContent = customCode;
            if (!deployedSha) {
                try { const { sha } = await fetchGithubCode(type, 'latest', env); if (sha) deployedSha = sha; } catch (e) {}
            }
            // 自定义代码审计：记录 SHA256 到部署日志
            customCodeHash = Array.from(new Uint8Array(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(customCode))
            )).map(b => b.toString(16).padStart(2, '0')).join('');
            logger.audit('customCode deploy', { sha256: customCodeHash });
        } else {
            try {
                const { code, sha } = await fetchGithubCode(type, shaForFetch, env);
                githubScriptContent = code;
                if (!deployedSha && sha) deployedSha = sha;
            } catch (e: any) { return [{ name: "网络错误", success: false, msg: e.message }]; }
        }

        githubScriptContent = applyTemplateTransform(type, githubScriptContent, variables, { echTokenEnabled });

        const logs: Array<{ name: string; success: boolean; msg: string }> = [];
        for (const acc of accounts) {
            const targetWorkers = acc['workers_' + type] || [];
            for (const wName of targetWorkers) {
                const logItem = { name: acc.alias + ' -> [' + wName + ']', success: false, msg: "" };
                try {
                    const baseUrl = cf.workerScript(acc.accountId, wName);
                    const jsonHeaders = getAuthHeaders(acc.email, acc.globalKey);
                    const bindingsRes = await fetch(baseUrl + '/bindings', { headers: jsonHeaders });
                    let currentBindings = bindingsRes.ok ? (await bindingsRes.json()).result : [];
                    if (deletedVariables.length > 0) {
                        currentBindings = currentBindings.filter((b: any) => !deletedVariables.includes(b.name));
                    }
                    if (variables) {
                        variables.forEach(v => {
                            if (v.value && v.value.trim() !== "") {
                                const bindingType = (v as any).secret ? "secret_text" : "plain_text";
                                const idx = currentBindings.findIndex((b: any) => b.name === v.key);
                                if (idx !== -1) currentBindings[idx] = { name: v.key, type: bindingType, text: v.value };
                                else currentBindings.push({ name: v.key, type: bindingType, text: v.value });
                            }
                        });
                    }
                    const { ok, res: updateRes } = await uploadWorker(acc, wName, githubScriptContent, currentBindings);
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
                logs.push(logItem);
            }
        }

        const hasSuccess = logs.some(l => l.success);
        if (hasSuccess) {
            try {
                const existing = await getJSON(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, []);
                const journalEntry: Record<string, unknown> = { time: new Date().toISOString(), type, sha: deployedSha, accounts: logs.filter(l => l.success).length, total: logs.length, summary: logs.map(l => l.name + ': ' + (l.success ? 'OK' : l.msg)).join('; ').substring(0, 500) };
                if (customCodeHash) journalEntry.customSha = customCodeHash;
                existing.unshift(journalEntry);
                await putJSON(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, existing.slice(0, 100));
            } catch (e) { logger.warn("deploy journal write failed", { error: (e as Error).message }); }
            const mode = isLatestMode ? 'latest' : 'fixed';
            await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode, currentSha: deployedSha || 'unknown', deployTime: new Date().toISOString() });
        }
        return logs;
    } catch (e: any) { return [{ name: "系统错误", success: false, msg: e.message }]; }
}

export async function fetchGithubVersion(env: AppEnv, type: TemplateType): Promise<{ localSha: string | null; localTime: string | null; remoteSha: string; remoteDate: string; remoteMsg: string; mode: string }> {
    const [deployConfig, accounts] = await Promise.all([
        getJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' }),
        getJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []),
    ]);
    const hasDeployed = accounts.some((a: any) => a['workers_' + type] && a['workers_' + type].length > 0);
    if (!hasDeployed && deployConfig.currentSha) {
        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
    }
    const localSha = hasDeployed ? deployConfig.currentSha : null;
    const localTime = hasDeployed ? deployConfig.deployTime : null;
    
    const { apiUrl, branch } = getGithubUrls(type);
    const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-Worker-Manager' };
    if (env.GITHUB_TOKEN) headers['Authorization'] = 'token ' + env.GITHUB_TOKEN;
    const ghRes = await fetch(apiUrl + '?sha=' + branch + '&per_page=1&t=' + Date.now(), { headers });
    if (!ghRes.ok) throw new Error('GitHub API Error: ' + ghRes.status);
    const ghData: any = await ghRes.json();
    const latestCommit = Array.isArray(ghData) ? ghData[0] : ghData;
    
    return {
        localSha, localTime,
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
            await coreDeployLogic(env, { type, variables });
        }
    } catch (e) { console.error('[Update Error] ' + type + ': ' + (e as Error).message); }
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
    await coreDeployLogic(env, { type, variables, targetSha });
}

        let customCodeHash = "";