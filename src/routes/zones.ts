/**
 * 路由: Zones / Workers 管理 / 子域名
 */

import { KV_KEYS } from '../config/templates';
import { cf, getAuthHeaders, jsonError, json } from '../lib/cloudflare-api';

export async function handleGetZones(accountId: string, email: string, key: string) {
    try {
        const res = await fetch(cf.zones(accountId), {
            headers: getAuthHeaders(email, key)
        });
        const data: any = await res.json();
        const zones = data.result.map((z: any) => ({ id: z.id, name: z.name }));
        return json({ success: true, zones });
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleGetAllWorkers(accountId: string, email: string, key: string) {
    try {
        const res = await fetch(cf.workerScripts(accountId), {
            headers: getAuthHeaders(email, key)
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

export async function handleDeleteWorker(env: any, accountId: string, email: string, key: string, workerName: string, deleteKv: boolean) {
    try {
        const headers = getAuthHeaders(email, key);

        let kvNamespaceIds: string[] = [];
        if (deleteKv) {
            const bindRes = await fetch(cf.workerBindings(accountId, workerName), { headers });
            if (bindRes.ok) {
                const binds = (await bindRes.json()).result;
                kvNamespaceIds = binds.filter((b: any) => b.type === 'kv_namespace').map((b: any) => b.namespace_id);
            }
        }

        const delWorkerRes = await fetch(cf.workerScript(accountId, workerName), {
            method: "DELETE", headers
        });

        if (delWorkerRes.ok) {
            const ACCOUNTS_KEY = KV_KEYS.ACCOUNTS;
            const accounts = JSON.parse(await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]");
            let updated = false;

            for (const acc of accounts) {
                if (acc.accountId === accountId) {
                    ['workers_cmliu', 'workers_joey', 'workers_ech'].forEach(type => {
                        if (acc[type] && acc[type].includes(workerName)) {
                            acc[type] = acc[type].filter((n: string) => n !== workerName);
                            updated = true;
                        }
                    });
                }
            }

            if (updated) {
                await env.CONFIG_KV.put(ACCOUNTS_KEY, JSON.stringify(accounts));
            }

            if (deleteKv && kvNamespaceIds.length > 0) {
                await new Promise(r => setTimeout(r, 1000));
                for (const nsId of kvNamespaceIds) {
                    await fetch(cf.kvNamespace(accountId, nsId), {
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

export async function handleFetchBindings(accountId: string, email: string, key: string, workerName: string) {
    try {
        const res = await fetch(cf.workerBindings(accountId, workerName), {
            headers: getAuthHeaders(email, key)
        });
        const data: any = await res.json();
        const bindings = data.result
            .filter((b: any) => b.type === "plain_text" || b.type === "secret_text")
            .map((b: any) => ({ key: b.name, value: b.type === "plain_text" ? b.text : "" }));
        return json({ success: true, data: bindings });
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleGetSubdomain(accountId: string, email: string, key: string) {
    try {
        const headers = getAuthHeaders(email, key);
        const res = await fetch(cf.acctSubdomain(accountId), { headers });
        const data: any = await res.json();
        if (data.success) {
            return json({ success: true, subdomain: data.result?.subdomain || '' });
        } else {
            return new Response(JSON.stringify({ success: false, msg: data.errors?.[0]?.message || '查询失败' }), { headers: { "Content-Type": "application/json" } });
        }
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleChangeSubdomain(accountId: string, email: string, key: string, newSubdomain: string) {
    try {
        const headers = getAuthHeaders(email, key);
        try {
            await fetch(cf.acctSubdomain(accountId), { method: 'DELETE', headers });
        } catch (e) { }
        const res = await fetch(cf.acctSubdomain(accountId), {
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
