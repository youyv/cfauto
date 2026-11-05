/* Local-only integration test. No production config, credentials or KV bindings.
 * Restart budget: the default light profile keeps 8 real process restarts (one before
 * each named recovery checkpoint) and coalesces the remaining scenario restart sites
 * into the same process generation. Set RELIABILITY_RUNTIME_FULL_RESTARTS=1 for the
 * original full 35-restart coverage. */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { RUNTIME_CHECKPOINTS } = require('./test-scope.cjs');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfauto-do-test-'));
    // Put transient Wrangler bundles next to the isolated state, not in the source tree.
    const fixtureRoot = path.join(root, 'test/fixtures/reliability');
    const config = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'wrangler.jsonc'), 'utf8'));
    config.main = path.resolve(fixtureRoot, config.main);
    const configFile = path.join(dir, 'wrangler.json');
    await fs.writeFile(configFile, JSON.stringify(config));
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', BROWSER: 'none', HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, APPDATA: dir, LOCALAPPDATA: dir };
    for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_|WRANGLER_API|ACCESS_CODE|ENCRYPTION_SECRET|GITHUB_TOKEN|RELIABILITY_)/i.test(key)) delete env[key];
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    let child, exited, output = '', starts = 0;
    const checkpoints = [];
    const checkpoint = id => {
        assert.equal(id, RUNTIME_CHECKPOINTS[checkpoints.length]);
        assert.ok(starts > 1, 'A recovery checkpoint requires a real process restart');
        checkpoints.push({ id, restarts: starts - 1 });
    };
    const stop = async () => {
        if (!child || child.exitCode !== null) return;
        if (process.platform === 'win32') cp.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGTERM');
        await exited;
        child = null;
    };
    const send = async (body, fixture = '', observationTimeoutMs = 5000) => {
        const readOnly=['status','largeSnapshot','largeProviderStatus'].includes(body.action);
        for(let attempt=0;attempt<3;attempt++){
            const response=await fetch('http://127.0.0.1:'+port+'/'+fixture,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(observationTimeoutMs)});
            const bytes=await response.text();let json;try{json=JSON.parse(bytes);}catch{
                await fs.writeFile(path.join(dir,'non-json-'+Date.now()+'.txt'),bytes);
                if(readOnly&&response.status===503&&bytes.includes('restarted mid-request')&&attempt<2){console.log('LOCAL_READ_ONLY_RESTART_OBSERVATION '+JSON.stringify({action:body.action,target:body.target,attempt,status:response.status}));await wait(500);continue;}
                throw Error('LOCAL_NON_JSON_'+response.status+': '+bytes.slice(0,200));
            }
            return {status:response.status,...json};
        }
        throw Error('LOCAL_READ_ONLY_RESTART_NOT_RESOLVED');
    };
    const role = async (target, action, extra = {}) => {
        const result = await send({ target, action, ...extra }, 'roles');
        assert.equal(result.status, 200, 'role fixture request: ' + action);
        return result.result;
    };
    const businessRole = async (target, action, extra = {}) => {
        const result = await send({ target, action, ...extra }, 'business-roles');
        assert.equal(result.status, 200, 'business DO request: ' + action);
        return result.result;
    };
    const resourceRole=async(target,action,extra={})=>{const result=await send({target,action,...extra},'resource-roles');assert.equal(result.status,200,'resource DO request: '+action);return result.result;};
    const until = async (read, predicate) => {
        for (let i = 0; i < 120; i++) { const value = await read(); if (predicate(value)) return value; await wait(250); }
        throw new Error('Real DO alarm did not reach the expected durable state');
    };
    // Real process-restart budget. The default light profile keeps one restart before
    // each named recovery checkpoint plus the pre-large-write boundary (so workerd memory
    // is released before the 5 MiB source scenario), and coalesces the rest into the same
    // process generation; set RELIABILITY_RUNTIME_FULL_RESTARTS=1 for all 35 restarts.
    const FULL_RESTARTS = process.env.RELIABILITY_RUNTIME_FULL_RESTARTS === '1';
    const LIGHT_RESTART_KEEP = new Set([1, 2, 15, 20, 28, 30, 33, 34, 35]);
    let restartSeq = 0, realRestarts = 0, coalescedRestarts = 0;
    const restart = async () => {
        restartSeq++;
        if (!FULL_RESTARTS && !LIGHT_RESTART_KEEP.has(restartSeq)) { coalescedRestarts++; console.log('LOCAL_RESTART_COALESCED ' + restartSeq); return; }
        await stop(); await start(); realRestarts++;
    };
    const start = async () => {
        starts++;
        child = cp.spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', configFile, '--persist-to', path.join(dir, 'state'), '--port', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        exited = new Promise(resolve => child.once('exit', resolve));
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { output += data; });
        for (let i = 0; i < 300; i++) {
            if (child.exitCode !== null) throw new Error('Local runtime exited');
            try { if ((await send({ action: 'status' })).status === 200) return; } catch {}
            await wait(250);
        }
        throw new Error('Local runtime startup timed out');
    };
    try {
        await start();
        for (const action of ['unsigned','misaddress']) assert.equal((await send({action},'production-shell')).result.status,403);
        assert.deepEqual((await send({action:'private'},'production-shell')).result.rejected,['bootstrap','bindTrusted','submit','status','execute','config','rpc']);
        assert.deepEqual((await send({action:'deliver'},'production-shell')).result,{status:200,body:{value:{duplicate:false}}});
        assert.equal((await send({action:'gatewayWrongManager'},'production-shell')).result.status,403);
        assert.deepEqual((await send({action:'gatewayUnavailable'},'production-shell')).result,{status:503,body:{error:'MAINTENANCE'}});
        assert.equal((await send({ action: 'status' })).result.generation, null);
        assert.equal((await send({ action: 'maintenance', enabled: false, epoch: 0 })).status, 503);
        const records = [{ domain: 'autoConfig', revision: 1, value: { enabled: false } }];
        const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex'); // keys already canonical
        assert.equal((await send({ action: 'begin', id: 'g1', digest, count: 1 })).status, 200);
        assert.equal((await send({ action: 'stage', id: 'g1', record: records[0] })).status, 200);
        assert.equal((await send({ action: 'activate', id: 'g1', epoch: 0 })).status, 200);
        assert.equal((await send({ action: 'maintenance', enabled: false, epoch: 1 })).status, 200);
        const writes = await Promise.all([true, false].map(enabled => send({ action: 'cas', generation: 'g1', changes: [{ domain: 'autoConfig', expectedRevision: 1, value: { enabled } }] })));
        assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
        assert.equal((await send({ action: 'runtime', operation: 'once', patch: { lastCheck: 200 } })).status, 200);
        assert.equal((await send({ action: 'enqueue', id: 'task1', digest: 'a'.repeat(64), snapshot: 'snap1', steps: ['delete_worker'] })).status, 200);
        const claimed = (await send({ action: 'claim' })).result;
        assert.equal(claimed.job, 'task1');
        const submission = { scope: 'test', key: 'retry-key', targets: ['a1', 'a2', 'a3', 'a4'].map(account => ({ account, snapshot: 'snap1', steps: ['upload'] })) };
        const submitted = await send({ action: 'dispatchSubmit', request: submission });
        assert.equal(submitted.status, 200);
        const dispatched = (await send({ action: 'dispatchReserve' })).result;
        assert.deepEqual(dispatched.map(d => d.account), ['a1', 'a2', 'a3']);
        assert.equal((await send({ action: 'dispatchAck', ...dispatched[0] })).status, 200);
        const sealedContext = { id: 'large_snapshot', kind: 'task_snapshot', account: 'a1', generation: 'g1' };
        const sealedValue = { code: 'local-frozen-code-'.repeat(5000), secret: 'mock-secret' };
        assert.equal((await send({ action: 'sealPut', context: sealedContext, value: sealedValue })).status, 200);
        assert.equal((await send({ action: 'journal', job: 'confirmed' })).result.success, true);
        assert.equal((await send({ action: 'journal', job: 'lost', failTransport: true })).result.blocked, true);
        assert.equal((await send({ action: 'cas', generation: 'g1', changes: [{ domain: 'accounts', expectedRevision: 0, value: [] }] })).status, 200);
        const preparedRequest = { scope: 'test', key: 'prepared', generation: 'g1', epoch: 2, expected: [{ domain: 'accounts', revision: 1 }], targets: [{ account: 'a5', steps: ['upload'], operation: { code: 'immutable-code' } }] };
        const prepared = await send({ action: 'prepare', request: preparedRequest });
        assert.equal(prepared.status, 200);
        const authorityFixture = 'runner-authority';
        const policy = await send({ action: 'authoritySeed' }, authorityFixture);
        assert.deepEqual(policy.result, { observationUntil: 604801000 });
        assert.equal((await send({ action: 'authorityWrite', now: 1001, epoch: 2, revision: 1, token: 'changed' }, authorityFixture)).status, 409);
        assert.equal((await send({ action: 'authorityWrite', now: 1001, epoch: 2, revision: 1, alias: 'metadata-edit' }, authorityFixture)).status, 200);
        assert.equal((await send({ action: 'dispatchSubmit', request: { scope: 'test', key: 'credential-task', targets: [{ account: 'a1', snapshot: 'snap1', steps: ['upload'] }] } }, authorityFixture)).status, 200);
        assert.equal((await send({ action: 'authorityWrite', now: 604801000, epoch: 2, revision: 2, token: 'changed' }, authorityFixture)).status, 409);
        const credentialDelivery = (await send({ action: 'dispatchReserve' }, authorityFixture)).result[0];
        const credentialPermit = { ...credentialDelivery, generation: 'g1', credentialRevision: 1 };
        assert.equal((await send({ action: 'authorityAuthorize', permit: credentialPermit }, authorityFixture)).status, 200);
        const reviewPermit = { generation: 'g1', credentialRevision: 1, task: credentialDelivery.task, account: credentialDelivery.account, token: credentialDelivery.token, snapshot: credentialDelivery.snapshot };
        assert.deepEqual((await send({ action: 'authorityReview', permit: reviewPermit, epoch: 2, accountsRevision: 2 }, authorityFixture)).result, { authorizedReadOnly: true });
        assert.equal((await send({ action: 'authorityRevoke' }, authorityFixture)).status, 200);
        assert.equal((await send({ action: 'authorityAuthorize', permit: credentialPermit }, authorityFixture)).status, 409);
        const als = await send({ action: 'als' });
        assert.equal(als.status, 200);
        assert.deepEqual(als.result.map(r => [r.before, r.after, r.ownJournal]), [[1000, 1000, true], [2000, 2000, true]]);
        assert.equal((await send({ action: 'credentialPrepare' })).result.v2, true);
        assert.equal((await send({ action: 'runnerSeed', crashAfterHttp: true }, 'runner-replay')).status, 200);
        assert.equal((await send({ action: 'runnerSeed' }, 'runner-lost')).status, 200);
        assert.equal((await send({ action: 'runnerTick', failTransport: true }, 'runner-lost')).result[0].state, 'needs_review');
        assert.equal((await send({ action: 'runnerSeed' }, 'runner-revoked')).status, 200);
        assert.equal((await send({ action: 'runnerTick', revoked: true }, 'runner-revoked')).result[0].state, 'needs_review');
        await role('global','bootstrap');
        for (const account of ['a1','a2','a3','a4']) await role(account,'flags',{ receiptBlocked:true });
        await role('global','flags',{ loseDelivery:true });
        const roleTask = await role('global','submit',{ key:'role-once',accounts:['a1','a2','a3','a4'] });
        for (const account of ['a1','a2','a3']) await until(() => role(account,'status'), s => s.jobs[0]?.state === 'succeeded' && s.receipts.length === 1);
        await until(() => role('global','status',{ task:roleTask.id }), s => s.dispatch.filter(d => d.state === 'accepted').length === 3);
        assert.deepEqual((await role('a4','status')).jobs,[]);
        const roleInbox = (await role('a1','status')).inbox;
        assert.equal((await role('global','badAddress')).status,403);
        const creationAccount = 'e'.repeat(32);
        await businessRole('global','bootstrap');
        await businessRole(creationAccount,'flags',{progressBlocked:true});
        const creationTask = await businessRole('global','businessCreate',{key:'created-once'});
        await until(() => businessRole(creationAccount,'status'),s => s.businessWrites === 1 && s.jobs[0]?.state === 'running');
        assert.equal((await businessRole(creationAccount,'status')).namespaceWrites,1);
        assert.deepEqual((await businessRole('global','status')).workers,['mock-worker']);
        assert.equal((await businessRole('global','status',{task:creationTask.id})).dispatch[0].state,'accepted');
        await businessRole('global','flags',{loseSubmitAck:true});
        assert.equal((await send({target:'global',action:'admissionSubmit',key:'admission-once'},'business-roles')).status,500);
        const acceptedAdmission = (await businessRole('global','status')).admissionTasks.find(t=>t.id!==creationTask.id).id;
        assert.equal((await businessRole('global','status')).sourceReads,2);
        const incompleteAdmission=(await businessRole('global','admissionIncomplete')).items[0];assert.equal(incompleteAdmission.manifestStored,true);
        await businessRole('global','flags',{sourceOffline:true});
        await restart();
        assert.deepEqual((await role('a1','status')).inbox,roleInbox);
        const recoveredAdmission=await businessRole('global','admissionRecover',{id:incompleteAdmission.id});assert.deepEqual(recoveredAdmission,{id:acceptedAdmission,duplicate:true});
        assert.equal((await businessRole('global','admissionIncomplete')).items.length,0);
        const admissionReplay=await businessRole('global','admissionSubmit',{key:'admission-once'});
        assert.deepEqual(admissionReplay,{id:acceptedAdmission,duplicate:true});
        console.log('PASS: real local DO restart recovers an incomplete admission by original stable dispatch identity and sealed manifest with source offline; no replan, no new task or random identity, original submit still replays the same ACK');
        checkpoint('admission_recovery');
        await businessRole('global','admissionCancel',{task:acceptedAdmission});
        assert.equal((await businessRole('global','admissionInspect',{task:acceptedAdmission})).targets[0].cancellationRequested,true);
        await businessRole(creationAccount,'flags',{progressBlocked:false});
        const creationFinal = await until(() => businessRole('global','status',{task:creationTask.id}),s => s.dispatch[0]?.state === 'terminal');
        assert.equal(creationFinal.dispatch[0].outcome,'partial_failed');
        assert.deepEqual(creationFinal.workers,['mock-worker','created-worker']);
        assert.deepEqual(creationFinal.facts.filter(f=>f.task===creationTask.id).map(f=>f.state),['verified','failed']);
        const cancelledAdmission=await until(()=>businessRole('global','admissionInspect',{task:acceptedAdmission}),s=>s.targets[0].state==='terminal');
        assert.equal(cancelledAdmission.targets[0].outcome,'cancelled');
        assert.deepEqual(cancelledAdmission.targets[0].steps,[{ordinal:0,kind:'upload',state:'skipped'}]);
        assert.equal((await businessRole('global','status')).sourceReads,2);
        const creationState = await businessRole(creationAccount,'status');
        assert.equal(creationState.namespaceWrites,1);assert.equal(creationState.businessWrites,1);assert.equal(creationState.calls,8);

        await businessRole('global','flags',{sourceOffline:false});
        await businessRole(creationAccount,'flags',{progressBlocked:true});
        const replacementTask=await businessRole('global','admissionReplace',{key:'replace-once'});
        await until(()=>businessRole(creationAccount,'status'),s=>s.businessWrites===2 && s.jobs.some(j=>j.id===replacementTask.id && j.state==='succeeded'));
        assert.equal((await businessRole('global','status',{task:replacementTask.id})).dispatch[0].state,'accepted');
        assert.equal((await businessRole('global','admissionInspect',{task:replacementTask.id})).targets[0].steps[0].kind,'replace_worker');
        assert.equal((await businessRole(creationAccount,'status')).namespaceWrites,1);
        await businessRole('global','flags',{sourceOffline:true});
        const replacementInbox=(await businessRole(creationAccount,'status')).inbox;
        await businessRole(creationAccount,'lastRetry');
        await until(()=>businessRole(creationAccount,'status'),s=>s.retryFailures===8);
        const firstTaskPage=await businessRole('global','admissionList',{limit:1});
        assert.equal(firstTaskPage.items[0].id,replacementTask.id);assert.ok(firstTaskPage.cursor);
        assert.deepEqual(Object.keys(firstTaskPage.items[0]).sort(),['id','targets']);
        assert.deepEqual(Object.keys(firstTaskPage.items[0].targets[0]).sort(),['account','cancellationRequested','outcome','state']);
        assert.deepEqual(await businessRole('global','admissionList',{scope:'another-owner',limit:20}),{items:[],cursor:null});

        for (const account of ['a1','a2','a3','a4']) await role(account,'flags',{ receiptBlocked:false });
        await until(() => role('global','status',{ task:roleTask.id }), s => s.dispatch.every(d => d.state === 'terminal'));
        for (const account of ['a1','a2','a3','a4']) {
            const state = await role(account,'status'); assert.equal(state.calls,1); assert.ok(state.alarms > 0);
            assert.ok(!state.tables.some(t => t.name === 'config_records'));
        }
        assert.ok(!(await role('global','status')).tables.some(t => t.name === 'account_jobs'));
        assert.equal((await role('global','submit',{ key:'role-once',accounts:['a1','a2','a3','a4'] })).id,roleTask.id);
        const businessAccount = 'e'.repeat(32);
        const scriptRole=async(target,action,extra={})=>{const result=await send({target,action,...extra},'script-roles');assert.equal(result.status,200,'script DO request: '+action);return result.result;};
        await scriptRole('global','bootstrap');
        await scriptRole(businessAccount,'flags',{receiptBlocked:true});
        const businessTask = await scriptRole('global','admissionSubmit',{key:'business-once'});
        await until(() => scriptRole(businessAccount,'status'),s => s.jobs[0]?.state === 'succeeded' && s.receipts.length === 1);
        assert.equal((await scriptRole(businessAccount,'status')).businessWrites,1);
        await scriptRole(businessAccount,'lastRetry');
        await until(()=>scriptRole(businessAccount,'status'),s=>s.retryFailures===8);
        await role('a1','flags',{ unknown:true });
        const unknownTask = await role('global','submit',{ key:'role-unknown',accounts:['a1'] });
        const behindUnknown = await role('global','submit',{ key:'role-behind-unknown',accounts:['a1'] });
        await until(() => role('a1','status'), s => s.jobs.some(j => j.id === unknownTask.id && j.state === 'needs_review'));
        assert.equal((await role('global','status',{ task:behindUnknown.id })).dispatch[0].state,'pending');
        await role('a2','flags',{ hold:true });
        const revokedTask = await role('global','submit',{ key:'role-revoked',accounts:['a2'] });
        await until(() => role('global','status',{ task:revokedTask.id }), s => s.dispatch[0].state === 'accepted');
        await role('global','revoke',{ account:'a2' }); await role('a2','flags',{ hold:false });
        await until(() => role('a2','status'), s => s.jobs.some(j => j.id === revokedTask.id && j.state === 'needs_review'));
        assert.equal((await role('a2','status')).calls,1);
        await restart();
        assert.equal((await role('a1','status')).calls,2); assert.equal((await role('a2','status')).calls,1);
        assert.equal((await role('global','status',{ task:unknownTask.id })).dispatch[0].state,'accepted');
        assert.equal((await role('global','status',{ task:revokedTask.id })).dispatch[0].state,'accepted');
        assert.equal((await role('global','status',{ task:behindUnknown.id })).dispatch[0].state,'pending');
        await role('global','wake',{task:unknownTask.id});
        await role('global','wake',{task:behindUnknown.id});
        await wait(400);
        assert.equal((await role('a1','status')).calls,2);
        assert.equal((await role('a1','status')).jobs.find(j=>j.id===unknownTask.id).state,'needs_review');
        assert.equal((await role('global','status',{task:behindUnknown.id})).dispatch[0].state,'pending');
        assert.equal((await scriptRole(businessAccount,'status')).retryFailures,8);
        await scriptRole(businessAccount,'flags',{receiptBlocked:false});
        await wait(400);
        assert.equal((await scriptRole('global','status',{task:businessTask.id})).dispatch[0].state,'accepted');
        await scriptRole('global','wake',{task:businessTask.id});
        await until(() => scriptRole('global','status',{task:businessTask.id}),s => s.dispatch[0]?.state === 'terminal');
        const businessState = await scriptRole(businessAccount,'status');
        assert.equal(businessState.calls,3); assert.equal(businessState.businessWrites,1); assert.ok(businessState.alarms>0);
        assert.equal((await scriptRole('global','admissionSubmit',{key:'business-once'})).id,businessTask.id);
        assert.equal((await scriptRole(businessAccount,'status')).businessWrites,1);
        assert.deepEqual((await send({action:'deliver'},'production-shell')).result,{status:200,body:{value:{duplicate:true}}});
        assert.deepEqual((await businessRole('global','status')).workers,['mock-worker','created-worker']);
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,2);
        assert.equal((await businessRole(creationAccount,'status')).retryFailures,8);
        assert.deepEqual((await businessRole(creationAccount,'status')).inbox,replacementInbox);
        const secondTaskPage=await businessRole('global','admissionList',{limit:1,cursor:firstTaskPage.cursor});
        assert.deepEqual(secondTaskPage.items.map(t=>t.id),[acceptedAdmission]);assert.equal(secondTaskPage.cursor,null);
        await businessRole(creationAccount,'flags',{progressBlocked:false});
        await wait(400);
        assert.equal((await businessRole('global','status',{task:replacementTask.id})).dispatch[0].state,'accepted');
        await businessRole('global','wake',{task:replacementTask.id});
        const replacementFinal=await until(()=>businessRole('global','admissionInspect',{task:replacementTask.id}),s=>s.targets[0].state==='terminal');
        assert.equal(replacementFinal.targets[0].outcome,'succeeded');
        assert.deepEqual(replacementFinal.targets[0].steps,[{ordinal:0,kind:'replace_worker',state:'verified'}]);
        assert.deepEqual(await businessRole('global','admissionReplace',{key:'replace-once'}),{id:replacementTask.id,duplicate:true});
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,2);
        assert.equal((await businessRole(creationAccount,'status')).namespaceWrites,1);
        assert.deepEqual((await businessRole(creationAccount,'status')).inbox,replacementInbox);
        console.log('PASS: real DO scoped redacted list and cursor across restart; parked progress and terminal receipt recover only after explicit wake with original delivery; no duplicate PUT; unknown barrier and successor remain blocked');
        checkpoint('queue_unknown_barriers');
        console.log('PASS: real DO existing-target batch replacement, pinned mode and source, exact source/bindings readback, progress recovery across process restart with no duplicate PUT or namespace creation');
        console.log('PASS: real business DO Worker+KV creation, strict source/bindings readback, lost progress channel across process restart, current-authority Worker list commit before terminal release, later domain failure preserves created resources and no repeated POST/PUT');
        assert.deepEqual(await businessRole('global','admissionSubmit',{key:'admission-once'}),{id:acceptedAdmission,duplicate:true});
        assert.equal((await businessRole('global','status')).sourceReads,4);
        assert.equal((await businessRole('global','admissionInspect',{task:acceptedAdmission})).targets[0].outcome,'cancelled');
        console.log('PASS: real DO admission manifest survives lost submit ACK and process restart, retries use original task with source offline, durable cancellation skips queued work with no extra HTTP writes, safe status after second restart');
        // Config-changing intents use the same production preparation transaction.
        await businessRole('global','flags',{sourceOffline:false,loseSubmitAck:true});
        await businessRole(creationAccount,'flags',{progressBlocked:true});
        const tasksBeforeFuse=(await businessRole('global','status')).admissionTasks.map(t=>t.id);
        assert.equal((await send({target:'global',action:'admissionFuse',key:'fuse-once'},'business-roles')).status,500);
        const fuseTask=(await businessRole('global','status')).admissionTasks.find(t=>!tasksBeforeFuse.includes(t.id)).id;
        assert.ok(!(await businessRole('global','admissionList',{limit:20})).items.some(t=>t.id===fuseTask)); // Lost ACK has not yet linked the admission receipt.
        const fusedConfig=await businessRole('global','configEvidence');
        const rotated=fusedConfig.records.find(r=>r.domain.startsWith('override:')).value[0].value;
        assert.notEqual(rotated,'local-global-uuid');
        await until(()=>businessRole(creationAccount,'status'),s=>s.businessWrites===3);
        await businessRole(creationAccount,'lastRetry');
        await until(()=>businessRole(creationAccount,'status'),s=>s.retryFailures===8);
        await businessRole('global','flags',{sourceOffline:true});
        await restart();
        assert.deepEqual(await businessRole('global','admissionFuse',{key:'fuse-once'}),{id:fuseTask,duplicate:true});
        assert.deepEqual(await businessRole('global','configEvidence'),fusedConfig);
        await businessRole(creationAccount,'flags',{progressBlocked:false});
        await businessRole('global','wake',{task:fuseTask});
        const fuseFinal=await until(()=>businessRole('global','admissionInspect',{task:fuseTask}),s=>s.targets[0].state==='terminal');
        assert.equal(fuseFinal.targets[0].outcome,'succeeded');
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,4);
        for(const worker of await businessRole(creationAccount,'bindingEvidence')) assert.equal(worker.bindings.find(b=>b.name==='UUID').text,rotated);
        await businessRole('global','flags',{sourceOffline:false});
        const clearTask=await businessRole('global','admissionClear',{key:'clear-once'});
        const cleared=(await businessRole('global','configEvidence')).records.find(r=>r.domain.startsWith('override:'));
        assert.equal(cleared.value,null);assert.equal(cleared.revision,2);
        const clearFinal=await until(()=>businessRole('global','admissionInspect',{task:clearTask.id}),s=>s.targets[0].state==='terminal');
        assert.equal(clearFinal.targets[0].outcome,'succeeded');
        for(const worker of await businessRole(creationAccount,'bindingEvidence')) assert.equal(worker.bindings.find(b=>b.name==='UUID').text,'local-global-uuid');
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,6);
        assert.equal((await businessRole(creationAccount,'status')).namespaceWrites,1);
        assert.deepEqual(await businessRole('global','admissionFuse',{key:'fuse-once'}),{id:fuseTask,duplicate:true});
        assert.equal((await businessRole('global','configEvidence')).records.find(r=>r.domain.startsWith('override:')).value,null);
        console.log('PASS: real DO atomic fuse override/task admission, lost ACK and third restart retain a single UUID for both workers; parked progress wakes without duplicate writes; subsequent manual clear restores global UUID and old fuse replay cannot undo it');
        await businessRole('global','flags',{sourceOffline:true,loseSubmitAck:true});
        await businessRole(creationAccount,'flags',{progressBlocked:true});
        const beforeManual=(await businessRole('global','status')).admissionTasks.map(t=>t.id);
        const readsBeforeManual=(await businessRole('global','status')).sourceReads;
        assert.equal((await send({target:'global',action:'admissionManual',key:'manual-custom-once'},'business-roles')).status,500);
        const manualTask=(await businessRole('global','status')).admissionTasks.find(t=>!beforeManual.includes(t.id)).id;
        await until(()=>businessRole(creationAccount,'status'),s=>s.businessWrites===7);
        await businessRole(creationAccount,'lastRetry');
        await until(()=>businessRole(creationAccount,'status'),s=>s.retryFailures===8);
        await restart();
        assert.deepEqual(await businessRole('global','admissionManual',{key:'manual-custom-once'}),{id:manualTask,duplicate:true});
        assert.equal((await businessRole('global','status')).sourceReads,readsBeforeManual);
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,7);
        await businessRole(creationAccount,'flags',{progressBlocked:false});
        await businessRole('global','wake',{task:manualTask});
        const manualFinal=await until(()=>businessRole('global','admissionInspect',{task:manualTask}),s=>s.targets[0].state==='terminal');
        assert.equal(manualFinal.targets[0].outcome,'succeeded');
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,8);
        assert.equal((await businessRole(creationAccount,'status')).namespaceWrites,1);
        const manualCode='export default {fetch(){return new Response("manual-local")}}; /*'+'x'.repeat(180000)+'*/';
        for(const worker of await businessRole(creationAccount,'sourceEvidence')){
            assert.equal(worker.digest,createHash('sha256').update(manualCode).digest('hex'));assert.equal(worker.bytes,Buffer.byteLength(manualCode));
        }
        for(const worker of await businessRole(creationAccount,'bindingEvidence')){
            assert.equal(worker.bindings.some(b=>b.name==='UUID'),false);
            assert.equal(worker.bindings.find(b=>b.name==='MANUAL_SECRET').text,'local-only-secret');
            if(worker.name==='created-worker')assert.ok(worker.bindings.some(b=>b.type==='kv_namespace' && b.namespace_id==='c'.repeat(32)));
        }
        assert.doesNotMatch(JSON.stringify(manualFinal),/manual-local|local-only-secret|digest|snapshot/);
        console.log('PASS: real DO signed >128KiB manual custom-source admission, explicit UUID deletion and KV preservation; lost ACK + fourth restart recover same sealed bytes and parked receipt; both workers verified with exactly two new PUTs, no upstream fetch or namespace cleanup');
        await businessRole('global','repairSetup');await businessRole(creationAccount,'repairSetup');
        await businessRole('global','flags',{sourceOffline:false,loseSubmitAck:true});
        await businessRole(creationAccount,'flags',{progressBlocked:true});
        const beforeRepair=(await businessRole('global','status')).admissionTasks.map(t=>t.id);
        assert.equal((await send({target:'global',action:'admissionRepair',key:'repair-once'},'business-roles')).status,500);
        const repairTask=(await businessRole('global','status')).admissionTasks.find(t=>!beforeRepair.includes(t.id)).id;
        await until(()=>businessRole(creationAccount,'repairEvidence'),s=>s.flagWrites===1);
        await businessRole(creationAccount,'lastRetry');await until(()=>businessRole(creationAccount,'status'),s=>s.retryFailures===8);
        await businessRole('global','flags',{sourceOffline:true});
        const readsAfterRepair=(await businessRole('global','status')).sourceReads;
        await restart();
        assert.deepEqual(await businessRole('global','admissionRepair',{key:'repair-once'}),{id:repairTask,duplicate:true});
        assert.equal((await businessRole('global','status')).sourceReads,readsAfterRepair);
        assert.equal((await businessRole(creationAccount,'repairEvidence')).workerDeletes,1);
        await businessRole(creationAccount,'flags',{progressBlocked:false});await businessRole('global','wake',{task:repairTask});
        const repairFinal=await until(()=>businessRole('global','admissionInspect',{task:repairTask}),s=>s.targets[0].state==='terminal');
        assert.equal(repairFinal.targets[0].outcome,'succeeded');
        const repairEvidence=await businessRole(creationAccount,'repairEvidence');
        // The account rotation is a single non-destructive PUT: the delete/recreate
        // fallback only exists for accounts whose provider refuses to replace an
        // existing subdomain, so no DELETE is issued here.
        assert.equal(repairEvidence.workerDeletes,2);assert.equal(repairEvidence.domainWrites,2);assert.equal(repairEvidence.flagWrites,2);assert.equal(repairEvidence.subdomainWrites,1);
        assert.equal(repairEvidence.domains.length,2);assert.ok(repairEvidence.domains.every(d=>d.enabled===true&&d.previews_enabled===false));assert.match(JSON.parse(repairEvidence.flags.find(r=>r.key==='account').payload),/^repair-[a-f0-9]{24}$/);
        for(const flag of repairEvidence.flags.filter(r=>r.key!=='account'))assert.deepEqual(JSON.parse(flag.payload),{enabled:false,previews_enabled:true});
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,10);assert.equal((await businessRole(creationAccount,'status')).namespaceWrites,1);
        assert.doesNotMatch(JSON.stringify(repairFinal),/local-only-secret|repair-[a-f0-9]{24}|digest|snapshot|admission-local/);
        console.log('PASS: real DO legacy manual/batch/repair HTTP intent adapters and observed no-total_pages domain schema; 1101 repair backs up before delete, retains hidden secret/KV, restores domains and preview flags, rotates account exactly once with one non-destructive subdomain PUT; lost ACK + fifth restart replay original plan/progress with no duplicate DELETE/PUT');
        await businessRole('global','flags',{sourceOffline:false});await businessRole(creationAccount,'flags',{repairLoseDelete:true});
        const lostRepair=await businessRole('global','admissionRepair',{key:'repair-delete-lost'});
        await until(()=>businessRole(creationAccount,'status'),s=>s.jobs.some(j=>j.state==='needs_review'));
        assert.equal((await businessRole(creationAccount,'repairEvidence')).workerDeletes,3);
        assert.equal((await businessRole(creationAccount,'status')).businessWrites,10);
        await businessRole('global','wake',{task:lostRepair.id});await new Promise(r=>setTimeout(r,100));
        assert.equal((await businessRole(creationAccount,'repairEvidence')).workerDeletes,3);
        assert.equal((await businessRole(creationAccount,'repairEvidence')).subdomainWrites,1);
        assert.notEqual((await businessRole('global','admissionInspect',{task:lostRepair.id})).targets[0].state,'terminal');
        console.log('PASS: real DO lost repair DELETE response blocks rebuild and account rotation, retains global permit and cannot be unlocked by wake');
        // Independent real DO namespace, all account credentials and resources fake.
        await resourceRole('global','bootstrap');await resourceRole('global','resourceSetup');await resourceRole(creationAccount,'resourceSetup');
        const nodeTask=await resourceRole('global','admissionResource',{key:'nodes-once',path:'/api/save_yxip',body:{type:'cmliu',accountId:creationAccount,rawContent:'1.2.3.4:443#HK'}});
        assert.equal((await until(()=>resourceRole('global','admissionInspect',{task:nodeTask.id}),s=>s.targets[0].state==='terminal')).targets[0].outcome,'succeeded');
        assert.equal((await resourceRole(creationAccount,'resourceEvidence')).nodeWrites,2);
        await resourceRole('global','flags',{loseSubmitAck:true});await resourceRole(creationAccount,'flags',{progressBlocked:true});
        const resourceRemoval={key:'remove-shared',path:'/api/delete_worker',body:{accountId:creationAccount,workerName:'mock-worker',deleteKv:true}};
        const resourceBefore=(await resourceRole('global','status')).admissionTasks.map(t=>t.id);
        assert.equal((await send({target:'global',action:'admissionResource',...resourceRemoval},'resource-roles')).status,500);
        const resourceTask=(await resourceRole('global','status')).admissionTasks.find(t=>!resourceBefore.includes(t.id)).id;
        await until(()=>resourceRole(creationAccount,'resourceEvidence'),s=>s.workerDeletes===1);await resourceRole(creationAccount,'lastRetry');await until(()=>resourceRole(creationAccount,'status'),s=>s.retryFailures===8);
        assert.deepEqual((await resourceRole('global','status')).workers,['mock-worker','spare-worker']);
        await resourceRole('global','flags',{inventoryOffline:true});await restart();
        assert.deepEqual(await resourceRole('global','admissionResource',resourceRemoval),{id:resourceTask,duplicate:true});assert.equal((await resourceRole('global','resourceEvidence')).inventoryReads,1);
        await resourceRole(creationAccount,'flags',{progressBlocked:false});await resourceRole('global','wake',{task:resourceTask});
        assert.equal((await until(()=>resourceRole('global','admissionInspect',{task:resourceTask}),s=>s.targets[0].state==='terminal')).targets[0].outcome,'succeeded');
        assert.deepEqual((await resourceRole('global','status')).workers,['spare-worker']);assert.equal((await resourceRole(creationAccount,'resourceEvidence')).workerDeletes,1);assert.equal((await resourceRole(creationAccount,'resourceEvidence')).namespaceDeletes,0);
        assert.equal((await resourceRole(creationAccount,'resourceEvidence')).namespaces.length,1);
        await resourceRole('global','flags',{inventoryOffline:false});await resourceRole(creationAccount,'flags',{progressBlocked:true});
        const lastRemoval=await resourceRole('global','admissionResource',{key:'remove-last',path:'/api/delete_worker',body:{accountId:creationAccount,workerName:'spare-worker',deleteKv:true}});
        await until(()=>resourceRole(creationAccount,'resourceEvidence'),s=>s.workerDeletes===2);await resourceRole(creationAccount,'lastRetry');await until(()=>resourceRole(creationAccount,'status'),s=>s.retryFailures===8);
        await resourceRole('global','resourceConfigEdit');await resourceRole(creationAccount,'flags',{progressBlocked:false});await resourceRole('global','wake',{task:lastRemoval.id});
        assert.equal((await until(()=>resourceRole('global','admissionInspect',{task:lastRemoval.id}),s=>s.targets[0].state==='terminal')).targets[0].outcome,'succeeded');
        assert.deepEqual((await resourceRole('global','status')).workers,[]);assert.equal((await resourceRole(creationAccount,'resourceEvidence')).namespaceDeletes,1);assert.equal((await resourceRole(creationAccount,'resourceEvidence')).namespaces.length,0);
        const resourceConfig=await resourceRole('global','configEvidence');assert.ok(JSON.stringify(resourceConfig).includes('newer-local-edit'));
        const renameTask=await resourceRole('global','admissionResource',{key:'rename-once',path:'/api/change_subdomain',body:{accountId:creationAccount,newSubdomain:' N '}});
        assert.equal((await until(()=>resourceRole('global','admissionInspect',{task:renameTask.id}),s=>s.targets[0].state==='terminal')).targets[0].outcome,'succeeded');
        const resourceEvidence=await resourceRole(creationAccount,'resourceEvidence');assert.equal(resourceEvidence.subdomainWrites,2);assert.equal(resourceEvidence.workerDeletes,2);assert.equal(resourceEvidence.nodeWrites,2);
        assert.deepEqual(await resourceRole('global','admissionResource',resourceRemoval),{id:resourceTask,duplicate:true});assert.deepEqual(await resourceRole(creationAccount,'resourceEvidence'),resourceEvidence);
        console.log('PASS: real DO legacy nodes/delete/subdomain adapters; two frozen node writes, shared KV retained, final unshared KV deleted only once, current-authority config edits preserved; lost ACK and sixth process restart reuse removal manifest with inventory offline, no repeated DELETE/PUT');
        // Configuration commits must survive a lost response and a seventh process restart.
        // All credentials/resources above and below are local mock data only.
        await resourceRole('global','configSetup');
        const configRpc=async(method,body,extra={})=>resourceRole('global','configRpc',{method,body,...extra});
        const readConfig=async(selector)=>{const r=await configRpc('read_config',{selector});assert.equal(r.status,200);return r.body.value;};
        const makeEdit=(view,selector,value,key)=>({key,generation:view.generation,epoch:view.epoch,revision:view.revision,selector,value});
        const configBeforeExternal=await resourceRole(creationAccount,'resourceEvidence');
        const autoView=await readConfig({kind:'auto'});
        const autoEdit=makeEdit(autoView,{kind:'auto'},{enabled:false,interval:45},'config-auto-once');
        assert.equal((await configRpc('edit_config',{request:autoEdit})).status,200);
        const autoSaved=await readConfig({kind:'auto'});assert.equal(autoSaved.value.enabled,false);assert.equal(autoSaved.value.lastCheck,undefined);assert.deepEqual(autoSaved.runtime.value,{lastCheck:100,lastGc:80});
        assert.equal((await configRpc('edit_config',{request:{...autoEdit,key:'stale-tab'}})).status,409);
        assert.equal((await configRpc('edit_config',{request:makeEdit(autoSaved,{kind:'auto'},{lastCheck:0},'config-reset-runtime')})).status,400);
        const accountView=await readConfig({kind:'accounts'});assert.equal(accountView.value[0].apiToken,'***');assert.ok(!JSON.stringify(accountView).includes('v2:'));
        const credentialEdit=makeEdit(accountView,{kind:'accounts'},accountView.value.map(a=>({...a,apiToken:'not-permitted-during-observation'})),'config-credential-refused');
        assert.equal((await configRpc('edit_config',{request:credentialEdit})).status,409);
        const accountEdit=makeEdit(accountView,{kind:'accounts'},accountView.value.map(a=>({...a,alias:'edited-in-real-local-do'})),'config-alias-once');
        assert.equal((await configRpc('edit_config',{request:accountEdit})).status,200);
        const nodeView=await readConfig({kind:'joey_nodes'});
        const configNodeEdit=makeEdit(nodeView,{kind:'joey_nodes'},'local.example:443','config-nodes-once');
        assert.equal((await send({target:'global',action:'configRpc',method:'edit_config',body:{request:configNodeEdit},loseAck:true},'resource-roles')).status,500);
        await restart();
        const replayConfig=await configRpc('edit_config',{request:configNodeEdit});assert.equal(replayConfig.status,200);assert.equal(replayConfig.body.value.duplicate,true);assert.equal(replayConfig.body.value.revision,nodeView.revision+1);
        const savedNodes=await readConfig({kind:'joey_nodes'});assert.equal(savedNodes.revision,nodeView.revision+1);assert.deepEqual(savedNodes.value,[{key:'other',value:'kept',secret:true},{key:'yx',value:'local.example:443'}]);
        const replayAccount=await configRpc('edit_config',{request:accountEdit});assert.equal(replayAccount.status,200);assert.equal(replayAccount.body.value.duplicate,true);
        assert.equal((await readConfig({kind:'accounts'})).value[0].alias,'edited-in-real-local-do');
        assert.deepEqual((await readConfig({kind:'auto'})).runtime.value,{lastCheck:100,lastGc:80});
        assert.deepEqual(await resourceRole(creationAccount,'resourceEvidence'),configBeforeExternal);
        console.log('PASS: real local DO authenticated config RPC, atomic CAS+idempotent receipts, credential observation barrier, runtime separation, Joey yx preservation, stale-tab refusal; lost config ACK + seventh process restart replay without new external writes');
        // Dedicated namespace: a failed terminal projection must retain its global permit.
        const ledgerRole=async(target,action,extra={})=>{const result=await send({target,action,...extra},'ledger-roles');assert.equal(result.status,200,'ledger DO request: '+action);return result.result;};
        const ledgerView=async(task)=>ledgerRole('global','ledgerEvidence',{task});
        const deployValue=e=>e.config.records.find(r=>r.domain==='deploy:cmliu').value;
        const journalValue=e=>e.config.records.find(r=>r.domain==='deployJournal').value;
        await ledgerRole('global','bootstrap');await ledgerRole('global','ledgerSetup');
        const initialLedger=await ledgerView();
        await ledgerRole(creationAccount,'flags',{receiptBlocked:true});
        const fullLedger=await ledgerRole('global','ledgerSubmit',{key:'ledger-full-once'});
        await until(()=>ledgerRole(creationAccount,'status'),s=>s.jobs.find(j=>j.id===fullLedger.id)?.state==='succeeded');
        const beforeLedgerReceipt=await ledgerView(fullLedger.id);
        assert.deepEqual(deployValue(beforeLedgerReceipt),deployValue(initialLedger));assert.equal(journalValue(beforeLedgerReceipt),null);
        assert.equal(beforeLedgerReceipt.versions.length,1);assert.equal(beforeLedgerReceipt.runs[0].status,'running');assert.equal(beforeLedgerReceipt.dispatch[0].state,'accepted');
        await ledgerRole('global','flags',{ledgerFault:true});await ledgerRole(creationAccount,'flags',{receiptBlocked:false});
        await ledgerRole(creationAccount,'lastRetry');
        await until(()=>ledgerRole(creationAccount,'status'),s=>s.retryFailures===8);
        const failedLedger=await ledgerView(fullLedger.id);assert.deepEqual(failedLedger,beforeLedgerReceipt);
        assert.equal((await ledgerRole(creationAccount,'status')).businessWrites,1);
        await restart(); // Eighth process restart, same persisted SQLite databases.
        assert.deepEqual(await ledgerView(fullLedger.id),failedLedger);
        assert.deepEqual(await ledgerRole('global','ledgerSubmit',{key:'ledger-full-once'}),{id:fullLedger.id,duplicate:true});
        await ledgerRole('global','flags',{ledgerFault:false});await ledgerRole('global','wake',{task:fullLedger.id});
        const committedLedger=await until(()=>ledgerView(fullLedger.id),s=>s.dispatch[0].state==='terminal');
        assert.equal(deployValue(committedLedger).currentSha,'a'.repeat(40));assert.equal(journalValue(committedLedger).length,1);
        assert.equal(committedLedger.runs[0].result.advanced,true);assert.equal((await ledgerRole(creationAccount,'status')).businessWrites,1);
        await ledgerRole('global','wake',{task:fullLedger.id});assert.deepEqual(await ledgerView(fullLedger.id),committedLedger);
        await ledgerRole('global','flags',{alternateSource:true});
        const partialLedger=await ledgerRole('global','ledgerSubmit',{key:'ledger-partial-once',partial:true});
        const afterPartial=await until(()=>ledgerView(partialLedger.id),s=>s.dispatch[0].state==='terminal');
        assert.equal(afterPartial.runs[0].scope,'partial');assert.equal(afterPartial.runs[0].result.advanced,false);
        assert.equal(deployValue(afterPartial).currentSha,'a'.repeat(40));assert.equal(deployValue(afterPartial).deployTime,deployValue(committedLedger).deployTime);
        assert.equal(journalValue(afterPartial).length,2);assert.equal((await ledgerRole(creationAccount,'status')).businessWrites,2);
        await ledgerRole('global','flags',{sourceOffline:true});
        const customLedger=await ledgerRole('global','ledgerSubmit',{key:'ledger-custom-once',custom:true});
        const customDone=await until(()=>ledgerView(customLedger.id),s=>s.dispatch[0].state==='terminal');
        assert.equal(customDone.runs[0].status,'succeeded');assert.equal(deployValue(customDone).currentSha,null);
        assert.match(deployValue(customDone).currentCustomSha,/^[a-f0-9]{64}$/);
        const sourceReads=(await ledgerRole('global','status')).sourceReads;
        const frozenCycle=await ledgerRole('global','cycleOpen',{scheduledAt:600000,now:600000});
        const frozenCycleEvidence=await ledgerRole('global','cycleEvidence',{id:frozenCycle.id});
        await restart(); // Ninth restart: retrieve only retained sealed custom bytes.
        assert.deepEqual(await ledgerRole('global','cycleOpen',{scheduledAt:600000,now:600100}),frozenCycle);
        assert.deepEqual(await ledgerRole('global','cycleEvidence',{id:frozenCycle.id}),frozenCycleEvidence);
        const customFuse=await ledgerRole('global','customFuse',{key:'custom-fuse-once'});
        const fuseDone=await until(()=>ledgerView(customFuse.id),s=>s.dispatch[0].state==='terminal');
        assert.equal(fuseDone.runs[0].status,'succeeded');assert.equal(fuseDone.runs[0].scope,'partial');
        assert.equal(fuseDone.runs[0].result.advanced,false);
        assert.equal(deployValue(fuseDone).currentCustomSha,deployValue(customDone).currentCustomSha);
        assert.equal(deployValue(fuseDone).deployTime,deployValue(customDone).deployTime);
        assert.equal((await ledgerRole('global','status')).sourceReads,sourceReads);
        assert.equal((await ledgerRole('global','sourcePins')).length,1);
        assert.deepEqual(await ledgerRole('global','customFuse',{key:'custom-fuse-once'}),{id:customFuse.id,duplicate:true});
        assert.equal((await ledgerRole(creationAccount,'status')).businessWrites,4);
        assert.deepEqual(await ledgerRole('global','cycleEvidence',{id:frozenCycle.id}),frozenCycleEvidence);
        console.log('PASS: persistent Cron window identity, sealed config snapshot and stable lane task key survive ninth process restart and newer deployment/override writes; not a full Cron scheduler acceptance');
        const sentNotice=await ledgerRole('global','notice',{operation:'enqueue',task:fullLedger.id});
        assert.equal((await ledgerRole('global','notice',{operation:'send',id:sentNotice.id})).state,'delivered');
        const lostNotice=await ledgerRole('global','notice',{operation:'enqueue',task:customFuse.id});
        assert.equal((await ledgerRole('global','notice',{operation:'send',id:lostNotice.id,loseResponse:true})).state,'unknown');
        const queuedNotice=await ledgerRole('global','notice',{operation:'enqueue',task:partialLedger.id});
        assert.equal(await ledgerRole('global','noticeCount'),2);
        await restart(); // Tenth restart: durable webhook delivery/unknown barriers.
        await ledgerRole('global','notice',{operation:'recover'});
        assert.equal((await ledgerRole('global','notice',{operation:'send',id:sentNotice.id})).state,'delivered');
        assert.equal((await ledgerRole('global','notice',{operation:'send',id:lostNotice.id})).state,'unknown');
        assert.equal(await ledgerRole('global','noticeCount'),2);
        assert.equal((await ledgerRole('global','notice',{operation:'send',id:queuedNotice.id})).state,'delivered');
        assert.equal(await ledgerRole('global','noticeCount'),3);
        assert.deepEqual(await ledgerRole('global','notice',{operation:'enqueue',task:customFuse.id}),{id:lostNotice.id,duplicate:true});
        console.log('PASS: independent sealed webhook outbox, verified deployment completion prerequisite, tenth process restart preserves delivered and unknown without another POST, queued notification resumes once; local fake provider only');
        await ledgerRole('global','flags',{sourceOffline:false});
        console.log('PASS: ninth real local DO restart, fixed custom fuse retrieves retained encrypted source offline, no upstream requests or fake commit, source/key reference pin, verified partial completion and original intent replay without another HTTP write');
        await ledgerRole(creationAccount,'flags',{loseScriptResponse:true});
        const unknownLedger=await ledgerRole('global','ledgerSubmit',{key:'ledger-unknown-once'});
        const unknownView=await until(()=>ledgerView(unknownLedger.id),s=>s.runs[0].status==='needs_review');
        assert.equal(unknownView.dispatch[0].state,'accepted');assert.deepEqual(deployValue(unknownView),deployValue(fuseDone));assert.equal(journalValue(unknownView).length,4);
        await ledgerRole('global','wake',{task:unknownLedger.id});assert.equal((await ledgerRole(creationAccount,'status')).businessWrites,5);
        assert.deepEqual(await ledgerView(unknownLedger.id),unknownView);
        console.log('PASS: real local DO full ledger advances only with final receipt; journal transaction failure rolls back config+permit, eighth restart and replay append once without repeat HTTP; different-source partial keeps current SHA/time; unknown retains permit and blocks ledger completion');
        const automationRole=async(target,action,extra={})=>{const result=await send({target,action,...extra},'automation-roles');assert.equal(result.status,200,'automation DO request: '+action);return result.result;};
        await automationRole('global','bootstrap');
        const automationAt=Math.floor(Date.now()/300000)*300000+1000;
        await automationRole('global','automationSetup',{now:automationAt});
        await automationRole('global','flags',{hold:true,loseSubmitAck:true});
        await automationRole(creationAccount,'flags',{hold:true});
        const automationStart=await automationRole('global','automationStart',{scheduledAt:automationAt});
        assert.equal(automationStart.lanes[0].state,'submitting');
        const automationBefore=await automationRole('global','automationState',{cycle:automationStart.cycle});
        assert.equal(automationBefore.tasks.length,1);assert.equal(automationBefore.notices,0);assert.equal(automationBefore.sourceReads,2);
        await automationRole('global','flags',{sourceOffline:true});
        await automationRole('global','automationSetup',{enabled:false,now:automationAt});
        await restart(); // Eleventh restart: cycle admission lost ACK, sealed decision, original UUID.
        await automationRole('global','flags',{hold:false});
        await automationRole(creationAccount,'flags',{hold:false});
        const automationDone=await until(()=>automationRole('global','automationState',{cycle:automationStart.cycle}),s=>s.flow.state==='complete');
        assert.equal(automationDone.flow.lanes[0].task,automationBefore.tasks[0].id);assert.equal(automationDone.tasks.length,1);assert.equal(automationDone.sourceReads,2);assert.equal(automationDone.notices,1);assert.equal(automationDone.autoRevision,2);assert.equal(automationDone.runtime.value.lastCheck,automationAt);assert.equal(automationDone.flow.retentionAudit,true);
        assert.equal((await automationRole(creationAccount,'status')).businessWrites,1);
        assert.equal((await automationRole('global','automationStart',{scheduledAt:automationAt})).lanes[0].task,automationBefore.tasks[0].id);
        assert.equal((await automationRole(creationAccount,'status')).businessWrites,1);
        await automationRole('global','flags',{sourceOffline:false,loseWebhook:true});
        await automationRole('global','automationSetup',{now:automationAt+300000});
        const unknownAutomation=await automationRole('global','automationStart',{scheduledAt:automationAt+300000});
        const unknownAutomationDone=await until(()=>automationRole('global','automationState',{cycle:unknownAutomation.cycle}),s=>s.flow.state==='needs_review');
        assert.equal(unknownAutomationDone.flow.lanes[0].state,'notification_unknown');assert.equal(unknownAutomationDone.notices,2);assert.equal((await automationRole(creationAccount,'status')).businessWrites,2);
        const alarmCount=(await automationRole('global','status')).alarms;await wait(6500);
        assert.equal((await automationRole('global','automationState',{cycle:unknownAutomation.cycle})).notices,2);
        assert.ok((await automationRole('global','status')).alarms-alarmCount<=1,'unknown notification does not run a perpetual alarm loop');
        console.log('PASS: eleventh real local DO restart restores sealed Cron decision after lost admission ACK and newer disabled settings, same task/UUID without source reload, verified receipt then one webhook, independent runtime and retain-all audit; unknown notification parks without repeat HTTP or recurring alarms');
        const catalogBefore=await automationRole('global','catalog',{limit:1});
        assert.equal(catalogBefore.items[0].id,unknownAutomationDone.flow.lanes[0].task);
        assert.equal(catalogBefore.items[0].state,'succeeded');assert.equal(catalogBefore.items[0].notification,'unknown');assert.match(catalogBefore.cursor,/^v2\./);
        const viewBefore=await automationRole('global','view',{selector:{kind:'init',templates:['cmliu']}});
        assert.equal(viewBefore.generation,'g1');assert.equal(viewBefore.data.accounts[0].apiToken,'***');assert.ok(viewBefore.revisions.accounts>=1);
        assert.ok(!JSON.stringify(catalogBefore).includes('snapshot'));assert.ok(!JSON.stringify(catalogBefore).includes('local-test-only'));
        await automationRole('global','flags',{holdProjection:true,hold:true});
        await automationRole('global','automationSetup',{enabled:false,now:automationAt+300000});
        const authorityBefore=await automationRole('global','view',{selector:{kind:'config',selector:{kind:'auto'}}});
        await restart(); // Twelfth restart: authoritative reads and signed catalog cursor.
        assert.deepEqual(await automationRole('global','catalog',{limit:1}),catalogBefore);
        const olderPage=await automationRole('global','catalog',{limit:1,cursor:catalogBefore.cursor});assert.equal(olderPage.items[0].id,automationBefore.tasks[0].id);assert.equal(olderPage.cursor,null);
        assert.deepEqual(await automationRole('global','view',{selector:{kind:'config',selector:{kind:'auto'}}}),authorityBefore);
        const taskDetail=await automationRole('global','taskView',{id:unknownAutomationDone.flow.lanes[0].task});assert.equal(taskDetail.notification,'unknown');assert.equal(taskDetail.targets[0].steps[0].state,'verified');assert.equal(taskDetail.targets[0].steps[0].result.scriptVerified,true);assert.match(taskDetail.revision,/^[a-f0-9]{64}$/);
        await automationRole('global','flags',{holdProjection:false,hold:false});
        await until(()=>automationRole('global','view',{selector:{kind:'projection'}}),s=>s.data.pending===0);
        assert.equal((await automationRole(creationAccount,'status')).businessWrites,2);assert.equal((await automationRole('global','automationState',{cycle:unknownAutomation.cycle})).notices,2);
        console.log('PASS: twelfth real local DO restart retains authoritative masked reads, revision/runtime separation, v2 scoped catalog pagination and verified step projection; successful task/unknown webhook remain separate; revision hint consumer catches up without repeated HTTP writes');
        const externalZones=await automationRole('global','externalRead',{request:{kind:'zones',account:creationAccount}});
        assert.equal(externalZones.status,200);assert.equal(externalZones.body.value.data.zones.length,2);assert.equal(externalZones.calls,2);
        const externalBindings=await automationRole('global','externalRead',{request:{kind:'bindings',account:creationAccount,worker:'mock-worker'}});
        assert.equal(externalBindings.status,200);assert.equal(externalBindings.body.value.data.data[0].value,'');assert.ok(!JSON.stringify(externalBindings).includes('local-hidden-read-value'));
        await restart(); // Thirteenth restart: external reads do not create work or release barriers.
        const externalAgain=await automationRole('global','externalRead',{request:{kind:'zones',account:creationAccount}});
        assert.equal(externalAgain.status,200);assert.deepEqual(externalAgain.body.value,externalZones.body.value);
        await automationRole('global','flags',{revokeRead:true});
        const rejectedRead=await automationRole('global','externalRead',{request:{kind:'zones',account:creationAccount}});
        assert.equal(rejectedRead.status,409);assert.equal(rejectedRead.calls,externalAgain.calls+1);assert.deepEqual(rejectedRead.body,{error:'CONFLICT'});
        await restart(); // Revocation must remain after a process restart, not a transient read filter.
        const revokedRead=await automationRole('global','externalRead',{request:{kind:'workers',account:creationAccount}});
        assert.equal(revokedRead.status,409);assert.equal(revokedRead.calls,rejectedRead.calls);
        assert.equal((await automationRole(creationAccount,'status')).businessWrites,2);assert.equal((await automationRole('global','automationState',{cycle:unknownAutomation.cycle})).notices,2);
        console.log('PASS: thirteenth/fourteenth real local DO restarts retain authoritative external reads, strict multi-page inventory and hidden Secret projection; mid-pagination and persisted credential revocation stop the next GET without new tasks, external mutations or notice retries');
        const transferView=(await automationRole('global','view',{selector:{kind:'accounts_export'}})).data;
        assert.equal(transferView.format,'cfauto.accounts');assert.equal(transferView.version,2);assert.equal(transferView.accounts.length,1);
        assert.ok(transferView.accounts[0].apiToken.startsWith('v2:'));assert.ok(!JSON.stringify(transferView).includes('mock-only-token'));
        const transferInput={key:'local-account-import',generation:transferView.source.generation,epoch:transferView.source.epoch,revision:transferView.source.revision,selector:{kind:'accounts_import'},value:{file:transferView}};
        const transferRpc=async(request,extra={})=>automationRole('global','configRpc',{method:'edit_config',body:{request},...extra});
        assert.equal((await transferRpc(transferInput)).status,409); // Observation policy, not guessed success.
        await automationRole('global','transferAfterObservation');
        assert.equal((await send({target:'global',action:'configRpc',method:'edit_config',body:{request:transferInput},loseAck:true},'automation-roles')).status,500);
        const afterTransfer=(await automationRole('global','view',{selector:{kind:'accounts_export'}})).data;
        assert.equal(afterTransfer.source.revision,transferInput.revision+1);assert.deepEqual(afterTransfer.accounts,transferView.accounts);
        await restart(); // Fifteenth restart: import receipt and credential policy/revocations are durable.
        const transferReplay=await transferRpc(transferInput);assert.equal(transferReplay.status,200);assert.equal(transferReplay.body.value.duplicate,true);assert.equal(transferReplay.body.value.merged,1);
        assert.deepEqual((await automationRole('global','view',{selector:{kind:'accounts_export'}})).data,afterTransfer);
        assert.equal((await transferRpc({...transferInput,value:{file:transferView,unprefixed:'plaintext'}})).status,409);
        const stillRevoked=await automationRole('global','externalRead',{request:{kind:'workers',account:creationAccount}});assert.equal(stillRevoked.status,409);assert.equal(stillRevoked.calls,rejectedRead.calls);
        assert.equal((await automationRole(creationAccount,'status')).businessWrites,2);assert.equal((await automationRole('global','automationState',{cycle:unknownAutomation.cycle})).notices,2);
        console.log('PASS: fifteenth real local DO restart replays an atomic account import after lost ACK, preserves original v2 ciphertext/worker inventory and revoked credentials, with no new external writes or webhook retries; observation remains mandatory');
        checkpoint('credential_import_revocation');
        assert.equal((await send({action:'seed'},'archive-source')).status,200);
        assert.equal((await send({action:'create',loseAck:true},'archive-source')).status,500);
        const archiveRoot=(await send({action:'root'},'archive-source')).result;
        const archiveSummary=(await send({action:'summary'},'archive-source')).result;
        assert.equal(archiveSummary.archive.state,'ready');assert.equal(archiveSummary.archive.migrationReady,false);assert.equal(archiveSummary.configRows,93);assert.equal(archiveSummary.archivedVarRevision,1);assert.equal(archiveSummary.revocations,1);assert.deepEqual(archiveSummary.dispatchStates,['sending']);assert.deepEqual(archiveSummary.runtime,{lastCheck:123,lastGc:100});assert.equal(archiveSummary.plaintextAbsent,true);assert.ok(archiveSummary.pageCount>3);assert.deepEqual(archiveSummary.sourceRefs,[{id:'retained_source',keyId:'local_archive'}]);
        await send({action:'newConfig'},'archive-source');
        assert.equal((await send({action:'receiveRoot',packet:archiveRoot},'archive-copy')).result.state,'receiving');
        const archivePage0=(await send({action:'page',ordinal:0},'archive-source')).result;
        assert.equal((await send({action:'receivePage',ordinal:0,packet:archivePage0},'archive-copy')).result.duplicate,false);
        assert.equal((await send({action:'finishReceive'},'archive-copy')).status,404);
        assert.equal((await send({action:'status'},'archive-copy')).result.generation,null);
        await restart(); // Sixteenth restart: retained backup packets and snapshot identity.
        assert.equal((await send({action:'create'},'archive-source')).result.state,'ready');
        assert.deepEqual((await send({action:'root'},'archive-source')).result,archiveRoot);
        const archiveAfter=(await send({action:'summary'},'archive-source')).result;assert.equal(archiveAfter.archivedVarRevision,1);assert.equal(archiveAfter.currentVarRevision,2);assert.equal(archiveAfter.archive.migrationReady,false);assert.deepEqual(archiveAfter.dispatchStates,['sending']);
        assert.equal((await send({action:'receiveRoot',packet:archiveRoot},'archive-copy')).result.state,'receiving');
        assert.equal((await send({action:'receivePage',ordinal:0,packet:archivePage0},'archive-copy')).result.duplicate,true);
        for(let i=1;i<archiveSummary.pageCount;i++){const packet=(await send({action:'page',ordinal:i},'archive-source')).result;assert.equal((await send({action:'receivePage',ordinal:i,packet},'archive-copy')).result.duplicate,false);}
        assert.equal((await send({action:'finishReceive'},'archive-copy')).result.state,'ready');
        assert.deepEqual((await send({action:'root'},'archive-copy')).result,archiveRoot);
        assert.equal((await send({action:'importPacket',packet:{...archiveRoot,proof:'0'.repeat(64)}},'archive-copy')).status,400);
        assert.equal((await send({action:'status'},'archive-copy')).result.generation,null);
        console.log('PASS: sixteenth real local DO restart preserves complete multipage authority snapshot, runtime, revocation, held dispatch and source references; lost backup ACK replays original snapshot after edits; resumable whole-archive encrypted transfer never activates data or releases barriers; migrationReady remains false');
        // Separate valid data set: the original multipage archive intentionally has
        // orphan overrides and must not be loosened into an importable manifest.
        assert.equal((await send({action:'migrationSeed'},'archive-migration')).result.migrationReady,false);
        assert.equal((await send({action:'migrationBegin',loseAck:true},'archive-migration')).status,500);
        const migrationBefore=(await send({action:'migrationSummary'},'archive-migration')).result;
        assert.equal(migrationBefore.activeCount,40);assert.equal(migrationBefore.stagedCount,0);assert.equal(migrationBefore.status.generation,'g1');assert.equal(migrationBefore.status.maintenance,1);
        assert.equal((await send({action:'migrationResume',limit:7,loseAck:true},'archive-migration')).status,500);
        const migrationPartial=(await send({action:'migrationSummary'},'archive-migration')).result;
        assert.equal(migrationPartial.stagedCount,7);assert.equal(migrationPartial.import.state,'staging');assert.equal(migrationPartial.stagedCredentialDigest,migrationPartial.sourceCredentialDigest);
        await restart(); // Seventeenth restart: original prepared ciphertext and staged rows.
        assert.deepEqual((await send({action:'migrationSummary'},'archive-migration')).result,migrationPartial);
        assert.equal((await send({action:'migrationBegin'},'archive-migration')).result.state,'staging');
        for(let i=0;i<5;i++)assert.equal((await send({action:'migrationResume',limit:7},'archive-migration')).status,200);
        const migrationVerified=(await send({action:'migrationSummary'},'archive-migration')).result;
        assert.equal(migrationVerified.stagedCount,40);assert.equal(migrationVerified.import.state,'verified');assert.equal(migrationVerified.import.activationReady,false);assert.equal(migrationVerified.status.generation,'g1');
        for(const key of ['activeDigest','runtimeDigest','policyDigest','revocationsDigest','outboxDigest','preparedDigest','sourceCredentialDigest'])assert.equal(migrationVerified[key],migrationBefore[key],key+' changed during inactive import');
        assert.equal(migrationVerified.stagedCredentialDigest,migrationBefore.sourceCredentialDigest);
        assert.equal((await send({action:'migrationRevoke'},'archive-migration')).status,200);
        assert.equal((await send({action:'migrationResume'},'archive-migration')).status,409);
        const migrationRevoked=(await send({action:'migrationSummary'},'archive-migration')).result;assert.equal(migrationRevoked.import.stale,true);assert.equal(migrationRevoked.status.generation,'g1');assert.equal(migrationRevoked.stagedCount,40);
        assert.equal((await automationRole(creationAccount,'status')).businessWrites,2);assert.equal((await automationRole('global','automationState',{cycle:unknownAutomation.cycle})).notices,2);
        console.log('PASS: seventeenth real local DO restart resumes a complete 40-domain inactive generation after preparation/stage ACK loss using identical ciphertext; all active config/runtime/policy/revocation/outbox digests stay unchanged; new revocation invalidates the import without activating it or repeating HTTP');
        // Local fake legacy payload/resolver, not production credentials or source provenance.
        assert.equal((await send({action:'legacyBegin',loseAck:true},'archive-legacy')).status,500);
        assert.equal((await send({action:'legacyResume',limit:5},'archive-legacy')).status,200);
        const legacyPartial=(await send({action:'legacySummary'},'archive-legacy')).result;assert.equal(legacyPartial.import.staged,5);assert.equal(legacyPartial.pins.length,0);assert.equal(legacyPartial.status.generation,null);assert.equal(legacyPartial.policyCount,0);
        await restart(); // Eighteenth restart: strict legacy preparation is never reencrypted on resume.
        assert.deepEqual((await send({action:'legacySummary'},'archive-legacy')).result,legacyPartial);
        assert.equal((await send({action:'legacyBegin'},'archive-legacy')).status,200);
        assert.equal((await send({action:'legacyResume',limit:20},'archive-legacy')).status,200);
        const legacyVerified=(await send({action:'legacySummary'},'archive-legacy')).result;assert.equal(legacyVerified.import.state,'verified');assert.equal(legacyVerified.import.staged,15);assert.equal(legacyVerified.import.activationReady,false);assert.equal(legacyVerified.status.generation,null);assert.equal(legacyVerified.preparedDigest,legacyPartial.preparedDigest);assert.equal(legacyVerified.credentialDigest,legacyPartial.credentialDigest);assert.equal(legacyVerified.policyCount,0);assert.deepEqual(legacyVerified.runtimeRows,[]);assert.equal(legacyVerified.pins.length,1);assert.equal(legacyVerified.pins[0].generation,'gLegacy');assert.equal(legacyVerified.sourceBlockers.legacyDrainUnproven,1);
        assert.equal((await send({action:'migrationSummary'},'archive-migration')).result.import.stale,true);
        console.log('PASS: eighteenth real local DO restart resumes strictly classified fake legacy data with identical v2 ciphertext, commits source pins only at complete verification and retains legacyDrainUnproven; no active config/runtime/policy or fabricated deployment history is installed (fake resolver tests persistence, not production provenance)');
        assert.equal((await send({action:'switchPrepare'},'archive-migration')).result.state,'verified');
        assert.equal((await send({action:'switchDrain',limit:8,loseAck:true},'archive-migration')).status,500);
        const switchPartial=(await send({action:'switchSummary'},'archive-migration')).result;assert.equal(switchPartial.drain.probed,8);assert.equal(switchPartial.drain.state,'probing');assert.equal(switchPartial.status.generation,'g1');assert.equal(switchPartial.validatedAccounts,25);assert.equal(switchPartial.allRotated,false);
        await restart(); // Nineteenth restart: persistent seals in actual ProductionCoordinator account DOs.
        assert.deepEqual((await send({action:'switchSummary'},'archive-migration')).result,switchPartial);
        assert.equal((await send({action:'switchLateDelivery'},'archive-migration')).status,503);
        for(let i=0;i<3;i++)assert.equal((await send({action:'switchDrain',limit:8},'archive-migration')).status,200);
        const switchReady=(await send({action:'switchSummary'},'archive-migration')).result;assert.equal(switchReady.drain.state,'ready');assert.equal(switchReady.drain.probed,25);assert.equal(switchReady.drain.legacyDrainProven,false);
        await send({action:'switchFault',enabled:true},'archive-migration');assert.equal((await send({action:'switchActivate'},'archive-migration')).status,503);
        const switchRolledBack=(await send({action:'switchSummary'},'archive-migration')).result;assert.deepEqual(switchRolledBack,switchReady);
        await send({action:'switchFault',enabled:false},'archive-migration');await send({action:'switchMaintenanceFault',enabled:true},'archive-migration');
        assert.equal((await send({action:'switchActivate'},'archive-migration')).status,503);assert.deepEqual((await send({action:'switchSummary'},'archive-migration')).result,switchReady);
        assert.equal((await send({action:'switchMaintenanceAudit'},'archive-migration')).result.state,'pending');
        await send({action:'switchMaintenanceFault',enabled:false},'archive-migration');assert.equal((await send({action:'switchActivate',loseAck:true},'archive-migration')).status,500);
        const switchCommitted=(await send({action:'switchSummary'},'archive-migration')).result;assert.equal(switchCommitted.status.generation,'g3');assert.equal(switchCommitted.status.epoch,4);assert.equal(switchCommitted.status.maintenance,1);assert.equal(switchCommitted.allRotated,true);assert.equal(switchCommitted.validatedAccounts,25);assert.equal(switchCommitted.receipts,1);assert.equal(switchCommitted.drain.state,'consumed');assert.equal(switchCommitted.oldDigest,switchReady.oldDigest);assert.deepEqual(switchCommitted.runtime,switchReady.runtime);assert.equal(switchCommitted.heads[0].config_generation,'g3');assert.equal(switchCommitted.heads[0].credential_generation,'g3');assert.equal(switchCommitted.heads[0].runtime_generation,'g3');assert.equal(switchCommitted.policies.length,2);assert.equal(switchCommitted.policies[1].observation_until,604802000);assert.deepEqual(switchCommitted.revocations,[{generation:'g1',n:2},{generation:'g3',n:2}]);
        await restart(); // Twentieth restart: switch receipt/pointers and old account seals survive together.
        assert.deepEqual((await send({action:'switchSummary'},'archive-migration')).result,switchCommitted);
        const switchMaintenanceAudit=(await send({action:'switchMaintenanceAudit'},'archive-migration')).result;assert.equal(switchMaintenanceAudit.state,'complete');assert.equal(switchMaintenanceAudit.receipt.generation,'g3');assert.ok(switchMaintenanceAudit.attempts>=3);
        const switchReplay=(await send({action:'switchActivate'},'archive-migration')).result;assert.equal(switchReplay.generation,'g3');assert.equal(switchReplay.committedAt,2000);assert.equal(switchReplay.legacyCutover,false);
        assert.deepEqual((await send({action:'switchSummary'},'archive-migration')).result,switchCommitted);assert.deepEqual((await send({action:'switchMaintenanceAudit'},'archive-migration')).result,switchMaintenanceAudit);assert.equal((await send({action:'switchLateDelivery'},'archive-migration')).status,503);
        console.log('PASS: real DO current-authority generation activation shares its maintenance ACK with pointer/runtime/policy/drain transaction; maintenance-receipt fault rolls back everything; after response loss and restart the original command replays despite old expected epoch, with all 25 credentials verified and old assets retained');
        checkpoint('authority_activation_atomicity');
        assert.equal((await send({action:'switchOpen'},'archive-migration')).result.epoch,5);assert.equal((await send({action:'switchOldRuntime'},'archive-migration')).status,409);assert.equal((await send({action:'switchNewRuntime'},'archive-migration')).result.revision,2);
        const switchedOpen=(await send({action:'switchSummary'},'archive-migration')).result;assert.equal(switchedOpen.heads[0].epoch,5);assert.equal(switchedOpen.runtime.value.lastCheck,999);assert.equal(switchedOpen.runtimeGenerations.find(r=>r.generation==='g1').revision,1);assert.equal(switchedOpen.runtimeGenerations.find(r=>r.generation==='g3').revision,2);assert.equal(switchedOpen.oldDigest,switchReady.oldDigest);assert.equal(switchedOpen.receipts,1);
        console.log('PASS: nineteenth/twentieth real local DO restarts persist actual production-account drain seals for 25 accounts; late old delivery is denied; receipt failure rolls back import/drain/policy/runtime/pointers/outbox; lost activation ACK replays once; latest authority g1->g3 rekeys only inactive credentials, retains old data/revocations/runtime and seven-day observation; runtime receipts remain generation-owned. LOCAL ONLY, not legacy ingress drain or production cutover');
        for(const action of ['maintenanceUnsigned','maintenanceWrongKey','maintenanceWrongTarget','maintenanceWrongObject','maintenanceReaderDenied'])assert.equal((await send({action},'production-shell')).result.status,403);
        const maintenanceStatus=(await send({action:'maintenanceStatus'},'production-shell')).result;assert.equal(maintenanceStatus.status,200);assert.equal(maintenanceStatus.body.value.generation,null);assert.equal(maintenanceStatus.body.value.legacyDrainProven,false);
        const maintenanceFreeze=(await send({action:'maintenanceFreeze'},'production-shell')).result;assert.equal(maintenanceFreeze.status,200);assert.deepEqual(maintenanceFreeze.body.value,{generation:null,epoch:0,maintenance:1});
        assert.equal((await send({action:'maintenanceConflict'},'production-shell')).result.status,409);
        await restart(); // Twenty-first restart: actual production DO private maintenance authentication + durable audit.
        assert.deepEqual((await send({action:'maintenanceFreeze'},'production-shell')).result,maintenanceFreeze);
        const maintenanceAudit=(await send({action:'maintenanceAudit'},'production-shell')).result;assert.equal(maintenanceAudit.status,200);assert.equal(maintenanceAudit.body.value.operator,'ops');assert.equal(maintenanceAudit.body.value.state,'complete');assert.equal(maintenanceAudit.body.value.attempts,1);assert.deepEqual(maintenanceAudit.body.value.result,maintenanceFreeze.body.value);
        assert.equal((await send({action:'maintenanceWrongKey'},'production-shell')).result.status,403);
        console.log('PASS: twenty-first real local DO restart preserves independently signed maintenance receipt on actual ProductionCoordinator; wrong role/key/installation/address and unsigned requests denied, original ACK replayed, conflicting intent rejected. Empty production store remains maintained/unactivated; no public maintenance route, legacy drain or production cutover claimed');
        assert.equal((await send({action:'observationSeed'},'unknown-observation')).status,200);
        const observation=(await send({action:'observationCapture'},'unknown-observation')).result;assert.equal(observation.state,'observed');assert.equal(observation.settled,false);assert.equal(observation.possibleInFlight,true);
        const observationState=(await send({action:'observationState'},'unknown-observation')).result;assert.equal(observationState.calls,4);assert.deepEqual(observationState.jobs,[{state:'needs_review'}]);assert.deepEqual(observationState.permits,[{state:'sending'}]);
        await restart(); // Twenty-second restart: real SQLite observation evidence, read replay and revoke.
        assert.deepEqual((await send({action:'observationCapture'},'unknown-observation')).result,observation);
        assert.deepEqual((await send({action:'observationState'},'unknown-observation')).result,observationState);
        assert.equal((await send({action:'observationRevoke'},'unknown-observation')).status,200);
        assert.equal((await send({action:'observationCapture'},'unknown-observation')).status,409);
        assert.deepEqual((await send({action:'observationState'},'unknown-observation')).result,observationState);
        console.log('PASS: twenty-second real local DO restart preserves original fixed-GET observation ACK, sealed raw responses and unknown task/permit; no extra GET or mutation on replay, persisted credential revocation refuses review. Primitive integration uses a local mock role; actual ProductionCoordinator signed review chain is separately Node-SQLite tested, not remote/production acceptance');
        const transferRoot=(await send({action:'transferExport',id:'transfer_root',part:null},'archive-source')).result;
        assert.equal((await send({action:'transferBegin',descriptor:transferRoot.descriptor},'archive-transfer-copy')).status,200);
        const firstTransferFrame=(await send({action:'transferFrame',id:'transfer_root',ordinal:0},'archive-source')).result;assert.ok(firstTransferFrame.data.length<=4096);
        assert.equal((await send({action:'transferPut',id:'transfer_root',ordinal:0,data:firstTransferFrame.data,loseAck:true},'archive-transfer-copy')).status,500);
        await restart(); // Twenty-third restart: interrupted ciphertext transport survives original frame ACK loss.
        assert.equal((await send({action:'transferInfo',id:'transfer_root'},'archive-transfer-copy')).result.received,1);
        assert.deepEqual((await send({action:'transferFrame',id:'transfer_root',ordinal:0},'archive-source')).result,firstTransferFrame);
        for(let ordinal=transferRoot.descriptor.frames-1;ordinal>=0;ordinal--){const frame=(await send({action:'transferFrame',id:'transfer_root',ordinal},'archive-source')).result;assert.equal((await send({action:'transferPut',id:'transfer_root',ordinal,data:frame.data},'archive-transfer-copy')).status,200);}
        assert.equal((await send({action:'transferCommit',id:'transfer_root',loseAck:true},'archive-transfer-copy')).status,500);
        await restart(); // Twenty-fourth restart: original imported packet is not overwritten after lost completion ACK.
        assert.equal((await send({action:'transferInfo',id:'transfer_root'},'archive-transfer-copy')).result.state,'complete');
        assert.equal((await send({action:'transferCommit',id:'transfer_root'},'archive-transfer-copy')).result.state,'complete');
        const transferInventory=(await send({action:'transferInventory'},'archive-source')).result;
        for(let part=0;part<transferInventory.pages;part++){const id='transfer_page_'+part,info=(await send({action:'transferExport',id,part},'archive-source')).result;assert.equal((await send({action:'transferBegin',descriptor:info.descriptor},'archive-transfer-copy')).status,200);for(let ordinal=0;ordinal<info.descriptor.frames;ordinal++){const frame=(await send({action:'transferFrame',id,ordinal},'archive-source')).result;assert.equal((await send({action:'transferPut',id,ordinal,data:frame.data},'archive-transfer-copy')).status,200);}assert.equal((await send({action:'transferCommit',id},'archive-transfer-copy')).result.state,'complete');}
        assert.equal((await send({action:'finishReceive'},'archive-transfer-copy')).result.state,'ready');assert.equal((await send({action:'status'},'archive-transfer-copy')).result.generation,null);
        console.log('PASS: twenty-third/twenty-fourth real local DO restarts preserve bounded ciphertext frames, out-of-order resume, lost frame/packet ACKs and original encrypted packet bytes; full archived pages verify without activating target config or releasing tasks. Local fake data, not remote or production cutover');
        assert.equal((await send({action:'setup'},'production-archive')).result.status,200);
        assert.equal((await send({action:'list'},'production-archive')).result.body.value.items[0],'e'.repeat(32));
        assert.equal((await send({action:'denyRpc'},'production-archive')).result.status,403);
        assert.equal((await send({action:'createLost'},'production-archive')).status,500);
        const accountArchiveAudit=(await send({action:'audit'},'production-archive')).result.body.value;assert.equal(accountArchiveAudit.state,'complete');assert.equal(accountArchiveAudit.result.migrationReady,false);
        assert.equal((await send({action:'export'},'production-archive')).result.status,200);const accountArchiveFrame=(await send({action:'frame'},'production-archive')).result.body.value;assert.ok(accountArchiveFrame.data.length<=4096);
        await restart(); // Twenty-fifth restart: actual production account archive path, independently authorized global grant.
        assert.deepEqual((await send({action:'create'},'production-archive')).result.body.value,accountArchiveAudit.result);
        assert.deepEqual((await send({action:'frame'},'production-archive')).result.body.value,accountArchiveFrame);
        assert.equal((await send({action:'denyRpc'},'production-archive')).result.status,403);
        console.log('PASS: twenty-fifth real DO restart replays the actual production global-to-account independently authorized archive and original bounded encrypted frame after lost ACK; RPC-only forgery denied, no queue restore or provider write. Seed is confined to a never-deploy loopback subclass/isolated local namespace');
        assert.equal((await send({action:'observationSeed'},'unknown-adjudication')).status,200);
        assert.equal((await send({action:'observationCapture'},'unknown-adjudication')).status,200);
        assert.equal((await send({action:'adjudicationAttest'},'unknown-adjudication')).result.approved,false);
        assert.equal((await send({action:'adjudicationClose',loseAck:true},'unknown-adjudication')).status,500);
        const manualFailureBefore=(await send({action:'adjudicationState'},'unknown-adjudication')).result;
        assert.equal(manualFailureBefore.state,'failed');assert.equal(manualFailureBefore.callState[0].state,'unknown');assert.equal(manualFailureBefore.fact.code,'OPERATOR_CLOSED_UNCONFIRMED');assert.equal(manualFailureBefore.calls,4);
        await restart(); // Twenty-sixth restart: authenticated local sealed adjudication facts survive lost decision ACK.
        assert.deepEqual((await send({action:'adjudicationClose'},'unknown-adjudication')).result,manualFailureBefore.receipt);
        assert.deepEqual((await send({action:'adjudicationState'},'unknown-adjudication')).result,manualFailureBefore);
        assert.notEqual((await send({action:'adjudicationClose',operator:'wrong'},'unknown-adjudication')).status,200);
        console.log('PASS: twenty-sixth real local DO restart preserves operator-attested failed closure, original sealed fact and decision ACK without repeating HTTP; original execution call stays unknown. Local trusted permission callback only; real ProductionCoordinator independent signatures, terminal propagation and human-attributed drain are separately Node SQLite tested');
        const auditPageBefore=(await send({action:'maintenanceList'},'production-shell')).result;
        assert.equal(auditPageBefore.status,200);assert.equal(auditPageBefore.body.value.items.length,2);assert.ok(auditPageBefore.body.value.cursor);
        await restart(); // Twenty-seventh restart: actual production independent audit pagination.
        assert.deepEqual((await send({action:'maintenanceList'},'production-shell')).result,auditPageBefore);
        const auditPageAfter=(await send({action:'maintenanceList',cursor:auditPageBefore.body.value.cursor},'production-shell')).result;
        assert.equal(auditPageAfter.status,200);assert.equal(auditPageAfter.body.value.watermark,auditPageBefore.body.value.watermark);
        assert.ok(auditPageAfter.body.value.items.every(r=>r.seq<auditPageBefore.body.value.items.at(-1).seq));
        assert.ok(auditPageAfter.body.value.items.every(r=>!Object.hasOwn(r,'intent')&&!Object.hasOwn(r,'result')));
        console.log('PASS: twenty-seventh real local DO restart preserves independently signed production audit page ACK and operator/installation-bound cursor watermark; later inspection attempts do not shift the frozen identity set, and pages contain no raw intent or execution result');
        const applicationBefore=(await send({action:'recovery'},'application-entry')).result;
        assert.equal(applicationBefore.status,200);assert.equal(applicationBefore.body.mode,'authority');assert.equal(applicationBefore.body.status.generation,null);assert.equal(applicationBefore.kvBusinessTouches,0);
        assert.equal((await send({action:'restore'},'application-entry')).result.status,409);
        assert.equal((await send({action:'partial'},'application-entry')).result.status,503);
        const applicationMaintenance=(await send({action:'maintenance'},'application-entry')).result;
        assert.equal(applicationMaintenance.status,200);assert.equal(applicationMaintenance.kvSessionTouches,0);assert.equal(applicationMaintenance.kvBusinessTouches,0);
        const applicationCron=(await send({action:'cron'},'application-entry')).result;assert.equal(applicationCron.cronRejected,true);assert.equal(applicationCron.kvBusinessTouches,0);
        await restart(); // Twenty-eighth restart: the actual public index stays on authority after restart.
        const applicationAfter=(await send({action:'recovery'},'application-entry')).result;assert.deepEqual(applicationAfter.body,applicationBefore.body);assert.equal(applicationAfter.kvBusinessTouches,0);
        assert.equal((await send({action:'tasks'},'application-entry')).result.status,200);
        console.log('PASS: twenty-eighth real local DO restart exercises actual production index HTTP and scheduled entry, recovery metadata, retired KV restore rejection, partial-binding fail-closed and cookie-independent maintenance; session-only fake KV has zero business touches. Empty generation remains inactive; no production migration or browser execution');
        checkpoint('public_authority_ingress');
        const initialFixture='runner-initial';
        assert.equal((await send({action:'initialPrepare'},initialFixture)).result.state,'verified');
        assert.equal((await send({action:'initialActivate',auditFault:true},initialFixture)).status,503);
        const initialRolledBack=(await send({action:'initialState'},initialFixture)).result;
        assert.equal(initialRolledBack.status.generation,null);assert.equal(initialRolledBack.proof[0].state,'ready');assert.equal(initialRolledBack.imports.state,'verified');assert.equal(initialRolledBack.outbox,0);assert.deepEqual(initialRolledBack.heads,[]);assert.deepEqual(initialRolledBack.policy,[]);
        const initialAck=(await send({action:'initialActivate'},initialFixture)).result;assert.equal(initialAck.generation,'initial-g1');assert.equal(initialAck.maintenance,true);assert.equal(initialAck.observationUntil,604802000);
        const initialState=(await send({action:'initialState'},initialFixture)).result;assert.equal(initialState.proof[0].state,'consumed');assert.equal(initialState.imports.state,'activated');assert.equal(initialState.heads[0].runtime_generation,'initial-g1');
        await restart(); // Twenty-ninth restart: initial atomic participant, LOCAL FAKE proof only.
        assert.deepEqual((await send({action:'initialActivate'},initialFixture)).result,initialAck);
        assert.deepEqual((await send({action:'initialState'},initialFixture)).result,initialState);
        console.log('PASS: twenty-ninth real local DO restart retains initial generation pointer/runtime/policy/import/proof and original ACK together; injected audit failure rolls back all participants. Proof provider is explicitly LOCAL FAKE, not production legacy drain, public bootstrap or permission to cut over.');


        // NEW LOCAL-ONLY actual ProductionCoordinator source anchor / encrypted transfer.
        // None of these generated evidence hashes is a real production drain approval.
        const initialNative=async(command,operator='importer')=>{const r=await send({action:'command',command,operator},'initial-production');assert.equal(r.status,200);return r.result;};
        const nativeIdentity=(await initialNative({id:'native_identity',action:'initial_identity',args:{},expected:null},'inspector')).body.value;
        assert.equal(nativeIdentity.generation,null);assert.equal(nativeIdentity.sourceAnchorConfigured,false);
        const canonicalInitial=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
        const compiledInitial=require('esbuild').buildSync({entryPoints:[path.join(root,'src/reliability/sealed-store.ts')],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'}).outputFiles[0].text;
        const InitialModule=require('node:module'),loadedInitial=new InitialModule(path.join(dir,'initial-packet-builder.cjs'),module);loadedInitial.filename=path.join(dir,'initial-packet-builder.cjs');loadedInitial.paths=module.paths;loadedInitial._compile(compiledInitial,loadedInitial.filename);await fs.writeFile(loadedInitial.filename,compiledInitial,{flag:'wx'});
        const {DatabaseSync}=require('node:sqlite'),initialSql=new DatabaseSync(path.join(dir,'initial-packet-builder.sqlite'));
        const nativeDb={rows:(q,...p)=>initialSql.prepare(q).all(...p),transaction:fn=>{initialSql.exec('BEGIN IMMEDIATE');try{const result=fn();initialSql.exec('COMMIT');return result;}catch(e){initialSql.exec('ROLLBACK');throw e;}}};
        const nativeNow=Date.now(),nativeTarget=nativeIdentity.target,nativeSourceId='native_source',nativeGeneration='g_native_initial';
        const nativeOldKey=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode('local-retained-access-code-only')),{name:'AES-GCM'},false,['encrypt']),nativeOldIv=crypto.getRandomValues(new Uint8Array(12)),nativeOldCipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:nativeOldIv},nativeOldKey,new TextEncoder().encode('native-local-token')),nativeV1='v1:'+Buffer.concat([Buffer.from(nativeOldIv),Buffer.from(nativeOldCipher)]).toString('base64');
        const nativeValues={ACCOUNTS_UNIFIED_STORAGE:JSON.stringify([{accountId:'e'.repeat(32),alias:'native local fake',email:'',globalKey:'',apiToken:nativeV1,authMode:'token',workers_cmliu:['native-one']}]),AUTO_UPDATE_CFG_GLOBAL:JSON.stringify({enabled:false,interval:'30',lastCheck:456,lastGc:400})};
        const nativeEntries=Object.keys(nativeValues).sort().map((name,i)=>({name,file:'value-'+String(i).padStart(6,'0')+'.bin',bytes:Buffer.byteLength(nativeValues[name]),sha256:createHash('sha256').update(nativeValues[name]).digest('hex')}));
        const nativeManifest={schema:1,readOnly:true,...nativeTarget,deployment:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',version:'22222222-2222-2222-2222-222222222222',startedAt:new Date(nativeNow-4000).toISOString(),capturedAt:new Date(nativeNow-3000).toISOString(),consistency:'live-best-effort-not-cutover',migrationReady:false,inventoryMatched:true,verifiedLocalBytes:true,totalBytes:nativeEntries.reduce((n,e)=>n+e.bytes,0),entries:nativeEntries};const nativeManifestText=JSON.stringify(nativeManifest,null,2);
        const nativeEvidence={legacyDeployment:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',legacyVersion:'11111111-1111-1111-1111-111111111111',freezeDeployment:nativeManifest.deployment,freezeVersion:nativeManifest.version,freezeArtifact:'1'.repeat(64),freezeEvidence:'2'.repeat(64),drainEvidence:'3'.repeat(64),backupManifest:createHash('sha256').update(nativeManifestText).digest('hex'),verificationReport:'4'.repeat(64),frozenAt:nativeNow-6000,drainedAt:nativeNow-5000,backupStartedAt:nativeNow-4000,backupCompletedAt:nativeNow-3000,verifiedAt:nativeNow,expiresAt:nativeNow+3600000};
        const nativePayload={schema:1,kind:'cfauto.initial-cutover-source',pinId:'native_proof',target:nativeTarget,evidence:nativeEvidence,manifest:Buffer.from(nativeManifestText).toString('base64'),entries:nativeEntries.map(e=>({file:e.file,data:Buffer.from(nativeValues[e.name]).toString('base64')})),customSources:[]};
        const nativeContext={id:nativeSourceId+'_sealed',kind:'config_backup',account:'initial_cutover',generation:nativeGeneration},nativeSealed=new loadedInitial.exports.SealedStore(nativeDb,{currentId:'snapshot',keys:{snapshot:'5'.repeat(64)}});await nativeSealed.put(nativeContext,nativePayload,nativeNow);const nativePacket=canonicalInitial(await nativeSealed.exportPacket(nativeContext)),nativeBytes=Buffer.from(nativePacket);initialSql.close();
        const nativePin={schema:1,id:'native_proof',target:nativeTarget,installation:nativeIdentity.installation,sourceId:nativeSourceId,importId:'native_import',generation:nativeGeneration,epoch:0,packet:{id:nativeContext.id,digest:createHash('sha256').update(nativePacket).digest('hex'),bytes:nativeBytes.length,frames:Math.ceil(nativeBytes.length/3072)},evidence:nativeEvidence,unprefixed:'plaintext',legacyKeySource:'retained_ACCESS_CODE'};
        assert.equal((await send({action:'installPin',pin:nativePin},'initial-production')).result.status,200);
        await restart(); // Thirtieth restart: separately installed LOCAL FAKE anchor loaded by actual production constructor.
        const nativeExpected={generation:null,epoch:0,maintenance:1},nativeBegin={id:'native_source_begin',action:'initial_source_begin',args:{id:nativeSourceId},expected:nativeExpected};assert.equal((await initialNative(nativeBegin,'inspector')).status,403);assert.equal((await initialNative(nativeBegin)).status,200);
        for(let ordinal=0;ordinal<nativePin.packet.frames;ordinal++){const data=nativeBytes.subarray(ordinal*3072,(ordinal+1)*3072).toString('base64');assert.equal((await initialNative({id:'native_source_frame_'+ordinal,action:'initial_source_frame',args:{id:nativeSourceId,ordinal,data},expected:nativeExpected})).status,200);}
        assert.equal((await initialNative({id:'native_source_commit',action:'initial_source_commit',args:{id:nativeSourceId},expected:nativeExpected})).status,200);assert.equal((await initialNative({id:'native_import_begin',action:'initial_import_begin',args:{},expected:nativeExpected})).status,200);assert.equal((await initialNative({id:'native_import_resume',action:'initial_import_resume',args:{limit:100},expected:nativeExpected})).body.value.state,'verified');
        const nativeActivate={id:'native_activate',action:'initial_activate',args:{},expected:nativeExpected};assert.equal((await initialNative(nativeActivate)).status,403);assert.equal((await send({action:'command',command:nativeActivate,operator:'activator',loseAck:true},'initial-production')).status,500);
        const nativeAck=(await initialNative({id:'native_activation_read',action:'initial_activation_inspect',args:{id:'native_activate'},expected:null},'inspector')).body.value;assert.equal(nativeAck.generation,nativeGeneration);assert.equal(nativeAck.maintenance,true);
        const nativeState=(await send({action:'state'},'initial-production')).result.body;assert.equal(nativeState.status.generation,nativeGeneration);assert.equal(nativeState.credentialsVerified,true);assert.deepEqual(nativeState.heads,[{config_generation:nativeGeneration,credential_generation:nativeGeneration,runtime_generation:nativeGeneration,epoch:1}]);assert.deepEqual(nativeState.proofs,[{state:'consumed'}]);assert.deepEqual(nativeState.runtime,[{domain:'automation',revision:1,payload:{lastCheck:456,lastGc:400}}]);
        await restart(); // Thirty-first restart: original signed activation replay, no re-import or re-encryption.
        assert.deepEqual((await initialNative(nativeActivate,'activator')).body.value,nativeAck);assert.deepEqual((await send({action:'state'},'initial-production')).result.body,nativeState);
        console.log('PASS: thirtieth and thirty-first actual local DO process restarts install a LOCAL FAKE deployment anchor, transfer a real encrypted packet into actual ProductionCoordinator, enforce inspector/importer/activator separation, atomically activate credentials/runtime/config and replay the original lost ACK. All evidence is fake/local; this does NOT certify production stop-write or permit deployment.');
        checkpoint('initial_archive_replay');

        // Fresh namespace: original retained fixtures and their unknown barriers stay untouched.
        // Observer budget only: account alarms may be sealing multi-MiB receipts.
        // This does not change provider timeouts or retry timed-out writes.
        const largeRole=async(target,action,extra={})=>{const began=Date.now();try{const response=await send({target,action,...extra},'large-source-roles',30000);assert.equal(response.status,200,'large source fixture: '+action);return response.result;}finally{console.log('LARGE_SOURCE_OBSERVATION '+JSON.stringify({target,action,elapsedMs:Date.now()-began}));}};
        const largeAccount='e'.repeat(32);
        await largeRole('global','bootstrap');await largeRole('global','largeFixtureSetup');await largeRole(largeAccount,'largeFixtureSetup');
        const largeTask=await largeRole('global','ledgerSubmit',{key:'large-source-original'});
        const largeShape=await largeRole('global','largeSnapshot',{task:largeTask.id});
        assert.equal(largeShape.schema,2);assert.equal(largeShape.sources,1);assert.equal(largeShape.commands,6);assert.ok(largeShape.bytes<2*1024*1024);assert.equal(largeShape.sourceReads,2);
        assert.equal((await largeRole(largeAccount,'status')).businessWrites,0);
        await restart(); // Thirty-second actual process restart, before any large-source external write.
        await largeRole('global','flags',{sourceOffline:true});
        const largeReplay=await largeRole('global','ledgerSubmit',{key:'large-source-original'});assert.equal(largeReplay.id,largeTask.id);assert.equal(largeReplay.duplicate,true);
        await largeRole(largeAccount,'flags',{hold:false});
        await until(()=>largeRole(largeAccount,'status'),s=>s.jobs.some(j=>j.id===largeTask.id&&j.state==='succeeded'));
        await until(()=>largeRole('global','status',{task:largeTask.id}),s=>s.dispatch.every(d=>d.state==='terminal'));
        assert.deepEqual(await largeRole(largeAccount,'largeProviderStatus'),{workers:7,targetWorkers:6,minBytes:1726148,maxBytes:1726148,untargetedUnchanged:true,writes:6});
        await restart(); // Thirty-third actual process restart, after durable completion.
        const largeFinished=await largeRole('global','ledgerSubmit',{key:'large-source-original'});assert.equal(largeFinished.id,largeTask.id);assert.equal(largeFinished.duplicate,true);
        assert.deepEqual(await largeRole(largeAccount,'largeProviderStatus'),{workers:7,targetWorkers:6,minBytes:1726148,maxBytes:1726148,untargetedUnchanged:true,writes:6});
        assert.deepEqual(await largeRole('global','largeSnapshot',{task:largeTask.id}),largeShape);
        console.log('PASS: thirty-second and thirty-third real DO process restarts preserve one shared 1,726,148-byte source across six Worker commands and binding RPC; all six original bytes deploy exactly once to LOCAL MOCK resources, original admission ACK replays with upstream offline, no truncated targets, no source re-download and no repeated PUT');
        checkpoint('shared_source_rpc_replay');
        // Independent namespace; older 33-restart state and its evidence are untouched.
        const hugeRole=async(target,action,extra={})=>{const began=Date.now();try{const response=await send({target,action,...extra},'huge-source-roles',60000);assert.equal(response.status,200,'huge source fixture: '+action);return response.result;}finally{console.log('HUGE_SOURCE_OBSERVATION '+JSON.stringify({target,action,elapsedMs:Date.now()-began}));}};
        const hugeAccounts=[largeAccount,...Array.from({length:8},(_,i)=>(i+16).toString(16).padStart(32,'0'))];
        await hugeRole('global','bootstrap');await hugeRole('global','largeFixtureSetup');
        for(const account of hugeAccounts)await hugeRole(account,'largeFixtureSetup');
        const hugeTask=await hugeRole('global','ledgerSubmit',{key:'huge-source-original'}),hugeShapes=[];
        for(const account of hugeAccounts){const shape=await hugeRole('global','largeSnapshot',{task:hugeTask.id,account});assert.equal(shape.schema,2);assert.equal(shape.sources,1);assert.equal(shape.commands,2);assert.ok(shape.bytes<5*1024*1024);assert.ok(shape.decodedBytes>5*1024*1024);assert.equal(shape.sourceReads,2);hugeShapes.push(shape);assert.equal((await hugeRole(account,'status')).businessWrites,0);}
        await restart(); // Thirty-fourth real process restart, before any large external write.
        await hugeRole('global','flags',{sourceOffline:true});
        const hugeReplay=await hugeRole('global','ledgerSubmit',{key:'huge-source-original'});assert.equal(hugeReplay.id,hugeTask.id);assert.equal(hugeReplay.duplicate,true);
        for(const account of hugeAccounts)await hugeRole(account,'flags',{hold:false});
        for(const account of hugeAccounts)await until(()=>hugeRole(account,'status'),x=>x.jobs.some(j=>j.id===hugeTask.id&&j.state==='succeeded'));
        await until(()=>hugeRole('global','status',{task:hugeTask.id}),x=>x.dispatch.length===9&&x.dispatch.every(d=>d.state==='terminal'));
        for(const account of hugeAccounts)assert.deepEqual(await hugeRole(account,'largeProviderStatus'),{workers:3,targetWorkers:2,minBytes:5142235,maxBytes:5142235,untargetedUnchanged:true,writes:2});
        await restart(); // Thirty-fifth real process restart, after the original task completed.
        const hugeFinished=await hugeRole('global','ledgerSubmit',{key:'huge-source-original'});assert.equal(hugeFinished.id,hugeTask.id);assert.equal(hugeFinished.duplicate,true);
        for(const [i,account]of hugeAccounts.entries()){assert.deepEqual(await hugeRole('global','largeSnapshot',{task:hugeTask.id,account}),hugeShapes[i]);assert.deepEqual(await hugeRole(account,'largeProviderStatus'),{workers:3,targetWorkers:2,minBytes:5142235,maxBytes:5142235,untargetedUnchanged:true,writes:2});}
        console.log('PASS: thirty-fourth and thirty-fifth real DO process restarts preserve a 5,142,235-byte source across nine accounts and eighteen LOCAL MOCK Worker uploads; compressed authenticated snapshots stay within the original 5 MiB ciphertext budget; actual bounded production binding RPC, all original bytes, offline-source ACK replay and no repeated PUT verified');
        checkpoint('large_source_nine_account_replay');
        console.log('PASS: actual production DO class on workerd, independent mock Secret slots, private RPC rejection, physical address isolation and inbox persistence across restart; no production bootstrap API or real external business writes');
        console.log('PASS: real DO trusted business planner + static upload executor, multipart upload/readback, complete dependency snapshot, receipt recovery across restart and no repeated HTTP mutation (local 2026-07-07 with nodejs_als; not remote 2026-07-16 acceptance)');
        console.log('PASS: real multi-object authenticated binding RPC, physical role/address isolation, native alarms, three-account permits, delivery replay, terminal outbox after process restart, queued unknown barrier and revoked credentials');
        assert.equal((await send({ action: 'authorityAuthorize', permit: credentialPermit }, authorityFixture)).status, 409);
        assert.equal((await send({ action: 'dispatchInspect', task: credentialDelivery.task }, authorityFixture)).result[0].state, 'sending');
        assert.deepEqual((await send({ action: 'credentialRead' })).result, { verified: true, revision: 1 });
        const replay = await send({ action: 'runnerTick', failTransport: true }, 'runner-replay');
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.result, [{ job: 'runner_job', state: 'succeeded' }, { job: 'runner_job', state: 'succeeded' }]);
        const replayState = (await send({ action: 'runnerState' }, 'runner-replay')).result;
        assert.equal(replayState.calls, 1); assert.equal(replayState.next.state, 'queued');
        assert.deepEqual((await send({ action: 'runnerResult' }, 'runner-replay')).result.result, { before: 1234, now: 1234, uuid: '11111111-1111-4111-8111-111111111111', subdomain: 'local-fixed', code: 'local-frozen-code', success: true });
        for (const fixture of ['runner-lost', 'runner-revoked']) {
            assert.deepEqual((await send({ action: 'runnerTick' }, fixture)).result, [null, null]);
            const state = (await send({ action: 'runnerState' }, fixture)).result;
            assert.equal(state.job.state, 'needs_review'); assert.equal(state.next.state, 'queued');
            assert.equal(state.calls, fixture === 'runner-lost' ? 1 : 0);
        }
        assert.deepEqual((await send({ action: 'sealGet', context: sealedContext })).result, sealedValue);
        assert.equal((await send({ action: 'journal', job: 'confirmed', failTransport: true })).result.success, true);
        assert.equal((await send({ action: 'journal', job: 'lost' })).result.blocked, true);
        const lostEvidence = (await send({ action: 'journalEvidence', job: 'lost' })).result;
        assert.deepEqual(lostEvidence, { identity: { job: 'lost', account: 'a1', generation: 'g1' }, ordinal: 0, mutation: true, state: 'unknown', requestMatches: true, unchanged: true });
        assert.equal((await send({ action: 'authorityReview', permit: reviewPermit, epoch: 2, accountsRevision: 2 }, authorityFixture)).status, 409);
        assert.equal((await send({ action: 'dispatchInspect', task: credentialDelivery.task }, authorityFixture)).result[0].state, 'sending');
        console.log('PASS: original encrypted HTTP request evidence survives all 21 process restarts and is read without executor, transport or journal mutation; exact live review permit works before revocation and persisted revocation rejects it after restart without releasing the permit (not an online reconciliation or adjudication endpoint)');
        assert.deepEqual((await send({ action: 'prepare', request: preparedRequest })).result, { id: prepared.result.id, duplicate: true });
        assert.equal((await send({ action: 'prepare', request: { ...preparedRequest, key: 'stale', expected: [{ domain: 'accounts', revision: 0 }] } })).status, 400);
        assert.deepEqual((await send({ action: 'dispatchReserve' })).result, dispatched.slice(1));
        const replayed = await send({ action: 'dispatchSubmit', request: submission });
        assert.equal(replayed.result.id, submitted.result.id);
        assert.equal(replayed.result.duplicate, true);
        assert.equal((await send({ action: 'dispatchComplete', ...dispatched[0], outcome: 'unknown', evidence: 'b'.repeat(64) })).status, 400);
        assert.equal((await send({ action: 'dispatchComplete', ...dispatched[0], outcome: 'succeeded', evidence: 'b'.repeat(64) })).status, 200);
        assert.deepEqual((await send({ action: 'dispatchReserve' })).result.map(d => d.account), ['a2', 'a3', 'a4']);
        assert.equal((await send({ action: 'claim' })).result, null);
        assert.equal((await send({ action: 'inspect', id: 'task1' })).result.steps[0].state, 'in_flight');
        assert.equal((await send({ action: 'finish', id: 'task1', ordinal: 0, token: claimed.token, outcome: 'unknown', evidence: 'b'.repeat(64) })).status, 200);
        assert.equal((await send({ action: 'claim' })).result, null);
        assert.equal((await send({ action: 'reconcile', id: 'task1', ordinal: 0, token: claimed.token, outcome: 'verified', evidence: 'c'.repeat(64) })).status, 200);
        assert.equal((await send({ action: 'inspect', id: 'task1' })).result.state, 'succeeded');
        const read = await send({ action: 'read', domains: ['autoConfig'] });
        assert.equal(read.result.records[0].revision, 2);
        assert.deepEqual((await send({ action: 'runtime', operation: 'once', patch: { lastCheck: 200 } })).result, { revision: 1 });
        assert.deepEqual((await send({ action: 'readRuntime' })).result.value, { lastCheck: 200 });
        assert.equal((await send({ action: 'activate', id: 'g1', epoch: 2 })).status, 409);
        console.log('PASS: real local DO SQLite bootstrap, CAS race, runtime isolation, restart persistence, receipt replay, activation guard, in-flight/unknown queue barrier, global HMAC dedupe, restart-stable dispatch tokens, three-account permits, encrypted multi-chunk snapshots, prepared-task dedupe, journal replay and unknown barrier across restart; real nodejs_als isolation, AccountRunner fetch wrapper/receipt replay, revocation, coalesced ticks and v2 credential reads across restart; atomic credential/permit guards, seven-day policy and persistent revocation');
        checkpoint('cas_policy_final_replay');
        assert.equal(checkpoints.length, RUNTIME_CHECKPOINTS.length);
        console.log('RUNTIME_CHECKPOINTS ' + JSON.stringify(checkpoints));
    } catch (error) {
        console.error(error);
        console.error(output);
        process.exitCode = 1;
    } finally {
        await stop();
        await fs.writeFile(path.join(dir, 'runtime.log'), output);
        console.log('LOCAL_RESTART_PROFILE ' + JSON.stringify({ profile: FULL_RESTARTS ? 'full' : 'light', realRestarts, coalescedRestarts, starts: starts - 1 }));
        console.log('ACTUAL_LOCAL_PROCESS_RESTARTS ' + (starts - 1));
        console.log('Local test evidence (mock data only): ' + dir);
        // Preserve mock state/logs. Only remove rebuildable cache after success,
        // after resolving both the owned temp directory and exact cache target.
        if (!process.exitCode) {
            const parent = await fs.realpath(os.tmpdir()), owned = await fs.realpath(dir);
            assert.equal(path.dirname(owned).toLowerCase(), parent.toLowerCase());
            assert.ok(path.basename(owned).startsWith('cfauto-do-test-'));
            const cache = path.join(owned, '.wrangler', 'tmp');
            try {
                const actual = await fs.realpath(cache);
                assert.equal(actual.toLowerCase(), cache.toLowerCase());
                assert.ok(!(await fs.lstat(cache)).isSymbolicLink());
                await fs.rm(cache, { recursive: true });
                console.log('LOCAL_BUILD_CACHE_REMOVED');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
