/**
 * 定时任务 — 自动检查更新 + 熔断轮换 + KV 回收
 */

import { KV_KEYS, autoUpdateTypes, fuseRotatableTypes, autoFlagKey } from './config/templates';
import { getJSON, putJSON } from './lib/kv-utils';
import { readAccounts } from './lib/account-store';
import { fetchInternalStats } from './lib/stats';
import { checkAndDeployUpdate, rotateUUIDAndDeploy } from './lib/auto-update';
import { runKvGc, readLiveAccountIds, GC_INTERVAL_MS } from './lib/kv-gc';
import { logger } from './lib/logger';
import { fetchWithTimeout } from './lib/cloudflare-api';
import type { AutoUpdateConfig } from './lib/types';
import type { AppEnv } from "./config/env";

/** 模板的自动更新开关是否开启（配置里显式 false 才算关闭，缺省视为开启） */
function isTypeEnabled(config: AutoUpdateConfig, type: string): boolean {
    const flag = (config as unknown as Record<string, unknown>)[autoFlagKey(type)];
    return flag !== false;
}

/** 是否到了执行 KV 回收的时间。纯函数，导出供测试覆盖 */
export function shouldRunGc(lastGc: number | undefined, now: number, intervalMs = GC_INTERVAL_MS): boolean {
    return now - (lastGc || 0) >= intervalMs;
}

/**
 * KV 回收 —— 与自动更新完全解耦，**即使 enabled 为 false 也执行**。
 *
 * 理由：孤儿键和超长日志的产生与「是否开启自动更新」无关（手动部署、删账号、
 * 恢复备份都会留下垃圾），关掉自动更新反而更需要有人来收拾。节流靠独立的
 * `lastGc` 字段（24h），不占用 `lastCheck` 的语义。
 *
 * 账号表不可信时**跳过本轮**（readLiveAccountIds 返回 null）：空账号集合会让
 * collectOrphanKeys 把所有账号级覆盖判为孤儿，那是不可接受的破坏性后果。
 */
async function maybeRunKvGc(env: AppEnv): Promise<void> {
    try {
        const cfg = await getJSON<AutoUpdateConfig | null>(env.CONFIG_KV, KV_KEYS.GLOBAL_CONFIG, null);
        if (!shouldRunGc(cfg?.lastGc, Date.now())) return;
        const accountIds = await readLiveAccountIds(env.CONFIG_KV);
        if (accountIds === null) {
            logger.warn('cron: 账号表不可信，跳过本轮 KV 回收', { module: 'cron' });
            return;
        }
        const result = await runKvGc(env, accountIds);
        // 无论是否有清理动作都推进 lastGc，避免每 5 分钟重复 list 一遍 KV
        const latest = await getJSON<AutoUpdateConfig | null>(env.CONFIG_KV, KV_KEYS.GLOBAL_CONFIG, null);
        await putJSON(env.CONFIG_KV, KV_KEYS.GLOBAL_CONFIG, { ...(latest || cfg || {}), lastGc: Date.now() });
        if (!result.listComplete) {
            logger.warn('cron: KV 回收未列完全部键，下轮继续', { module: 'cron' });
        }
    } catch (e) {
        logger.error('cron: KV 回收失败', e as Error, { module: 'cron' });
    }
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

/**
 * cron 入口。
 *
 * 拆成「自动更新（runAutoUpdate）」+「KV 回收（maybeRunKvGc）」两段，两段互不影响：
 * 更新流程里任何 early return / 异常都不会让回收被跳过。此前把回收写在同一个函数尾部
 * 时，`if (!config.enabled) return` 之类的提前退出会连带跳过回收 —— 而那恰恰是最需要
 * 回收的场景（关掉了自动更新，仍在手动部署与增删账号）。
 */
export async function handleCronJob(env: AppEnv) {
    await runAutoUpdate(env);
    await maybeRunKvGc(env);
}

async function runAutoUpdate(env: AppEnv) {
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
                    await sendFuseAlert(acc.alias, stat!.total, stat!.max || 100000, fuseThreshold, config);
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

/** 发送熔断告警 webhook（不需要 env：webhook URL 来自 config，非环境变量） */
async function sendFuseAlert(alias: string, total: number, limit: number, threshold: number, config: AutoUpdateConfig) {
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
