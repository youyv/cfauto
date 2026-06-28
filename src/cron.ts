/**
 * 定时任务 — 自动检查更新 + 熔断轮换
 */

import { KV_KEYS, TEMPLATES } from './config/templates';
import { getJSON, putJSON } from './lib/kv-utils';
import { readAccounts } from './lib/account-store';
import { decryptKey } from './lib/crypto-utils';
import { fetchInternalStats } from './lib/stats';
import { checkAndDeployUpdate, rotateUUIDAndDeploy } from './lib/auto-update';
import { logger } from './lib/logger';
import type { AppEnv } from "./config/env";

export async function handleCronJob(env: AppEnv) {
    const GLOBAL_CONFIG_KEY = KV_KEYS.GLOBAL_CONFIG;
    const config = await getJSON(env.CONFIG_KV, GLOBAL_CONFIG_KEY, null);
    if (!config) return;
    if (!config.enabled) return;

    const now = Date.now();
    const lastCheck = config.lastCheck || 0;
    const intervalMs = (parseInt(String(config.interval), 10) || 30) * 60 * 1000;

    if (now - lastCheck <= intervalMs) return;

    const accounts = await readAccounts(env);
    if (accounts.length === 0) return;

    try {
        await Promise.all(accounts.map(async (a: any) => { if (a.globalKey) a.globalKey = await decryptKey(env, a.globalKey); }));
        const statsData = await fetchInternalStats(accounts);
        const allErrored = statsData.length > 0 && statsData.every(s => s.error);
        if (allErrored) {
            logger.warn('cron: all accounts stats errored, skipping this cycle', { count: statsData.length });
            config.lastCheck = now;
            await putJSON(env.CONFIG_KV, GLOBAL_CONFIG_KEY, config);
            return;
        }
        let actionTaken = false;

        const fuseThreshold = parseInt(String(config.fuseThreshold || 0), 10);
        if (fuseThreshold > 0) {
            for (const acc of accounts) {
                const stat = statsData.find(s => s.alias === acc.alias);
                if (!stat || stat.error) continue;
                const limit = stat.max || 100000;
                if ((stat.total / limit) * 100 >= fuseThreshold) {
                    const fuseTypes = Object.entries(TEMPLATES).filter(([, t]) => t.uuidField).map(([k]) => k);
                    for (const ft of fuseTypes) {
                        const flagKey = 'auto' + ft.charAt(0).toUpperCase() + ft.slice(1);
                        if (config[flagKey] === false) continue;
                        await rotateUUIDAndDeploy(env, ft);
                    }
                    actionTaken = true;
                    await sendFuseAlert(env, acc.alias, stat.total, limit, fuseThreshold, config);
                    break;
                }
            }
        }

        if (!actionTaken) {
            const updateTypes = Object.entries(TEMPLATES).filter(([, t]) => t.uuidField).map(([k]) => k);
            const enabledTypes = updateTypes.filter(type => {
                const flagKey = 'auto' + type.charAt(0).toUpperCase() + type.slice(1);
                return config[flagKey] !== false;
            });
            if (enabledTypes.length > 0) {
                await Promise.all(enabledTypes.map(type =>
                    checkAndDeployUpdate(env, type)
                ));
            }
        }
    } catch (e) {
        logger.error('cron job failed', e as Error, { module: 'cron' });
    }

    config.lastCheck = now;
    await putJSON(env.CONFIG_KV, GLOBAL_CONFIG_KEY, config);
}

async function sendFuseAlert(env: AppEnv, alias: string, total: number, limit: number, threshold: number, config: any) {
    try {
        const webhookUrl = config.fuseWebhook;
        if (!webhookUrl) return;
        const payload = {
            msgtype: 'text',
            text: { content: '[Worker中控] \u{1F525} 熔断触发: ' + alias + ' 用量达 ' + ((total/limit)*100).toFixed(1) + '% (阈值' + threshold + '%), 已自动轮换UUID并重新部署' }
        };
        const webhookRes = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!webhookRes.ok) logger.warn('fuse webhook failed', { status: webhookRes.status });
    } catch (e) { logger.error('fuse webhook error', e as Error, { module: 'fuse' }); }
}
