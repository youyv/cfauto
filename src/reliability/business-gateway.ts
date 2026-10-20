import { EXTERNAL_READ_PATHS, externalReadIntent } from './external-read-intent';
import { LEGACY_VIEW_PATHS, legacyViewSelector } from './authority-views';
import { MAX_BUSINESS_INTENT_BYTES } from './business-limits';
import type { AppEnv } from '../config/env';
import { checkCsrf, requireAccessCode, requireCookie } from '../middleware/auth';
import { parseApplicationIntent, legacyHttpIntent, LEGACY_TASK_PATHS } from './application-intent';
import { parseConfigEdit, parseConfigSelector, legacyConfigEdit, LEGACY_CONFIG_PATHS } from './config-editor';
import { CoordinatorRpc } from './coordinator-rpc';
import { productionConfig, type ReliabilityEnv } from './production-config';
import { sendCoordinatorRpc } from './production-rpc';
import { identifier, ReliabilityError, type Json } from './protocol';

const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function body(request: Request, limit = 120000): Promise<unknown> {
    if (!request.body || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) throw new ReliabilityError('INVALID', 400);
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.length; if (bytes > limit) throw new ReliabilityError('INVALID', 400);
            chunks.push(next.value);
        }
        const all = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(all));
    } catch { throw new ReliabilityError('INVALID', 400); }
    finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
/** Authenticated public task adapter selected by the authority ingress. Never proxy a public request
 * to the DO, accept a scope/PreparedTaskInput, or fall back to business KV on failure. */
export async function businessGateway(request: Request, env: AppEnv & ReliabilityEnv): Promise<Response> {
    try {
        const url = new URL(request.url);
        const access = requireAccessCode(env); if (access) return access;
        const auth = await requireCookie(request, env); if (auth) return auth;
        // Stronger exact-origin check in addition to existing session-bound CSRF.
        const origin = request.headers.get('origin');
        if (origin && new URL(origin).origin !== url.origin) return reply({ error: 'INVALID' }, 403);
        const csrf = await checkCsrf(request, url, env); if (csrf) return csrf;
        if(url.pathname==='/api/reliability/recovery'){
            if(request.method!=='GET'||url.search||url.hash)throw new ReliabilityError('INVALID',400);const config=productionConfig(env),rpc=new CoordinatorRpc(config.rpcSecret),value=await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'read_view',env.RELIABILITY_MANAGER_ACCOUNT,{selector:{kind:'recovery'}});
            if(!value||typeof value!=='object'||Array.isArray(value)||(value.generation!==null&&typeof value.generation!=='string')||!Number.isSafeInteger(value.epoch)||typeof value.maintenance!=='boolean')throw new ReliabilityError('NOT_READY',503);
            return reply({format:'cfauto.recovery-workflow',version:1,mode:'authority',protocol:1,status:value,target:{account:env.RELIABILITY_MANAGER_ACCOUNT,worker:env.RELIABILITY_MANAGER_WORKER,namespace:env.RELIABILITY_CONFIG_NAMESPACE}});
        }
        if(['/api/backup','/api/restore','/api/restore/preview','/api/restore/snapshot'].includes(url.pathname)){
            // Old KV bytes must never masquerade as a current-authority backup or
            // become a parallel restore writer. This is an explicit protocol error,
            // not a downloadable backup, successful restore or silent fallback.
            return reply({error:'INDEPENDENT_MAINTENANCE_REQUIRED',protocol:1,workflow:'/api/reliability/recovery',message:'完整权威备份和恢复必须使用独立维护CLI；未读取或写入旧KV业务数据。'},409);
        }
        if (request.method==='GET' && (LEGACY_VIEW_PATHS as readonly string[]).includes(url.pathname)) {
            const selector=legacyViewSelector(request),settings=productionConfig(env),rpc=new CoordinatorRpc(settings.rpcSecret);
            const result=await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'read_view',env.RELIABILITY_MANAGER_ACCOUNT,{selector} as unknown as Json);
            if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.generation!=='string'||!Number.isSafeInteger(result.epoch)||!result.revisions||typeof result.revisions!=='object'||Array.isArray(result.revisions))throw new ReliabilityError('NOT_READY',503);
            const metadata={generation:result.generation,epoch:result.epoch,revisions:result.revisions,maintenance:result.maintenance,protocol:1};
            const response=reply(selector.kind==='init'?{...result.data as Record<string,Json>,reliability:metadata}:result.data);
            response.headers.set('X-Reliability-Protocol','1');response.headers.set('X-Config-Generation',result.generation);response.headers.set('X-Config-Epoch',String(result.epoch));
            if(selector.kind==='accounts_export')response.headers.set('Content-Disposition','attachment; filename="accounts-v2.json"');
            const revisions=Object.values(result.revisions);if(revisions.length===1)response.headers.set('X-Config-Revision',String(revisions[0]));
            return response;
        }
        if ((EXTERNAL_READ_PATHS as readonly string[]).includes(url.pathname)) {
            const intent=externalReadIntent(request,request.method==='POST'?await body(request,MAX_BUSINESS_INTENT_BYTES):undefined),settings=productionConfig(env),rpc=new CoordinatorRpc(settings.rpcSecret);
            const result=await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'read_external',env.RELIABILITY_MANAGER_ACCOUNT,{request:intent} as unknown as Json);
            if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.generation!=='string'||!Number.isSafeInteger(result.epoch)||!Object.hasOwn(result,'data'))throw new ReliabilityError('NOT_READY',503);
            identifier(result.generation);
            const response=reply(result.data);response.headers.set('X-Reliability-Protocol','1');response.headers.set('X-Config-Generation',result.generation);response.headers.set('X-Config-Epoch',String(result.epoch));return response;
        }
        if ((LEGACY_CONFIG_PATHS as readonly string[]).includes(url.pathname)) {
            if (request.headers.get('x-reliability-protocol') !== '1') return reply({error:'UPGRADE_REQUIRED',protocol:1},428);
            const input = legacyConfigEdit(request,await body(request));
            const config = productionConfig(env),rpc = new CoordinatorRpc(config.rpcSecret);
            return reply(await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'edit_config',env.RELIABILITY_MANAGER_ACCOUNT,{request:input} as unknown as Json));
        }
        if ((LEGACY_TASK_PATHS as readonly string[]).includes(url.pathname)) {
            // Do not change the response shape under an old page: preserve its draft
            // and require the asynchronous protocol before accepting any task.
            if (request.headers.get('x-reliability-protocol') !== '1') return reply({error:'UPGRADE_REQUIRED',protocol:1},428);
            const payload = await body(request,MAX_BUSINESS_INTENT_BYTES);
            const config=productionConfig(env),rpc=new CoordinatorRpc(config.rpcSecret);
            if (url.pathname === '/api/save_yxip' && payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string,unknown>).type === 'joey_var') {
                const input = legacyConfigEdit(request,payload);
                return reply(await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'edit_config',env.RELIABILITY_MANAGER_ACCOUNT,{request:input} as unknown as Json));
            }
            const intent=legacyHttpIntent(request,payload);
            const result=await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'submit_task',env.RELIABILITY_MANAGER_ACCOUNT,{request:intent} as unknown as Json);
            if (!result || typeof result!=='object' || Array.isArray(result) || typeof result.id!=='string' || typeof result.duplicate!=='boolean') throw new ReliabilityError('NOT_READY',503);
            identifier(result.id);
            return reply({id:result.id,duplicate:result.duplicate,status:'accepted',statusUrl:'/api/reliability/tasks/'+result.id,protocol:1},202);
        }
        if (url.pathname === '/api/reliability/config') {
            if (url.hash) throw new ReliabilityError('INVALID',400);
            const config = productionConfig(env), rpc = new CoordinatorRpc(config.rpcSecret);
            if (request.method === 'GET') {
                if ([...url.searchParams.keys()].some(k => !['kind', 'template'].includes(k)) || url.searchParams.getAll('kind').length !== 1 || url.searchParams.getAll('template').length > 1) throw new ReliabilityError('INVALID',400);
                const selector = parseConfigSelector({ kind: url.searchParams.get('kind'), ...(url.searchParams.has('template') ? { template: url.searchParams.get('template') } : {}) });
                return reply(await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'read_config',env.RELIABILITY_MANAGER_ACCOUNT,{selector}));
            }
            if (request.method === 'POST') {
                if (request.headers.get('x-reliability-protocol') !== '1') return reply({error:'UPGRADE_REQUIRED',protocol:1},428);
                if (url.search) throw new ReliabilityError('INVALID',400);
                const input = parseConfigEdit(await body(request));
                return reply(await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'edit_config',env.RELIABILITY_MANAGER_ACCOUNT,{request:input} as unknown as Json));
            }
            return reply({error:'INVALID'},405);
        }
        const listing = url.pathname === '/api/reliability/tasks' && request.method === 'GET';
        if ((!listing && url.search) || url.hash) return reply({ error: 'INVALID' }, 400);
        const config = productionConfig(env), rpc = new CoordinatorRpc(config.rpcSecret);
        if (listing) {
            if ([...url.searchParams.keys()].some(key=>!['limit','cursor'].includes(key)) || url.searchParams.getAll('limit').length>1 || url.searchParams.getAll('cursor').length>1) throw new ReliabilityError('INVALID',400);
            const raw = url.searchParams.get('limit') ?? '20', cursor = url.searchParams.get('cursor');
            if (!/^[1-9][0-9]?$/.test(raw) || Number(raw)>50 || (cursor !== null && !/^v2\.[1-9][0-9]{0,15}\.[a-f0-9]{64}$/.test(cursor))) throw new ReliabilityError('INVALID',400);
            return reply(await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,'list_tasks',env.RELIABILITY_MANAGER_ACCOUNT,{limit:Number(raw),cursor}));
        }
        if (url.pathname === '/api/reliability/tasks' && request.method === 'POST') {
            const intent = parseApplicationIntent(await body(request, MAX_BUSINESS_INTENT_BYTES));
            const value = await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR, rpc, 'submit_task', env.RELIABILITY_MANAGER_ACCOUNT, { request: intent } as unknown as Json);
            return reply(value, 202);
        }
        const cancel = /^\/api\/reliability\/tasks\/([a-zA-Z0-9_-]{1,100})\/(cancel|wake)$/.exec(url.pathname);
        if (cancel && request.method === 'POST') {
            const input = await body(request);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new ReliabilityError('INVALID',400);
            const value = await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR,rpc,cancel[2] === 'cancel' ? 'cancel_task' : 'wake_task',env.RELIABILITY_MANAGER_ACCOUNT,{id:cancel[1]});
            return reply(value,202);
        }
        const match = /^\/api\/reliability\/tasks\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
        if (match && request.method === 'GET') {
            identifier(match[1]);
            const value = await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR, rpc, 'inspect_task', env.RELIABILITY_MANAGER_ACCOUNT, { id: match[1] });
            return reply(value);
        }
        return reply({ error: 'INVALID' }, 404);
    } catch (error) {
        const known = error instanceof ReliabilityError;
        return reply({ error: known ? error.code : 'NOT_READY' }, known ? error.status : 503);
    }
}
