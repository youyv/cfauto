import {initialCredentialRing} from './initial-credential-ring';
import {MaintenanceInitialCutover} from './maintenance-initial-cutover';
import {MaintenanceGeneration} from './maintenance-generation';
import {MaintenanceArchive} from './maintenance-archive';
import {AuthorityDrain} from './authority-drain';
import {MaintenanceAuthentication,MAINTENANCE_ORIGIN} from './maintenance-protocol';
import {MaintenanceEndpoint} from './maintenance-endpoint';
import {MaintenanceService,maintenanceIntent} from './maintenance-service';
import { ExternalReads } from './external-reads';
import { TaskCatalog } from './task-catalog';
import { AuthorityViews } from './authority-views';
import { ConfigProjection } from './config-projection';
import { AutomationCycles } from './automation-cycle';
import { AutomationPlanner } from './automation-planner';
import { AutomationFlow } from './automation-flow';
import { WebhookOutbox } from './webhook-outbox';
import { RetainedCustomSource } from './retained-custom-source';
import { DurableObject } from 'cloudflare:workers';
import { fetchDirectWithTimeout } from '../lib/cloudflare-api';
import { AccountQueue } from './account-queue';
import { executeBusinessOperation } from './business-executor';
import { accountId, shape } from './business-command';
import { BusinessAdmission } from './business-admission';
import { ApplicationPlanner, parseApplicationIntent } from './application-intent';
import { BusinessPlanner } from './business-planner';
import { ConfigStore, type SqlDatabase } from './config-store';
import { CoordinatorEndpoint, type RoleRuntime } from './coordinator-endpoint';
import { CoordinatorRpc, type CoordinatorRole } from './coordinator-rpc';
import { GlobalCoordinatorRuntime, AccountCoordinatorRuntime } from './coordinator-runtime';
import { CredentialAuthority } from './credential-authority';
import { ConfigEditor } from './config-editor';
import { productionConfig, type ProductionConfig, type ReliabilityEnv } from './production-config';
import { sendCoordinatorRpc } from './production-rpc';
import { canonical, sha256, ReliabilityError, type Json } from './protocol';
import { SealedStore } from './sealed-store';
import { TaskDispatch } from './task-dispatch';
import { TaskPreparation } from './task-preparation';

/** Production-only role shell. Intentionally NOT exported by src/index.ts or bound in
 * production Wrangler until ALL writers, migration and remote gates are validated.
 * Only fetch/alarm are callable: no bootstrap, test flags, injected executor, raw SQL,
 * key getters or RPC-callable TypeScript-private helpers. */
export class ProductionCoordinator extends DurableObject<ReliabilityEnv> {
    #db: SqlDatabase;
    #config: ProductionConfig;
    #endpoint: CoordinatorEndpoint;
    #rpc: CoordinatorRpc;
    #maintenance: MaintenanceEndpoint | undefined;
    #maintenanceService: MaintenanceService | undefined;
    #globalRuntime: GlobalCoordinatorRuntime | undefined;
    #archiveService: Promise<MaintenanceArchive> | undefined;
    #generationService: Promise<MaintenanceGeneration> | undefined;
    #initialService: MaintenanceInitialCutover | undefined;
    #admission: Pick<BusinessAdmission, 'listIncomplete'|'recover'> | undefined;
    constructor(ctx: DurableObjectState, env: ReliabilityEnv) {
        super(ctx, env);
        this.#config = productionConfig(env); // Fail before creating business tables.
        this.#rpc = new CoordinatorRpc(this.#config.rpcSecret);
        this.#db = { rows: <T extends Record<string, unknown>>(query: string, ...params: (string | number | null)[]) => ctx.storage.sql.exec(query, ...params).toArray() as T[], transaction: fn => ctx.storage.transactionSync(fn) };
        this.#endpoint = new CoordinatorEndpoint(this.#db, this.#rpc, name => ctx.id.equals(env.RELIABILITY_COORDINATOR.idFromName(name)), role => this.#create(role));
    }
    #create(role: CoordinatorRole): RoleRuntime {
        if (role.role === 'account') accountId(role.account);
        const sealed = new SealedStore(this.#db, this.#config.snapshots);
        const wakeup = { admit: <T>(fn: () => Promise<T>) => this.ctx.blockConcurrencyWhile(fn), arm: (delay: number) => this.ctx.storage.setAlarm(Date.now() + delay) };
        const send = sendCoordinatorRpc.bind(undefined, this.env.RELIABILITY_COORDINATOR, this.#rpc);
        if (role.role === 'global') {
            const config = new ConfigStore(this.#db), dispatch = new TaskDispatch(this.#db, new TextEncoder().encode(this.#config.idempotencySecret));
            const authority = new CredentialAuthority(this.#db, config, dispatch, this.#config.credentials);
            const editor = new ConfigEditor(this.#db, config, authority, this.#config.credentials, new TextEncoder().encode(this.#config.idempotencySecret));
            const preparation = new TaskPreparation(config, sealed, dispatch, new TextEncoder().encode(this.#config.idempotencySecret));
            const runtime = new GlobalCoordinatorRuntime(this.#db, config, sealed, dispatch, authority, preparation, send, wakeup, true, operator=>{if(!this.#config.maintenance?.operators[operator]?.permissions.includes('review'))throw new ReliabilityError('INVALID',403);},async message=>{if(!this.#config.maintenance?.operators[message.operator]?.permissions.includes('archive')||canonical(message.target)!==canonical({account:this.env.RELIABILITY_MANAGER_ACCOUNT,worker:this.env.RELIABILITY_MANAGER_WORKER,namespace:this.env.RELIABILITY_CONFIG_NAMESPACE}))throw new ReliabilityError('INVALID',403);return maintenanceIntent(message,this.#config.idempotencySecret);},async message=>{const permission=message.command.action==='review_candidates'?'inspect':message.command.action==='review_attest'?'attest':message.command.action==='review_close_failed'?'adjudicate':undefined;if(!permission||!this.#config.maintenance?.operators[message.operator]?.permissions.includes(permission)||canonical(message.target)!==canonical({account:this.env.RELIABILITY_MANAGER_ACCOUNT,worker:this.env.RELIABILITY_MANAGER_WORKER,namespace:this.env.RELIABILITY_CONFIG_NAMESPACE}))throw new ReliabilityError('INVALID',403);return maintenanceIntent(message,this.#config.idempotencySecret);});
            this.#globalRuntime = runtime;
            const admission = new BusinessAdmission(this.#db, config, sealed, dispatch,
                new ApplicationPlanner(config, new BusinessPlanner(config, { ring: this.#config.credentials, protected: this.#config.protected, source: { token: this.env.GITHUB_TOKEN }, customSource: new RetainedCustomSource(this.#db, sealed) })),
                input => runtime.submit(input), new TextEncoder().encode(this.#config.idempotencySecret), parseApplicationIntent);
            this.#admission = admission;
            const projection = new ConfigProjection(this.#db, config), views = new AuthorityViews(config, this.#config.credentials, projection);
            const external = new ExternalReads(config, authority, {ring:this.#config.credentials,githubToken:this.env.GITHUB_TOKEN,protected:this.#config.protected});
            const cycles = new AutomationCycles(this.#db, config, sealed);
            const flow = new AutomationFlow(this.#db, config, cycles, sealed,
                new AutomationPlanner(this.#db, config, cycles, { ring: this.#config.credentials, protected: this.#config.protected, source: { token: this.env.GITHUB_TOKEN }, customSource: new RetainedCustomSource(this.#db, sealed) }),
                dispatch, new WebhookOutbox(this.#db, sealed), { submit: (plan, guard) => runtime.submit(plan, guard), arm: wakeup.arm });
            const catalog = new TaskCatalog(this.#db, dispatch, admission, new TextEncoder().encode(this.#config.idempotencySecret));
            return {
                tick: async () => { await runtime.tick(); await flow.tick(); if(config.status().generation && projection.consume().pending)await wakeup.arm(1000); },
                handle: async (message): Promise<Json> => {
                    if (message.direction === 'scheduler-global') {
                        if (message.account !== this.env.RELIABILITY_MANAGER_ACCOUNT || message.method !== 'cron_cycle') throw new ReliabilityError('INVALID', 403);
                        const body:unknown=message.body;
                        shape(body, 'scheduledAt');
                        return flow.start(body.scheduledAt);
                    }
                    if (message.direction !== 'gateway-global') {
                        const result = await runtime.handle(message);
                        if (message.method === 'complete' || message.method === 'progress') {
                            const task = (message.body as {permit:{task:string}}).permit.task;
                            // Account receipts must not await global work that can submit
                            // more account messages. Runtime already durably scheduled a wake.
                            this.ctx.waitUntil(flow.observeTask(task));
                        }
                        return result;
                    }
                    if (message.account !== this.env.RELIABILITY_MANAGER_ACCOUNT) throw new ReliabilityError('INVALID', 403);
                    // One installation administrator today. The browser cannot choose
                    // a scope, source transport, prepared snapshot or executor.
                    const body: unknown = message.body;
                    if (message.method === 'read_external') { shape(body, 'request'); return external.read(body.request); }
                    if (message.method === 'read_view') { shape(body, 'selector'); return views.read(body.selector); }
                    if (message.method === 'read_config') { shape(body, 'selector'); return editor.read(body.selector); }
                    if (message.method === 'edit_config') { shape(body, 'request'); const result=await editor.edit(body.request); await wakeup.arm(1000); return result; }
                    if (message.method === 'submit_task') {
                        shape(body, 'request');
                        return admission.submit('manager', body.request);
                    }
                    if (message.method === 'list_tasks') return catalog.list('manager',body);
                    if (message.method === 'wake_task') {
                        shape(body,'id');
                        await catalog.inspect('manager',body.id);
                        await runtime.requestWake(body.id);
                        return { id:body.id,wakeRequested:true };
                    }
                    if (message.method === 'cancel_task') {
                        shape(body, 'id');
                        await catalog.inspect('manager', body.id);
                        await runtime.requestCancel(body.id);
                        return { id: body.id, cancellationRequested: true };
                    }
                    if (message.method === 'inspect_task') {
                        shape(body, 'id');
                        return catalog.inspect('manager', body.id);
                    }
                    throw new ReliabilityError('INVALID', 400);
                }
            };
        }
        return new AccountCoordinatorRuntime(this.#db, new AccountQueue(this.#db), sealed, role.account, send, wakeup, {
            digestSecret: this.#config.evidenceSecret,
            businessEffects: true,
            archiveInstallation:()=>sha256(canonical({account:this.env.RELIABILITY_MANAGER_ACCOUNT,worker:this.env.RELIABILITY_MANAGER_WORKER,namespace:this.env.RELIABILITY_CONFIG_NAMESPACE})),
            transport: (url, init, timeout) => {
                const target = new URL(url);
                if (target.origin !== 'https://api.cloudflare.com' || target.username || target.password || target.hash || !target.pathname.startsWith('/client/v4/accounts/' + role.account + '/')) throw new ReliabilityError('INVALID', 403);
                // The executor supplies fixed URLs and the journal supplies the signal.
                // Never send credentials to a redirect, different account or arbitrary URL.
                return fetchDirectWithTimeout(url, { ...init, redirect: 'manual' }, timeout);
            },
            execute: (operation, step) => executeBusinessOperation(role.account, operation, step, this.#config.protected)
        });
    }
    async fetch(request: Request): Promise<Response> {
        if(new URL(request.url).origin===MAINTENANCE_ORIGIN){
            if(!this.#config.maintenance)return Response.json({error:'NOT_READY'},{status:503,headers:{'Cache-Control':'no-store'}});
            if(!this.#maintenance)this.#maintenance=new MaintenanceEndpoint(new MaintenanceAuthentication(this.#config.maintenance,{account:this.env.RELIABILITY_MANAGER_ACCOUNT,worker:this.env.RELIABILITY_MANAGER_WORKER,namespace:this.env.RELIABILITY_CONFIG_NAMESPACE}),name=>this.ctx.id.equals(this.env.RELIABILITY_COORDINATOR.idFromName(name)),()=>{
                // Only after independent signature + physical global validation.
                this.#endpoint.bindTrusted({role:'global'});
                if(!this.#maintenanceService){const config=new ConfigStore(this.#db);this.#maintenanceService=new MaintenanceService(this.#db,config,new AuthorityDrain(this.#db,config,sendCoordinatorRpc.bind(undefined,this.env.RELIABILITY_COORDINATOR,this.#rpc)),Date.now,message=>{if(!this.#globalRuntime)throw new ReliabilityError('NOT_READY',503);return this.#globalRuntime.observeUnknown(message);},async message=>{if(!this.#admission)throw new ReliabilityError('NOT_READY',503);return message.command.action==='admission_list'?this.#admission.listIncomplete('manager',message.command.args):this.#admission.recover('manager',(message.command.args as {id:string}).id);},async message=>{if(['account_archive','archive_accounts'].includes(message.command.action)){if(!this.#globalRuntime)throw new ReliabilityError('NOT_READY',503);return this.#globalRuntime.archiveMaintenance(message);}if(!this.#archiveService)this.#archiveService=sha256(canonical({account:this.env.RELIABILITY_MANAGER_ACCOUNT,worker:this.env.RELIABILITY_MANAGER_WORKER,namespace:this.env.RELIABILITY_CONFIG_NAMESPACE})).then(installation=>new MaintenanceArchive(this.#db,config,new SealedStore(this.#db,this.#config.snapshots),installation));return (await this.#archiveService).execute(message);},this.#config.idempotencySecret,async(message,commit)=>{if(!this.#generationService)this.#generationService=sha256(canonical({account:this.env.RELIABILITY_MANAGER_ACCOUNT,worker:this.env.RELIABILITY_MANAGER_WORKER,namespace:this.env.RELIABILITY_CONFIG_NAMESPACE})).then(installation=>new MaintenanceGeneration(this.#db,config,new SealedStore(this.#db,this.#config.snapshots),installation,this.#config.credentials,new TextEncoder().encode(this.#config.idempotencySecret),new AuthorityDrain(this.#db,config,sendCoordinatorRpc.bind(undefined,this.env.RELIABILITY_COORDINATOR,this.#rpc))));return (await this.#generationService).execute(message,commit);},async message=>{if(!this.#globalRuntime)throw new ReliabilityError('NOT_READY',503);return this.#globalRuntime.adjudicate(message);},async(message,commit)=>{if(!this.#initialService)this.#initialService=new MaintenanceInitialCutover(this.#db,config,new SealedStore(this.#db,this.#config.snapshots),{account:this.env.RELIABILITY_MANAGER_ACCOUNT,worker:this.env.RELIABILITY_MANAGER_WORKER,namespace:this.env.RELIABILITY_CONFIG_NAMESPACE},this.#config.initialCutover,initialCredentialRing(this.env,this.#config,this.#config.initialCutover),new TextEncoder().encode(this.#config.idempotencySecret));return this.#initialService.execute(message,commit);});}
                return this.#maintenanceService;
            });
            return this.#maintenance.fetch(request);
        }
        return this.#endpoint.fetch(request);
    }
    async alarm(): Promise<void> { await this.#endpoint.alarm(); }
}
