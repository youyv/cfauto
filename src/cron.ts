/**
 * 定时任务 — 自动检查更新 + 熔断轮换
 */

import { KV_KEYS, autoUpdateTypes, fuseRotatableTypes, autoFlagKey } from './config/templates';
import { getJSON, putJSON } from './lib/kv-utils';
import { readAccounts } from './lib/account-store';
import { fetchInternalStats } from './lib/stats';
import { checkAndDeployUpdate, rotateUUIDAndDeploy } from './lib/auto-update';
import { logger } from './lib/logger';
import { fetchWithTimeout } from './lib/cloudflare-api';
import type { AutoUpdateConfig } from './lib/types';
import type { AppEnv } from "./config/env";

/** 模板的自动更新开关是否开启（配置里显式 false 才算关闭，缺省视为开启） */
function isTypeEnabled(config: AutoUpdateConfig, type: string): boolean {
    const flag = (config as unknown as Record<string, unknown>)[autoFlagKey(type)];
    return flag !== false;
}

/** 熔断判定 — 纯函数，导出供测试覆盖边界（0 阈值、缺 stats、limit 兜底） */
export function isFuseTriggered(
    stat: { total: number; max: number; error?: string } | undefined,
    threshold: number
): boolean {
    if (threshold <= 0) return false;
    if (!stat || stat.error) return false;
    const limit = stat.max || 100000;
    if (limit <= 0) return false;
    return (stat.total / limit) * 100 >= threshold;
}

export async function handleCronJob(env: AppEnv) {
    const GLOBAL_CONFIG_KEY = KV_KEYS.GLOBAL_CONFIG;
    let savedConfig: AutoUpdateConfig | null = null;
    try {
        const config = await getJSON<AutoUpdateConfig | null>(env.CONFIG_KV, GLOBAL_CONFIG_KEY, null);
        if (!config || !config.enabled) return;
        savedConfig = config;

        const now = Date.now();
        const lastCheck = config.lastCheck || 0;
        const intervalMs = (parseInt(String(config.interval), 10) || 30) * 60 * 1000;

        if (now - lastCheck <= intervalMs) return;

        const accounts = await readAccounts(env);
        if (accounts.length === 0) {
            // 空账号也更新 lastCheck，避免每次调度都重复读 KV
            config.lastCheck = now;
            await putJSON(env.CONFIG_KV, GLOBAL_CONFIG_KEY, config);
            return;
        }

        // readAccounts 已自动解密 globalKey，无需再次解密
        const statsData = await fetchInternalStats(accounts);
        const allErrored = statsData.length > 0 && statsData.every(s => s.error);
        if (allErrored) {
            logger.warn('cron: all accounts stats errored, skipping this cycle', { count: statsData.length });
            return;
        }

        // ===== 熔断：只轮换真正超限账号的 UUID =====
        // 此前 rotateUUIDAndDeploy 不传 accountIds，导致一个账号超限就把所有账号的 UUID
        // 一起换掉，全部订阅链接同时失效。现在逐账号定向轮换。
        const fuseThreshold = parseInt(String(config.fuseThreshold || 0), 10);
        const fusedAccounts: string[] = [];
        if (fuseThreshold > 0) {
            const rotatable = fuseRotatableTypes().filter(t => isTypeEnabled(config, t));
            for (const acc of accounts) {
                try {
                    const stat = statsData.find(s => s.alias === acc.alias);
                    if (!isFuseTriggered(stat, fuseThreshold)) continue;
                    for (const ft of rotatable) {
                        await rotateUUIDAndDeploy(env, ft, [acc.accountId]);
                    }
                    fusedAccounts.push(acc.alias);
                    await sendFuseAlert(env, acc.alias, stat!.total, stat!.max || 100000, fuseThreshold, config);
                } catch (e) {
                    // 单账号熔断失败不中断其余账号
                    logger.error('cron: fuse check failed for ' + acc.alias, e as Error, { module: 'cron' });
                }
            }
        }

        // ===== 版本更新检查 =====
        // 与熔断不再互斥：熔断只影响超限账号的 UUID，其余账号仍应跟随上游更新。
        // 参与更新的类型由 TEMPLATES[].autoUpdate 决定，不再借用 uuidField
        // （ech 无 UUID 但同样需要更新，此前被静默排除，UI 开关形同虚设）。
        const enabledTypes = autoUpdateTypes().filter(t => isTypeEnabled(config, t));
        if (enabledTypes.length > 0) {
            // 顺序执行避免瞬间并发超过 Cloudflare API 限流（1200次/5分钟）
            for (const type of enabledTypes) {
                await checkAndDeployUpdate(env, type);
            }
        }
        if (fusedAccounts.length > 0) {
            logger.audit('cron fuse summary', { accounts: fusedAccounts, threshold: fuseThreshold });
        }
    } catch (e) {
        logger.error('cron job failed', e as Error, { module: 'cron' });
    }

    // GUARANTEED: 配置已启用并进入工作流后，无论成功/失败/异常都持久化 lastCheck，防止重复触发
    if (savedConfig && savedConfig.enabled) {
        try {
            // 重读一次，避免用内存里的旧快照覆盖本轮部署写入的其他字段
            const latest = await getJSON<AutoUpdateConfig | null>(env.CONFIG_KV, GLOBAL_CONFIG_KEY, null);
            const toWrite: AutoUpdateConfig = { ...(latest || savedConfig), lastCheck: Date.now() };
            await putJSON(env.CONFIG_KV, GLOBAL_CONFIG_KEY, toWrite);
        } catch (e) {
            logger.error('cron: persist lastCheck failed', e as Error, { module: 'cron' });
        }
    }
}

/** 掩码 URL 中的敏感段（query/token），仅保留协议+主机+路径前段 */
function maskUrl(url: string): string {
    try {
        const u = new URL(url);
        u.search = '';
        return u.origin + u.pathname;
    } catch { return 'invalid-url'; }
}

async function sendFuseAlert(env: AppEnv, alias: string, total: number, limit: number, threshold: number, config: AutoUpdateConfig) {
    try {
        const webhookUrl = config.fuseWebhook;
        if (!webhookUrl) return;
        if (!webhookUrl.startsWith("https://")) { logger.warn("fuseWebhook URL must use https", { url: maskUrl(webhookUrl) }); return; }
        const payload = {
            msgtype: 'text',
            text: { content: '[Worker中控] \u{1F525} 熔断触发: ' + alias + ' 用量达 ' + ((total/limit)*100).toFixed(1) + '% (阈值' + threshold + '%), 已自动轮换该账号 UUID 并重新部署' }
        };
        const webhookRes = await fetchWithTimeout(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 10000);
        if (!webhookRes.ok) logger.warn('fuse webhook failed', { status: webhookRes.status });
    } catch (e) { logger.error('fuse webhook error', e as Error, { module: 'fuse' }); }
}
