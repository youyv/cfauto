/**
 * 路由: Zones / Workers 管理 / 子域名
 */

import { KV_KEYS, TEMPLATES, BINDING } from '../config/templates';
import { readAccounts, writeAccounts } from '../lib/account-store';
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
            const accounts = await readAccounts(env);
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
                await writeAccounts(env, accounts);
                // 检查各类型Worker是否已全部删除，是则清理关联的派生状态
                const allTypes = Object.keys(TEMPLATES);
                for (const t of allTypes) {
                    const hasAny = accounts.some((a: any) => a['workers_' + t] && a['workers_' + t].length > 0);
                    if (!hasAny) {
                        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(t), { mode: 'latest' });
                        await putJSON(env.CONFIG_KV, KV_KEYS.vars(t), []);
                        await putJSON(env.CONFIG_KV, KV_KEYS.favorites(t), []);
                    }
                }
            }

            // 删除关联的 KV 命名空间（轮询等待 CF 异步解绑，避免竞态失败）
            let kvDeleteErrors: string[] = [];
            if (deleteKv && kvNamespaceIds.length > 0) {
                for (const nsId of kvNamespaceIds) {
                    let deleted = false;
                    for (let attempt = 0; attempt < 5; attempt++) {
                        if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
                        const delRes = await fetch(cf.kvNamespace(cred.accountId, nsId), {
                            method: "DELETE", headers
                        });
                        if (delRes.ok) { deleted = true; break; }
                        // 409 Conflict = 命名空间仍处于绑定状态，等待后重试
                        if (delRes.status !== 409) break;
                    }
                    if (!deleted) {
                        kvDeleteErrors.push(nsId);
                        console.warn('[DeleteWorker] KV namespace deletion failed:', nsId);
                    }
                }
            }

            if (kvDeleteErrors.length > 0) {
                return json({ success: true, kvWarnings: kvDeleteErrors.length + ' 个 KV 命名空间删除失败，请到 Cloudflare Dashboard 手动清理' });
            }
            return json({ success: true });
        } else {
            const err = await delWorkerRes.json();
            return json({ success: false, msg: err.errors[0]?.message || "删除失败" });
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
            return json({ success: false, msg: data.errors?.[0]?.message || '查询失败' });
        }
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleChangeSubdomain(cred: AccountCredentials, newSubdomain: string) {
    try {
        const headers = getAuthHeaders(cred.email, cred.globalKey);
        // 先尝试直接 PUT（覆盖），避免无故删除已有子域名
        let res = await fetch(cf.acctSubdomain(cred.accountId), {
            method: 'PUT',
            headers,
            body: JSON.stringify({ subdomain: newSubdomain })
        });
        let data: any = await res.json();
        if (data.success) {
            return json({ success: true, subdomain: data.result?.subdomain || newSubdomain });
        }
        const errMsg = data.errors?.[0]?.message || '修改失败';
        // PUT 返回 "already has" 时，先保存旧值再删再建（含指数退避重试 + 失败恢复）
        if (errMsg.includes('already has')) {
            // 保存当前子域名用于失败恢复
            let oldSubdomain = '';
            try {
                const getRes = await fetch(cf.acctSubdomain(cred.accountId), { headers });
                const getData = await getRes.json();
                oldSubdomain = getData.result?.subdomain || '';
            } catch (_) { /* best-effort */ }

            const delRes = await fetch(cf.acctSubdomain(cred.accountId), { method: 'DELETE', headers });
            if (!delRes.ok) {
                return json({ success: false, msg: 'Cloudflare 不支持通过 API 修改已有子域名，请到 Dashboard → Workers & Pages → 设置中手动修改。' });
            }

            // 指数退避重试 PUT（最多3次: 1s, 2s, 4s）
            let putSuccess = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                res = await fetch(cf.acctSubdomain(cred.accountId), {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({ subdomain: newSubdomain })
                });
                data = await res.json();
                if (data.success) { putSuccess = true; break; }
            }

            if (putSuccess) {
                return json({ success: true, subdomain: data.result?.subdomain || newSubdomain });
            }

            // 恢复旧子域名（尽最大努力）
            if (oldSubdomain) {
                try {
                    await fetch(cf.acctSubdomain(cred.accountId), {
                        method: 'PUT', headers,
                        body: JSON.stringify({ subdomain: oldSubdomain })
                    });
                    return json({ success: false, msg: '新子域名设置失败，已恢复原子域名: ' + oldSubdomain + '。请稍后重试。' });
                } catch (_) {}
            }
            return json({ success: false, msg: '子域名修改失败，且无法自动恢复。请到 Dashboard → Workers & Pages → 设置中手动设置。' });
        }
        return json({ success: false, msg: errMsg });
    } catch (e: any) { return jsonError(e.message); }
}
