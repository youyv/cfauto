import {canonical,identifier,sha256,ReliabilityError,type Json} from './protocol';
import {SealedStore,type SealedContext} from './sealed-store';
import {copyPreparedTask,copyPreparedTarget} from './prepared-task-copy';
import {SourceInterner} from './shared-source';
import type {AutomationDecision} from './automation-planner';
import type {PreparedTaskInput} from './task-preparation';

export interface DecisionIdentity {cycle:string;generation:string;at:number}
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const rootContext=(id:DecisionIdentity):SealedContext=>({id:'decision_'+id.cycle,kind:'artifact',account:'automation',generation:id.generation});
const partContext=(id:DecisionIdentity,lane:number,ordinal:number,account:string):SealedContext=>({id:'decision_part_'+id.cycle+'_'+lane+'_'+ordinal,kind:'artifact',account,generation:id.generation});
function identity(value:any,id:DecisionIdentity):void {
    if(!value||value.cycle!==id.cycle||value.generation!==id.generation||value.at!==id.at||!Array.isArray(value.lanes)||value.lanes.length>10||new Set(value.lanes.map((lane:any)=>lane.template)).size!==value.lanes.length)unavailable();
}
/** Clone only bounded per-account targets, retaining exact artifact sharing in
 * memory. Never stringify the complete multi-account source payload at once. */
export function copyAutomationDecision(input:AutomationDecision):AutomationDecision {
    if(!input||Object.getPrototypeOf(input)!==Object.prototype||!Array.isArray(input.lanes)||input.lanes.length>10||input.lanes.some(lane=>!lane||Object.getPrototypeOf(lane)!==Object.prototype))unavailable();
    const copy=JSON.parse(canonical({...input,lanes:[]})),interner=new SourceInterner();
    copy.lanes=input.lanes.map(lane=>({...JSON.parse(canonical({...lane,plan:null})),plan:copyPreparedTask(lane.plan,interner)}));return copy;
}
/** Parts precede the root commit marker. No task is admitted until the entire
 * immutable root AND every referenced part authenticate. Orphans are retained;
 * recovery never recomputes source/randomness after an incomplete manifest. */
export async function storeAutomationDecision(sealed:SealedStore,id:DecisionIdentity,input:AutomationDecision):Promise<void> {
    const value=copyAutomationDecision(input);identity(value,id);if(value.schema!==1)unavailable();
    const root:any={...value,schema:2,lanes:[]};
    for(const [laneIndex,lane] of value.lanes.entries()){
        identifier(lane.template);const targets=[];
        for(const [ordinal,target] of lane.plan.targets.entries()){
            const context=partContext(id,laneIndex,ordinal,target.account);
            const part={schema:1,cycle:id.cycle,template:lane.template,ordinal,target};
            await sealed.put(context,part as unknown as Json);
            if(canonical(await sealed.get(context))!==canonical(part))unavailable();
            targets.push({account:target.account,ordinal,digest:await sha256(canonical(part))});
        }
        root.lanes.push({...lane,plan:{...lane.plan,targets}});
    }
    await sealed.put(rootContext(id),root);
}
/** Schema 1 is the original inline decision. Schema 2 has authenticated target
 * references in exactly the same sealed-store/AAD format; no DB or key migration. */
export async function readAutomationDecision(sealed:SealedStore,id:DecisionIdentity):Promise<AutomationDecision> {
    const root=await sealed.get(rootContext(id)) as any;identity(root,id);
    const interner=new SourceInterner();
    if(root.schema===1){for(const lane of root.lanes)for(const target of lane.plan?.targets??[])interner.apply(target);return root;}
    if(root.schema!==2||Object.keys(root).sort().join(',')!=='at,checked,cycle,epoch,gc,generation,issues,lanes,schema'||!Number.isSafeInteger(root.epoch)||root.epoch<0||typeof root.checked!=='boolean'||typeof root.gc!=='boolean'||!Array.isArray(root.issues))unavailable();
    const decision:AutomationDecision={...root,schema:1,lanes:[]};
    for(const [laneIndex,lane] of root.lanes.entries()){
        if(!lane?.plan||!Array.isArray(lane.plan.targets)||lane.plan.targets.length>100||new Set(lane.plan.targets.map((ref:any)=>ref.account)).size!==lane.plan.targets.length)unavailable();
        identifier(lane.template);const targets:PreparedTaskInput['targets']=[];
        for(const [ordinal,ref] of lane.plan.targets.entries()){
            if(!ref||Object.keys(ref).sort().join(',')!=='account,digest,ordinal'||ref.ordinal!==ordinal||typeof ref.digest!=='string'||!/^[a-f0-9]{64}$/.test(ref.digest))unavailable();
            identifier(ref.account);const context=partContext(id,laneIndex,ordinal,ref.account);
            const part=await sealed.get(context) as any;
            // This digest stays INSIDE the encrypted root, never in public/SQL metadata.
            if(await sha256(canonical(part))!==ref.digest)unavailable();
            if(!part||Object.keys(part).sort().join(',')!=='cycle,ordinal,schema,target,template'||part.schema!==1||part.cycle!==id.cycle||part.template!==lane.template||part.ordinal!==ordinal||part.target?.account!==ref.account)unavailable();
            targets.push(copyPreparedTarget(part.target,interner));
        }
        decision.lanes.push({...lane,plan:{...lane.plan,targets}});
    }
    return decision;
}
