import {copyAutomationDecision} from './automation-decision-store';
import { autoFlagKey, autoUpdateTypes, fuseRotatableTypes, TEMPLATES } from '../config/templates';
import type { AccountEntry, AutoUpdateConfig } from '../lib/types';
import { fetchInternalStats, statForAccount, isFuseTriggered, type StatResult } from '../lib/stats';
import { normalizeUpstream } from '../lib/upstream';
import { AutomationCycles } from './automation-cycle';
import { BusinessPlanner, type BusinessRequest, type PlannerOptions } from './business-planner';
import { splitAutomationConfig } from './config-editor';
import { ConfigStore, type SqlDatabase } from './config-store';
import { readCredentialAccounts } from './credential-accounts';
import { loadSourceArtifact, type SourceArtifact, type SourceRequest } from './source-artifact';
import type { PreparedTaskInput } from './task-preparation';
import { canonical, ReliabilityError, revision } from './protocol';
import { webhookDestination } from './webhook-outbox';

export interface AutomationDecision {
    schema:1; cycle:string; generation:string; epoch:number; at:number;
    checked:boolean; gc:boolean;
    lanes:{template:string;plan:PreparedTaskInput;webhook:string|null}[];
    issues:{template:string;code:string}[];
}
export interface AutomationPlannerOptions extends PlannerOptions { statistics?:(accounts:AccountEntry[])=>Promise<StatResult[]> }
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const workers=(account:AccountEntry,type:string):string[]=>((account as unknown as Record<string,unknown>)['workers_'+type]??[]) as string[];
/** Read-only decision builder. Called once after a durable cycle reservation; all
 * decisions are sealed before admission. Recovery never calls this builder again.
 * No KV configuration or legacy mutation helper participates in this path. */
export class AutomationPlanner {
    private readonly options:AutomationPlannerOptions;
    constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly cycles:AutomationCycles,options:AutomationPlannerOptions) {
        this.options={...options,ring:{...options.ring,keys:{...options.ring.keys}},source:{...options.source}};
    }
    async prepare(cycle:string,now:number):Promise<AutomationDecision> {
        revision(now);
        const frozen=await this.cycles.read(cycle) as unknown as {view:ReturnType<ConfigStore['readAll']>};
        const view=frozen.view, record=(domain:string)=>view.records.find(r=>r.domain===domain)??{domain,revision:0,value:null};
        const runtime=this.config.readRuntime().value as Record<string,number>;
        for(const key of ['lastCheck','lastGc'])if(runtime[key]!==undefined)revision(runtime[key]);
        const decision:AutomationDecision={schema:1,cycle,generation:view.generation,epoch:view.epoch,at:now,checked:false,gc:now-(runtime.lastGc??0)>=86400000,lanes:[],issues:[]};
        const split=splitAutomationConfig(record('autoConfig').value??{});
        if(Object.keys(split.runtime).length)unavailable();
        const auto=split.config as unknown as AutoUpdateConfig;
        if(!auto.enabled || now-(runtime.lastCheck??0)<=Number(auto.interval??30)*60000)return decision;
        decision.checked=true;
        const expected=[{domain:'accounts',revision:record('accounts').revision},{domain:'autoConfig',revision:record('autoConfig').revision}];
        this.config.assertBarrier(view.generation,view.epoch,expected);
        const accounts=await readCredentialAccounts(record('accounts').value as unknown as AccountEntry[],this.options.ring);
        if(!accounts.length)return decision;
        const busy=new Set(this.db.rows<{account:string}>("SELECT DISTINCT account FROM dispatch_outbox WHERE state!='terminal'").map(r=>r.account));
        const enabled=(template:string)=>(auto as unknown as Record<string,unknown>)[autoFlagKey(template)]!==false;
        const rotatable=new Set(fuseRotatableTypes().filter(enabled)), updating=new Set(autoUpdateTypes().filter(enabled));
        let stats:StatResult[]=[];
        if(Number(auto.fuseThreshold??0)>0 && accounts.some(a=>[...rotatable].some(t=>workers(a,t).length))) {
            try{
                const result=JSON.parse(canonical(await (this.options.statistics??fetchInternalStats)(accounts)));
                if(!Array.isArray(result)||result.some(s=>!s||typeof s!=='object'||Array.isArray(s)))unavailable();
                stats=result;
            }
            catch{decision.issues.push({template:'all',code:'STATS_UNAVAILABLE'});}
        }
        for(const template of Object.keys(TEMPLATES).filter(t=>updating.has(t)||rotatable.has(t)).sort()) {
            try {
                const owners=accounts.filter(a=>workers(a,template).length);
                if(!owners.length)continue;
                if(owners.some(a=>busy.has(a.accountId))){decision.issues.push({template,code:'ACCOUNT_BUSY'});continue;}
                const dep=(record('deploy:'+template).value??{mode:'latest'}) as Record<string,any>;
                if(!['latest','fixed'].includes(dep.mode))unavailable();
                if(dep.pendingTargets!==undefined && (!Array.isArray(dep.pendingTargets)||dep.pendingTargets.some((k:unknown)=>typeof k!=='string')||new Set(dep.pendingTargets).size!==dep.pendingTargets.length))unavailable();
                const selection=record('upstream:'+template).value??{path:'',branch:''};
                const normalized=normalizeUpstream(selection), identity=normalized.path?JSON.stringify(normalized):'';
                const sources=new Map<string,SourceArtifact>();
                const load=async(request:SourceRequest):Promise<SourceArtifact>=>{
                    const key=canonical(request);let artifact=sources.get(key);
                    if(!artifact){artifact=await loadSourceArtifact(request,this.options.source);sources.set(key,artifact);}
                    return artifact;
                };
                let full=false;const pending=new Set<string>();
                if(dep.mode==='latest' && updating.has(template)) {
                    const latest=await load({template,selection,ref:'latest'});
                    full=!dep.currentSha || dep.currentSha!==latest.commit || (dep.sourceIdentity??'')!==identity;
                    if(!full && dep.pendingSha===latest.commit && !dep.pendingCustomSha && (dep.pendingSourceIdentity??dep.sourceIdentity??'')===identity && (!dep.pendingDigest||dep.pendingDigest===latest.digest))for(const key of dep.pendingTargets??[])pending.add(key);
                }
                const targets:BusinessRequest['targets']=[];let fused=false;
                for(const account of owners) {
                    const fuse=rotatable.has(template)&&isFuseTriggered(statForAccount(stats,account.accountId),Number(auto.fuseThreshold??0));
                    if(fuse){fused=true;targets.push({account:account.accountId,actions:[{kind:'fuse',template,echTokenEnabled:true}]});}
                    else {
                        const selected=workers(account,template).filter(worker=>full||pending.has(account.accountId+'::'+worker));
                        if(selected.length)targets.push({account:account.accountId,actions:selected.map(worker=>({kind:'upload' as const,template,worker,ref:'latest',overrides:'apply' as const,echTokenEnabled:true}))});
                    }
                }
                if(!targets.length)continue;
                const planner=new BusinessPlanner(this.config,{...this.options,frozenView:view,sourceLoader:load,allowFullFuse:true});
                const plan=await planner.prepare('automation',{key:this.cycles.taskKey(cycle,template),targets},full?[template]:[]);
                for(const domain of ['autoConfig','deploy:'+template])if(!plan.expected.some(r=>r.domain===domain))plan.expected.push({domain,revision:record(domain).revision});
                plan.expected.sort((a,b)=>a.domain.localeCompare(b.domain));
                this.config.assertBarrier(plan.generation,plan.epoch,plan.expected);
                let webhook:string|null=null;
                if(fused&&auto.fuseWebhook){try{webhook=webhookDestination(auto.fuseWebhook).url;}catch{decision.issues.push({template,code:'WEBHOOK_UNSUPPORTED'});}}
                decision.lanes.push({template,plan,webhook});
            } catch(error) {decision.issues.push({template,code:error instanceof ReliabilityError?error.code:'NOT_READY'});}
        }
        return copyAutomationDecision(decision);
    }
}
