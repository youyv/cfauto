/**
 * 路由: Zones / Workers 管理 / 子域名
 * 
 * 安全约束: 所有 handler 使用服务端 KV 存储的凭据（通过 accountId 查找），
 * 不再接受请求体中的 email/globalKey，防止已登录用户操作未授权账号。
 */

import { KV_KEYS, TEMPLATES } from '../config/templates';
import { readAccounts, writeAccounts, findAccount, removeWorkerName, hasAnyWorker } from '../lib/account-store';
import { cf, getAuthHeaders, jsonError, json, fetchWithTimeout, readApiJson, readApiResult } from '../lib/cloudflare-api';
import { readWorkerBindings, deleteKvNamespaces } from '../lib/deploy-utils';
import { putJSON } from "../lib/kv-utils";
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";

/** 从服务端 KV 查找账号凭据并返回认证头，未找到则抛出 Response 错误 */
async function resolveCredentials(env: AppEnv, accountId: string) {
    if (!accountId || typeof accountId !== 'string') {
        throw new Response(JSON.stringify({ success: false, msg: '缺少 accountId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const acc = await findAccount(env, accountId);
    if (!acc) throw new Response(JSON.stringify({ success: false, msg: '账号未在服务端配置' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    if (!acc.globalKey) throw new Response(JSON.stringify({ success: false, msg: '该账号密钥缺失或解密失败，请重新填写 Global API Key' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    return { accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey, headers: getAuthHeaders(acc.email, acc.globalKey) };
}

/** 统一处理 handler 异常：保留主动抛出的 Response，其余记录日志后返回可读错误 */
function failure(e: unknown, label: string): Response {
    if (e instanceof Response) return e;
    const err = e instanceof Error ? e : new Error(String(e));
    logger.error(label + ' failed', err, { module: 'zones' });
    return jsonError(err.message || (label + ' failed'));
}

export async function handleGetZones(env: AppEnv, accountId: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        const allZones: Array<{ id: string; name: string }> = [];
        let page = 1;
        // 上限保护：避免上游 result_info 异常时无限翻页耗尽 subrequest 配额
        const MAX_PAGES = 20;
        while (page <= MAX_PAGES) {
            const res = await fetchWithTimeout(cf.zones(aid) + '&page=' + page, { headers });
            const data = await readApiJson<{ result?: Array<{ id: string; name: string }>; result_info?: { total_pages?: number } }>(res, '读取域名列表');
            if (!data.result || data.result.length === 0) break;
            data.result.forEach((z) => allZones.push({ id: z.id, name: z.name }));
            const totalPages = data.result_info?.total_pages || 0;
            if (page >= totalPages) break;
            page++;
        }
        return json({ success: true, zones: allZones });
    } catch (e) { return failure(e, 'handleGetZones'); }
}

export async function handleGetAllWorkers(env: AppEnv, accountId: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        const res = await fetchWithTimeout(cf.workerScripts(aid), { headers });
        const result = await readApiResult<Array<{ id: string; created_on: string; modified_on: string }>>(res, '读取 Worker 列表') || [];
        const workers = result.map((w) => ({
            id: w.id,
            created_on: w.created_on,
            modified_on: w.modified_on
        }));
        return json({ success: true, workers });
    } catch (e) { return failure(e, 'handleGetAllWorkers'); }
}

export async function handleDeleteWorker(env: AppEnv, accountId: string, workerName: string, deleteKv: boolean) {
    try {
        if (!workerName || typeof workerName !== 'string') return jsonError('缺少 workerName', 400, 'VALIDATION_ERROR');
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);

        let kvNamespaceIds: string[] = [];
        if (deleteKv) {
            const { ok, bindings } = await readWorkerBindings(aid, workerName, headers);
            if (ok) {
                kvNamespaceIds = bindings
                    .filter((b) => b.type === 'kv_namespace' && b.namespace_id)
                    .map((b) => b.namespace_id!);
            } else {
                // 读不到绑定就跳过 KV 清理，而不是盲目删除所有命名空间
                logger.warn('deleteWorker: bindings 读取失败，跳过 KV 清理', { module: 'zones', workerName });
            }
        }

        const delWorkerRes = await fetchWithTimeout(cf.workerScript(aid, workerName), {
            method: "DELETE", headers
        });

        if (!delWorkerRes.ok) {
            let msg = '删除失败 (HTTP ' + delWorkerRes.status + ')';
            try { const err: any = await delWorkerRes.json(); msg = err.errors?.[0]?.message || msg; }
            catch { logger.warn('deleteWorker: 错误响应非 JSON', { module: 'zones', status: delWorkerRes.status }); }
            return json({ success: false, msg });
        }

        // Worker 已删除 → 同步账号记录，并在某模板彻底无部署时重置其配置
        const accounts = await readAccounts(env);
        let updated = false;
        for (const acc of accounts) {
            if (acc.accountId !== aid) continue;
            for (const t of Object.keys(TEMPLATES)) {
                if (removeWorkerName(acc, t, workerName)) updated = true;
            }
        }

        if (updated) {
            await writeAccounts(env, accounts);
            for (const t of Object.keys(TEMPLATES)) {
                if (!hasAnyWorker(accounts, t)) {
                    await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(t), { mode: 'latest' });
                    await putJSON(env.CONFIG_KV, KV_KEYS.vars(t), []);
                    await putJSON(env.CONFIG_KV, KV_KEYS.favorites(t), []);
                }
            }
            // 清理该账号的账号级变量覆盖（若该模板在此账号下已无 Worker）
            for (const t of Object.keys(TEMPLATES)) {
                const acc = accounts.find(a => a.accountId === aid);
                if (acc && (acc[`workers_${t}`] || []).length === 0) {
                    await env.CONFIG_KV.delete(KV_KEYS.accountVars(t, aid)).catch((e: unknown) =>
                        logger.warn('deleteWorker: accountVars 清理失败', { module: 'zones', error: String(e) }));
                }
            }
        }

        const kvDeleteErrors = deleteKv
            ? await deleteKvNamespaces(aid, kvNamespaceIds, headers)
            : [];

        if (kvDeleteErrors.length > 0) {
            return json({ success: true, kvWarnings: kvDeleteErrors.length + ' 个 KV 命名空间删除失败，请到 Cloudflare Dashboard 手动清理' });
        }
        return json({ success: true });
    } catch (e) { return failure(e, 'handleDeleteWorker'); }
}

export async function handleFetchBindings(env: AppEnv, accountId: string, workerName: string) {
    try {
        if (!workerName || typeof workerName !== 'string') return jsonError('缺少 workerName', 400, 'VALIDATION_ERROR');
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        const res = await fetchWithTimeout(cf.workerBindings(aid, workerName), { headers });
        const result = await readApiResult<Array<{ type: string; name: string; text?: string }>>(res, '读取绑定') || [];
        const bindings = result
            .filter((b) => b.type === "plain_text" || b.type === "secret_text")
            .map((b) => ({ key: b.name, value: b.type === "plain_text" ? (b.text || '') : "", secret: b.type === "secret_text" }));
        return json({ success: true, data: bindings });
    } catch (e) { return failure(e, 'handleFetchBindings'); }
}

export async function handleGetSubdomain(env: AppEnv, accountId: string) {
    try {
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        const res = await fetchWithTimeout(cf.acctSubdomain(aid), { headers });
        // 未设置子域名时 CF 返回 404，属于正常业务状态而非错误
        if (res.status === 404) return json({ success: true, subdomain: '' });
        const data = await readApiJson<{ success?: boolean; result?: { subdomain?: string }; errors?: Array<{ message: string }> }>(res, '读取子域名');
        if (data.success) return json({ success: true, subdomain: data.result?.subdomain || '' });
        return json({ success: false, msg: data.errors?.[0]?.message || '查询失败' });
    } catch (e) { return failure(e, 'handleGetSubdomain'); }
}

/** 子域名格式：CF 要求小写字母数字与连字符，长度 1-63 且不以连字符开头/结尾 */
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function handleChangeSubdomain(env: AppEnv, accountId: string, newSubdomain: string) {
    try {
        const sub = String(newSubdomain || '').trim().toLowerCase();
        if (!SUBDOMAIN_RE.test(sub)) {
            return jsonError('子域名格式非法：仅允许小写字母、数字与连字符，长度 1-63，且不能以连字符开头或结尾', 400, 'VALIDATION_ERROR');
        }
        const { headers, accountId: aid } = await resolveCredentials(env, accountId);
        let res = await fetchWithTimeout(cf.acctSubdomain(aid), {
            method: 'PUT',
            headers,
            body: JSON.stringify({ subdomain: sub })
        });
        let data: any = await res.json().catch(() => ({ success: false, errors: [{ message: 'HTTP ' + res.status }] }));
        if (data.success) {
            return json({ success: true, subdomain: data.result?.subdomain || sub });
        }
        const errMsg = data.errors?.[0]?.message || '修改失败';
        if (errMsg.includes('already has')) {
            let oldSubdomain = '';
            try {
                const getRes = await fetchWithTimeout(cf.acctSubdomain(aid), { headers });
                if (getRes.ok) {
                    const getData: any = await getRes.json();
                    oldSubdomain = getData.result?.subdomain || '';
                }
            } catch (_) { logger.warn('changeSubdomain get old subdomain failed', { module: 'zones' }); }

            // 安全: 拿不到旧域名就不执行 DELETE，防止删除后无法恢复
            if (!oldSubdomain) {
                return json({ success: false, msg: '无法获取当前子域名，已中止修改（防止删除后无法自动恢复）。请到 Dashboard → Workers & Pages → 设置中手动修改。' });
            }
            const delRes = await fetchWithTimeout(cf.acctSubdomain(aid), { method: 'DELETE', headers });
            if (!delRes.ok) {
                return json({ success: false, msg: 'Cloudflare 不支持通过 API 修改已有子域名，请到 Dashboard → Workers & Pages → 设置中手动修改。' });
            }
            logger.audit('subdomain delete for rename', { accountId: aid, from: oldSubdomain, to: sub });

            let putSuccess = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                res = await fetchWithTimeout(cf.acctSubdomain(aid), {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({ subdomain: sub })
                });
                data = await res.json().catch(() => ({ success: false }));
                if (data.success) { putSuccess = true; break; }
            }

            if (putSuccess) {
                return json({ success: true, subdomain: data.result?.subdomain || sub });
            }

            try {
                const restoreRes = await fetchWithTimeout(cf.acctSubdomain(aid), {
                    method: 'PUT', headers,
                    body: JSON.stringify({ subdomain: oldSubdomain })
                });
                if (restoreRes.ok) {
                    return json({ success: false, msg: '新子域名设置失败，已恢复原子域名: ' + oldSubdomain + '。请稍后重试。' });
                }
                logger.error('Failed to restore old subdomain', new Error('HTTP ' + restoreRes.status), { module: 'zones', oldSubdomain });
            } catch (e) { logger.error('Failed to restore old subdomain', e as Error, { module: 'zones', oldSubdomain }); }
            return json({ success: false, msg: '子域名修改失败，且原子域名 ' + oldSubdomain + ' 恢复也失败。请到 Dashboard → Workers & Pages → 设置中手动设置。' });
        }
        return json({ success: false, msg: errMsg });
    } catch (e) { return failure(e, 'handleChangeSubdomain'); }
}
