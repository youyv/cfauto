import {copyPreparedTask} from './prepared-task-copy';
import {packBusinessSources} from './shared-source';
import type { RetainedCustomSource } from './retained-custom-source';
import { buildDeploymentPlans } from './deployment-plan';
import { normalizeUpstream } from '../lib/upstream';
import { planRemovalNamespaces, type InventoryTransport } from './resource-inventory';
import { businessJson } from './business-limits';
import { TEMPLATES, readTemplateSettings } from '../config/templates';
import type { AccountEntry } from '../lib/types';
import { ConfigStore } from './config-store';
import { readCredentialAccounts } from './credential-accounts';
import type { KeyRing } from './credential-envelope';
import { canonical, sha256, ReliabilityError, type Json, type ConfigChange } from './protocol';
import type { PreparedTaskInput } from './task-preparation';
import { MAX_SEALED_PLAINTEXT_BYTES } from './sealed-store';
import { isSourceReference, loadSourceArtifact, type SourceRequest, type SourceOptions, type SourceArtifact, type DeploymentArtifact } from './source-artifact';
import { accountId, invalid, parseBusinessOperation, protect, resourcePolicy, shape, taskIdentity, validateAction, variables, type BusinessAction, type BusinessCommand, type BusinessOperation, type ProtectedResources } from './business-command';

const COMPATIBILITY_TEMPLATE_KINDS = new Set(['repair','manual_deploy','upload','create_worker','replace_worker','deploy_worker','fuse']);
export interface BusinessRequest { key: string; targets: { account: string; actions: BusinessAction[] }[] }
/** Copy and validate public intent BEFORE any await; never accept a prepared snapshot. */
export function parseBusinessRequest(input: unknown): BusinessRequest {
    let request: BusinessRequest;
    try { request = JSON.parse(businessJson(input)); } catch { return invalid(); }
    shape(request, 'key,targets'); taskIdentity('intent', request.key, 0);
    if (!Array.isArray(request.targets) || !request.targets.length || request.targets.length > 20 || new Set(request.targets.map(t => t?.account)).size !== request.targets.length) invalid();
    for (const target of request.targets) {
        shape(target, 'account,actions'); accountId(target.account);
        if (!Array.isArray(target.actions) || !target.actions.length || target.actions.length > 50) invalid();
        target.actions.forEach(validateAction);
    }
    request.targets.sort((a,b) => a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
    return request;
}
/** Server-owned policy, not browser JSON. Source transport is read-only and fixed-host. */
export interface PlannerOptions { ring: KeyRing; protected: ProtectedResources; source?: SourceOptions; inventory?: InventoryTransport; customSource?: Pick<RetainedCustomSource, 'load'>; frozenView?: ReturnType<ConfigStore['read']>; sourceLoader?: (request: SourceRequest) => Promise<SourceArtifact>; allowFullFuse?: boolean }
/** Produces an immutable executable snapshot, not an HTTP endpoint. ConfigStore.read is
 * synchronous and records ALL dependencies before crypto/network awaits. Submission
 * still MUST go through GlobalCoordinatorRuntime/TaskPreparation's transactional CAS.
 * Explicit creation and existing-worker commands; legacy batch/fuse/config adapters
 * are separate and must not bypass this boundary. */
export class BusinessPlanner {
    private readonly options: PlannerOptions;
    constructor(private readonly config: ConfigStore, options: PlannerOptions) {
        this.options = { ...options, ring: { ...options.ring, keys: { ...options.ring.keys } }, protected: resourcePolicy(options.protected), source: { ...options.source }, ...(options.frozenView ? {frozenView:JSON.parse(canonical(options.frozenView))} : {}) };

    }
    isSubdomainProtected(account: string): boolean { accountId(account); return this.options.protected.workers.some(p=>p.account===account); }
    private loadSource(request: SourceRequest): Promise<SourceArtifact> {
        return this.options.sourceLoader ? this.options.sourceLoader(request) : loadSourceArtifact(request,this.options.source);
    }
    async prepare(scope: string, input: BusinessRequest, fullTemplates: string[] = []): Promise<PreparedTaskInput> {
        const request = parseBusinessRequest(input);
        fullTemplates = [...fullTemplates];
        if (new Set(fullTemplates).size!==fullTemplates.length || fullTemplates.some(t=>!Object.hasOwn(TEMPLATES,t))) invalid();
        for (const target of request.targets) for (const action of target.actions) if ('template' in action && fullTemplates.includes(action.template) && !['manual_deploy','upload','configure_domain',...(this.options.allowFullFuse?['fuse']:[])].includes(action.kind)) invalid();
        // These commands do not consume a clock. Random UUID/subdomain decisions
        // below live in the sealed admission manifest, never in executor-time randomness.
        const now = 0; taskIdentity(scope, request.key, now);
        if (!Array.isArray(request.targets) || !request.targets.length || request.targets.length > 20 || new Set(request.targets.map(t => t?.account)).size !== request.targets.length) invalid();
        const domains = new Set(['accounts']);
        for (const target of request.targets) {
            shape(target, 'account,actions'); accountId(target.account);
            if (!Array.isArray(target.actions) || !target.actions.length || target.actions.length > 50) invalid();
            for (const action of target.actions) {
                validateAction(action); protect(this.options.protected, target.account, action);
                if ('template' in action && COMPATIBILITY_TEMPLATE_KINDS.has(action.kind)) domains.add('template:' + action.template);
                if (action.kind === 'remove_worker') for(const t of Object.keys(TEMPLATES)) for(const domain of ['deploy:'+t,'vars:'+t,'favorites:'+t,'override:'+t+':'+target.account]) domains.add(domain);
                if (action.kind === 'repair') { domains.add('vars:' + action.template); domains.add('upstream:' + action.template); }
                if (action.kind === 'manual_deploy') {
                    domains.add('override:' + action.template + ':' + target.account);
                    if (action.source.kind === 'upstream') domains.add('upstream:' + action.template);
                }
                if (action.kind === 'create_worker' || action.kind === 'replace_worker' || action.kind === 'deploy_worker') domains.add('upstream:' + action.template);
                if (action.kind === 'upload' || action.kind === 'fuse') {
                    domains.add('vars:' + action.template); domains.add('upstream:' + action.template);
                    if (action.kind === 'fuse' || action.overrides !== 'ignore') domains.add('override:' + action.template + ':' + target.account);
                    if (action.kind === 'fuse') domains.add('deploy:' + action.template);
                }
            }
        }
        const fixed=this.options.frozenView;
        const view = fixed ? {generation:fixed.generation,epoch:fixed.epoch,records:[...domains].sort().map(domain=>fixed.records.find(r=>r.domain===domain) ?? {domain,revision:0,value:null})} : this.config.read([...domains].sort());
        const record = (domain: string): Json => { const r = view.records.find(r => r.domain === domain); if (!r) return invalid(); return r.value; };
        // Frozen with the plan: later panel edits must not change an admitted task's upload metadata.
        const compatibilityDate = (template: string): string => {
            const settings = readTemplateSettings(template, record('template:' + template));
            if (!settings) throw new ReliabilityError('NOT_READY', 503);
            return settings.compatibilityDate;
        };
        const expected = view.records.map(r => ({ domain: r.domain, revision: r.revision }));
        this.config.assertBarrier(view.generation, view.epoch, expected); // Reject maintenance before downloads.
        const accounts = await readCredentialAccounts(record('accounts') as unknown as AccountEntry[], this.options.ring);
        const artifacts = new Map<string, SourceArtifact>();
        const targets: PreparedTaskInput['targets'] = [];
        const changes = new Map<string,ConfigChange>();
        const policies = new Map<string,{mode:'latest'|'fixed';sourceIdentity:string}>();
        const describe = (template:string, ref:string, account:string, ordinal:number, custom=false) => {
            const mode = ref==='latest' && !custom ? 'latest' as const : 'fixed' as const;
            const selection = custom ? {path:'',branch:''} : normalizeUpstream(record('upstream:'+template) ?? {path:'',branch:''});
            const sourceIdentity=selection.path?JSON.stringify(selection):'';
            policies.set(account+':'+ordinal,{mode,sourceIdentity});
        };
        for (const target of request.targets) {
            const account = accounts.find(a => a.accountId === target.account); if (!account) return invalid();
            const authMode = account.authMode ?? (account.apiToken ? 'token' : 'key');
            const credential:BusinessOperation['credential']={authMode,email:account.email,apiToken:authMode==='token'?account.apiToken || '':'',globalKey:authMode==='key'?account.globalKey:''};
            const commands: BusinessCommand[] = [];
            const createdWorkers = new Set<string>();
            const actions: Exclude<BusinessAction,{kind:'fuse'}>[] = [];
            const rotations = new Map<string,ReturnType<typeof variables>>();
            const changedTemplates = new Set<string>();
            for (const intent of target.actions) {
                if (intent.kind !== 'fuse') { actions.push(intent); continue; }
                // Fuse is account/template-wide: one frozen UUID for ALL registered
                // workers. Never let a client rotate only a subset of that account.
                if (changedTemplates.has(intent.template) || target.actions.some(a=>a !== intent && 'template' in a && a.template===intent.template)) invalid();
                changedTemplates.add(intent.template);
                const workers = account['workers_' + intent.template as `workers_${string}`] ?? [];
                if (!workers.length || new Set(workers).size !== workers.length) invalid();
                const deploy = record('deploy:' + intent.template) ?? {mode:'latest'};
                if (!deploy || Array.isArray(deploy) || typeof deploy !== 'object' || !['latest','fixed'].includes(deploy.mode as string)) return invalid();
                const custom = deploy.mode === 'fixed' && deploy.currentSha === null;
                const ref = deploy.mode === 'fixed' ? deploy.currentSha : 'latest';
                if (!custom && (!isSourceReference(ref) || (deploy.mode==='fixed' && ref==='latest'))) return invalid();
                const domain = 'override:' + intent.template + ':' + target.account;
                const global = variables(record('vars:' + intent.template) ?? []), old = variables(record(domain) ?? []);
                const field = TEMPLATES[intent.template].uuidField;
                const base = old.find(v=>v.key===field) ?? global.find(v=>v.key===field);
                const rotated = variables([{key:field,value:crypto.randomUUID(),secret:base?.secret===true}]);
                rotations.set(intent.template,rotated);
                changes.set(domain,{domain,expectedRevision:expected.find(r=>r.domain===domain)!.revision,value:rotated as unknown as Json});
                if (custom) {
                    const digest=deploy.currentCustomSha;
                    if (typeof digest!=='string' || deploy.currentDigest!==digest || deploy.sourceIdentity!=='' || !this.options.customSource) return invalid();
                    const artifact=await this.options.customSource.load(view.generation,intent.template,digest);
                    // Preserve UUID-only override semantics, and use the existing
                    // custom-capable executor. No fake commit, upstream download,
                    // domain toggle, variable deletion or global version promotion.
                    const merged=new Map(global.map(v=>[v.key,v]));
                    for (const v of rotated) merged.set(v.key,v);
                    for (const worker of [...workers].sort()) {
                        describe(intent.template,'fixed',target.account,commands.length,true);
                        const command:BusinessCommand={kind:'manual_upload',template:intent.template,worker,artifact,variables:[...merged.values()],deletedVariables:[],echTokenEnabled:intent.echTokenEnabled,preserveBlankPlainText:true};
                        protect(this.options.protected,target.account,command);
                        commands.push(command);
                    }
                } else for (const worker of [...workers].sort()) actions.push({kind:'upload',template:intent.template,worker,ref:ref as string,overrides:'apply',echTokenEnabled:intent.echTokenEnabled});
            }
            for (const action of actions) {
                validateAction(action); protect(this.options.protected,target.account,action);
                if (action.kind !== 'upload' || action.overrides !== 'clear') continue;
                const same = actions.filter(a=>'template' in a && a.template===action.template);
                const workers = account['workers_' + action.template as `workers_${string}`] ?? [];
                if (!workers.length || same.length !== workers.length || same.some(a=>a.kind!=='upload' || a.overrides!=='clear') || new Set(same.map(a=> 'worker' in a ? a.worker : '')).size !== workers.length || workers.some(w=>!same.some(a=>'worker' in a && a.worker===w))) invalid();
                const domain='override:'+action.template+':'+target.account;
                if (record(domain)!==null) changes.set(domain,{domain,expectedRevision:expected.find(r=>r.domain===domain)!.revision,value:null});
            }
            const repairRotation = target.actions.some(a => a.kind === 'repair' && a.rotateSubdomain);
            if (repairRotation && target.actions.some(a => a.kind !== 'repair')) invalid();
            for (const intent of actions) {
                // Resolve batch upsert from the authoritative account registry, not a
                // provider error. Snapshot the choice; retries must never flip mode.
                const action: Exclude<BusinessAction, { kind: 'deploy_worker' | 'fuse' }> = intent.kind === 'deploy_worker'
                    ? { ...intent, kind: account[`workers_${intent.template}`]?.includes(intent.worker) || createdWorkers.has(intent.template + ':' + intent.worker) ? 'replace_worker' as const : 'create_worker' as const }
                    : intent;
                if(action.kind==='remove_worker') {
                    // A removal occupies its own account task. Do not let later uploads
                    // recreate a target before the frozen namespace cleanup completes.
                    if(actions.length!==1) invalid();
                    const namespaces=action.deleteKv ? await planRemovalNamespaces(target.account,action.worker,credential,this.options.inventory) : null;
                    for(const namespace of namespaces ?? []) protect(this.options.protected,target.account,{kind:'delete_kv',namespace});
                    const cleanupDomains=new Set(Object.keys(TEMPLATES).flatMap(t=>['deploy:'+t,'vars:'+t,'favorites:'+t,'override:'+t+':'+target.account]));
                    const cleanup=expected.filter(r=>cleanupDomains.has(r.domain));
                    commands.push({kind:'remove_worker',worker:action.worker,namespaces,cleanup});
                    for(const namespace of namespaces ?? []) commands.push({kind:'cleanup_kv',worker:action.worker,namespace});
                    continue;
                }
                if (action.kind === 'repair') {
                    const workers = account[`workers_${action.template}`] ?? [];
                    if (actions.filter(a=>'template' in a && a.template===action.template).length !== 1 || !workers.length || new Set(workers).size !== workers.length || canonical([...workers].sort()) !== canonical([...action.workers].sort())) invalid();
                    for (const worker of workers) {
                        if (Object.keys(TEMPLATES).some(t=>t!==action.template && account[`workers_${t}`]?.includes(worker))) invalid();
                        protect(this.options.protected,target.account,{kind:'delete_worker',template:action.template,worker});
                    }
                    const selection = record('upstream:' + action.template) ?? {path:'',branch:''};
                    const sourceKey = canonical([action.template,selection,'latest']);
                    let artifact = artifacts.get(sourceKey);
                    if (!artifact) { artifact=await this.loadSource({template:action.template,selection,ref:'latest'}); artifacts.set(sourceKey,artifact); }
                    const global = variables(record('vars:'+action.template) ?? []);
                    for (const worker of [...workers].sort()) {
                        describe(action.template,'latest',target.account,commands.length);
                        commands.push({kind:'repair_worker',template:action.template,worker,artifact,variables:global,echTokenEnabled:true,compatibilityDate:compatibilityDate(action.template)});
                    }
                    continue;
                }
                if (action.kind === 'manual_deploy') {
                    // A manual operation clears the selected account/template override,
                    // therefore it must cover ALL of its registered workers, once each.
                    if (actions.filter(a=>'template' in a && a.template===action.template).length !== 1) invalid();
                    const workers = account[`workers_${action.template}`] ?? [];
                    if (!workers.length || new Set(workers).size !== workers.length || commands.length + workers.length * (action.template === 'ech' ? 2 : 1) > 50) invalid();
                    for (const worker of workers) {
                        if (Object.keys(TEMPLATES).some(t=>t!==action.template && account[`workers_${t}`]?.includes(worker))) invalid();
                        protect(this.options.protected,target.account,{kind:'delete_worker',template:action.template,worker});
                    }
                    let artifact: DeploymentArtifact;
                    if (action.source.kind === 'custom') artifact = {kind:'custom',template:action.template,code:action.source.code,digest:await sha256(action.source.code)};
                    else {
                        const selection=record('upstream:'+action.template) ?? {path:'',branch:''};
                        const sourceKey=canonical([action.template,selection,action.source.ref]);
                        let frozen=artifacts.get(sourceKey);
                        if (!frozen) { frozen=await this.loadSource({template:action.template,selection,ref:action.source.ref}); artifacts.set(sourceKey,frozen); }
                        artifact=frozen;
                    }
                    const domain='override:'+action.template+':'+target.account;
                    if (record(domain)!==null) changes.set(domain,{domain,expectedRevision:expected.find(r=>r.domain===domain)!.revision,value:null});
                    const supplied=variables(action.variables).filter(v=>v.value.trim()!=='' && !action.deletedVariables.includes(v.key));
                    for (const worker of workers) {
                        describe(action.template,action.source.kind==='custom'?'custom':action.source.ref,target.account,commands.length,action.source.kind==='custom');
                        commands.push({kind:'manual_upload',template:action.template,worker,artifact,variables:supplied,deletedVariables:action.deletedVariables,echTokenEnabled:action.echTokenEnabled,compatibilityDate:compatibilityDate(action.template)});
                        if (action.template==='ech') commands.push({kind:'configure_domain',template:action.template,worker,enabled:!action.echDisableWorkersDev,hostname:'',zone:''});
                    }
                    continue;
                }
                // Creation is explicit, never an upload fallback on a missing target.
                if ('worker' in action) {
                    const registered = account[`workers_${action.template}`]?.includes(action.worker) || createdWorkers.has(action.template + ':' + action.worker);
                    if (action.kind === 'create_worker') {
                        if (Object.keys(TEMPLATES).some(t => account[`workers_${t}`]?.includes(action.worker) || createdWorkers.has(t + ':' + action.worker))) invalid();
                        createdWorkers.add(action.template + ':' + action.worker);
                    } else if (!registered || (action.kind === 'replace_worker' && Object.keys(TEMPLATES).some(t => t !== action.template && account[`workers_${t}`]?.includes(action.worker)))) invalid();
                }
                if (action.kind === 'upload' || action.kind === 'create_worker' || action.kind === 'replace_worker') {
                    const selection = record('upstream:' + action.template) ?? { path: '', branch: '' };
                    const sourceKey = canonical([action.template, selection, action.ref]);
                    let artifact = artifacts.get(sourceKey);
                    if (!artifact) { artifact = await this.loadSource({ template: action.template, selection, ref: action.ref }); artifacts.set(sourceKey, artifact); }
                    describe(action.template,action.ref,target.account,commands.length);
                    if (action.kind !== 'upload') {
                        commands.push({ kind: action.kind, template: action.template, worker: action.worker, artifact, variables: variables(action.variables).filter(v => v.value.trim() !== ''), namespaceTitle: action.namespaceTitle, echTokenEnabled: action.echTokenEnabled, compatibilityDate: compatibilityDate(action.template), ...(action.sourceVariables ? {sourceVariables:variables(action.sourceVariables)} : {}) });
                        continue;
                    }
                    const global = variables(record('vars:' + action.template) ?? []);
                    const override = action.overrides === 'apply' ? rotations.get(action.template) ?? variables(record('override:' + action.template + ':' + account.accountId) ?? []) : [];
                    // Preserve existing UUID-only override semantics; never apply legacy
                    // unrelated override values to secrets or proxy settings.
                    const merged = new Map(global.map(v => [v.key, v]));
                    for (const v of override) if (v.key === TEMPLATES[action.template].uuidField) merged.set(v.key, v);
                    commands.push({ kind: 'upload', template: action.template, worker: action.worker, artifact, variables: [...merged.values()], echTokenEnabled: action.echTokenEnabled, compatibilityDate: compatibilityDate(action.template) });
                } else if (action.kind === 'configure_domain') {
                    if (action.customPrefix && (!account.defaultZoneId || !account.defaultZoneName)) invalid();
                    commands.push({ kind: action.kind, template: action.template, worker: action.worker, enabled: action.enabled,
                        hostname: action.customPrefix ? action.customPrefix + '.' + account.defaultZoneName : '', zone: action.customPrefix ? account.defaultZoneId! : '' });
                    if (action.customPrefix) commands.push({ kind: action.kind, template: action.template, worker: action.worker, enabled: action.enabled, hostname: '', zone: '' });
                } else commands.push(action);
            }
            // The account-level rotation is planned as a plain subdomain change: the
            // executor tries the non-destructive PUT first and only ever deletes an
            // existing workers.dev subdomain when the provider refuses that PUT, with a
            // verified restore of the previous name whenever the replacement does not
            // hold. A repair must never strand an account without a hostname.
            if (repairRotation) commands.push({kind:'change_subdomain',subdomain:'repair-' + crypto.randomUUID().replace(/-/g,'').slice(0,24)});
            const operation = parseBusinessOperation({ schema: 1, account: account.accountId, credential, commands } satisfies BusinessOperation, account.accountId);
            const coordinated = { credentialRevision: account.credentialRevision!, input: { now, uuids: [], subdomains: [], sources: {} }, operation:packBusinessSources(operation) };
            if (new TextEncoder().encode(canonical(coordinated)).length > MAX_SEALED_PLAINTEXT_BYTES - 16384) invalid();
            targets.push({ account: account.accountId, steps: commands.map(c => c.kind), operation: coordinated as unknown as Json });
        }
        // The caller can inspect nothing mutable from config/request/options after await.
        // Check once here for early failure, and again atomically in task submission.
        this.config.assertBarrier(view.generation, view.epoch, expected);
        const deployment=buildDeploymentPlans(targets,accounts,policies,fullTemplates);
        return copyPreparedTask({ ...(deployment.length?{deployment}:{}), scope, key: request.key, generation: view.generation, epoch: view.epoch, expected, ...(changes.size ? {changes:[...changes.values()].sort((a,b)=>a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0)} : {}), targets });
    }
}
