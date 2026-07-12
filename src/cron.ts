/**
 * 定时任务 — 自动检查更新 + 熔断轮换
 */

import { KV_KEYS, TEMPLATES } from './config/templates';
import { getJSON, putJSON } from './lib/kv-utils';
import { readAccounts } from './lib/account-store';
import { fetchInternalStats } from './lib/stats';
import { checkAndDeployUpdate, rotateUUIDAndDeploy } from './lib/auto-update';
import { logger } from './lib/logger';
import type { AutoUpdateConfig } from './lib/types';
import type { AppEnv } from "./config/env";

/** 模板类型 → AutoUpdateConfig 开关字段映射（编译期类型安全） */
const AUTO_FLAG: Record<string, keyof AutoUpdateConfig> = {
    cmliu: 'autoCmliu', joey: 'autoJoey', ech: 'autoEch'
};

export async function handleCronJob(env: AppEnv) {
    const GLOBAL_CONFIG_KEY = KV_KEYS.GLOBAL_CONFIG;
    const config = await getJSON(env.CONFIG_KV, GLOBAL_CONFIG_KEY, null) as AutoUpdateConfig | null;
    if (!config) return;
    if (!config.enabled) return;

    const now = Date.now();
    const lastCheck = config.lastCheck || 0;
    const intervalMs = (parseInt(String(config.interval), 10) || 30) * 60 * 1000;

    if (now - lastCheck <= intervalMs) return;

    const accounts = await readAccounts(env);
    if (accounts.length === 0) return;

    try {
        // readAccounts 已自动解密 globalKey，无需再次解密
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
                        const flagKey = AUTO_FLAG[ft];
                        if (flagKey && config[flagKey] === false) continue;
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
                const flagKey = AUTO_FLAG[type];
                return !flagKey || config[flagKey] !== false;
            });
            if (enabledTypes.length > 0) {
                // 顺序执行避免瞬间并发超过 Cloudflare API 限流（1200次/5分钟）
                for (const type of enabledTypes) {
                    await checkAndDeployUpdate(env, type);
                }
            }
        }
    } catch (e) {
        logger.error('cron job failed', e as Error, { module: 'cron' });
    }

    config.lastCheck = now;
    await putJSON(env.CONFIG_KV, GLOBAL_CONFIG_KEY, config);
}

async function sendFuseAlert(env: AppEnv, alias: string, total: number, limit: number, threshold: number, config: AutoUpdateConfig) {
    try {
        const webhookUrl = config.fuseWebhook;
        if (!webhookUrl) return;
        if (!webhookUrl.startsWith("https://")) { logger.warn("fuseWebhook URL must use https", { url: webhookUrl }); return; }
        const payload = {
            msgtype: 'text',
            text: { content: '[Worker中控] \u{1F525} 熔断触发: ' + alias + ' 用量达 ' + ((total/limit)*100).toFixed(1) + '% (阈值' + threshold + '%), 已自动轮换UUID并重新部署' }
        };
        const webhookRes = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!webhookRes.ok) logger.warn('fuse webhook failed', { status: webhookRes.status });
    } catch (e) { logger.error('fuse webhook error', e as Error, { module: 'fuse' }); }
}
