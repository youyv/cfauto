import { readWorkerScriptParts } from './worker-script-response';
import { cf } from '../lib/cloudflare-api';
import { applyTemplateTransform } from '../lib/github';
import { accountId, protect, type BusinessCommand, type ProtectedResources } from './business-command';
import { executionJournal } from './execution-context';
import { ExecutionUnknown } from './execution-journal';
import { canonical, sha256, ReliabilityError, type Json } from './protocol';

type Repair = Extract<BusinessCommand, {kind:'repair_worker'}>;
type Binding = Record<string, unknown>;
interface Domain { hostname: string; service: string; zone_id: string; environment: string; enabled?: boolean; previews_enabled?: boolean }
export interface RepairTransport {
    get(url: string): Promise<Response>;
    api(response: Response): Promise<any>;
    mutation(url: string, method: string, body?: string): Promise<any>;
    upload(worker: string, code: string, bindings: Binding[], template: string): Promise<void>;
    scriptMatches(response: Response, code: string): Promise<boolean>;
    bindingReadback(actual: unknown, expected: Binding[]): boolean;
    absent(response: Response): Promise<void>;
}
function unknown(): never { throw new ExecutionUnknown(); }
/** No destructive write until every preflight response has been encrypted by the HTTP
 * journal. Journal replay freezes these provider inputs too, including the old source.
 * Unknown writes never repeat. This is not a fence against Cloudflare Dashboard edits. */
function restoreBindings(value: unknown, command: Repair, account: string, resources: ProtectedResources): Binding[] {
    if (!Array.isArray(value)) return unknown();
    const names = new Set<string>(), result: Binding[] = [];
    const vars = new Map(command.variables.map(v=>[v.key,v.value]));
    for (const b of value) {
        if (!b || typeof b.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(b.name) || names.has(b.name)) return unknown();
        names.add(b.name);
        if (b.type === 'kv_namespace') {
            accountId(b.namespace_id);
            if (Object.keys(b).some(k=>!['name','type','namespace_id'].includes(k))) return unknown();
            protect(resources,account,{kind:'delete_kv',namespace:b.namespace_id});
            result.push({name:b.name,type:b.type,namespace_id:b.namespace_id});
        } else if (b.type === 'plain_text' || b.type === 'secret_text') {
            if (Object.keys(b).some(k=>!['name','type','text'].includes(k))) return unknown();
            const supplied = vars.get(b.name);
            // Preserve original binding types. A saved nonempty global value replaces
            // text, exactly as the legacy repair did; overrides are deliberately unused.
            const text = supplied !== undefined && supplied !== '' ? supplied : b.type === 'plain_text' ? b.text : undefined;
            if (typeof text !== 'string') return unknown();
            result.push({name:b.name,type:b.type,text});
        } else return unknown(); // R2/DO/service/etc. are not round-trip safe here.
    }
    return result;
}
function workerFlags(value: any): { enabled: boolean; previews_enabled: boolean } {
    if (typeof value?.enabled !== 'boolean' || typeof value?.previews_enabled !== 'boolean') return unknown();
    return {enabled:value.enabled,previews_enabled:value.previews_enabled};
}
function hostname(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 253 && value.includes('.') && value.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p));
}
/** A partial page is never evidence of no domains. Require stable explicit totals. */
async function domains(io: RepairTransport, account: string): Promise<Domain[]> {
    const rows: Domain[] = [], names = new Set<string>(); let pages: number | undefined, count: number | undefined;
    for (let page=1;page<=100;page++) {
        const response = await io.get(cf.workerDomains(account)+'?per_page=100&page='+page);
        let body: any; try { body=await response.json(); } catch { return unknown(); }
        const info=body?.result_info;
        if (!response.ok || body?.success !== true || !Array.isArray(body.result) || body.result.length>100 || info?.page!==page || !Number.isSafeInteger(info.total_count) || info.total_count<0) return unknown();
        // Observed Cloudflare domains response (GET-only 2026-10-01) omits
        // total_pages. Derive it ONLY with complete, consistent pagination metadata;
        // never equate a short/empty result with completeness or invent a next cursor.
        let totalPages=info.total_pages;
        if (totalPages===undefined) {
            if(info.per_page!==100 || info.count!==body.result.length) return unknown();
            totalPages=Math.ceil(info.total_count/100);
            if(body.result.length!==Math.min(100,Math.max(0,info.total_count-(page-1)*100))) return unknown();
        }
        if(!Number.isSafeInteger(totalPages) || totalPages<0 || totalPages>100 || (pages!==undefined && pages!==totalPages) || (count!==undefined && count!==info.total_count) || (info.count!==undefined && info.count!==body.result.length) || (info.per_page!==undefined && info.per_page!==100)) return unknown();
        pages=totalPages; count=info.total_count;
        if (pages===0 && (page!==1 || count!==0 || body.result.length)) return unknown();
        for (const d of body.result) {
            if (!d || !hostname(d.hostname) || typeof d.service!=='string' || typeof d.environment!=='string' || names.has(d.hostname)) return unknown();
            accountId(d.zone_id); names.add(d.hostname);
            for(const key of ['enabled','previews_enabled']) if(Object.hasOwn(d,key) && typeof d[key]!=='boolean') return unknown();
            rows.push({hostname:d.hostname,service:d.service,zone_id:d.zone_id,environment:d.environment,
                ...(Object.hasOwn(d,'enabled')?{enabled:d.enabled}:{}),...(Object.hasOwn(d,'previews_enabled')?{previews_enabled:d.previews_enabled}:{})});
        }
        if (page >= pages!) {
            if (rows.length!==count) return unknown();
            return rows.sort((a,b)=>a.hostname<b.hostname?-1:a.hostname>b.hostname?1:0);
        }
    }
    return unknown();
}
async function backupSource(response: Response): Promise<void> {
    if (!response.ok) return unknown();
    // Retain the entire original response in the encrypted journal, not just a hash.
    // Reject obvious error pages before deleting, including 200 HTML from a gateway.
    const type=(response.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('multipart/form-data')) {
        const modules=await readWorkerScriptParts(response);
        if (!modules.length || !modules.some(part=>part.code.trim() && !/^\s*</.test(part.code))) return unknown();
    } else {
        const text=await response.text();
        if (type.includes('text/html') || !text.trim() || /^\s*</.test(text)) return unknown();
    }
}
export async function executeRepair(account: string, command: Repair | Extract<BusinessCommand,{kind:'rotate_subdomain'}>, resources: ProtectedResources, io: RepairTransport): Promise<{outcome:'verified'|'failed';result:Json}> {
    if (!executionJournal()) throw new ReliabilityError('NOT_READY',503);
    if (command.kind==='rotate_subdomain') {
        const current=await io.get(cf.acctSubdomain(account));
        // A definite provider "this account has no workers.dev subdomain" answer is a
        // PRE-MUTATION fact: nothing was written yet, so the rotation is a definite
        // failure rather than an unknown. A missing subdomain must never wedge the
        // account queue (and through it every other account) behind needs_review.
        // Transport/permission failures still fall through io.api and stay unknown.
        if (current.status===404) return {outcome:'failed',result:{kind:command.kind,code:'PROVIDER_STATE_ABSENT'}};
        const old=await io.api(current);
        if (typeof old?.subdomain!=='string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(old.subdomain) || old.subdomain===command.subdomain) return unknown();
        // Once deletion starts, even a definite rejection later needs review: the
        // account might be left without its old subdomain. Never auto-restore over it.
        try {
            await io.mutation(cf.acctSubdomain(account),'DELETE');
            const absent=await io.api(await io.get(cf.acctSubdomain(account)));
            if (!absent || !Object.hasOwn(absent,'subdomain') || ![null,''].includes(absent.subdomain)) return unknown();
            await io.mutation(cf.acctSubdomain(account),'PUT',canonical({subdomain:command.subdomain}));
            if ((await io.api(await io.get(cf.acctSubdomain(account))))?.subdomain!==command.subdomain) return unknown();
        } catch { return unknown(); }
        return {outcome:'verified',result:{kind:command.kind,confirmed:true}};
    }
    if (await sha256(command.artifact.code)!==command.artifact.digest) return unknown();
    if (command.template==='ech' && (!/const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s.test(command.artifact.code) || !/const\s+token\s*=\s*['"].*?['"];/.test(command.artifact.code) || command.variables.some(v=>['PROXYIP','TOKEN'].includes(v.key) && /[\x00-\x1f\x7f\u2028\u2029]/.test(v.value)))) return unknown();
    const code=applyTemplateTransform(command.template,command.artifact.code,command.variables,{echTokenEnabled:true});
    await backupSource(await io.get(cf.workerScript(account,command.worker)));
    const bindings=restoreBindings(await io.api(await io.get(cf.workerBindings(account,command.worker))),command,account,resources);
    const saved=(await domains(io,account)).filter(d=>d.service===command.worker);
    // The public domain PUT schema cannot restore non-default per-domain flags.
    // Preserve observed defaults and verify them on readback; refuse non-defaults
    // before DELETE instead of silently enabling a disabled hostname/preview.
    if (saved.some(d=>d.environment!=='production' || d.enabled===false || d.previews_enabled===true) || saved.length>100) return unknown();
    const flags=workerFlags(await io.api(await io.get(cf.workerSubdomain(account,command.worker))));
    try {
        await io.mutation(cf.workerScript(account,command.worker),'DELETE');
        await io.absent(await io.get(cf.workerScript(account,command.worker)));
        await io.upload(command.worker,code,bindings,command.template);
        if (!await io.scriptMatches(await io.get(cf.workerScript(account,command.worker)),code) || !io.bindingReadback(await io.api(await io.get(cf.workerBindings(account,command.worker))),bindings)) return unknown();
        for (const d of saved) {
            const restored=await io.mutation(cf.workerDomains(account),'PUT',canonical({hostname:d.hostname,service:d.service,zone_id:d.zone_id,environment:d.environment}));
            if (restored?.hostname!==d.hostname || restored?.service!==d.service || restored?.zone_id!==d.zone_id || restored?.environment!==d.environment) return unknown();
        }
        const restored=(await domains(io,account)).filter(d=>d.service===command.worker);
        if (canonical(restored)!==canonical(saved)) return unknown();
        await io.mutation(cf.workerSubdomain(account,command.worker),'POST',canonical(flags));
        if (canonical(workerFlags(await io.api(await io.get(cf.workerSubdomain(account,command.worker)))))!==canonical(flags)) return unknown();
    } catch { return unknown(); }
    return {outcome:'verified',result:{kind:command.kind,worker:command.worker,commit:command.artifact.commit,scriptVerified:true,bindingsVerified:true,domainsVerified:true,subdomainVerified:true}};
}
