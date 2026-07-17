/**
 * 路由: Zones / Workers 管理 / 子域名
 * 
 * 安全约束: 所有 handler 使用服务端 KV 存储的凭据（通过 accountId 查找），
 * 不再接受请求体中的 email/globalKey，防止已登录用户操作未授权账号。
 */

import { KV_KEYS, TEMPLATES } from '../config/templates';
import { readAccounts, writeAccounts, findAccount } from '../lib/account-store';
import { cf, getAuthHeaders, jsonError, json } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";

/** 从服务端 KV 查找账号凭据并返回认证头，未找到则抛出 Response 错误 */
async function resolveCredentials(env: AppEnv, accountId: string) {
    const acc = await findAccount(env, accountId);
    if (!acc) throw new Response(JSON.stringify({ success: false, msg: '账号未在服务端配置' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return { accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey, headers: getAuthHeaders(acc.email, acc.globalKey) };
}

export async function handleGetZones(env: AppEnv, accountId: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        let allZones: Array<{ id: string; name: string }> = [];
        let page = 1;
        while (true) {
            const res = await fetch(cf.zones(aid) + '&page=' + page, { headers });
            const data: any = await res.json();
            if (!data.result || data.result.length === 0) break;
            data.result.forEach((z: any) => allZones.push({ id: z.id, name: z.name }));
            const totalPages = data.result_info?.total_pages || 0;
            if (page >= totalPages) break;
            page++;
        }
        return json({ success: true, zones: allZones });
    } catch (e: any) { logger.error('handleGetZones failed', e instanceof Error ? e : new Error(String(e)), { module: 'zones' }); return jsonError('Zones fetch failed'); }
}

export async function handleGetAllWorkers(env: AppEnv, accountId: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        const res = await fetch(cf.workerScripts(aid), { headers });
        const data: any = await res.json();
        const workers = data.result.map((w: any) => ({
            id: w.id,
            created_on: w.created_on,
            modified_on: w.modified_on
        }));
        return json({ success: true, workers });
    } catch (e: any) { logger.error('Operation failed', e instanceof Error ? e : new Error(String(e)), { module: 'zones' }); return jsonError('Operation failed'); }
}

export async function handleDeleteWorker(env: AppEnv, accountId: string, workerName: string, deleteKv: boolean) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);

        let kvNamespaceIds: string[] = [];
        if (deleteKv) {
            const bindRes = await fetch(cf.workerBindings(aid, workerName), { headers });
            if (bindRes.ok) {
                const binds = (await bindRes.json()).result;
                kvNamespaceIds = binds.filter((b: any) => b.type === 'kv_namespace').map((b: any) => b.namespace_id);
            }
        }

        const delWorkerRes = await fetch(cf.workerScript(aid, workerName), {
            method: "DELETE", headers
        });

        if (delWorkerRes.ok) {
            const accounts = await readAccounts(env);
            let updated = false;

            for (const acc of accounts) {
                if (acc.accountId === aid) {
                    Object.keys(TEMPLATES).forEach(k => {
                        const t = 'workers_' + k;
                        if (acc[t] && acc[t].includes(workerName)) {
                            acc[t] = acc[t].filter((n: string) => n !== workerName);
                            updated = true;
                        }
                    });
                }
            }

            if (updated) {
                await writeAccounts(env, accounts);
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

            let kvDeleteErrors: string[] = [];
            if (deleteKv && kvNamespaceIds.length > 0) {
                for (const nsId of kvNamespaceIds) {
                    let deleted = false;
                    for (let attempt = 0; attempt < 5; attempt++) {
                        if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
                        const delRes = await fetch(cf.kvNamespace(aid, nsId), {
                            method: "DELETE", headers
                        });
                        if (delRes.ok) { deleted = true; break; }
                        if (delRes.status !== 409) break;
                    }
                    if (!deleted) {
                        kvDeleteErrors.push(nsId);
                        logger.warn('KV namespace deletion failed', { module: 'zones', nsId });
                    }
                }
            }

            if (kvDeleteErrors.length > 0) {
                return json({ success: true, kvWarnings: kvDeleteErrors.length + ' 个 KV 命名空间删除失败，请到 Cloudflare Dashboard 手动清理' });
            }
            return json({ success: true });
        } else {
            const err = await delWorkerRes.json();
            return json({ success: false, msg: err.errors?.[0]?.message || "删除失败" });
        }
    } catch (e: any) {
        if (e instanceof Response) return e;
        logger.error('handleDeleteWorker failed', e instanceof Error ? e : new Error(String(e)), { module: 'zones' }); return jsonError('Delete worker failed');
    }
}

export async function handleFetchBindings(env: AppEnv, accountId: string, workerName: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        const res = await fetch(cf.workerBindings(aid, workerName), { headers });
        const data: any = await res.json();
        const bindings = data.result
            .filter((b: any) => b.type === "plain_text" || b.type === "secret_text")
            .map((b: any) => ({ key: b.name, value: b.type === "plain_text" ? b.text : "" }));
        return json({ success: true, data: bindings });
    } catch (e: any) { logger.error('Operation failed', e instanceof Error ? e : new Error(String(e)), { module: 'zones' }); return jsonError('Operation failed'); }
}

export async function handleGetSubdomain(env: AppEnv, accountId: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        const res = await fetch(cf.acctSubdomain(aid), { headers });
        const data: any = await res.json();
        if (data.success) {
            return json({ success: true, subdomain: data.result?.subdomain || '' });
        } else {
            return json({ success: false, msg: data.errors?.[0]?.message || '查询失败' });
        }
    } catch (e: any) { logger.error('Operation failed', e instanceof Error ? e : new Error(String(e)), { module: 'zones' }); return jsonError('Operation failed'); }
}

export async function handleChangeSubdomain(env: AppEnv, accountId: string, newSubdomain: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        let res = await fetch(cf.acctSubdomain(aid), {
            method: 'PUT',
            headers,
            body: JSON.stringify({ subdomain: newSubdomain })
        });
        let data: any = await res.json();
        if (data.success) {
            return json({ success: true, subdomain: data.result?.subdomain || newSubdomain });
        }
        const errMsg = data.errors?.[0]?.message || '修改失败';
        if (errMsg.includes('already has')) {
            let oldSubdomain = '';
            try {
                const getRes = await fetch(cf.acctSubdomain(aid), { headers });
                const getData = await getRes.json();
                oldSubdomain = getData.result?.subdomain || '';
            } catch (_) { logger.warn('changeSubdomain get old subdomain failed', { module: 'zones' }); }

            const delRes = await fetch(cf.acctSubdomain(aid), { method: 'DELETE', headers });
            if (!delRes.ok) {
                return json({ success: false, msg: 'Cloudflare 不支持通过 API 修改已有子域名，请到 Dashboard → Workers & Pages → 设置中手动修改。' });
            }

            let putSuccess = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                res = await fetch(cf.acctSubdomain(aid), {
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

            if (oldSubdomain) {
                try {
                    await fetch(cf.acctSubdomain(aid), {
                        method: 'PUT', headers,
                        body: JSON.stringify({ subdomain: oldSubdomain })
                    });
                    return json({ success: false, msg: '新子域名设置失败，已恢复原子域名: ' + oldSubdomain + '。请稍后重试。' });
                } catch (_) { logger.warn('Failed to restore old subdomain', { module: 'zones', oldSubdomain }); }
            }
            return json({ success: false, msg: '子域名修改失败，且无法自动恢复。请到 Dashboard → Workers & Pages → 设置中手动设置。' });
        }
        return json({ success: false, msg: errMsg });
    } catch (e: any) { logger.error('Operation failed', e instanceof Error ? e : new Error(String(e)), { module: 'zones' }); return jsonError('Operation failed'); }
}
