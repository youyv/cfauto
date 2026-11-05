import {copyBusinessOperation} from './shared-source';
import { TEMPLATES, isValidCompatibilityDate } from '../config/templates';
import { canonical, identifier, revision, ReliabilityError } from './protocol';
import { MAX_SOURCE_BYTES, customSourceCode, isSourceReference, type SourceArtifact, type DeploymentArtifact } from './source-artifact';
import type { VariableEntry } from '../lib/types';

type WorkerDeployAction = { [K in 'create_worker' | 'replace_worker' | 'deploy_worker']:
    { kind: K; template: string; worker: string; ref: string; variables: VariableEntry[]; namespaceTitle: string; echTokenEnabled: boolean; sourceVariables?: VariableEntry[] }
}['create_worker' | 'replace_worker' | 'deploy_worker'];
export type ManualSource = { kind: 'upstream'; ref: string } | { kind: 'custom'; code: string };
export type BusinessAction =
    | { kind: 'repair'; template: string; workers: string[]; rotateSubdomain: boolean }
    | { kind: 'manual_deploy'; template: string; source: ManualSource; variables: VariableEntry[]; deletedVariables: string[]; echTokenEnabled: boolean; echDisableWorkersDev: boolean }
    | { kind: 'upload'; template: string; worker: string; ref: string; overrides: 'apply' | 'clear' | 'ignore'; echTokenEnabled: boolean }
    | { kind: 'fuse'; template: string; echTokenEnabled: boolean }
    | WorkerDeployAction
    | { kind: 'remove_worker'; worker: string; deleteKv: boolean }
    | { kind: 'delete_worker'; template: string; worker: string }
    | { kind: 'configure_domain'; template: string; worker: string; enabled: boolean; customPrefix: string }
    | { kind: 'rename_subdomain'; subdomain: string }
    | { kind: 'change_subdomain'; subdomain: string }
    | { kind: 'delete_kv'; namespace: string }
    | { kind: 'write_nodes'; template: string; worker: string; content: string };
export type BusinessCommand = Exclude<BusinessAction, { kind: 'remove_worker' | 'repair' | 'manual_deploy' | 'fuse' | 'upload' | 'create_worker' | 'replace_worker' | 'deploy_worker' | 'configure_domain' }> |
    { kind: 'remove_worker'; worker: string; namespaces: string[] | null; cleanup: {domain:string; revision:number}[] } |
    { kind: 'cleanup_kv'; worker: string; namespace: string } |
    { kind: 'repair_worker'; template: string; worker: string; artifact: SourceArtifact; variables: VariableEntry[]; echTokenEnabled: true; compatibilityDate?: string } |
    { kind: 'rotate_subdomain'; subdomain: string } |
    { kind: 'manual_upload'; template: string; worker: string; artifact: DeploymentArtifact; variables: VariableEntry[]; deletedVariables: string[]; echTokenEnabled: boolean; preserveBlankPlainText?: true; compatibilityDate?: string } |
    { kind: 'upload'; template: string; worker: string; artifact: SourceArtifact; variables: VariableEntry[]; echTokenEnabled: boolean; compatibilityDate?: string } |
    { kind: 'create_worker' | 'replace_worker'; template: string; worker: string; artifact: SourceArtifact; variables: VariableEntry[]; namespaceTitle: string; echTokenEnabled: boolean; sourceVariables?: VariableEntry[]; compatibilityDate?: string } |
    { kind: 'configure_domain'; template: string; worker: string; enabled: boolean; hostname: string; zone: string };
export interface BusinessOperation {
    schema: 1; account: string;
    credential: { email: string; globalKey: string; apiToken: string; authMode: 'key' | 'token' };
    commands: BusinessCommand[];
}
export interface ProtectedResources { workers: { account: string; worker: string }[]; namespaces: { account: string; namespace: string }[] }
export const invalid = (): never => { throw new ReliabilityError('INVALID', 400); };
export function shape(value: unknown, keys: string): asserts value is Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) invalid();
}
function optionalCompatibilityDate(command: Record<string, any>): void {
    if (!Object.hasOwn(command, 'compatibilityDate')) return;
    // Frozen at planning time; old sealed snapshots may omit it and fall back to the template default.
    if (!isValidCompatibilityDate(command.compatibilityDate)) invalid();
}
export function accountId(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) invalid(); }
export function workerName(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) invalid(); }
export function templateType(value: unknown): asserts value is string { if (typeof value !== 'string' || !Object.hasOwn(TEMPLATES, value)) invalid(); }
export function boundedText(value: unknown, max: number): asserts value is string { if (typeof value !== 'string' || new TextEncoder().encode(value).length > max) invalid(); }
function subdomain(value: unknown): void { if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) invalid(); }
export function validateAction(value: unknown): asserts value is BusinessAction {
    const action = value as BusinessAction;
    switch (action?.kind) {
        case 'repair':
            shape(action,'kind,template,workers,rotateSubdomain'); templateType(action.template);
            if (typeof action.rotateSubdomain !== 'boolean' || !Array.isArray(action.workers) || !action.workers.length || action.workers.length > 49 || new Set(action.workers).size !== action.workers.length) invalid();
            action.workers.forEach(workerName); return;
        case 'manual_deploy':
            shape(action, 'kind,template,source,variables,deletedVariables,echTokenEnabled,echDisableWorkersDev'); templateType(action.template);
            if (typeof action.echTokenEnabled !== 'boolean' || typeof action.echDisableWorkersDev !== 'boolean') invalid();
            if (action.source?.kind === 'custom') { shape(action.source,'kind,code'); customSourceCode(action.source.code); }
            else { shape(action.source,'kind,ref'); if (action.source.kind !== 'upstream' || !isSourceReference(action.source.ref)) invalid(); }
            variables(action.variables); deletedVariables(action.deletedVariables, action.template); return;
        case 'upload': shape(action, 'kind,template,worker,ref,overrides,echTokenEnabled'); if (!isSourceReference(action.ref) || !['apply','clear','ignore'].includes(action.overrides) || typeof action.echTokenEnabled !== 'boolean') invalid(); break;
        case 'fuse': shape(action,'kind,template,echTokenEnabled'); templateType(action.template); if (!TEMPLATES[action.template].uuidField || typeof action.echTokenEnabled !== 'boolean') invalid(); return;
        case 'deploy_worker':
        case 'replace_worker':
        case 'create_worker': shape(action, 'kind,template,worker,ref,variables,namespaceTitle,echTokenEnabled' + (Object.hasOwn(action,'sourceVariables') ? ',sourceVariables' : '')); if (Object.hasOwn(action,'sourceVariables')) variables(action.sourceVariables); if (!isSourceReference(action.ref) || typeof action.echTokenEnabled !== 'boolean') invalid(); namespaceTitle(action.namespaceTitle); variables(action.variables); break;
        case 'remove_worker': shape(action,'kind,worker,deleteKv'); workerName(action.worker); if(typeof action.deleteKv!=='boolean') invalid(); return;
        case 'delete_worker': shape(action, 'kind,template,worker'); break;
        case 'configure_domain': shape(action, 'kind,template,worker,enabled,customPrefix'); if (typeof action.enabled !== 'boolean' || typeof action.customPrefix !== 'string' || (action.customPrefix !== '' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(action.customPrefix))) invalid(); break;
        case 'rename_subdomain':
        case 'change_subdomain': shape(action, 'kind,subdomain'); subdomain(action.subdomain); return;
        case 'delete_kv': shape(action, 'kind,namespace'); accountId(action.namespace); return;
        case 'write_nodes': shape(action, 'kind,template,worker,content'); boundedText(action.content, 65536); if (!action.content.trim()) invalid(); break;
        default: invalid();
    }
    templateType(action.template); workerName(action.worker);
    if (action.kind === 'create_worker' || action.kind === 'replace_worker' || action.kind === 'deploy_worker') creationBindings(action);
    if (action.kind === 'write_nodes' && !TEMPLATES[action.template].yxipKey) invalid();
}
export function variables(value: unknown): VariableEntry[] {
    if (!Array.isArray(value) || value.length > 256) return invalid();
    const names = new Set<string>();
    return value.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(k => !['key','value','secret','type'].includes(k))) invalid();
        if (typeof entry.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry.key) || names.has(entry.key)) invalid();
        names.add(entry.key); boundedText(entry.value, 8192);
        if ((entry.secret !== undefined && typeof entry.secret !== 'boolean') || (entry.type !== undefined && entry.type !== 'plain_text' && entry.type !== 'secret_text')) invalid();
        return { key: entry.key, value: entry.value, secret: entry.secret === true || entry.type === 'secret_text' };
    });
}
/** Explicit text-variable deletion only: never a namespace or arbitrary binding removal. */
export function deletedVariables(value: unknown, template: string): asserts value is string[] {
    if (!Array.isArray(value) || value.length > 256 || new Set(value).size !== value.length || value.some(k => typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) || k === TEMPLATES[template].kvBindingName)) invalid();
}
function upstreamArtifact(artifact: SourceArtifact, template: string): void {
    shape(artifact, 'template,repository,path,commit,code,digest');
    if (typeof artifact.commit !== 'string' || typeof artifact.digest !== 'string' || artifact.template !== template || artifact.repository !== TEMPLATES[template].ghUser + '/' + TEMPLATES[template].ghRepo || !/^[a-f0-9]{40}$/.test(artifact.commit) || !/^[a-f0-9]{64}$/.test(artifact.digest)) invalid();
    boundedText(artifact.path, 512); boundedText(artifact.code, MAX_SOURCE_BYTES); if (!artifact.code.trim()) invalid();
}
/** A title is data, never a path. No trimming after admission may change its identity. */
function namespaceTitle(value: unknown): asserts value is string {
    boundedText(value, 512);
    if (value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) invalid();
}
function creationBindings(command: { template: string; namespaceTitle: string; variables: VariableEntry[] }): void {
    namespaceTitle(command.namespaceTitle);
    const binding = TEMPLATES[command.template].kvBindingName;
    if (command.namespaceTitle && (!binding || command.variables.some(v => v.key === binding))) invalid();
}
export function resourcePolicy(input: ProtectedResources): ProtectedResources {
    let policy: ProtectedResources;
    try { policy = JSON.parse(canonical(input)); } catch { return invalid(); }
    shape(policy, 'workers,namespaces');
    if (!Array.isArray(policy.workers) || !Array.isArray(policy.namespaces)) invalid();
    for (const p of policy.workers) { shape(p,'account,worker'); accountId(p.account); workerName(p.worker); }
    for (const p of policy.namespaces) { shape(p,'account,namespace'); accountId(p.account); accountId(p.namespace); }
    return policy;
}
export function protect(policy: ProtectedResources, account: string, action: BusinessAction | BusinessCommand): void {
    if (('worker' in action && policy.workers.some(p => p.account === account && p.worker === action.worker)) ||
        ((action.kind === 'delete_kv' || action.kind === 'cleanup_kv') && policy.namespaces.some(p => p.account === account && p.namespace === action.namespace)) ||
        ((action.kind === 'rename_subdomain' || action.kind === 'change_subdomain' || action.kind === 'rotate_subdomain' || (action.kind === 'repair' && action.rotateSubdomain)) && policy.workers.some(p => p.account === account))) invalid();
}
/** Defense in depth at executor entry; never dispatch an arbitrary method, URL or handler. */
export function parseBusinessOperation(input: unknown, boundAccount: string): BusinessOperation {
    let value: BusinessOperation;
    try { value = copyBusinessOperation(input); } catch { return invalid(); }
    shape(value, 'schema,account,credential,commands'); accountId(value.account); accountId(boundAccount);
    if (value.schema !== 1 || value.account !== boundAccount || !Array.isArray(value.commands) || !value.commands.length || value.commands.length > 50) invalid();
    shape(value.credential, 'email,globalKey,apiToken,authMode');
    const cred = value.credential;
    for (const field of ['email','globalKey','apiToken'] as const) { boundedText(cred[field], 8192); if (/[\x00-\x1f\x7f]/.test(cred[field])) invalid(); }
    if (cred.authMode === 'token' ? !cred.apiToken.trim() || !!cred.globalKey : cred.authMode === 'key' ? !cred.globalKey.trim() || !cred.email.trim() || !!cred.apiToken : true) invalid();
    for (const command of value.commands) {
        if (command?.kind === 'remove_worker') {
            shape(command,'kind,worker,namespaces,cleanup'); workerName(command.worker);
            if(command.namespaces!==null) {
                if(!Array.isArray(command.namespaces) || command.namespaces.length>49 || new Set(command.namespaces).size!==command.namespaces.length) invalid();
                command.namespaces.forEach(accountId);
                if(canonical(command.namespaces)!==canonical([...command.namespaces].sort())) invalid();
            }
            if(value.commands[0]!==command || value.commands.length!==1+(command.namespaces?.length ?? 0) || (command.namespaces ?? []).some((namespace,i)=>{const next=value.commands[i+1];return next?.kind!=='cleanup_kv' || next.worker!==command.worker || next.namespace!==namespace;})) invalid();
            const domains=Object.keys(TEMPLATES).flatMap(t=>['deploy:'+t,'vars:'+t,'favorites:'+t,'override:'+t+':'+value.account]).sort();
            if(!Array.isArray(command.cleanup) || canonical(command.cleanup.map(r=>r?.domain))!==canonical(domains)) invalid();
            for(const row of command.cleanup){shape(row,'domain,revision');revision(row.revision);}
        } else if(command?.kind === 'cleanup_kv') {
            shape(command,'kind,worker,namespace'); workerName(command.worker); accountId(command.namespace);
            const index=value.commands.indexOf(command);
            const before=value.commands.slice(0,index);
            const removal=before.find(c=>c.kind==='remove_worker' && c.worker===command.worker);
            if(!removal || removal.kind!=='remove_worker' || !removal.namespaces?.includes(command.namespace) || before.some(c=>c.kind==='cleanup_kv' && c.namespace===command.namespace)) invalid();
        } else if (command?.kind === 'rotate_subdomain') {
            shape(command,'kind,subdomain'); subdomain(command.subdomain);
        } else if (command?.kind === 'repair_worker') {
            shape(command,'kind,template,worker,artifact,variables,echTokenEnabled'+(Object.hasOwn(command,'compatibilityDate')?',compatibilityDate':'')); templateType(command.template); workerName(command.worker);
            if (command.echTokenEnabled !== true) invalid();
            optionalCompatibilityDate(command);
            command.variables = variables(command.variables); upstreamArtifact(command.artifact, command.template);
        } else if (command?.kind === 'manual_upload') {
            shape(command,'kind,template,worker,artifact,variables,deletedVariables,echTokenEnabled'+(Object.hasOwn(command,'preserveBlankPlainText')?',preserveBlankPlainText':'')+(Object.hasOwn(command,'compatibilityDate')?',compatibilityDate':'')); templateType(command.template); workerName(command.worker);
            optionalCompatibilityDate(command);
            if (typeof command.echTokenEnabled !== 'boolean') invalid();
            command.variables = variables(command.variables); deletedVariables(command.deletedVariables,command.template);
            // Only the trusted retained-source planner can request exact blank text.
            // Public manual intents keep their established blank-means-preserve policy.
            if (Object.hasOwn(command,'preserveBlankPlainText') && (command.preserveBlankPlainText!==true || command.deletedVariables.length!==0)) invalid();
            if (command.variables.some(v=> (!v.value.trim() && (!command.preserveBlankPlainText || v.secret)) || command.deletedVariables.includes(v.key))) invalid();
            if (command.artifact && typeof command.artifact === 'object' && 'kind' in command.artifact) {
                shape(command.artifact,'kind,template,code,digest');
                if (command.artifact.kind !== 'custom' || command.artifact.template !== command.template || typeof command.artifact.digest !== 'string' || !/^[a-f0-9]{64}$/.test(command.artifact.digest)) invalid();
                customSourceCode(command.artifact.code);
            } else upstreamArtifact(command.artifact,command.template);
        } else if (command?.kind === 'upload' || command?.kind === 'create_worker' || command?.kind === 'replace_worker') {
            shape(command, (command.kind !== 'upload' ? 'kind,template,worker,artifact,variables,namespaceTitle,echTokenEnabled' + (Object.hasOwn(command,'sourceVariables') ? ',sourceVariables' : '') : 'kind,template,worker,artifact,variables,echTokenEnabled') + (Object.hasOwn(command,'compatibilityDate') ? ',compatibilityDate' : '')); templateType(command.template); workerName(command.worker);
            optionalCompatibilityDate(command);
            if (typeof command.echTokenEnabled !== 'boolean') invalid();
            command.variables = variables(command.variables);
            if (command.kind !== 'upload') { creationBindings(command); if (Object.hasOwn(command,'sourceVariables')) command.sourceVariables = variables(command.sourceVariables); }
            upstreamArtifact(command.artifact,command.template);
        } else if (command?.kind === 'configure_domain') {
            shape(command, 'kind,template,worker,enabled,hostname,zone'); templateType(command.template); workerName(command.worker);
            if (typeof command.enabled !== 'boolean' || typeof command.hostname !== 'string' || typeof command.zone !== 'string') invalid();
            if (command.hostname) {
                accountId(command.zone);
                if (command.hostname.length > 253 || !command.hostname.includes('.') || command.hostname.split('.').some(p => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) invalid();
            } else if (command.zone) invalid();
        } else {
            if (['deploy_worker','fuse','manual_deploy','repair'].includes((command as { kind: string })?.kind)) invalid(); // Planner-only intent, never executable.
            validateAction(command);
        }
    }
    return value;
}
export function taskIdentity(scope: string, key: string, now: number): void { identifier(scope); identifier(key); revision(now); }
