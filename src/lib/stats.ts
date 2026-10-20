import { BILLING_METRICS_QUERY } from './billing-query';
/**
 * 用量统计 — Cloudflare GraphQL 查询
 */

import { cf, getAuthHeaders, fetchWithTimeout } from './cloudflare-api';
import { pooledMap } from './concurrency';
import { hasAccountCredentials } from './account-store';
import type { AccountEntry } from './types';

/** 免费计划的每日请求硬上限 */
export const FREE_PLAN_DAILY_LIMIT = 100000;

/** 根据当日实际用量推算每日配额上限：超过10万必然不是免费计划 */
function guessDailyLimit(total: number): number {
    if (total > FREE_PLAN_DAILY_LIMIT) return 10000000; // paid plan: 每天可能达千万级
    return FREE_PLAN_DAILY_LIMIT;                       // free plan: 硬限制 100K/天
}

export interface StatResult {
    accountId: string;
    alias: string;
    total: number;
    max: number;
    error?: string;
}

/**
 * 解析账号配额上限：显式设置且 > 0 时用它，否则回落默认 10 万（免费计划）。
 * 区分「未设置」与「显式设为 0」——后者不应被 falsy 判断吞掉。
 */
export function resolveLimit(acc: Pick<AccountEntry, 'dailyLimit'>): number {
    return (acc.dailyLimit !== undefined && acc.dailyLimit > 0) ? acc.dailyLimit : FREE_PLAN_DAILY_LIMIT;
}

/** 账号是否显式配置了配额上限（区别于「未设置」与「显式设为 0」） */
function hasExplicitLimit(acc: Pick<AccountEntry, 'dailyLimit'>): boolean {
    return acc.dailyLimit !== undefined && acc.dailyLimit > 0;
}

/**
 * 统一的配额上限解析 — 成功路径与失败路径都必须走这里。
 *
 * 此前成功路径内联了 `dailyLimit > 0 ? dailyLimit : guessDailyLimit(total)`，
 * 与失败路径的 resolveLimit 在「未显式设置」时给出不同结果（1000 万 vs 10 万），
 * 导致同一账号统计成功时熔断永不触发、失败时却可能触发。
 */
function resolveMax(acc: Pick<AccountEntry, 'dailyLimit'>, total: number): number {
    return hasExplicitLimit(acc) ? acc.dailyLimit! : guessDailyLimit(total);
}

export async function fetchInternalStats(accounts: AccountEntry[]): Promise<StatResult[]> {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const query = BILLING_METRICS_QUERY;
    // 有界并发：账号多时全量并发容易撞 CF 限流（1200 次/5 分钟）
    return pooledMap(accounts, async (acc) => {
        try {
            if (!hasAccountCredentials(acc)) {
                return { accountId: acc.accountId, alias: acc.alias, total: 0, max: resolveLimit(acc), error: '未配置凭据或解密失败，请重新填写 API Key / API Token' };
            }
            const res = await fetchWithTimeout(cf.graphql(), {
                method: "POST", headers: getAuthHeaders(acc),
                body: JSON.stringify({ query: query, variables: { AccountID: acc.accountId, filter: { datetime_geq: todayStart.toISOString(), datetime_leq: now.toISOString() } } })
            });
            // 先判 HTTP 层：非 2xx 时 body 可能是 HTML 错误页，直接 json() 会抛异常
            if (!res.ok) {
                // Free the response connection before this pool slot starts another account.
                await res.body?.cancel();
                return { accountId: acc.accountId, alias: acc.alias, total: 0, max: resolveLimit(acc), error: "HTTP " + res.status + " (检查 API Key 权限)" };
            }
            let data: any;
            try { data = await res.json(); }
            catch { return { accountId: acc.accountId, alias: acc.alias, total: 0, max: resolveLimit(acc), error: 'GraphQL 响应不是合法 JSON' }; }
            // GraphQL 返回的错误信息（API Key 无权限等）
            if (data.errors) return { accountId: acc.accountId, alias: acc.alias, total: 0, max: resolveLimit(acc), error: data.errors[0]?.message || "GraphQL error" };
            const accountRows = data.data?.viewer?.accounts;
            const accountData = Array.isArray(accountRows) && accountRows.length === 1 ? accountRows[0] : null;
            if (!accountData) return { accountId: acc.accountId, alias: acc.alias, total: 0, max: resolveLimit(acc), error: "无数据(检查 Account ID 是否正确)" };
            const workerReqs = parseUsageGroups(accountData.workersInvocationsAdaptive);
            const pagesReqs = parseUsageGroups(accountData.pagesFunctionsInvocationsAdaptiveGroups);
            if (workerReqs === null || pagesReqs === null || !Number.isSafeInteger(workerReqs + pagesReqs)) return { accountId: acc.accountId, alias: acc.alias, total: 0, max: resolveLimit(acc), error: '统计结构不完整、已截断或数值无效；禁止据此熔断' };
            const total = workerReqs + pagesReqs;
            return { accountId: acc.accountId, alias: acc.alias, total, max: resolveMax(acc, total) };
        } catch (e: any) { return { accountId: acc.accountId, alias: acc.alias, total: 0, max: resolveLimit(acc), error: e.message }; }
    });
}

/** A limit-sized response may be truncated. Missing or malformed groups are unknown,
 * never usable zero; only an explicitly empty array is a complete zero observation. */
export function parseUsageGroups(groups: unknown): number | null {
    if (!Array.isArray(groups) || groups.length >= 1000) return null;
    let total=0;
    for (const group of groups) {
        const count=group?.sum?.requests;
        if (!Number.isSafeInteger(count) || count<0 || !Number.isSafeInteger(total+count)) return null;
        total+=count;
    }
    return total;
}
/** Labels are mutable and non-unique. Duplicate provider/account results fail closed. */
export function statForAccount(stats: StatResult[], accountId: string): StatResult | undefined {
    const matches=stats.filter(s=>s.accountId===accountId);
    return matches.length===1 ? matches[0] : undefined;
}

/** 熔断判定 — 纯函数，导出供测试覆盖边界（0 阈值、缺 stats、limit 兜底） */
export function isFuseTriggered(
    stat: { total: number; max: number; error?: string } | undefined,
    threshold: number
): boolean {
    if (!Number.isFinite(threshold) || threshold <= 0) return false;
    if (!stat || stat.error || !Number.isSafeInteger(stat.total) || stat.total < 0 || !Number.isSafeInteger(stat.max) || stat.max <= 0) return false;
    const limit = stat.max;
    return (stat.total / limit) * 100 >= threshold;
}
