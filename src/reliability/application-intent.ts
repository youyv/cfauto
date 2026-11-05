import { TEMPLATES, type TemplateType } from '../config/templates';
import { batchVariables, configToVariables } from '../lib/batch-bindings';
import type { AccountEntry } from '../lib/types';
import { accountId, boundedText, invalid, shape, templateType, validateAction, variables, workerName, type BusinessAction } from './business-command';
import { businessJson } from './business-limits';
import { BusinessPlanner, parseBusinessRequest, type BusinessRequest } from './business-planner';
import { ConfigStore } from './config-store';
import { canonical, identifier, ReliabilityError } from './protocol';
import type { PreparedTaskInput } from './task-preparation';

type Manual = Extract<BusinessAction, {kind:'manual_deploy'}>;
type Batch = Extract<BusinessAction, {kind:'deploy_worker'}>;
export type LegacyIntent = { key: string; operation:
    | {kind:'manual'; action:Manual; accounts:string[] | null}
    | {kind:'batch'; action:Batch; aliases:string[]; domain:{enabled:boolean; customPrefix:string}}
    | {kind:'nodes'; template:string; account:string; content:string}
    | {kind:'repair'; template:string; targets:{account:string; worker:string}[]; rotateSubdomain:boolean; preserveProtectedSubdomains?:true}
};
export type ApplicationIntent = BusinessRequest | LegacyIntent;
const sort = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;
function strings(value: unknown, check:(value:unknown)=>void): asserts value is string[] {
    if (!Array.isArray(value) || !value.length || value.length > 20 || new Set(value).size !== value.length) invalid();
    (value as unknown[]).forEach(check);
}
function alias(value: unknown): void { boundedText(value,256); if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) invalid(); }
/** This parser performs NO config/network reads. Admission hashes the unresolved intent
 * before aliases, full target sets or latest are resolved. Never hash an expanded plan. */
export function parseApplicationIntent(input: unknown): ApplicationIntent {
    if (!input || typeof input !== 'object' || !Object.hasOwn(input,'operation')) return parseBusinessRequest(input);
    let value: LegacyIntent;
    try { value=JSON.parse(businessJson(input)); } catch { return invalid(); }
    shape(value,'key,operation'); identifier(value.key);
    const op=value.operation;
    switch(op?.kind) {
        case 'manual':
            shape(op,'kind,action,accounts'); validateAction(op.action);
            if(op.action.kind!=='manual_deploy') invalid();
            if(op.accounts!==null) { strings(op.accounts,accountId); op.accounts.sort(sort); }
            break;
        case 'batch':
            shape(op,'kind,action,aliases,domain'); validateAction(op.action);
            if(op.action.kind!=='deploy_worker' || op.action.ref!=='latest' || op.action.echTokenEnabled!==false) invalid();
            strings(op.aliases,alias); op.aliases.sort(sort);
            shape(op.domain,'enabled,customPrefix');
            validateAction({kind:'configure_domain',template:op.action.template,worker:op.action.worker,...op.domain});
            break;
        case 'nodes':
            shape(op,'kind,template,account,content'); accountId(op.account);
            validateAction({kind:'write_nodes',template:op.template,worker:'validate-target',content:op.content}); break;
        case 'repair':
            shape(op,'kind,template,targets,rotateSubdomain'+(Object.hasOwn(op,'preserveProtectedSubdomains')?',preserveProtectedSubdomains':'')); templateType(op.template);
            if(Object.hasOwn(op,'preserveProtectedSubdomains')&&op.preserveProtectedSubdomains!==true)invalid();
            if(typeof op.rotateSubdomain!=='boolean' || !Array.isArray(op.targets) || !op.targets.length || op.targets.length>980) invalid();
            for(const target of op.targets) { shape(target,'account,worker'); accountId(target.account); workerName(target.worker); }
            if(new Set(op.targets.map(t=>t.account+':'+t.worker)).size!==op.targets.length) invalid();
            op.targets.sort((a,b)=>sort(a.account+':'+a.worker,b.account+':'+b.worker));
            break;
        default: invalid();
    }
    return value;
}
/** Trusted, synchronous expansion from one authoritative view, followed by the same
 * credential/source planner and transactional dependencies as native tasks. No KV. */
export class ApplicationPlanner {
    constructor(private readonly config:ConfigStore,private readonly business:BusinessPlanner) {}
    async prepare(scope:string,input:ApplicationIntent):Promise<PreparedTaskInput> {
        const intent=parseApplicationIntent(input);
        if(!('operation' in intent)) return this.business.prepare(scope,intent);
        const view=this.config.read(['accounts']);
        const expected=view.records.map(r=>({domain:r.domain,revision:r.revision}));
        this.config.assertBarrier(view.generation,view.epoch,expected);
        const accounts=view.records[0].value as unknown as AccountEntry[];
        if(!Array.isArray(accounts) || new Set(accounts.map(a=>a?.accountId)).size!==accounts.length) invalid();
        // Credentials are not decrypted here; BusinessPlanner validates them before use.
        for(const acc of accounts) { accountId(acc?.accountId); alias(acc.alias); }
        const targets:BusinessRequest['targets']=[];
        const op=intent.operation;
        if(op.kind==='manual') {
            const selected=op.accounts===null ? accounts.filter(a=>(a[('workers_'+op.action.template) as `workers_${string}`]?.length || 0)>0)
                : op.accounts.map(id=>{const a=accounts.find(a=>a.accountId===id);if(!a) return invalid();return a;});
            for(const acc of selected) targets.push({account:acc.accountId,actions:[op.action]});
        } else if(op.kind==='batch') {
            for(const name of op.aliases) {
                const selected=accounts.filter(a=>a.alias===name);
                if(selected.length!==1) invalid(); // Never silently choose the first duplicate alias.
                targets.push({account:selected[0].accountId,actions:[op.action,{kind:'configure_domain',template:op.action.template,worker:op.action.worker,...op.domain}]});
            }
        } else if(op.kind==='nodes') {
            const account=accounts.find(a=>a.accountId===op.account); if(!account) return invalid();
            const workers=account[('workers_'+op.template) as `workers_${string}`] ?? [];
            if(!workers.length || new Set(workers).size!==workers.length) invalid();
            targets.push({account:op.account,actions:[...workers].sort().map(worker=>({kind:'write_nodes',template:op.template,worker,content:op.content}))});
        } else {
            const actual=accounts.flatMap(acc=>(acc[('workers_'+op.template) as `workers_${string}`] || []).map(worker=>({account:acc.accountId,worker})))
                .sort((a,b)=>sort(a.account+':'+a.worker,b.account+':'+b.worker));
            if(canonical(actual)!==canonical(op.targets)) invalid(); // Whole-installation confirmation, not only a per-account subset.
            for(const acc of accounts) {
                const workers=op.targets.filter(t=>t.account===acc.accountId).map(t=>t.worker);
                if(workers.length) targets.push({account:acc.accountId,actions:[{kind:'repair',template:op.template,workers,rotateSubdomain:op.rotateSubdomain&&!(op.preserveProtectedSubdomains&&this.business.isSubdomainProtected(acc.accountId))}]});
            }
        }
        // Called before the first await: BusinessPlanner reads its view synchronously.
        const plan=await this.business.prepare(scope,parseBusinessRequest({key:intent.key,targets}),op.kind==='manual' && op.accounts===null?[op.action.template]:[]);
        this.config.assertBarrier(view.generation,view.epoch,expected);
        if(plan.generation!==view.generation || plan.epoch!==view.epoch || plan.expected.find(r=>r.domain==='accounts')?.revision!==expected[0].revision) throw new ReliabilityError('CONFLICT',409);
        return plan;
    }
}

export const LEGACY_TASK_PATHS = ['/api/deploy','/api/batch_deploy','/api/fix_1101','/api/delete_worker','/api/change_subdomain','/api/save_yxip'] as const;
function optionalShape(input:unknown,required:string[],optional:string[]):asserts input is Record<string,any> {
    if(!input || typeof input!=='object' || Array.isArray(input) || Object.getPrototypeOf(input)!==Object.prototype || required.some(k=>!Object.hasOwn(input,k)) || Object.keys(input).some(k=>!required.includes(k)&&!optional.includes(k))) invalid();
}
function bool(value:unknown, fallback=false):boolean { if(value===undefined)return fallback;if(typeof value!=='boolean')return invalid();return value; }
/** HTTP compatibility is explicit: caller MUST require X-Reliability-Protocol: 1 and
 * an Idempotency-Key first. Older pages expecting an array must get an upgrade refusal.
 * Request credentials, account snapshots, handler names and scopes are not accepted. */
export function legacyHttpIntent(request:Request,raw:unknown):ApplicationIntent {
    const url=new URL(request.url),key=request.headers.get('idempotency-key') ?? ''; identifier(key);
    if(request.method!=='POST' || url.hash) invalid();
    let operation:LegacyIntent['operation'];
    if(url.pathname==='/api/deploy') {
        if([...url.searchParams.keys()].some(k=>k!=='type') || url.searchParams.getAll('type').length!==1) invalid();
        const template=url.searchParams.get('type'); templateType(template);
        optionalShape(raw,[],['variables','deletedVariables','targetSha','customCode','echTokenEnabled','echDisableWorkersDev','targetAccountIds']);
        const custom=raw.customCode!==undefined && raw.customCode!==null && raw.customCode!=='';
        if(custom && raw.targetSha) invalid();
        operation={kind:'manual',action:{kind:'manual_deploy',template,source:custom?{kind:'custom',code:raw.customCode}:{kind:'upstream',ref:raw.targetSha ?? 'latest'},variables:variables(raw.variables ?? []),deletedVariables:raw.deletedVariables ?? [],echTokenEnabled:bool(raw.echTokenEnabled),echDisableWorkersDev:bool(raw.echDisableWorkersDev)},accounts:raw.targetAccountIds ?? null};
    } else if(url.pathname==='/api/batch_deploy') {
        if(url.search) invalid();
        optionalShape(raw,['template','workerName','targetAccounts'],['kvName','config','disableWorkersDev','customDomainPrefix','enableKV','savedVars','useSavedVars']);
        templateType(raw.template); workerName(raw.workerName);
        const enableKV=bool(raw.enableKV); bool(raw.useSavedVars);
        if(enableKV && (!TEMPLATES[raw.template].kvBindingName || typeof raw.kvName!=='string' || !raw.kvName.trim())) invalid();
        if(raw.kvName!==undefined) boundedText(raw.kvName,512);
        const config=raw.config ?? {};
        if(!config || typeof config!=='object' || Array.isArray(config)) invalid();
        variables(Object.entries(config).map(([key,value])=>({key,value})));
        const saved=raw.savedVars===null || raw.savedVars===undefined ? undefined : variables(raw.savedVars);
        operation={kind:'batch',action:{kind:'deploy_worker',template:raw.template,worker:raw.workerName,ref:'latest',variables:variables(batchVariables(raw.template as TemplateType,saved,config)),sourceVariables:variables(configToVariables(config)),namespaceTitle:enableKV?raw.kvName:'',echTokenEnabled:false},aliases:raw.targetAccounts,domain:{enabled:!bool(raw.disableWorkersDev),customPrefix:raw.customDomainPrefix ?? ''}};
    } else if(url.pathname==='/api/delete_worker') {
        if(url.search) invalid();
        optionalShape(raw,['accountId','workerName'],['deleteKv']); accountId(raw.accountId); workerName(raw.workerName);
        return parseBusinessRequest({key,targets:[{account:raw.accountId,actions:[{kind:'remove_worker',worker:raw.workerName,deleteKv:bool(raw.deleteKv)}]}]});
    } else if(url.pathname==='/api/change_subdomain') {
        if(url.search) invalid();
        optionalShape(raw,['accountId','newSubdomain'],[]); accountId(raw.accountId); boundedText(raw.newSubdomain,256);
        return parseBusinessRequest({key,targets:[{account:raw.accountId,actions:[{kind:'rename_subdomain',subdomain:raw.newSubdomain.trim().toLowerCase()}]}]});
    } else if(url.pathname==='/api/save_yxip') {
        if(url.search) invalid();
        optionalShape(raw,['type','accountId','rawContent'],[]);
        operation={kind:'nodes',template:raw.type,account:raw.accountId,content:raw.rawContent};
    } else if(url.pathname==='/api/fix_1101') {
        if(url.search) invalid();
        optionalShape(raw,['type','expectedTargets'],['preserveProtectedSubdomains']); templateType(raw.type);
        if(Object.hasOwn(raw,'preserveProtectedSubdomains')&&raw.preserveProtectedSubdomains!==true)invalid();
        if(!Array.isArray(raw.expectedTargets)) invalid();
        operation={kind:'repair',template:raw.type,rotateSubdomain:true,...(raw.preserveProtectedSubdomains===true?{preserveProtectedSubdomains:true as const}:{}),targets:raw.expectedTargets.map((t:unknown)=>{shape(t,'accountId,workerName');return {account:t.accountId,worker:t.workerName};})};
    } else return invalid();
    return parseApplicationIntent({key,operation}) as LegacyIntent;
}
