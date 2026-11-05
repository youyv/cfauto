import type { AppEnv } from '../config/env';
import type { TemplateType } from '../config/templates';
import { buildBatchBindings, configToVariables } from './batch-bindings';
import type { DeployConfig } from './types';
import { KV_KEYS, TEMPLATES } from '../config/templates';
import { readAccounts, getWorkerNames, hasAccountCredentials } from './account-store';
import { getJSON } from './kv-utils';
import { readUpstream } from './upstream';
import { normalizeVariables, requireTemplateType, WORKER_NAME_RE } from './validate';
import { cf, getAuthHeaders, fetchWithTimeout, readApiResult, json, jsonError, safeJson } from './cloudflare-api';
import { mergeVariableBindings, verifyWorkerScript } from './deploy-utils';
import { prepareDeployCode } from './auto-update';
import { resolveGithubTarget } from './github';
import { pooledMap } from './concurrency';

function canonicalBinding(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalBinding);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalBinding(v)]));
    return value;
}

/** All values stay server-side; even non-secret values may contain user-labelled secrets. */
export function bindingDifferences(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>, written: Set<string>) {
    const old = new Map(before.map(b => [String(b.name), b]));
    const next = new Map(after.map(b => [String(b.name), b]));
    return [...new Set([...old.keys(), ...next.keys()])].sort().map(name => {
        const a = old.get(name), b = next.get(name);
        const secret = a?.type === 'secret_text' || b?.type === 'secret_text';
        const action = !b ? 'removed' : !a ? 'added' : b?.type === 'secret_text' && written.has(name) ? 'write-secret'
            : JSON.stringify(canonicalBinding(a)) === JSON.stringify(canonicalBinding(b)) ? 'unchanged' : 'changed';
        return { name, beforeType: a?.type || null, afterType: b?.type || null, action, secret };
    });
}

/** POST is read-only: drafts must never enter URLs, logs, source caches or KV. */
export async function handleDeployPreview(req: Request, env: AppEnv): Promise<Response> {
    const type = new URL(req.url).searchParams.get('type') || '';
    const invalid = requireTemplateType(type, true);
    if (invalid) return invalid;
    const body = await safeJson(req);
    if (!body || typeof body !== 'object') return jsonError('需要预览对象', 400);
    if (body.customCode != null && typeof body.customCode !== 'string') return jsonError('自定义源码必须是字符串', 400);
    if (body.batch !== undefined) return handleBatchPreview(env, type, body.batch);
    const normalized = normalizeVariables(body.variables);
    if (!normalized.ok) return normalized.response;
    const deleted = body.deletedVariables || [];
    if (!Array.isArray(deleted) || deleted.length > 200 || deleted.some(v => typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v))) return jsonError('删除变量列表无效', 400);
    if (body.targetSha != null && (typeof body.targetSha !== 'string' || !/^[a-zA-Z0-9._/-]{1,200}$/.test(body.targetSha))) return jsonError('源码引用无效', 400);
    const [allAccounts, config, upstream] = await Promise.all([
        readAccounts(env), getJSON<DeployConfig>(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' }), readUpstream(env, type)
    ]);
    const ids = body.targetAccountIds;
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id: unknown) => typeof id !== 'string' || !allAccounts.some(a => a.accountId === id)))) return jsonError('目标账号清单无效或已变化', 400);
    const accounts = ids ? allAccounts.filter(a => ids.includes(a.accountId)) : allAccounts;
    const entries = accounts.flatMap(acc => getWorkerNames(acc, type).map(workerName => ({ acc, workerName })));
    const variables = normalized.value;
    const written = new Set(variables.filter(v => v.value.trim() && !deleted.includes(v.key)).map(v => v.key));
    // Existing source discovery may update caches. Keep those writes in an invocation-local overlay only.
    const previewEnv = readonlyPreviewEnv(env);
    let prepared: Awaited<ReturnType<typeof prepareDeployCode>> | null = null;
    let resolvedPath = upstream.path || TEMPLATES[type].ghPath;
    let resolvedRef = body.targetSha || upstream.branch || TEMPLATES[type].ghBranch;
    try {
        prepared = await prepareDeployCode(previewEnv, type, body.targetSha || null, body.customCode || null, variables, body.echTokenEnabled === true);
        const target = await resolveGithubTarget(previewEnv, type);
        resolvedPath = target.path;
        if (!body.targetSha) resolvedRef = target.branch;
    } catch (_) { /* Source failure remains unknown; binding differences can still be useful. */ }
    const sourceCode = prepared && !Array.isArray(prepared) ? prepared : null;
    const targets = await pooledMap(entries, async ({ acc, workerName }) => {
        const base = { accountId: acc.accountId, alias: acc.alias, workerName };
        try {
            const overrides = await getJSON<Array<{ key: string }>>(env.CONFIG_KV, KV_KEYS.accountVars(type, acc.accountId), []);
            const clearedOverrides = Array.isArray(overrides) ? overrides.map(v => v.key).filter(k => typeof k === 'string') : [];
            if (!hasAccountCredentials(acc)) return { ...base, status: 'unknown', reason: '凭据缺失，无法读取绑定', clearedOverrides };
            const before = env.reliabilityPreview ? await env.reliabilityPreview.bindings(acc, workerName) : await readApiResult<Array<Record<string, unknown>>>(await fetchWithTimeout(cf.workerBindings(acc.accountId, workerName), { headers: getAuthHeaders(acc) }), '读取预览绑定');
            if (!Array.isArray(before)) throw new Error('invalid bindings');
            const after = mergeVariableBindings(before, variables, deleted);
            const sourceVerdict = sourceCode ? await verifyWorkerScript(acc.accountId, workerName, getAuthHeaders(acc), sourceCode.scriptContent) : 'unverified';
            return { ...base, status: 'read', clearedOverrides, sourceAction: sourceVerdict === 'verified' ? 'unchanged' : sourceVerdict === 'mismatch' ? 'changed' : 'unknown', bindings: bindingDifferences(before, after, written) };
        } catch (_) { return { ...base, status: 'unknown', reason: '读取失败；无法确认此目标差异，不代表没有变化' }; }
    });
    return json({ success: true, accounts: accounts.filter(a => getWorkerNames(a, type).length).length, workers: targets.length, targets,
        source: { kind: body.customCode ? 'custom' : 'github', customCodeHash: sourceCode?.customCodeHash || null, repository: TEMPLATES[type].ghUser + '/' + TEMPLATES[type].ghRepo, path: resolvedPath,
            ref: resolvedRef, resolvedSha: sourceCode?.deployedSha || null, previousSha: config.currentSha || null,
            status: sourceCode ? 'read' : 'unknown', note: '逐目标源码按本次下载并转换的内容比对；SHA 为来源元信息，不保证与可变分支下载原子对应。源码和 Secret 不返回，预览后上游或目标仍可能变化。'  },
        effect: { accountOverrides: 'clear', echTokenEnabled: type === 'ech' && body.echTokenEnabled === true,
            disableWorkersDev: type === 'ech' && body.echDisableWorkersDev === true },
        note: '只读即时快照，不是部署锁；绑定值不返回。Secret 重新写入只标记写入，无法读取原值判断是否相同。显式删除可移除 KV 等绑定，但不删除 KV 命名空间。' });
}

function readonlyPreviewEnv(env: AppEnv): AppEnv {
    if (env.reliabilityReadOnly) return env; // DO reads must reject, not swallow, any business write.
    const cache = new Map<string, string | null>();
    return { ...env, CONFIG_KV: {
        get: async (key, options) => cache.has(key) ? cache.get(key)! : env.CONFIG_KV.get(key, options),
        put: async (key, value) => { cache.set(key, value); },
        delete: async key => { cache.set(key, null); },
        list: options => env.CONFIG_KV.list(options)
    } };
}

/** Batch creation replaces bindings rather than merging with the existing Worker. */
async function handleBatchPreview(env: AppEnv, type: TemplateType, draft: any): Promise<Response> {
    if (!draft || typeof draft !== 'object' || draft.template !== type || typeof draft.workerName !== 'string' || !WORKER_NAME_RE.test(draft.workerName.trim())) return jsonError('批量预览模板或 Worker 名称无效', 400);
    if (!Array.isArray(draft.targetAccounts) || !draft.targetAccounts.length || draft.targetAccounts.some((a: unknown) => typeof a !== 'string')) return jsonError('请选择有效的目标账号', 400);
    if (draft.enableKV && (typeof draft.kvName !== 'string' || !draft.kvName.trim())) return jsonError('开启 KV 时必须填写名称', 400);
    if (!draft.config || Array.isArray(draft.config) || typeof draft.config !== 'object' || Object.values(draft.config).some(v => typeof v !== 'string')) return jsonError('批量变量配置无效', 400);
    if (draft.customDomainPrefix != null && typeof draft.customDomainPrefix !== 'string') return jsonError('自定义域名前缀无效', 400);
    const normalized = normalizeVariables(draft.savedVars || []);
    if (!normalized.ok) return normalized.response;
    const savedVars = normalized.value;
    const accounts = await readAccounts(env);
    const selected = accounts.filter(a => draft.targetAccounts.includes(a.alias));
    const unresolved = draft.targetAccounts.filter((alias: string) => !selected.some(a => a.alias === alias));
    const workerName = draft.workerName.trim();
    const previewEnv = readonlyPreviewEnv(env);
    let code: Awaited<ReturnType<typeof prepareDeployCode>> | null = null;
    try { code = await prepareDeployCode(previewEnv, type, null, null, configToVariables(draft.config), false); } catch (_) { /* unknown source */ }
    const source = code && !Array.isArray(code) ? code : null;
    const targets = await pooledMap(selected, async acc => {
        const base = { accountId: acc.accountId, alias: acc.alias, workerName,
            domain: draft.customDomainPrefix ? (acc.defaultZoneId && acc.defaultZoneName ? draft.customDomainPrefix + '.' + acc.defaultZoneName : '未配置默认 Zone，部署时跳过') : null,
            disableWorkersDev: !!draft.disableWorkersDev };
        if (!hasAccountCredentials(acc)) return { ...base, status: 'unknown', reason: '缺少凭据；实际批量部署会跳过此账号' };
        try {
            const headers = getAuthHeaders(acc);
            const workers = env.reliabilityPreview ? await env.reliabilityPreview.workers(acc) : await readApiResult<Array<{ id: string }>>(await fetchWithTimeout(cf.workerScripts(acc.accountId), { headers }), '读取 Worker 清单');
            if (!Array.isArray(workers) || workers.some(w => !w || typeof w.id !== 'string')) throw new Error('invalid inventory');
            const exists = workers.some(w => w.id === workerName);
            const before = exists ? (env.reliabilityPreview ? await env.reliabilityPreview.bindings(acc, workerName) : await readApiResult<Array<Record<string, unknown>>>(await fetchWithTimeout(cf.workerBindings(acc.accountId, workerName), { headers }), '读取绑定')) : [];
            if (!Array.isArray(before)) throw new Error('invalid bindings');
            let namespaceId = '', kvAction = 'disabled';
            if (draft.enableKV) {
                const namespaces = env.reliabilityPreview ? await env.reliabilityPreview.namespaces(acc) : await readApiResult<Array<{ title: string; id: string }>>(await fetchWithTimeout(cf.kvNamespaces(acc.accountId) + '?per_page=100', { headers }), '读取 KV 清单');
                if (!Array.isArray(namespaces) || namespaces.some(n => !n || typeof n.id !== 'string' || typeof n.title !== 'string')) throw new Error('invalid namespaces');
                if (namespaces.filter(n => n.title === draft.kvName).length > 1) throw new Error('ambiguous namespace title');
                const found = namespaces.find(n => n.title === draft.kvName);
                if (!env.reliabilityPreview && !found && namespaces.length >= 100) return { ...base, status: 'unknown', reason: 'KV 首批清单已满，无法确认同名命名空间；未创建任何资源' };
                namespaceId = found?.id || '__preview_new_namespace__';
                kvAction = found ? 'reuse' : 'create';
            }
            const after = buildBatchBindings(type, namespaceId, !!draft.enableKV, savedVars, draft.config);
            const written = new Set(after.filter(b => b.type === 'secret_text').map(b => String(b.name)));
            const verdict = source && exists ? await verifyWorkerScript(acc.accountId, workerName, headers, source.scriptContent) : 'unverified';
            return { ...base, status: 'read', workerAction: exists ? 'replace' : 'create', kvAction,
                sourceAction: !source ? 'unknown' : !exists ? 'added' : verdict === 'verified' ? 'unchanged' : verdict === 'mismatch' ? 'changed' : 'unknown',
                bindings: bindingDifferences(before, after, written) };
        } catch (_) { return { ...base, status: 'unknown', reason: '读取失败，无法确认此目标差异；未创建任何资源' }; }
    });
    return json({ success: true, mode: 'batch', accounts: selected.length, workers: targets.length, targets, unresolved,
        source: { status: source ? 'read' : 'unknown', resolvedSha: source?.deployedSha || null },
        note: '只读即时快照，不是部署锁。同名 Worker 将被覆盖；批量绑定按新配置构建，未列出的原绑定会移除。KV 仅预览新建/复用，不删除命名空间。域名与 workers.dev 展示拟执行操作，不保证成功。账号覆盖保持不变，版本账本仅记录子集结果。' });
}
