export {LocalInitialProductionCoordinator} from './initial-source-probe';
import {initialSourceProbe,type InitialProbeEnv} from './initial-source-probe';
import {initialActivationProbe} from './initial-activation-probe';
import {applicationProbe} from './application-probe';
import {UnknownAdjudication} from '../../../src/reliability/unknown-adjudication';
import {readAdjudicationFact} from '../../../src/reliability/adjudication-fact';
export {LocalProductionArchiveCoordinator} from './account-archive-probe';
import {accountArchiveProbe,type AccountArchiveProbeEnv} from './account-archive-probe';
import {UnknownObservation,type ObservationRequest} from '../../../src/reliability/unknown-observation';
export { LocalArchiveCoordinator } from './archive-worker';
export { ProductionCoordinator } from '../../../src/reliability/production-coordinator';
import { productionProbe } from './production-probe';
import type { ReliabilityEnv } from '../../../src/reliability/production-config';
export { LocalRoleCoordinator, LocalBusinessCoordinator, LocalResourceCoordinator, LocalLedgerCoordinator, LocalScriptCoordinator, LocalAutomationCoordinator, LocalLargeSourceCoordinator, LocalHugeSourceCoordinator } from './role-worker';
import { CredentialAuthority } from '../../../src/reliability/credential-authority';
import { manifestDigest } from '../../../src/reliability/protocol';
import { AccountRunner, type RunnerSnapshot } from '../../../src/reliability/account-runner';
import { withExecution, executionNow, executionUUID, frozenSubdomain, executionJournal } from '../../../src/reliability/execution-context';
import { fetchWithTimeout } from '../../../src/lib/cloudflare-api';
import { fetchGithubCode } from '../../../src/lib/github';
import { migrateCredentialAccounts, readCredentialAccounts } from '../../../src/reliability/credential-accounts';
import { SealedStore } from '../../../src/reliability/sealed-store';
import { TaskPreparation } from '../../../src/reliability/task-preparation';
import { ExecutionJournal, ExecutionUnknown } from '../../../src/reliability/execution-journal';
import type { SqlDatabase } from '../../../src/reliability/config-store';
import { TaskDispatch } from '../../../src/reliability/task-dispatch';
import { ReliabilityCoordinator } from '../../../src/reliability/coordinator';
import { ReliabilityError } from '../../../src/reliability/protocol';

/** Deliberately test-only: never exported from src/index.ts or production wrangler.toml. */
export class LocalCoordinator extends ReliabilityCoordinator {
    private readonly dispatch: TaskDispatch;
    private readonly db: SqlDatabase;
    private readonly sealed: SealedStore;
    private readonly preparation: TaskPreparation;
    private readonly runner: AccountRunner;
    private readonly credentials: CredentialAuthority;
    private credentialNow = 1000;
    private failTransport = false;
    private revoked = false;
    private input = { now: 1234, uuids: ['11111111-1111-4111-8111-111111111111'], subdomains: ['local-fixed'], sources: { cmliu: { code: 'local-frozen-code', sha: null } } };
    private transport = async (): Promise<Response> => {
        this.db.rows('UPDATE fixture_calls SET calls=calls+1');
        if (this.failTransport) throw new Error('local-mock-lost-response');
        return Response.json({ success: true });
    };
    private execute = async () => {
        const before = executionNow();
        await Promise.resolve();
        const uuid = executionUUID(), subdomain = frozenSubdomain();
        const source = await fetchGithubCode('cmliu', 'latest', {} as any);
        const response = await fetchWithTimeout('https://api.cloudflare.com/client/v4/accounts/a1/workers/scripts/mock', { method: 'PUT', body: source.code });
        return { outcome: 'verified' as const, result: { before, now: executionNow(), uuid, subdomain: subdomain!, code: source.code, success: (await response.json() as any).success } };
    };
    constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);
        this.db = {
            rows: <T extends Record<string, unknown>>(query: string, ...params: (string | number | null)[]) => ctx.storage.sql.exec(query, ...params).toArray() as T[],
            transaction: callback => ctx.storage.transactionSync(callback)
        };
        this.dispatch = new TaskDispatch(this.db, new Uint8Array(32).fill(17)); // Test only.
        this.sealed = new SealedStore(this.db, { currentId: 'local_key', keys: { local_key: 'local-test-only-material-never-production' } });
        this.preparation = new TaskPreparation(this.config, this.sealed, this.dispatch, new Uint8Array(32).fill(18));
        this.db.rows('CREATE TABLE IF NOT EXISTS fixture_calls (id INTEGER PRIMARY KEY, calls INTEGER NOT NULL)');
        this.db.rows('INSERT OR IGNORE INTO fixture_calls VALUES (1,0)');
        this.credentials = new CredentialAuthority(this.db, this.config, this.dispatch, { currentId: 'new', keys: { new: 'local-test-only-new-credential-secret' } }, () => this.credentialNow);
        this.runner = new AccountRunner(this.db, this.queue, this.sealed, {
            account: 'a1', generation: 'g1', digestSecret: 'local-test-only-journal-digest-material', transport: this.transport,
            authorize: async () => { if (this.revoked) throw new ReliabilityError('CONFLICT', 409); },
            loadSnapshot: async snapshot => await this.sealed.get({ id: snapshot, kind: 'task_snapshot', account: 'a1', generation: 'g1' }) as unknown as RunnerSnapshot,
            execute: this.execute
        });
    }
    async fetch(request: Request): Promise<Response> {
        try {
            const body = await request.json() as any;
            let result: unknown;
            switch (body.action) {
                case 'initialPrepare': case 'initialActivate': case 'initialState': result=await initialActivationProbe(this.db,this.config,body);break;
                case 'observationSeed': {
                    const account='a'.repeat(32),ring={currentId:'new',keys:{new:'local-test-only-new-credential-secret'}};
                    const accounts=await migrateCredentialAccounts([{accountId:account,alias:'local',email:'',globalKey:'',apiToken:'mock-token',authMode:'token'}],ring,'plaintext');
                    const record={domain:'accounts',revision:1,value:accounts as any};this.config.beginImport('g1',await manifestDigest([record]),1);this.config.stage('g1',record);await this.config.activateInitial('g1',0);await this.credentials.initialize('g1',1);this.config.setMaintenance(false,1);
                    await this.dispatch.submit({scope:'observation',key:'local',targets:[{account,snapshot:'observation_snapshot',steps:['upload']}]});const delivery=this.dispatch.reserve()[0];
                    const permit={task:delivery.task,account,generation:'g1',snapshot:delivery.snapshot,token:delivery.token,credentialRevision:1};
                    this.queue.enqueue(delivery.task,delivery.digest,delivery.snapshot,delivery.steps);const step=this.queue.claim()!;
                    this.db.rows('CREATE TABLE IF NOT EXISTS coordinator_inbox (task TEXT PRIMARY KEY,delivery TEXT NOT NULL)');this.db.rows('INSERT INTO coordinator_inbox VALUES (?,?)',delivery.task,JSON.stringify({...delivery,generation:'g1',credentialRevision:1}));
                    const journal=new ExecutionJournal(this.db,this.sealed,{job:delivery.task+'_0',account,generation:'g1'},{digestSecret:'local-test-only-journal-digest-material',authorizeMutation:async()=>this.credentials.authorize(permit),transport:async()=>{this.db.rows('UPDATE fixture_calls SET calls=calls+1');throw new Error('mock-lost');}});
                    try{await journal.request('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/demo',{method:'PUT',headers:{Authorization:'Bearer mock-token'},body:'mock-code'});}catch(error){if(!(error instanceof ExecutionUnknown))throw error;}
                    this.queue.finish(step.job,step.ordinal,step.token,'unknown','e'.repeat(64));this.config.setMaintenance(true,2);
                    await this.sealed.put({id:'observation_input',account,generation:'g1',kind:'artifact'},{id:'local_review',operator:'local_operator',permit,epoch:3,accountsRevision:1,step:0,call:0});result={seeded:true};break;
                }
                case 'observationCapture': {
                    const account='a'.repeat(32),input=await this.sealed.get({id:'observation_input',account,generation:'g1',kind:'artifact'}) as unknown as ObservationRequest;
                    const service=new UnknownObservation(this.db,this.sealed,account,{digestSecret:'local-test-only-journal-digest-material',isExecuting:()=>false,authorize:async r=>this.credentials.authorizeReview(r.permit,r.epoch,r.accountsRevision),transport:async(_url,init)=>{if(init.method!=='GET'||init.body!==undefined)throw new Error('Read-only violation');this.db.rows('UPDATE fixture_calls SET calls=calls+1');return Response.json({success:true,result:[]});}});
                    result=await service.capture(input);break;
                }
                case 'adjudicationAttest':
                case 'adjudicationClose':
                case 'adjudicationState': {
                    const account='a'.repeat(32),input=await this.sealed.get({id:'observation_input',account,generation:'g1',kind:'artifact'}) as unknown as ObservationRequest;
                    const core=new UnknownAdjudication(this.db,this.sealed,this.queue,account,{digestSecret:'local-test-only-journal-digest-material',isExecuting:()=>false,authorize:async(action,operator,r,replay)=>{if(operator!==(action==='attest'?'local_attestor':'local_reviewer'))throw new ReliabilityError('INVALID',403);if(!replay)this.credentials.authorizeReview(r.permit,r.epoch,r.accountsRevision);}});
                    if(body.action==='adjudicationAttest'){const observed=JSON.parse(this.db.rows<{summary:string}>('SELECT summary FROM unknown_observations WHERE id=?',input.id)[0].summary);result=await core.attest({id:'local_attestation',operator:'local_attestor',observation:input,evidence:observed.evidence,statement:'provider_confirmed_terminal',reference:'local-fake-provider-case',document:'Fake local test attachment confirming the original request terminal, never production evidence.'});}
                    else if(body.action==='adjudicationClose'){const proof=this.db.rows<{proof:string}>('SELECT proof FROM unknown_attestations WHERE id=?','local_attestation')[0].proof;result=await core.closeFailed({id:'local_decision',operator:body.operator??'local_reviewer',attestation:'local_attestation',proof});if(body.loseAck)throw Error('local lost adjudication ACK');}
                    else{const step=this.queue.inspect(input.permit.task).steps[0],fact=await readAdjudicationFact(this.db,this.sealed,account,input.permit.task,0,step.evidence);result={calls:this.db.rows<{calls:number}>('SELECT calls FROM fixture_calls')[0].calls,state:this.queue.inspect(input.permit.task).state,callState:this.db.rows('SELECT state FROM execution_calls'),fact:fact?.fact??null,receipt:JSON.parse(this.db.rows<{summary:string}>('SELECT summary FROM unknown_adjudications WHERE id=?','local_decision')[0].summary)};}break;
                }
                case 'observationState': result={calls:this.db.rows<{calls:number}>('SELECT calls FROM fixture_calls')[0].calls,jobs:this.db.rows('SELECT state FROM account_jobs'),callsState:this.db.rows('SELECT state FROM execution_calls'),permits:this.db.rows('SELECT state FROM dispatch_outbox'),observations:this.db.rows('SELECT state FROM unknown_observations')};break;
                case 'observationRevoke': this.credentials.revoke('g1','a'.repeat(32),1);result={revoked:true};break;
                case 'authoritySeed': {
                    const accounts = await migrateCredentialAccounts([{ accountId: 'a1', alias: 'mock', email: '', globalKey: '', apiToken: 'mock-token', authMode: 'token' }], { currentId: 'new', keys: { new: 'local-test-only-new-credential-secret' } }, 'plaintext');
                    const records = [{ domain: 'accounts', revision: 1, value: accounts as any }];
                    this.config.beginImport('g1', await manifestDigest(records), 1); this.config.stage('g1', records[0]); await this.config.activateInitial('g1', 0);
                    result = await this.credentials.initialize('g1', 1); this.config.setMaintenance(false, 1); break;
                }
                case 'authorityWrite': {
                    this.credentialNow = body.now;
                    result = await this.credentials.write({ generation: 'g1', epoch: body.epoch, expectedRevision: body.revision, accounts: [{ accountId: 'a1', alias: body.alias || 'mock', email: '', globalKey: '', apiToken: body.token || '***', authMode: 'token' }] }); break;
                }
                case 'authorityReview': this.credentials.authorizeReview(body.permit, body.epoch, body.accountsRevision); result = { authorizedReadOnly: true }; break;
                case 'authorityAuthorize': result = this.credentials.authorize(body.permit); break;
                case 'authorityRevoke': result = this.credentials.revoke('g1', 'a1', 1); break;
                case 'runnerSeed': {
                    await this.sealed.put({ id: 'runner_snapshot', kind: 'task_snapshot', account: 'a1', generation: 'g1' }, { input: this.input, operation: null });
                    this.queue.enqueue('runner_job', 'd'.repeat(64), 'runner_snapshot', ['upload']);
                    this.queue.enqueue('runner_next', 'e'.repeat(64), 'runner_snapshot', ['upload']);
                    if (body.crashAfterHttp) {
                        const step = this.queue.claim()!;
                        const journal = new ExecutionJournal(this.db, this.sealed, { job: step.job + '_0', account: 'a1', generation: 'g1' }, { digestSecret: 'local-test-only-journal-digest-material', transport: this.transport, authorizeMutation: async () => {} });
                        await withExecution(journal, this.input, this.execute); await journal.finish();
                        // Intentionally leave the outer step in_flight: crash after HTTP
                        // receipt but before handler-result/queue acknowledgement.
                    }
                    result = this.queue.inspect('runner_job'); break;
                }
                case 'runnerTick': {
                    this.failTransport = !!body.failTransport; this.revoked = !!body.revoked;
                    try { result = await Promise.all([this.runner.tick(), this.runner.tick()]); }
                    finally { this.failTransport = false; this.revoked = false; }
                    break;
                }
                case 'runnerState': result = { job: this.queue.inspect('runner_job'), next: this.queue.inspect('runner_next'), calls: this.db.rows<{ calls: number }>('SELECT calls FROM fixture_calls')[0].calls }; break;
                case 'runnerResult': result = await this.sealed.get({ id: 'result_runner_job_0', kind: 'task_snapshot', account: 'a1', generation: 'g1' }); break;
                case 'als': {
                    result = await Promise.all([1000, 2000].map(async now => {
                        const journal = new ExecutionJournal(this.db, this.sealed, { job: 'als_' + now, account: 'a1', generation: 'g1' }, { digestSecret: 'local-test-only-journal-digest-material', transport: this.transport, authorizeMutation: async () => {} });
                        return withExecution(journal, { ...this.input, now }, async () => {
                            await Promise.resolve(); const before = executionNow();
                            await fetchWithTimeout('https://api.cloudflare.com/client/v4/accounts/a1/workers/scripts/als-mock', { method: 'PUT', body: String(now) });
                            await journal.finish(); return { before, after: executionNow(), uuid: executionUUID(), ownJournal: executionJournal() === journal };
                        });
                    }));
                    if (executionJournal()) throw new Error('Leaked ALS context');
                    break;
                }
                case 'credentialPrepare': {
                    const ring = { currentId: 'new', keys: { new: 'local-test-only-new-credential-secret' } };
                    const accounts = await migrateCredentialAccounts([{ accountId: 'a1', alias: 'mock', email: '', globalKey: '', apiToken: 'mock-token', authMode: 'token' }], ring, 'plaintext');
                    await this.sealed.put({ id: 'mock_credentials', kind: 'task_snapshot', account: 'a1', generation: 'g1' }, accounts as any);
                    result = { v2: accounts[0].apiToken!.startsWith('v2:new:') }; break;
                }
                case 'credentialRead': {
                    const accounts = await this.sealed.get({ id: 'mock_credentials', kind: 'task_snapshot', account: 'a1', generation: 'g1' }) as any;
                    const decoded = await readCredentialAccounts(accounts, { currentId: 'new', keys: { new: 'local-test-only-new-credential-secret' } });
                    result = { verified: decoded[0].apiToken === 'mock-token', revision: decoded[0].credentialRevision }; break;
                }
                case 'prepare': result = await this.preparation.submit(body.request); break;
                case 'sealPut': result = await this.sealed.put(body.context, body.value); break;
                case 'sealGet': result = await this.sealed.get(body.context); break;
                case 'journalEvidence': {
                    const journal = new ExecutionJournal(this.db, this.sealed, { job: body.job, account: 'a1', generation: 'g1' }, {
                        digestSecret: 'local-test-only-journal-digest-material',
                        authorizeMutation: async () => { throw new Error('Evidence must not authorize writes'); },
                        transport: async () => { throw new Error('Evidence must not call HTTP'); }
                    });
                    const before = JSON.stringify(this.db.rows('SELECT * FROM execution_calls WHERE job=? ORDER BY ordinal', body.job));
                    const evidence = await journal.readCallEvidence(0);
                    result = { identity: evidence.identity, ordinal: evidence.ordinal, mutation: evidence.mutation, state: evidence.state,
                        requestMatches: JSON.stringify(evidence.request) === JSON.stringify(['https://api.cloudflare.com/client/v4/accounts/a1/workers/scripts/mock', 'PUT', [], ['text', 'fixed-code']]),
                        unchanged: before === JSON.stringify(this.db.rows('SELECT * FROM execution_calls WHERE job=? ORDER BY ordinal', body.job)) };
                    break;
                }
                case 'journal': {
                    const journal = new ExecutionJournal(this.db, this.sealed, { job: body.job, account: 'a1', generation: 'g1' }, {
                        digestSecret: 'local-test-only-journal-digest-material',
                        authorizeMutation: async () => {},
                        transport: async () => {
                            if (body.failTransport) throw new Error('mock-lost-response');
                            return Response.json({ success: true, result: { mock: true } });
                        }
                    });
                    try {
                        const response = await journal.request('https://api.cloudflare.com/client/v4/accounts/a1/workers/scripts/mock', { method: 'PUT', body: 'fixed-code' });
                        await journal.finish(); result = await response.json();
                    } catch (error) {
                        if (!(error instanceof ExecutionUnknown)) throw error;
                        result = { blocked: true };
                    }
                    break;
                }
                case 'dispatchSubmit': result = await this.dispatch.submit(body.request); break;
                case 'dispatchReserve': result = this.dispatch.reserve(); break;
                case 'dispatchAck': result = this.dispatch.acknowledge(body.task, body.account, body.token); break;
                case 'dispatchComplete': result = this.dispatch.complete(body.task, body.account, body.token, body.outcome, body.evidence); break;
                case 'dispatchInspect': result = this.dispatch.inspect(body.task); break;
                case 'enqueue': result = this.queue.enqueue(body.id, body.digest, body.snapshot, body.steps); break;
                case 'claim': result = this.queue.claim(); break;
                case 'inspect': result = this.queue.inspect(body.id); break;
                case 'finish': result = this.queue.finish(body.id, body.ordinal, body.token, body.outcome, body.evidence); break;
                case 'reconcile': result = this.queue.reconcile(body.id, body.ordinal, body.token, body.outcome, body.evidence); break;
                case 'status': result = this.config.status(); break;
                case 'begin': result = this.config.beginImport(body.id, body.digest, body.count); break;
                case 'stage': result = this.config.stage(body.id, body.record); break;
                case 'activate': result = await this.config.activateInitial(body.id, body.epoch); break;
                case 'maintenance': result = this.config.setMaintenance(body.enabled, body.epoch); break;
                case 'read': result = this.config.read(body.domains); break;
                case 'cas': result = this.config.compareAndSet(body.generation, body.changes); break;
                case 'runtime': result = this.config.recordRuntime(body.operation, body.patch); break;
                case 'readRuntime': result = this.config.readRuntime(); break;
                default: return Response.json({ error: 'INVALID' }, { status: 400 });
            }
            return Response.json({ result: result ?? null });
        } catch (error) {
            if (!(error instanceof ReliabilityError)) console.error('Local fixture failure:', error);
            return Response.json({ error: error instanceof ReliabilityError ? error.code : 'INTERNAL' }, { status: error instanceof ReliabilityError ? error.status : 500 });
        }
    }
}
export default {
    async fetch(request: Request, env: { LOCAL_COORDINATOR: DurableObjectNamespace; LOCAL_ROLES: DurableObjectNamespace; LOCAL_BUSINESS: DurableObjectNamespace; LOCAL_RESOURCES: DurableObjectNamespace; LOCAL_LEDGER: DurableObjectNamespace; LOCAL_SCRIPT: DurableObjectNamespace; LOCAL_AUTOMATION: DurableObjectNamespace; LOCAL_LARGE_SOURCE: DurableObjectNamespace; LOCAL_HUGE_SOURCE: DurableObjectNamespace; LOCAL_ARCHIVE: DurableObjectNamespace; LOCAL_HARNESS: string } & ReliabilityEnv): Promise<Response> {
        // Fixture is loopback-only and requires an explicit local marker; it is not an admin API.
        if (env.LOCAL_HARNESS !== 'test-only' || !['127.0.0.1', 'localhost'].includes(new URL(request.url).hostname)) return new Response('Forbidden', { status: 403 });
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        const pathname = new URL(request.url).pathname;
        if (pathname === '/archive-transfer-copy' || pathname === '/archive-source' || pathname === '/archive-copy' || pathname === '/archive-migration' || pathname === '/archive-legacy') return env.LOCAL_ARCHIVE.get(env.LOCAL_ARCHIVE.idFromName(pathname)).fetch(request);
        if (pathname === '/initial-production')return initialSourceProbe(request,env as InitialProbeEnv);
        if (pathname === '/application-entry')return applicationProbe(request,env);
        if (pathname === '/production-archive') return accountArchiveProbe(request,env as AccountArchiveProbeEnv);
        if (pathname === '/production-shell') return productionProbe(request, env);
        if (pathname === '/huge-source-roles' || pathname === '/large-source-roles' || pathname === '/roles' || pathname === '/business-roles' || pathname === '/resource-roles' || pathname === '/ledger-roles' || pathname === '/script-roles' || pathname === '/automation-roles') {
            const body = await request.clone().json() as { target?: string };
            if (!body.target || !['global','a1','a2','a3','a4','e'.repeat(32),...(pathname==='/huge-source-roles'?Array.from({length:8},(_,i)=>(i+16).toString(16).padStart(32,'0')):[])].includes(body.target)) return new Response('Forbidden', { status:403 });
            const name = body.target === 'global' ? 'reliability-global-v1' : 'reliability-account-v1-' + body.target;
            const binding = pathname === '/huge-source-roles' ? env.LOCAL_HUGE_SOURCE : pathname === '/large-source-roles' ? env.LOCAL_LARGE_SOURCE : pathname === '/automation-roles' ? env.LOCAL_AUTOMATION : pathname === '/script-roles' ? env.LOCAL_SCRIPT : pathname === '/ledger-roles' ? env.LOCAL_LEDGER : pathname === '/resource-roles' ? env.LOCAL_RESOURCES : pathname === '/business-roles' ? env.LOCAL_BUSINESS : env.LOCAL_ROLES;
            return binding.get(binding.idFromName(name)).fetch(request);
        }
        if (pathname !== '/unknown-adjudication' && pathname !== '/unknown-observation' && !/^\/(?:runner-[a-z]+)?$/.test(pathname)) return new Response('Forbidden', { status: 403 });
        return env.LOCAL_COORDINATOR.get(env.LOCAL_COORDINATOR.idFromName('global-test' + (pathname === '/' ? '' : pathname))).fetch(request);
    }
};
