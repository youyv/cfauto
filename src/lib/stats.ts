/**
 * 用量统计 — Cloudflare GraphQL 查询
 */

import { cf, getAuthHeaders } from './cloudflare-api';

interface Account {
    alias: string;
    accountId: string;
    email: string;
    globalKey: string;
    dailyLimit?: number;
}

export interface StatResult {
    alias: string;
    total: number;
    max: number;
    error?: string;
}

export async function fetchInternalStats(accounts: Account[]): Promise<StatResult[]> {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const query = `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
         viewer { accounts(filter: {accountTag: $AccountID}) {
             workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
             pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
         }}}`;
    return await Promise.all(accounts.map(async (acc) => {
        try {
            const res = await fetch(cf.graphql(), {
                method: "POST", headers: getAuthHeaders(acc.email, acc.globalKey),
                body: JSON.stringify({ query: query, variables: { AccountID: acc.accountId, filter: { datetime_geq: todayStart.toISOString(), datetime_leq: now.toISOString() } } })
            });
            const data: any = await res.json();
            // GraphQL 返回的错误信息（API Key 无权限等）
            if (data.errors) return { alias: acc.alias, total: 0, max: acc.dailyLimit || 100000, error: data.errors[0]?.message || "GraphQL error" };
            const accountData = data.data?.viewer?.accounts?.[0];
            if (!accountData) return { alias: acc.alias, total: 0, max: acc.dailyLimit || 100000, error: "无数据(检查 Account ID 是否正确)" };
            const workerReqs = accountData.workersInvocationsAdaptive?.reduce((a: number, b: any) => a + (b.sum.requests || 0), 0) || 0;
            const pagesReqs = accountData.pagesFunctionsInvocationsAdaptiveGroups?.reduce((a: number, b: any) => a + (b.sum.requests || 0), 0) || 0;
            return { alias: acc.alias, total: workerReqs + pagesReqs, max: acc.dailyLimit || 100000 };
        } catch (e: any) { return { alias: acc.alias, total: 0, max: acc.dailyLimit || 100000, error: e.message }; }
    }));
}
