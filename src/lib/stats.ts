/**
 * 用量统计 — Cloudflare GraphQL 查询
 */

import { cf, getAuthHeaders, fetchWithTimeout } from './cloudflare-api';
import { pooledMap } from './concurrency';
import type { AccountEntry } from './types';

/** 免费计划的每日请求硬上限 */
export const FREE_PLAN_DAILY_LIMIT = 100000;

/** 根据当日实际用量推算每日配额上限：超过10万必然不是免费计划 */
function guessDailyLimit(total: number): number {
    if (total > FREE_PLAN_DAILY_LIMIT) return 10000000; // paid plan: 每天可能达千万级
    return FREE_PLAN_DAILY_LIMIT;                       // free plan: 硬限制 100K/天
}

export interface StatResult {
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
    const query = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
         viewer { accounts(filter: {accountTag: $AccountID}) {
             workersInvocationsAdaptive(limit: 1000, filter: $filter) { sum { requests } }
             pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
         }}}`;
    // 有界并发：账号多时全量并发容易撞 CF 限流（1200 次/5 分钟）
    return pooledMap(accounts, async (acc) => {
        try {
            if (!acc.globalKey) {
                return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: '密钥缺失或解密失败，请重新填写 API Key' };
            }
            const res = await fetchWithTimeout(cf.graphql(), {
                method: "POST", headers: getAuthHeaders(acc.email, acc.globalKey),
                body: JSON.stringify({ query: query, variables: { AccountID: acc.accountId, filter: { datetime_geq: todayStart.toISOString(), datetime_leq: now.toISOString() } } })
            });
            // 先判 HTTP 层：非 2xx 时 body 可能是 HTML 错误页，直接 json() 会抛异常
            if (!res.ok) {
                return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: "HTTP " + res.status + " (检查 API Key 权限)" };
            }
            let data: any;
            try { data = await res.json(); }
            catch { return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: 'GraphQL 响应不是合法 JSON' }; }
            // GraphQL 返回的错误信息（API Key 无权限等）
            if (data.errors) return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: data.errors[0]?.message || "GraphQL error" };
            const accountData = data.data?.viewer?.accounts?.[0];
            if (!accountData) return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: "无数据(检查 Account ID 是否正确)" };
            const workerReqs = sumRequests(accountData.workersInvocationsAdaptive);
            const pagesReqs = sumRequests(accountData.pagesFunctionsInvocationsAdaptiveGroups);
            const total = workerReqs + pagesReqs;
            return { alias: acc.alias, total, max: resolveMax(acc, total) };
        } catch (e: any) { return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: e.message }; }
    });
}

/** 累加 GraphQL 分组的 requests，容忍缺失的 sum 节点 */
function sumRequests(groups: unknown): number {
    if (!Array.isArray(groups)) return 0;
    return groups.reduce((acc: number, g: any) => acc + (g?.sum?.requests || 0), 0);
}
