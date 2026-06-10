/**
 * 定时任务 — 自动检查更新 + 熔断轮换
 */

import { KV_KEYS, TEMPLATES } from './config/templates';
import { fetchInternalStats } from './lib/stats';

export async function handleCronJob(env: any) {
    const ACCOUNTS_KEY = KV_KEYS.ACCOUNTS;
    const GLOBAL_CONFIG_KEY = KV_KEYS.GLOBAL_CONFIG;
    const configStr = await env.CONFIG_KV.get(GLOBAL_CONFIG_KEY);
    if (!configStr) return;
    const config = JSON.parse(configStr);
    if (!config.enabled) return;

    const now = Date.now();
    const lastCheck = config.lastCheck || 0;
    const intervalMs = (parseInt(config.interval) || 30) * 60 * 1000;

    if (now - lastCheck <= intervalMs) return;

    const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
    if (accounts.length === 0) return;

    const statsData = await fetchInternalStats(accounts);
    let actionTaken = false;

    const fuseThreshold = parseInt(config.fuseThreshold || 0);
    if (fuseThreshold > 0) {
        for (const acc of accounts) {
            const stat = statsData.find(s => s.alias === acc.alias);
            if (!stat || stat.error) continue;
            const limit = stat.max || 100000;
            if ((stat.total / limit) * 100 >= fuseThreshold) {
                const fuseTypes = Object.entries(TEMPLATES).filter(([, t]) => t.uuidField).map(([k]) => k);
                for (const ft of fuseTypes) {
                    await rotateUUIDAndDeploy(env, ft, accounts, ACCOUNTS_KEY);
                }
                actionTaken = true;
                break;
            }
        }
    }

    if (!actionTaken) {
        const updateTypes = Object.entries(TEMPLATES).filter(([, t]) => t.uuidField).map(([k]) => k);
        await Promise.all(updateTypes.map(type =>
            checkAndDeployUpdate(env, type, accounts, ACCOUNTS_KEY)
        ));
    }

    config.lastCheck = now;
    await env.CONFIG_KV.put(GLOBAL_CONFIG_KEY, JSON.stringify(config));
}

async function checkAndDeployUpdate(env: any, type: string, accounts: any[], accountsKey: string) {
    try {
        const deployConfig = JSON.parse(await env.CONFIG_KV.get(KV_KEYS.deployConfig(type)) || '{"mode":"latest"}');
        if (deployConfig.mode === 'fixed') return;

        const { handleCheckUpdate } = await import('./routes/check');
        const res = await handleCheckUpdate(env, type, 'latest');
        const checkData = await res.json();

        if (checkData.remote && (!checkData.local || checkData.remote.sha !== checkData.local.sha)) {
            const varsStr = await env.CONFIG_KV.get(KV_KEYS.vars(type));
            const variables = varsStr ? JSON.parse(varsStr) : [];
            const { coreDeployLogic } = await import('./routes/deploy');
            await coreDeployLogic(env, type, variables, [], accountsKey, 'latest');
        }
    } catch (e) { console.error(`[Update Error] ${type}: ${(e as Error).message}`); }
}

async function rotateUUIDAndDeploy(env: any, type: string, accounts: any[], accountsKey: string) {
    const VARS_KEY = KV_KEYS.vars(type);
    const varsStr = await env.CONFIG_KV.get(VARS_KEY);
    let variables: Array<{ key: string; value: string }> = varsStr ? JSON.parse(varsStr) : [];
    const uuidField = TEMPLATES[type].uuidField;
    if (!uuidField) return;

    let uuidUpdated = false;
    variables = variables.map(v => {
        if (v.key === uuidField) { v.value = crypto.randomUUID(); uuidUpdated = true; }
        return v;
    });
    if (!uuidUpdated) variables.push({ key: uuidField, value: crypto.randomUUID() });
    await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(variables));

    const deployConfig = JSON.parse(await env.CONFIG_KV.get(KV_KEYS.deployConfig(type)) || '{"mode":"latest"}');
    const targetSha = deployConfig.mode === 'fixed' ? deployConfig.currentSha : 'latest';
    const { coreDeployLogic } = await import('./routes/deploy');
    await coreDeployLogic(env, type, variables, [], accountsKey, targetSha);
}
