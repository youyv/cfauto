import { readWorkerScriptParts } from './worker-script-response';
import { emptyWorkerDeleteResponse } from './cloudflare-response-contract';
import { bindingNamespaces } from './resource-inventory';
import { executeRepair } from './repair-executor';
import { artifactIdentity } from './source-artifact';
import { TEMPLATES } from '../config/templates';
import { cf, fetchWithTimeout, getAuthHeaders } from '../lib/cloudflare-api';
import { applyTemplateTransform } from '../lib/github';
import { executionJournal } from './execution-context';
import { ExecutionUnknown } from './execution-journal';
import { canonical, ReliabilityError, sha256, type Json } from './protocol';
import { accountId, invalid, parseBusinessOperation, protect, resourcePolicy, templateType, type ProtectedResources, type BusinessCommand, workerName } from './business-command';

class Rejected extends Error {}
class ResourceConflict extends Error {}
function uncertain(): never { throw new ExecutionUnknown(); }
function unsupported(_command: never): never { return invalid(); }
async function api(response: Response, mutation = false): Promise<any> {
    let body: any; try { body = await response.json(); } catch { return uncertain(); }
    if (!response.ok || body?.success !== true) {
        // Only a definite provider rejection is a failed step. Lost responses, HTML,
        // gateway errors and malformed 2xx envelopes remain unknown in the journal.
        if (mutation && body?.success === false && (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 408))) throw new Rejected();
        return uncertain();
    }
    return body.result;
}
function normalize(code: string): string { return code.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\s+$/, ''); }
async function scriptMatches(response: Response, code: string): Promise<boolean> {
    if (!response.ok) return false;
    const entrypoint=response.headers.get('cf-entrypoint');
    if(entrypoint && entrypoint!=='index.js'){await response.body?.cancel();return false;}
    if ((response.headers.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')) {
        const modules=(await readWorkerScriptParts(response)).filter(part=>part.name==='index.js');
        return modules.length===1 && normalize(modules[0].code)===normalize(code);
    }
    // Never accept a substring: another module/comment containing the expected script
    // does not establish that the deployed entry module equals this snapshot.
    return normalize(await response.text()) === normalize(code);
}
function uploadBindings(existing: unknown, command: Extract<BusinessCommand, { kind: 'upload' | 'manual_upload' }>): Record<string, unknown>[] {
    if (!Array.isArray(existing)) return uncertain();
    const result: Record<string, unknown>[] = [], names = new Set<string>();
    // Ordinary update/fuse matches the legacy merge: blank inputs do not erase
    // remote values or override upstream defaults. The retained-custom-source
    // manual contract separately permits exact blank plain-text preservation.
    const variables = command.kind === 'upload' ? command.variables.filter(v => v.value.trim() !== '') : command.variables;
    const next = new Map(variables.map(v => [v.key, v]));
    const deleted = new Set(command.kind === 'manual_upload' ? command.deletedVariables : []);
    for (const binding of existing) {
        if (!binding || typeof binding !== 'object' || typeof binding.name !== 'string' || names.has(binding.name)) return uncertain();
        names.add(binding.name);
        const variable = next.get(binding.name);
        if (binding.type === 'kv_namespace') {
            accountId(binding.namespace_id); if (variable || deleted.has(binding.name) || Object.keys(binding).some(k => !['type','name','namespace_id'].includes(k))) return uncertain();
            result.push({ type: 'kv_namespace', name: binding.name, namespace_id: binding.namespace_id });
        } else if (binding.type === 'plain_text' || binding.type === 'secret_text') {
            if (Object.keys(binding).some(k => !['type','name','text'].includes(k))) return uncertain();
            if (deleted.has(binding.name)) continue; // Explicit text/secret deletion; resource bindings never reach here.
            // Cloudflare hides secret values. Never upload an empty/redacted secret or
            // silently drop it. Unsupported preservation stops BEFORE any HTTP write.
            if (binding.type === 'secret_text' && (!variable || !variable.value.trim())) return uncertain();
            if (!variable && typeof binding.text !== 'string') return uncertain();
            if (!variable) result.push({ type: binding.type, name: binding.name, text: binding.text });
        } else return uncertain(); // Unknown resource binding shapes are not round-trip safe.
    }
    for (const variable of next.values()) result.push({ type: variable.secret ? 'secret_text' : 'plain_text', name: variable.key, text: variable.value });
    return result;
}
/** A missing title is actionable only after every declared row was seen exactly once.
 * Provider totals/page size must stay stable; partial lists are never absence proof. */
async function namespaces(get: (url: string) => Promise<Response>, account: string): Promise<{ id: string; title: string }[]> {
    const rows: { id: string; title: string }[] = [], ids = new Set<string>();
    let pages: number | undefined, count: number | undefined, pageSize: number | null | undefined;
    for (let page = 1; page <= 100; page++) {
        const response = await get(cf.kvNamespaces(account) + '?per_page=100&page=' + page);
        let body: any; try { body = await response.json(); } catch { return uncertain(); }
        const info = body?.result_info, size = info?.per_page === undefined ? null : info.per_page;
        if (!response.ok || body?.success !== true || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length)) || !Array.isArray(body.result) || body.result.length > 100 || info?.page !== page || !Number.isSafeInteger(info.total_pages) || info.total_pages < 0 || info.total_pages > 100 || !Number.isSafeInteger(info.total_count) || info.total_count < 0 || info.total_count > 10000) return uncertain();
        if ((pages !== undefined && pages !== info.total_pages) || (count !== undefined && count !== info.total_count) || (pageSize !== undefined && pageSize !== size) || (info.count !== undefined && info.count !== body.result.length)) return uncertain();
        const totalPages: number = info.total_pages, totalCount: number = info.total_count;
        pages = totalPages; count = totalCount; pageSize = size;
        if (size !== null) {
            if (!Number.isSafeInteger(size) || size < 1 || size > 100) return uncertain();
            if (totalPages !== Math.max(1, Math.ceil(totalCount / size)) && !(totalCount === 0 && totalPages === 0)) return uncertain();
            if (body.result.length !== Math.min(size, Math.max(0, totalCount - (page - 1) * size))) return uncertain();
        }
        if ((totalCount === 0 && (page !== 1 || totalPages > 1 || body.result.length)) || (totalCount > 0 && (totalPages < 1 || totalPages > totalCount || page > totalPages)) || (page < totalPages && !body.result.length)) return uncertain();
        for (const row of body.result) {
            accountId(row?.id);
            if (typeof row.title !== 'string' || row.title.length > 512 || ids.has(row.id)) return uncertain();
            ids.add(row.id); rows.push({ id: row.id, title: row.title });
        }
        if (rows.length > totalCount) return uncertain();
        if (page >= totalPages) {
            if (rows.length !== totalCount) return uncertain();
            return rows;
        }
    }
    return uncertain();
}
async function requireAbsentWorker(response: Response): Promise<void> {
    if (response.ok) throw new ResourceConflict();
    let body: any; try { body = await response.json(); } catch { return uncertain(); }
    if (response.status !== 404 || body?.success !== false || !Array.isArray(body.errors) || !body.errors.some((e: any) => e?.code === 10007)) return uncertain();
}
async function requireExistingWorker(response: Response): Promise<void> {
    if (response.ok) {
        // A valid script response establishes existence only, not binding support.
        // Cancel the unused body before the next request.
        await response.body?.cancel();
        return;
    }
    let body: any; try { body = await response.json(); } catch { return uncertain(); }
    if (response.status === 404 && body?.success === false && Array.isArray(body.errors) && body.errors.some((e: any) => e?.code === 10007)) throw new ResourceConflict();
    return uncertain();
}
/** Legacy batch intentionally replaces variable/KV bindings. Refuse exotic resource
 * bindings before replacing: they cannot be safely represented by this command. */
function requireReplaceableBindings(value: unknown): void {
    if (!Array.isArray(value)) return uncertain();
    const names = new Set<string>();
    for (const binding of value) {
        if (!binding || typeof binding.name !== 'string' || names.has(binding.name)) return uncertain();
        names.add(binding.name);
        if (binding.type === 'kv_namespace') {
            accountId(binding.namespace_id);
            if (Object.keys(binding).some(k => !['type','name','namespace_id'].includes(k))) return uncertain();
        } else if (binding.type === 'plain_text' || binding.type === 'secret_text') {
            if (Object.keys(binding).some(k => !['type','name','text'].includes(k)) || (binding.type === 'plain_text' && typeof binding.text !== 'string')) return uncertain();
        } else return uncertain();
    }
}
function bindingReadback(actual: unknown, expected: Record<string, unknown>[]): boolean {
    if (!Array.isArray(actual) || actual.length !== expected.length || new Set(actual.map(b => b?.name)).size !== actual.length) return false;
    return expected.every(binding => {
        const b = actual.find(b => b?.name === binding.name);
        return b?.type === binding.type && (binding.type === 'kv_namespace' ? b.namespace_id === binding.namespace_id : binding.type === 'secret_text' || b.text === binding.text);
    });
}
const SUBDOMAIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The account-level workers.dev subdomain as a definite value. A 404, or an
 * explicit null/empty name, is a positive "this account has none" answer; anything
 * that cannot be read exactly stays unknown. */
async function readSubdomain(get: (url: string) => Promise<Response>, account: string): Promise<string | null> {
    const response = await get(cf.acctSubdomain(account));
    if (response.status === 404) return null;
    const value = await api(response);
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'subdomain')) return uncertain();
    const name = value.subdomain;
    if (name === null || name === '') return null;
    if (typeof name !== 'string' || !SUBDOMAIN_NAME.test(name)) return uncertain();
    return name;
}
/** PUT one subdomain and return the provider's own readback. A definite provider
 * refusal propagates as Rejected so the caller can escalate; a lost or malformed
 * response stays unknown and is never repeated. */
async function setSubdomain(get: (url: string) => Promise<Response>, mutate: (url: string, method: string, body?: string) => Promise<any>, account: string, target: string): Promise<string | null> {
    await mutate(cf.acctSubdomain(account), 'PUT', canonical({ subdomain: target }));
    return await readSubdomain(get, account);
}
/** Some accounts keep a subdomain the provider refuses to replace with a plain PUT,
 * so the repair deletes it before creating the new name. An account must never be
 * left without a workers.dev hostname: when the replacement cannot be confirmed and
 * the account is provably left with nothing, the previous name is put back and the
 * step is reported as a definite failure instead of stranding the account. The
 * previous name is rendered back only over a proved-absent account, so a lost write
 * is never overwritten. */
async function replaceSubdomain(get: (url: string) => Promise<Response>, mutate: (url: string, method: string, body?: string) => Promise<any>, account: string, kind: string, target: string): Promise<{ outcome: 'verified' | 'failed'; result: Json }> {
    const previous = await readSubdomain(get, account);
    if (previous === null) return { outcome: 'failed', result: { kind, code: 'PROVIDER_REJECTED' } };
    if (previous === target) return { outcome: 'verified', result: { kind, confirmed: true } };
    try { await mutate(cf.acctSubdomain(account), 'DELETE'); }
    catch (error) { if (error instanceof Rejected) return { outcome: 'failed', result: { kind, code: 'PROVIDER_REJECTED' } }; throw error; }
    // Never repeat a destructive request. An unconfirmed delete stops the step with
    // the account still holding whatever name the provider reports.
    if (await readSubdomain(get, account) !== null) return uncertain();
    let after: string | null = null;
    try { after = await setSubdomain(get, mutate, account, target); }
    catch (error) { if (!(error instanceof Rejected)) throw error; }
    if (after === target) return { outcome: 'verified', result: { kind, confirmed: true } };
    if (after === null) {
        let restored = false;
        try { restored = await setSubdomain(get, mutate, account, previous) === previous; }
        catch (error) { if (!(error instanceof Rejected)) throw error; }
        if (restored) return { outcome: 'failed', result: { kind, code: 'ROTATION_NOT_APPLIED' } };
    }
    return uncertain();
}
/** Bound-account, static executor. No environment, KV, arbitrary URL, code evaluation,
 * dynamic handler lookup or direct fetch path. Only call it inside AccountRunner. */
function commandCompatibilityDate(value: object): string {
    const command = value as { template?: string; compatibilityDate?: string };
    if (command.compatibilityDate !== undefined) return command.compatibilityDate;
    // Older sealed snapshots predate the editable setting; keep the original template default.
    if (command.template === undefined) throw new ReliabilityError('INVALID', 400);
    templateType(command.template);
    return TEMPLATES[command.template].compatibilityDate;
}
export async function executeBusinessOperation(boundAccount: string, input: Json, step: { ordinal: number; kind: string }, resources: ProtectedResources): Promise<{ outcome: 'verified' | 'failed'; result: Json }> {
    if (!executionJournal()) throw new ReliabilityError('NOT_READY', 503);
    const operation = parseBusinessOperation(input, boundAccount);
    if (!Number.isSafeInteger(step.ordinal) || step.ordinal < 0 || operation.commands[step.ordinal]?.kind !== step.kind) invalid();
    const policy = resourcePolicy(resources);
    for (const action of operation.commands) protect(policy, boundAccount, action);
    const command = operation.commands[step.ordinal];
    const headers = getAuthHeaders(operation.credential);
    const get = (url: string) => fetchWithTimeout(url, { headers });
    const mutation = async (url: string, method: string, body?: string, contentType = 'application/json'): Promise<any> => {
        const response=await fetchWithTimeout(url, { method, headers: { ...headers, 'Content-Type': contentType }, ...(body === undefined ? {} : { body }) });
        if (emptyWorkerDeleteResponse(url,method,response.status,0) && (await response.clone().arrayBuffer()).byteLength===0) return null;
        return api(response,true);
    };
    try {
        switch (command.kind) {
            case 'repair_worker':
            case 'rotate_subdomain': return await executeRepair(boundAccount,command,policy,{
                get, api, mutation, scriptMatches, bindingReadback, absent:requireAbsentWorker,
                upload:async(worker,code,bindings)=>{
                    const form=new FormData();
                    form.append('metadata',JSON.stringify({main_module:'index.js',compatibility_date:commandCompatibilityDate(command),bindings}));
                    form.append('script',new Blob([code],{type:'application/javascript+module'}),'index.js');
                    await api(await fetchWithTimeout(cf.workerScript(boundAccount,worker),{method:'PUT',headers:getAuthHeaders(operation.credential,undefined,true),body:form},60000),true);
                }
            });
            case 'manual_upload':
            case 'upload':
            case 'create_worker':
            case 'replace_worker': {
                if (await sha256(command.artifact.code) !== command.artifact.digest) return uncertain();
                let bindings: Record<string, unknown>[] = [];
                let namespace = '';
                const merging = command.kind === 'upload' || command.kind === 'manual_upload';
                if (command.kind === 'manual_upload') await requireExistingWorker(await get(cf.workerScript(boundAccount, command.worker)));
                if (command.kind === 'upload' || command.kind === 'manual_upload') bindings = uploadBindings(await api(await get(cf.workerBindings(boundAccount, command.worker))), command);
                const sourceVariables = 'sourceVariables' in command ? command.sourceVariables! : command.variables;
                if (command.template === 'ech' && (!/const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s.test(command.artifact.code) || !/const\s+token\s*=\s*['"].*?['"];/.test(command.artifact.code) || [...command.variables,...sourceVariables].some(v => ['PROXYIP','TOKEN'].includes(v.key) && /[\x00-\x1f\x7f\u2028\u2029]/.test(v.value)))) return uncertain();
                const code = applyTemplateTransform(command.template, command.artifact.code, sourceVariables, { echTokenEnabled: command.echTokenEnabled });
                // Transform validation precedes namespace creation: invalid ECH inputs must
                // not leave an avoidable resource behind. Never clean up a created namespace.
                if (command.kind === 'create_worker' || command.kind === 'replace_worker') {
                    if (command.kind === 'create_worker') await requireAbsentWorker(await get(cf.workerScript(boundAccount, command.worker)));
                    else {
                        await requireExistingWorker(await get(cf.workerScript(boundAccount, command.worker)));
                        requireReplaceableBindings(await api(await get(cf.workerBindings(boundAccount, command.worker))));
                    }
                    if (command.namespaceTitle) {
                        const matches = (await namespaces(get, boundAccount)).filter(n => n.title === command.namespaceTitle);
                        if (matches.length > 1) throw new ResourceConflict();
                        if (matches.length) namespace = matches[0].id;
                        else {
                            const created = await mutation(cf.kvNamespaces(boundAccount), 'POST', canonical({ title: command.namespaceTitle }));
                            accountId(created?.id);
                            if (created.title !== command.namespaceTitle) return uncertain();
                            namespace = created.id;
                            const confirmed = (await namespaces(get, boundAccount)).filter(n => n.title === command.namespaceTitle);
                            if (confirmed.length !== 1 || confirmed[0].id !== namespace) return uncertain();
                        }
                        protect(policy, boundAccount, { kind: 'delete_kv', namespace });
                        bindings.push({ type: 'kv_namespace', name: TEMPLATES[command.template].kvBindingName, namespace_id: namespace });
                    }
                    for (const variable of command.variables) if (variable.value.trim() !== '') bindings.push({ type: variable.secret ? 'secret_text' : 'plain_text', name: variable.key, text: variable.value });
                }
                const form = new FormData();
                form.append('metadata', JSON.stringify({ main_module: 'index.js', compatibility_date: commandCompatibilityDate(command), bindings }));
                form.append('script', new Blob([code], { type: 'application/javascript+module' }), 'index.js');
                await api(await fetchWithTimeout(cf.workerScript(boundAccount, command.worker), { method: 'PUT', headers: getAuthHeaders(operation.credential, undefined, true), body: form }, 60000), true);
                if (!await scriptMatches(await get(cf.workerScript(boundAccount, command.worker)), code)) return uncertain();
                if ((!merging || command.kind === 'manual_upload') && !bindingReadback(await api(await get(cf.workerBindings(boundAccount, command.worker))), bindings)) return uncertain();
                if (command.kind === 'manual_upload') return {outcome:'verified',result:{kind:command.kind,worker:command.worker,source:artifactIdentity(command.artifact),scriptVerified:true,bindingsVerified:true}};
                return { outcome: 'verified', result: { kind: command.kind, worker: command.worker, commit: command.artifact.commit, scriptVerified: true, bindingsAccepted: true, ...(command.kind !== 'upload' ? { namespace, bindingsVerified: true } : {}) } };
            }
            case 'cleanup_kv': {
                // Worker absence and the COMPLETE scripts SinglePage response must be
                // checked anew in this step; a binding is not namespace ownership.
                await requireAbsentWorker(await get(cf.workerScript(boundAccount,command.worker)));
                const response=await get(cf.workerScripts(boundAccount)); let body:any;
                try{body=await response.json();}catch{return uncertain();}
                if(!response.ok || body?.success!==true || (body.errors!==undefined && (!Array.isArray(body.errors) || body.errors.length)) || !Array.isArray(body.result) || body.result.length>1000) return uncertain();
                const info=body.result_info;
                // Match the read-side inventory boundary: a page-sized response
                // without metadata cannot prove that another Worker is absent.
                if(info===undefined && (body.result.length>=100 || Object.keys(body).some(k=>!['success','errors','messages','result'].includes(k)))) return uncertain();
                if(info?.per_page!==undefined && (!Number.isSafeInteger(info.per_page) || info.per_page<body.result.length || info.per_page<1 || info.per_page>1000)) return uncertain();
                if(info!==undefined && (!info || info.page!==1 || info.total_count!==body.result.length || (info.total_pages!==undefined && info.total_pages!==1) || (info.count!==undefined && info.count!==body.result.length) || info.cursor)) return uncertain();
                const names=new Set<string>(); let shared=false;
                for(const row of body.result){
                    workerName(row?.id); if(names.has(row.id)) return uncertain(); names.add(row.id);
                    if(row.id===command.worker) return uncertain(); // Recreated outside the coordinator.
                    const ids=bindingNamespaces(await api(await get(cf.workerBindings(boundAccount,row.id))));
                    shared ||= ids.includes(command.namespace);
                }
                if(shared) return {outcome:'verified',result:{kind:command.kind,worker:command.worker,namespace:command.namespace,disposition:'retained_shared'}};
                await mutation(cf.kvNamespace(boundAccount,command.namespace),'DELETE');
                if((await namespaces(get,boundAccount)).some(n=>n.id===command.namespace)) return uncertain();
                return {outcome:'verified',result:{kind:command.kind,worker:command.worker,namespace:command.namespace,disposition:'deleted'}};
            }
            case 'remove_worker':
            case 'delete_worker': {
                if(command.kind==='remove_worker') {
                    await requireExistingWorker(await get(cf.workerScript(boundAccount,command.worker)));
                    if(command.namespaces!==null) {
                        const current=bindingNamespaces(await api(await get(cf.workerBindings(boundAccount,command.worker))));
                        if(canonical(current)!==canonical(command.namespaces)) throw new ResourceConflict();
                        for(const namespace of current) protect(policy,boundAccount,{kind:'delete_kv',namespace});
                    }
                }
                await mutation(cf.workerScript(boundAccount, command.worker), 'DELETE');
                const readback = await get(cf.workerScript(boundAccount, command.worker));
                const body: any = await readback.json();
                if (readback.status !== 404 || body?.success !== false || !Array.isArray(body.errors) || !body.errors.some((e: any) => e?.code === 10007)) return uncertain();
                break;
            }
            case 'delete_kv': {
                await mutation(cf.kvNamespace(boundAccount, command.namespace), 'DELETE');
                // Use the same complete inventory proof as acquisition and cleanup.
                if ((await namespaces(get, boundAccount)).some(row => row.id === command.namespace)) return uncertain();
                break;
            }
            case 'rename_subdomain': {
                // Read and seal the old name before any destructive operation. Do not
                // retry writes or auto-restore after an ambiguous delete/recreate.
                const old=await api(await get(cf.acctSubdomain(boundAccount)));
                if(typeof old?.subdomain!=='string' || (old.subdomain!=='' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(old.subdomain))) return uncertain();
                if(old.subdomain===command.subdomain) break;
                if(old.subdomain) {
                    try {
                        await mutation(cf.acctSubdomain(boundAccount),'DELETE');
                        await mutation(cf.acctSubdomain(boundAccount),'PUT',canonical({subdomain:command.subdomain}));
                        const result=await api(await get(cf.acctSubdomain(boundAccount)));
                        if(result?.subdomain!==command.subdomain) return uncertain();
                    } catch { return uncertain(); }
                } else {
                    await mutation(cf.acctSubdomain(boundAccount),'PUT',canonical({subdomain:command.subdomain}));
                    const result=await api(await get(cf.acctSubdomain(boundAccount)));
                    if(result?.subdomain!==command.subdomain) return uncertain();
                }
                break;
            }
            case 'change_subdomain': {
                // The non-destructive path first: a plain PUT cannot strand an account
                // that already has a workers.dev subdomain.
                try {
                    if (await setSubdomain(get, mutation, boundAccount, command.subdomain) === command.subdomain) break;
                    return uncertain(); // Accepted but not confirmed: no destructive step follows.
                } catch (error) {
                    // A lost or malformed response keeps the step unknown without any delete.
                    if (!(error instanceof Rejected)) throw error;
                }
                return await replaceSubdomain(get, mutation, boundAccount, command.kind, command.subdomain);
            }
            case 'configure_domain': {
                if (command.hostname) {
                    const result = await mutation(cf.workerDomains(boundAccount), 'PUT', canonical({ hostname: command.hostname, service: command.worker, zone_id: command.zone }));
                    if (result?.hostname !== command.hostname || result?.service !== command.worker || result?.zone_id !== command.zone) return uncertain();
                } else {
                    await mutation(cf.workerSubdomain(boundAccount, command.worker), 'POST', canonical({ enabled: command.enabled }));
                    const result = await api(await get(cf.workerSubdomain(boundAccount, command.worker)));
                    if (result?.enabled !== command.enabled) return uncertain();
                }
                break;
            }
            case 'write_nodes': {
                const template = TEMPLATES[command.template];
                const bindings = await api(await get(cf.workerBindings(boundAccount, command.worker)));
                if (!Array.isArray(bindings)) return uncertain();
                const bound = bindings.filter((b: any) => b?.type === 'kv_namespace' && b.name === template.kvBindingName);
                if (bound.length !== 1) return uncertain(); accountId(bound[0].namespace_id); protect(policy, boundAccount, { kind: 'delete_kv', namespace: bound[0].namespace_id });
                const url = cf.kvValue(boundAccount, bound[0].namespace_id, encodeURIComponent(template.yxipKey));
                const content = template.yxipBuildContent(command.content);
                await mutation(url, 'PUT', content, template.yxipContentType);
                const readback = await get(url); if (!readback.ok || await readback.text() !== content) return uncertain(); break;
            }
            default: return unsupported(command);
        }
        return { outcome: 'verified', result: { kind: command.kind, ...('worker' in command ? { worker: command.worker } : {}), confirmed: true } };
    } catch (error) {
        if (error instanceof ResourceConflict) return { outcome: 'failed', result: { kind: command.kind, code: 'RESOURCE_CONFLICT' } };
        if (error instanceof Rejected) return { outcome: 'failed', result: { kind: command.kind, code: 'PROVIDER_REJECTED' } };
        throw error; // Never reinterpret a caught unknown as success or auto retry.
    }
}
