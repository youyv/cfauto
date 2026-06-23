/**
 * 路由: Zones / Workers 管理 / 子域名
 */

import { KV_KEYS, TEMPLATES } from '../config/templates';
import { cf, getAuthHeaders, jsonError, json } from '../lib/cloudflare-api';
import type { AccountCredentials } from '../config/env';
import { getJSON, putJSON } from "../lib/kv-utils";
import type { AppEnv } from "../config/env";

export async function handleGetZones(cred: AccountCredentials) {
    try {
        const headers = getAuthHeaders(cred.email, cred.globalKey);
        let allZones: Array<{ id: string; name: string }> = [];
        let page = 1;
        while (true) {
            const res = await fetch(cf.zones(cred.accountId) + '&page=' + page, { headers });
            const data: any = await res.json();
            if (!data.result || data.result.length === 0) break;
            data.result.forEach((z: any) => allZones.push({ id: z.id, name: z.name }));
            const totalPages = data.result_info?.total_pages || 0;
            if (page >= totalPages) break;
            page++;
        }
        return json({ success: true, zones: allZones });
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleGetAllWorkers(cred: AccountCredentials) {
    try {
        const res = await fetch(cf.workerScripts(cred.accountId), {
            headers: getAuthHeaders(cred.email, cred.globalKey)
        });
        const data: any = await res.json();
        const workers = data.result.map((w: any) => ({
            id: w.id,
            created_on: w.created_on,
            modified_on: w.modified_on
        }));
        return json({ success: true, workers });
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleDeleteWorker(env: AppEnv, cred: AccountCredentials, workerName: string, deleteKv: boolean) {
    try {
        const headers = getAuthHeaders(cred.email, cred.globalKey);

        let kvNamespaceIds: string[] = [];
        if (deleteKv) {
            const bindRes = await fetch(cf.workerBindings(cred.accountId, workerName), { headers });
            if (bindRes.ok) {
                const binds = (await bindRes.json()).result;
                kvNamespaceIds = binds.filter((b: any) => b.type === 'kv_namespace').map((b: any) => b.namespace_id);
            }
        }

        const delWorkerRes = await fetch(cf.workerScript(cred.accountId, workerName), {
            method: "DELETE", headers
        });

        if (delWorkerRes.ok) {
            const ACCOUNTS_KEY = KV_KEYS.ACCOUNTS;
            const accounts = await getJSON(env.CONFIG_KV, ACCOUNTS_KEY, []);
            let updated = false;

            for (const acc of accounts) {
                if (acc.accountId === cred.accountId) {
                    Object.keys(TEMPLATES).map(k => 'workers_' + k).forEach(type => {
                        if (acc[type] && acc[type].includes(workerName)) {
                            acc[type] = acc[type].filter((n: string) => n !== workerName);
                            updated = true;
                        }
                    });
                }
            }

            if (updated) {
                await putJSON(env.CONFIG_KV, ACCOUNTS_KEY, accounts);
                // 检查各类型Worker是否已全部删除，是则重置部署版本记录
                const allTypes = Object.keys(TEMPLATES);
                for (const t of allTypes) {
                    const hasAny = accounts.some((a: any) => a['workers_' + t] && a['workers_' + t].length > 0);
                    if (!hasAny) {
                        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(t), { mode: 'latest' });
                    }
                }
            }

            if (deleteKv && kvNamespaceIds.length > 0) {
                await new Promise(r => setTimeout(r, 1000));
                for (const nsId of kvNamespaceIds) {
                    await fetch(cf.kvNamespace(cred.accountId, nsId), {
                        method: "DELETE", headers
                    });
                }
            }
            return json({ success: true });
        } else {
            const err = await delWorkerRes.json();
            return new Response(JSON.stringify({ success: false, msg: err.errors[0]?.message || "删除失败" }), { status: 200 });
        }
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleFetchBindings(cred: AccountCredentials, workerName: string) {
    try {
        const res = await fetch(cf.workerBindings(cred.accountId, workerName), {
            headers: getAuthHeaders(cred.email, cred.globalKey)
        });
        const data: any = await res.json();
        const bindings = data.result
            .filter((b: any) => b.type === "plain_text" || b.type === "secret_text")
            .map((b: any) => ({ key: b.name, value: b.type === "plain_text" ? b.text : "" }));
        return json({ success: true, data: bindings });
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleGetSubdomain(cred: AccountCredentials) {
    try {
        const headers = getAuthHeaders(cred.email, cred.globalKey);
        const res = await fetch(cf.acctSubdomain(cred.accountId), { headers });
        const data: any = await res.json();
        if (data.success) {
            return json({ success: true, subdomain: data.result?.subdomain || '' });
        } else {
            return new Response(JSON.stringify({ success: false, msg: data.errors?.[0]?.message || '查询失败' }), { headers: { "Content-Type": "application/json" } });
        }
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleChangeSubdomain(cred: AccountCredentials, newSubdomain: string) {
    try {
        const headers = getAuthHeaders(cred.email, cred.globalKey);
        try {
            await fetch(cf.acctSubdomain(cred.accountId), { method: 'DELETE', headers });
        } catch (e) { console.warn('[changeSubdomain] DELETE failed:', (e as Error).message); }
        const res = await fetch(cf.acctSubdomain(cred.accountId), {
            method: 'PUT',
            headers,
            body: JSON.stringify({ subdomain: newSubdomain })
        });
        const data: any = await res.json();
        if (data.success) {
            return json({ success: true, subdomain: data.result?.subdomain || newSubdomain });
        } else {
            const errMsg = data.errors?.[0]?.message || '修改失败';
            if (errMsg.includes('already has')) {
                return new Response(JSON.stringify({ success: false, msg: 'Cloudflare 不支持通过 API 修改已有子域名，请到 Dashboard → Workers & Pages → 设置中手动修改。' }), { headers: { "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ success: false, msg: errMsg }), { headers: { "Content-Type": "application/json" } });
        }
    } catch (e: any) { return jsonError(e.message); }
}
