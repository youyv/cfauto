import {expandBusinessSources} from './shared-source';
import { TEMPLATES } from '../config/templates';
import type { AccountEntry } from '../lib/types';
import { normalizeUpstream } from '../lib/upstream';
import { accountId, workerName, shape, invalid as rejectInput, type BusinessCommand, type BusinessOperation } from './business-command';
import { canonical, encoded, revision } from './protocol';
import type { PreparedTaskInput } from './task-preparation';
function invalid(): never { return rejectInput(); }
export interface DeploymentTarget { account: string; worker: string; steps: number[] }
export interface DeploymentPlan {
    template: string; scope: 'full' | 'partial'; mode: 'latest' | 'fixed';
    sha: string | null; customSha: string | null; sourceDigest: string; sourceIdentity: string;
    targets: DeploymentTarget[];
}
export const SCRIPT_COMMANDS = new Set(['upload','manual_upload','create_worker','replace_worker','repair_worker']);
export function targetKey(account: string, worker: string): string { return account + '::' + worker; }
export function deploymentIdentity(plan: Pick<DeploymentPlan, 'sha' | 'customSha' | 'sourceDigest' | 'sourceIdentity'>): string {
    return canonical([plan.sha, plan.customSha, plan.sourceDigest, plan.sourceIdentity]);
}
/** Trusted planner metadata, never accepted from an HTTP request. Even this boundary
 * checks every target/ordinal against immutable commands before writing any receipt. */
export function validateDeploymentPlans(input: unknown, targets?: PreparedTaskInput['targets']): DeploymentPlan[] {
    const plans: DeploymentPlan[] = JSON.parse(encoded(input));
    if (!Array.isArray(plans) || plans.length > 1000) invalid();
    const identities=new Set<string>(), workers=new Set<string>();
    for (const plan of plans) {
        shape(plan,'template,scope,mode,sha,customSha,sourceDigest,sourceIdentity,targets');
        if (!Object.hasOwn(TEMPLATES,plan.template) || !['full','partial'].includes(plan.scope) || !['latest','fixed'].includes(plan.mode)) invalid();
        if (plan.sha === null ? typeof plan.customSha !== 'string' || !/^[a-f0-9]{64}$/.test(plan.customSha) || plan.mode !== 'fixed' : typeof plan.sha !== 'string' || !/^[a-f0-9]{40}$/.test(plan.sha) || plan.customSha !== null) invalid();
        if (typeof plan.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(plan.sourceDigest) || (plan.customSha && plan.customSha !== plan.sourceDigest) || typeof plan.sourceIdentity !== 'string' || plan.sourceIdentity.length > 2048) invalid();
        if (plan.sourceIdentity) {
            try { const selection=normalizeUpstream(JSON.parse(plan.sourceIdentity)); if (!selection.path || JSON.stringify(selection)!==plan.sourceIdentity) invalid(); } catch { invalid(); }
        }
        if (!Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length > 1000 || new Set(plan.targets.map(t=>targetKey(t.account,t.worker))).size !== plan.targets.length) invalid();
        const identity=canonical([plan.template,plan.mode,deploymentIdentity(plan)]);
        if (identities.has(identity)) invalid(); identities.add(identity);
        if (plan.scope==='full' && plans.filter(p=>p.template===plan.template).length!==1) invalid();
        for (const target of plan.targets) {
            const unique=plan.template+':'+targetKey(target.account,target.worker); if (workers.has(unique)) invalid(); workers.add(unique);
            shape(target,'account,worker,steps'); accountId(target.account); workerName(target.worker);
            if (!Array.isArray(target.steps) || !target.steps.length || target.steps.length>100 || new Set(target.steps).size!==target.steps.length || target.steps.some((n,i)=>{revision(n); return n>=100 || (i>0 && n<=target.steps[i-1]);})) invalid();
            if (targets) {
                const owner=targets.find(t=>t.account===target.account);
                const operation=expandBusinessSources((owner?.operation as { operation?: BusinessOperation })?.operation) as BusinessOperation | undefined;
                if (!owner || !operation) invalid();
                const command=operation.commands[target.steps[0]];
                if (!command || !SCRIPT_COMMANDS.has(command.kind) || !('artifact' in command) || command.template!==plan.template || command.worker!==target.worker) invalid();
                const artifact=command.artifact;
                if (!('kind' in artifact)) { const selected=plan.sourceIdentity?normalizeUpstream(JSON.parse(plan.sourceIdentity)).path:TEMPLATES[plan.template].ghPath; if (artifact.path!==selected) invalid(); }
                if (artifact.digest!==plan.sourceDigest || ('kind' in artifact ? plan.customSha!==artifact.digest || plan.sha!==null : plan.sha!==artifact.commit || plan.customSha!==null)) invalid();
                const required=operation.commands.flatMap((c,i)=>i===target.steps[0] || c.kind==='rotate_subdomain' || c.kind==='change_subdomain' || (c.kind==='configure_domain' && c.template===plan.template && c.worker===target.worker) ? [i] : []);
                if (canonical(required)!==canonical(target.steps)) invalid();
            }
        }
        plan.targets.sort((a,b)=>targetKey(a.account,a.worker).localeCompare(targetKey(b.account,b.worker)));
    }
    if (targets) for (const target of targets) {
        const operation=expandBusinessSources((target.operation as { operation?: BusinessOperation })?.operation) as BusinessOperation | undefined;
        if (!operation?.commands) continue;
        for (const [ordinal,command] of operation.commands.entries()) if (SCRIPT_COMMANDS.has(command.kind)) {
            if (!('template' in command) || !('worker' in command) || !plans.some(p=>p.template===command.template && p.targets.some(t=>t.account===target.account && t.worker===command.worker && t.steps[0]===ordinal))) invalid();
        }
    }
    return plans.sort((a,b)=>{const ka=canonical([a.template,a.mode,deploymentIdentity(a)]),kb=canonical([b.template,b.mode,deploymentIdentity(b)]);return ka<kb?-1:ka>kb?1:0;});
}
export function buildDeploymentPlans(targets: PreparedTaskInput['targets'], accounts: AccountEntry[], policies: Map<string,{mode:'latest'|'fixed';sourceIdentity:string}>, fullTemplates: string[]): DeploymentPlan[] {
    const plans=new Map<string,DeploymentPlan>();
    for (const target of targets) {
        const commands=(expandBusinessSources((target.operation as unknown as {operation:BusinessOperation}).operation) as BusinessOperation).commands;
        for (const [ordinal,command] of commands.entries()) {
            if (!SCRIPT_COMMANDS.has(command.kind) || !('artifact' in command)) continue;
            const policy=policies.get(target.account+':'+ordinal); if (!policy) invalid();
            const artifact=command.artifact, source={sha:'kind' in artifact?null:artifact.commit,customSha:'kind' in artifact?artifact.digest:null,sourceDigest:artifact.digest,sourceIdentity:policy.sourceIdentity};
            const group=canonical([command.template,policy.mode,deploymentIdentity(source)]);
            let plan=plans.get(group);
            if (!plan) { plan={template:command.template,scope:fullTemplates.includes(command.template)?'full':'partial',mode:policy.mode,...source,targets:[]}; plans.set(group,plan); }
            if (deploymentIdentity(plan)!==deploymentIdentity(source) || plan.mode!==policy.mode) invalid();
            const steps=commands.flatMap((c:BusinessCommand,i)=>i===ordinal || c.kind==='rotate_subdomain' || c.kind==='change_subdomain' || (c.kind==='configure_domain' && c.template===command.template && c.worker===command.worker) ? [i] : []);
            plan.targets.push({account:target.account,worker:command.worker,steps});
        }
    }
    const result=validateDeploymentPlans([...plans.values()],targets);
    for (const template of fullTemplates) {
        const plan=result.find(p=>p.template===template); if (!plan) invalid();
        const all=accounts.flatMap(a=>(a[`workers_`+template as `workers_${string}`] ?? []).map(w=>targetKey(a.accountId,w))).sort();
        if (!all.length || canonical(all)!==canonical(plan.targets.map(t=>targetKey(t.account,t.worker)).sort())) invalid();
    }
    return result;
}
