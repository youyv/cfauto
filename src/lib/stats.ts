/**
 * 用量统计 — Cloudflare GraphQL 查询
 */

import { cf, getAuthHeaders, fetchWithTimeout } from './cloudflare-api';

interface Account {
    alias: string;
    accountId: string;
    email: string;
    globalKey: string;
    dailyLimit?: number;
}

/** 根据当日实际用量推算每日配额上限：超过10万必然不是免费计划 */
function guessDailyLimit(total: number): number {
    if (total > 100000) return 10000000; // paid plan: 每天可能达千万级
    return 100000;                       // free plan: 硬限制 100K/天
}

export interface StatResult {
    alias: string;
    total: number;
    max: number;
    error?: string;
}

/** 解析账号配额上限：显式设置且 > 0 时用它，否则回落默认 10 万（免费计划） */
function resolveLimit(acc: Account): number {
    return (acc.dailyLimit !== undefined && acc.dailyLimit > 0) ? acc.dailyLimit : 100000;
}

export async function fetchInternalStats(accounts: Account[]): Promise<StatResult[]> {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const query = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
         viewer { accounts(filter: {accountTag: $AccountID}) {
             workersInvocationsAdaptive(limit: 1000, filter: $filter) { sum { requests } }
             pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
         }}}`;
    return await Promise.all(accounts.map(async (acc) => {
        try {
            const res = await fetchWithTimeout(cf.graphql(), {
                method: "POST", headers: getAuthHeaders(acc.email, acc.globalKey),
                body: JSON.stringify({ query: query, variables: { AccountID: acc.accountId, filter: { datetime_geq: todayStart.toISOString(), datetime_leq: now.toISOString() } } })
            });
            // 先判 HTTP 层：非 2xx 时 body 可能是 HTML 错误页，直接 json() 会抛异常
            if (!res.ok) {
                return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: "HTTP " + res.status + " (检查 API Key 权限)" };
            }
            const data: any = await res.json();
            // GraphQL 返回的错误信息（API Key 无权限等）
            if (data.errors) return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: data.errors[0]?.message || "GraphQL error" };
            const accountData = data.data?.viewer?.accounts?.[0];
            if (!accountData) return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: "无数据(检查 Account ID 是否正确)" };
            const workerReqs = accountData.workersInvocationsAdaptive?.reduce((a: number, b: any) => a + (b.sum.requests || 0), 0) || 0;
            const pagesReqs = accountData.pagesFunctionsInvocationsAdaptiveGroups?.reduce((a: number, b: any) => a + (b.sum.requests || 0), 0) || 0;
            const total = workerReqs + pagesReqs;
            return { alias: acc.alias, total, max: (acc.dailyLimit !== undefined && acc.dailyLimit > 0) ? acc.dailyLimit : guessDailyLimit(total) };
        } catch (e: any) { return { alias: acc.alias, total: 0, max: resolveLimit(acc), error: e.message }; }
    }));
}
