import {expandBusinessSources} from '../../src/reliability/shared-source';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { ConfigStore } from '../../src/reliability/config-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { TaskPreparation } from '../../src/reliability/task-preparation';
import { SealedStore } from '../../src/reliability/sealed-store';
import { BusinessPlanner } from '../../src/reliability/business-planner';
import { ApplicationPlanner } from '../../src/reliability/application-intent';
import { BusinessEffects } from '../../src/reliability/business-effects';
import { RetainedCustomSource } from '../../src/reliability/retained-custom-source';
import { DeploymentLedger } from '../../src/reliability/deployment-ledger';
import { validateDeploymentPlans } from '../../src/reliability/deployment-plan';
import { migrateCredentialAccounts } from '../../src/reliability/credential-accounts';
import { artifactIdentity } from '../../src/reliability/source-artifact';
import { AuthorityArchive } from '../../src/reliability/authority-archive';
import { archiveGenerationSource } from '../../src/reliability/archive-generation-source';
import { CredentialAuthority } from '../../src/reliability/credential-authority';
import { GenerationImport } from '../../src/reliability/generation-import';
import { prepareGenerationData, completeGenerationDomains } from '../../src/reliability/generation-data';
import { manifestDigest } from '../../src/reliability/protocol';
const opened: ReturnType<typeof sqliteFixture>[]=[];
const a='a'.repeat(32),b='b'.repeat(32),sha='c'.repeat(40),other='d'.repeat(40),oldSha='e'.repeat(40);
const ring={currentId:'local',keys:{local:'local-test-key-material-never-production'}};
const manual=(source:any={kind:'upstream',ref:'latest'})=>({kind:'manual_deploy',template:'cmliu',source,variables:[{key:'UUID',value:'private-variable'}],deletedVariables:[],echTokenEnabled:false,echDisableWorkersDev:false});
async function fixture() {
    const f=sqliteFixture();opened.push(f);const config=new ConfigStore(f.db),dispatch=new TaskDispatch(f.db,new Uint8Array(32).fill(4)),effects=new BusinessEffects(f.db),ledger=new DeploymentLedger(f.db);
    const accounts=await migrateCredentialAccounts([{accountId:a,alias:'one',email:'',globalKey:'',apiToken:'private-token',workers_cmliu:['one']},{accountId:b,alias:'two',email:'',globalKey:'',apiToken:'private-token',workers_cmliu:['two']}],ring,'plaintext');
    const records:any[]=[{domain:'accounts',revision:1,value:accounts},{domain:'deploy:cmliu',revision:1,value:{mode:'latest',currentSha:oldSha,deployTime:'old-time'}},{domain:'vars:cmliu',revision:1,value:[]}];
    config.beginImport('g1',await manifestDigest(records),records.length);records.forEach(r=>config.stage('g1',r));await config.activateInitial('g1',0);config.setMaintenance(false,1);
    let remote=sha;
    const transport=vi.fn(async(url:any)=>String(url).includes('api.github.com')?Response.json({sha:String(url).endsWith('/main')?remote:String(url).split('/').pop()}):new Response('export default { fetch(){return new Response("local-only")}};'));
    const business=new BusinessPlanner(config,{ring,protected:{workers:[],namespaces:[]},source:{transport}, customSource:new RetainedCustomSource(f.db,new SealedStore(f.db,ring))}),application=new ApplicationPlanner(config,business);
    const prep=new TaskPreparation(config,new SealedStore(f.db,ring),dispatch,new Uint8Array(32).fill(4));
    const plan=async(key='once',selected:string[]|null=null,source:any={kind:'upstream',ref:'latest'})=>application.prepare('manager',{key,operation:{kind:'manual',action:manual(source),accounts:selected}} as any);
    const submit=async(input:any)=>({input,...await prep.submit(input)});
    const activate=(task:string)=>dispatch.reserve().filter(d=>d.task===task).map(d=>{dispatch.acknowledge(d.task,d.account,d.token);return d;});
    const permit=(task:any,account:string)=>{
        const row=f.db.rows<any>('SELECT * FROM dispatch_outbox WHERE task=? AND account=?',task.id,account)[0];
        return {task:task.id,account,token:row.token,snapshot:row.snapshot,generation:'g1',credentialRevision:1};
    };
    const facts=(task:any,account:string,states:string[])=>{
        const stored=task.input.targets.find((t:any)=>t.account===account).operation.operation,operation=expandBusinessSources(stored);
        const result=operation.commands.map((c:any,ordinal:number)=>{
            const state=states[ordinal]??'verified';let value:any=null;
            if (state==='failed') value={kind:c.kind,code:'PROVIDER_REJECTED'};
            if (state==='verified') value=c.kind==='manual_upload'?{kind:c.kind,worker:c.worker,source:artifactIdentity(c.artifact),scriptVerified:true,bindingsVerified:true}:c.kind==='upload'?{kind:c.kind,worker:c.worker,commit:c.artifact.commit,scriptVerified:true,bindingsAccepted:true}:c.kind==='repair_worker'?{kind:c.kind,worker:c.worker,commit:c.artifact.commit,scriptVerified:true,bindingsVerified:true,domainsVerified:true,subdomainVerified:true}:['create_worker','replace_worker'].includes(c.kind)?{kind:c.kind,worker:c.worker,commit:c.artifact.commit,scriptVerified:true,bindingsAccepted:true,bindingsVerified:true,namespace:''}:{kind:c.kind,confirmed:true,...('worker' in c?{worker:c.worker}:{})};
            return {ordinal,kind:c.kind,state,evidence:state==='skipped'?null:'f'.repeat(64),result:value};
        });
        effects.apply(permit(task,account),stored,result);return result;
    };
    const finish=(task:any,account:string,states:string[]=[])=>{
        const applied=facts(task,account,states);
        const verified=applied.some((x:any)=>x.state==='verified'),failed=applied.some((x:any)=>x.state==='failed');
        const outcome=applied.every((x:any)=>x.state==='verified')?'succeeded':failed?verified?'partial_failed':'failed':verified?'partial_cancelled':'cancelled';
        effects.assertComplete(task.id,account,applied.length,outcome);dispatch.complete(task.id,account,permit(task,account).token,outcome,'f'.repeat(64));
    };
    const put=(domain:string,value:any)=>config.compareAndSet('g1',[{domain,expectedRevision:config.read([domain]).records[0].revision,value}]);
    const value=(domain='deploy:cmliu')=>config.read([domain]).records[0].value as any;
    return {...f,config,dispatch,effects,ledger,business,prep,plan,submit,activate,permit,facts,finish,put,value,transport,setRemote:(s:string)=>{remote=s;}};
}
afterEach(()=>{vi.restoreAllMocks();opened.splice(0).forEach(f=>f.sql.close());});
describe('durable deployment version/target ledger',()=>{
    it('freezes full scope only for an unrestricted manual intent and validates every source/step',async()=>{
        const f=await fixture(),full=await f.plan();
        expect(full.deployment).toMatchObject([{scope:'full',mode:'latest',sha,customSha:null,targets:[{account:a,worker:'one',steps:[0]},{account:b,worker:'two',steps:[0]}]}]);
        expect((await f.plan('subset',[a,b])).deployment?.[0].scope).toBe('partial');
        expect((await f.business.prepare('manager',{key:'native',targets:[{account:a,actions:[{kind:'upload',template:'cmliu',worker:'one',ref:'latest',overrides:'apply',echTokenEnabled:false}]}]})).deployment?.[0].scope).toBe('partial');
    });
    it('records source/target facts but advances only after every target terminal receipt',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);
        f.finish(task,a);expect(f.value().currentSha).toBe(oldSha);expect(f.value('deployJournal')).toBe(null);
        f.finish(task,b);expect(f.value()).toMatchObject({mode:'latest',currentSha:sha,pendingTargets:[],lastTaskId:task.id});expect(f.value().deployTime).not.toBe('old-time');
        expect(f.ledger.inspectTask(task.id)).toMatchObject([{status:'succeeded',result:{advanced:true}}]);
        expect(f.value('deployJournal')).toHaveLength(1);expect(f.value('deployJournal')[0]).toMatchObject({taskId:task.id,accounts:2,total:2,sha});
    });
    it('reconstruction/repeated admission and completion cannot append logs or advance revisions twice',async()=>{
        const f=await fixture(),input=await f.plan(),task=await f.submit(input);expect(await f.prep.submit(input)).toMatchObject({id:task.id,duplicate:true});f.activate(task.id);f.finish(task,a);f.finish(task,b);
        const before=f.config.readAll();const dispatch=new TaskDispatch(f.db,new Uint8Array(32).fill(4));const p=f.permit(task,b);dispatch.complete(task.id,b,p.token,'succeeded','f'.repeat(64));
        expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM deployment_runs')).toHaveLength(1);expect(f.value('deployJournal')).toHaveLength(1);
    });
    it('full failures preserve deployed SHA and record only unresolved current targets',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);f.finish(task,b,['failed']);
        expect(f.value()).toMatchObject({mode:'latest',currentSha:oldSha,deployTime:'old-time',pendingSha:sha,pendingTargets:[b+'::two']});expect(f.ledger.inspectTask(task.id)).toMatchObject([{status:'partial_failed',result:{advanced:false}}]);
    });
    it('partial success cannot advance mode, SHA, source identity or deployment time',async()=>{
        const f=await fixture();f.put('deploy:cmliu',{mode:'fixed',currentSha:oldSha,sourceIdentity:'',deployTime:'old',pendingTargets:[b+'::two']});const task=await f.submit(await f.plan('partial',[a]));f.activate(task.id);f.finish(task,a);
        expect(f.value()).toMatchObject({mode:'fixed',currentSha:oldSha,sourceIdentity:'',deployTime:'old',pendingTargets:[b+'::two']});expect(f.ledger.inspectTask(task.id)).toMatchObject([{scope:'partial',result:{advanced:false}}]);
    });
    it('does not clear pending targets with a successful deployment of the wrong source version',async()=>{
        const f=await fixture();f.put('deploy:cmliu',{mode:'latest',currentSha:oldSha,pendingSha:other,pendingTargets:[a+'::one',b+'::two']});const task=await f.submit(await f.plan('wrong-version',[a]));f.activate(task.id);f.finish(task,a);
        expect(f.value().pendingTargets).toEqual([a+'::one',b+'::two']);f.setRemote(other);
        const retry=await f.submit(await f.plan('right-version',[a]));f.activate(retry.id);f.finish(retry,a);expect(f.value().pendingTargets).toEqual([b+'::two']);expect(f.value().currentSha).toBe(oldSha);
    });
    it('does not clear a pending source-selection change merely because a commit matches',async()=>{
        const f=await fixture();f.put('deploy:cmliu',{mode:'latest',currentSha:oldSha,pendingSha:sha,pendingSourceIdentity:JSON.stringify({path:'other.js',branch:'next'}),pendingTargets:[a+'::one']});const task=await f.submit(await f.plan('wrong-path',[a]));f.activate(task.id);f.finish(task,a);expect(f.value().pendingTargets).toEqual([a+'::one']);
    });
    it('adds failed subset targets without replacing unrelated pending retries',async()=>{
        const f=await fixture();f.put('deploy:cmliu',{mode:'latest',currentSha:oldSha,pendingSha:oldSha,pendingTargets:[b+'::two']});const task=await f.submit(await f.plan('partial-failure',[a]));f.activate(task.id);f.finish(task,a,['failed']);expect(f.value().pendingTargets).toEqual([a+'::one',b+'::two']);
    });
    it('unknown progress blocks finalization and retains the permit without claiming failure or success',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.facts(task,a,['unknown']);f.finish(task,b);
        expect(f.ledger.inspectTask(task.id)).toMatchObject([{status:'needs_review',finished:null}]);expect(f.value().currentSha).toBe(oldSha);expect(f.value('deployJournal')).toBe(null);
        const p=f.permit(task,a);expect(()=>f.dispatch.complete(task.id,a,p.token,'failed','f'.repeat(64))).toThrow(/^CONFLICT$/);expect(f.dispatch.inspect(task.id).find(t=>t.account===a)?.state).toBe('accepted');
    });
    it('a late old full task cannot overwrite a newer full intent',async()=>{
        const f=await fixture(),first=await f.submit(await f.plan('older'));f.activate(first.id);f.finish(first,a);
        f.setRemote(other);const second=await f.submit(await f.plan('newer'));f.activate(second.id);f.finish(second,a);
        f.finish(first,b);expect(f.value().currentSha).toBe(oldSha);expect(f.ledger.inspectTask(first.id)).toMatchObject([{result:{advanced:false,superseded:true,currentSource:false}}]);
        f.activate(second.id);f.finish(second,b);expect(f.value().currentSha).toBe(other);expect(f.value('deployJournal')).toHaveLength(2);
    });
    it('new registry targets prevent an obsolete full coverage claim and remain pending',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);
        const current=f.value('accounts');current[0].workers_cmliu.push('new-worker');f.put('accounts',current);f.finish(task,b);
        expect(f.value()).toMatchObject({currentSha:oldSha,pendingSha:sha,pendingTargets:[a+'::new-worker']});expect(f.ledger.inspectTask(task.id)).toMatchObject([{result:{advanced:false,coversCurrent:false}}]);
    });
    it('a newer subset with a different source also invalidates a full source claim',async()=>{
        const f=await fixture(),full=await f.submit(await f.plan('full'));f.activate(full.id);f.finish(full,a);
        f.setRemote(other);const partial=await f.submit(await f.plan('partial',[a]));f.activate(partial.id);f.finish(partial,a);f.finish(full,b);
        expect(f.value()).toMatchObject({currentSha:oldSha,pendingSha:sha,pendingTargets:[a+'::one']});expect(f.ledger.inspectTask(full.id)).toMatchObject([{result:{advanced:false,currentSource:false}}]);
    });
    it('retains deployed mode and SHA if a full task was entirely cancelled',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan('cancel',null,{kind:'upstream',ref:other}));f.activate(task.id);f.finish(task,a,['skipped']);f.finish(task,b,['skipped']);
        expect(f.value()).toEqual({mode:'latest',currentSha:oldSha,deployTime:'old-time'});expect(f.value('deployJournal')[0].summary).toContain('cancelled');
    });
    it('distinguishes partial cancellation from provider failure in durable history',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan('partial-cancel'));f.activate(task.id);f.finish(task,a);f.finish(task,b,['skipped']);
        expect(f.ledger.inspectTask(task.id)).toMatchObject([{status:'partial_cancelled',result:{advanced:false}}]);expect(f.value('deployJournal')[0].summary).toContain('partial_cancelled');expect(f.value().currentSha).toBe(oldSha);
    });
    it('custom source success is fixed mode with its own digest and never an invented upstream SHA',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan('custom',null,{kind:'custom',code:'export default {fetch(){return new Response("custom")}}'}));f.activate(task.id);f.finish(task,a);f.finish(task,b);
        expect(f.value()).toMatchObject({mode:'fixed',currentSha:null,currentCustomSha:task.input.deployment[0].customSha});expect(f.value('deployJournal')[0]).toMatchObject({sha:null,customSha:task.input.deployment[0].customSha});
    });
    it('custom pending retries preserve null upstream SHA and clear only the matching custom artifact',async()=>{
        const f=await fixture(),source={kind:'custom',code:'export default {fetch(){return new Response("custom retry")}}'};
        const task=await f.submit(await f.plan('custom-failed',null,source));f.activate(task.id);f.finish(task,a);f.finish(task,b,['failed']);
        expect(f.value()).toMatchObject({currentSha:oldSha,pendingSha:null,pendingCustomSha:task.input.deployment[0].customSha,pendingTargets:[b+'::two']});
        const wrong=await f.submit(await f.plan('custom-wrong',[b],{kind:'custom',code:'export default {};'}));f.activate(wrong.id);f.finish(wrong,b);expect(f.value().pendingTargets).toEqual([b+'::two']);expect(f.value().pendingSha).toBe(null);
        const retry=await f.submit(await f.plan('custom-retry',[b],source));f.activate(retry.id);f.finish(retry,b);expect(f.value()).toMatchObject({currentSha:oldSha,pendingSha:null,pendingTargets:[],pendingCustomSha:task.input.deployment[0].customSha});
    });
    it('unknown journal projection errors roll back permit release and all config revisions',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);f.facts(task,b,[]);const before=f.config.readAll();
        f.sql.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON config_records WHEN NEW.domain='deployJournal' BEGIN SELECT RAISE(ABORT,'test journal fail'); END");
        const p=f.permit(task,b);expect(()=>f.dispatch.complete(task.id,b,p.token,'succeeded','f'.repeat(64))).toThrow('test journal fail');expect(f.config.readAll()).toEqual(before);expect(f.dispatch.inspect(task.id).find(t=>t.account===b)?.state).toBe('accepted');
        f.sql.exec('DROP TRIGGER fail_journal');f.dispatch.complete(task.id,b,p.token,'succeeded','f'.repeat(64));expect(f.value().currentSha).toBe(sha);expect(f.value('deployJournal')).toHaveLength(1);
    });
    it('rolls back a task and its config changes when ledger registration fails',async()=>{
        const f=await fixture();f.put('override:cmliu:'+a,[{key:'UUID',value:'retained'}]);const input=await f.plan();const before=f.config.readAll();
        f.sql.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON deployment_runs BEGIN SELECT RAISE(ABORT,'test registration fail'); END");
        await expect(f.prep.submit(input)).rejects.toThrow('test registration fail');expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);expect(f.db.rows('SELECT * FROM deployment_runs')).toEqual([]);
        expect(f.db.rows('SELECT * FROM sealed_objects').length).toBeGreaterThan(0);
    });
    it('does not write credential/variable/source bytes to ledger or journal tables',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);f.finish(task,b);
        const value=JSON.stringify([f.db.rows('SELECT * FROM deployment_runs'),f.db.rows('SELECT * FROM deployment_target_versions'),f.value('deployJournal')]);expect(value).not.toMatch(/private-token|private-variable|local-only|v2:/);
    });
    it('rejects missing/tampered ledger metadata before acceptance',async()=>{
        const f=await fixture(),input=await f.plan();
        const mutations=[(p:any)=>delete p.deployment,(p:any)=>{p.deployment[0].sha=other;},(p:any)=>{p.deployment[0].targets[0].steps=[99];},(p:any)=>{p.deployment[0].targets.pop();},(p:any)=>{p.deployment[0].sourceIdentity=JSON.stringify({path:'other.js',branch:'main'});}];
        for (const [i,mutate] of mutations.entries()) {const copy=structuredClone(input);copy.key='tamper-'+i;mutate(copy);await expect(f.prep.submit(copy)).rejects.toThrow(/^INVALID$/);}
        expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
    });
    it('rejects a forged full flag over a subset in the registration transaction',async()=>{
        const f=await fixture(),input=await f.plan('forged',[a]);input.deployment![0].scope='full';await expect(f.prep.submit(input)).rejects.toThrow(/^CONFLICT$/);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
    });
    it('keeps mixed source commands separate and never describes them as one full deployment',async()=>{
        const f=await fixture();const input=await f.business.prepare('manager',{key:'mixed',targets:[{account:a,actions:[{kind:'upload',template:'cmliu',worker:'one',ref:'latest',overrides:'apply',echTokenEnabled:false}]},{account:b,actions:[{kind:'upload',template:'cmliu',worker:'two',ref:other,overrides:'apply',echTokenEnabled:false}]}]});
        expect(input.deployment).toHaveLength(2);const task=await f.submit(input);f.activate(task.id);f.finish(task,a);f.finish(task,b);expect(f.value().currentSha).toBe(oldSha);expect(f.value('deployJournal')).toHaveLength(2);expect((f.ledger.inspectTask(task.id) as any[]).every(r=>r.scope==='partial')).toBe(true);
    });
    it('retains only history when an upstream edit races an accepted full task',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);const before=f.value();
        f.put('upstream:cmliu',{path:'owner/new-repo/main.js',branch:'main'});f.finish(task,b);
        expect(f.value()).toEqual(before);expect(f.ledger.inspectTask(task.id)).toMatchObject([{status:'succeeded',result:{advanced:false,sourceChanged:true}}]);expect(f.value('deployJournal')[0].summary).toContain('source_changed');
    });
    it('does not revive an old source after an edit and reversion at a newer revision',async()=>{
        const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);const before=f.value();
        f.put('upstream:cmliu',{path:'owner/new-repo/main.js',branch:'main'});f.put('upstream:cmliu',null);f.finish(task,a);f.finish(task,b);expect(f.value()).toEqual(before);
        expect(f.ledger.inspectTask(task.id)).toMatchObject([{result:{sourceChanged:true,advanced:false}}]);
    });
    it('an old partial failure cannot add pending targets to a newer full intent',async()=>{
        const f=await fixture(),partial=await f.submit(await f.plan('old-partial',[a]));f.activate(partial.id);
        f.setRemote(other);const full=await f.submit(await f.plan('new-full'));f.activate(full.id);f.finish(full,b);const before=f.value();
        f.finish(partial,a,['failed']);expect(f.value()).toEqual(before);expect(f.ledger.inspectTask(partial.id)).toMatchObject([{result:{superseded:true}}]);
    });
    it('a partial completion cannot modify pending state after an upstream edit',async()=>{
        const f=await fixture(),partial=await f.submit(await f.plan('old-partial',[a]));f.activate(partial.id);const before=f.value();
        f.put('upstream:cmliu',{path:'owner/new-repo/main.js',branch:'main'});f.finish(partial,a,['failed']);expect(f.value()).toEqual(before);
    });
    it('bounds the compatibility journal without deleting retained audit runs',async()=>{
        const f=await fixture();f.put('deployJournal',Array.from({length:100},(_,i)=>({time:'legacy',type:'cmliu',sha:oldSha,accounts:0,total:1,summary:'old-'+i})));const task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);f.finish(task,b);expect(f.value('deployJournal')).toHaveLength(100);expect(f.value('deployJournal')[0].taskId).toBe(task.id);expect(f.db.rows('SELECT * FROM deployment_runs')).toHaveLength(1);
    });
    it('refuses unknown or invalid deployment metadata shapes',()=>{
        for (const input of [{},[{}],[{template:'__proto__'}]]) expect(()=>validateDeploymentPlans(input)).toThrow();
    });
});

describe('retained custom source for fixed fuse',()=>{
    const code='export default {fetch(){return new Response("private custom source")}};';
    async function deployed() {
        const f=await fixture(), task=await f.submit(await f.plan('custom-full',null,{kind:'custom',code}));
        f.activate(task.id);f.finish(task,a);f.finish(task,b);f.transport.mockClear();return {f,task};
    }
    const fuse=(f:any)=>f.business.prepare('manager',{key:'custom-fuse',targets:[{account:a,actions:[{kind:'fuse',template:'cmliu',echTokenEnabled:false}]}]});
    it('reuses verified encrypted custom bytes without any upstream request or invented SHA',async()=>{
        const {f}=await deployed(),p=await fuse(f),c=(p.targets[0].operation as any).operation.commands[0];
        expect(c).toMatchObject({kind:'manual_upload',artifact:{kind:'custom',code},deletedVariables:[]});
        expect(c.artifact).not.toHaveProperty('commit');expect(f.transport).not.toHaveBeenCalled();
        expect(p.deployment).toMatchObject([{scope:'partial',mode:'fixed',sha:null,customSha:f.value().currentCustomSha}]);
        expect(c.variables.find((v:any)=>v.key==='UUID').value).toBe((p.changes![0].value as any)[0].value);
        expect(f.db.rows('SELECT * FROM retained_source_references')).toHaveLength(1);
        expect(JSON.stringify(f.db.rows('SELECT * FROM retained_source_references'))).not.toContain(code);
        await f.prep.submit(p);
    });
    it('fails closed for migrated custom configuration without a verified retained artifact',async()=>{
        const f=await fixture();f.put('deploy:cmliu',{mode:'fixed',currentSha:null,currentCustomSha:'a'.repeat(64),currentDigest:'a'.repeat(64),sourceIdentity:''});
        await expect(fuse(f)).rejects.toThrow('NOT_READY');expect(f.transport).not.toHaveBeenCalled();
    });
    it.each(['digest','missing','ciphertext','generation','unfinished'])('rejects %s mismatch without a network fallback',async(kind)=>{
        const {f,task}=await deployed();
        if(kind==='digest')f.put('deploy:cmliu',{...f.value(),currentDigest:'f'.repeat(64)});
        if(kind==='missing')f.db.rows('DELETE FROM sealed_objects WHERE id=(SELECT snapshot FROM dispatch_outbox WHERE task=? AND account=?)',task.id,a);
        if(kind==='ciphertext')f.db.rows("UPDATE sealed_chunks SET ciphertext='corrupt' WHERE id=(SELECT snapshot FROM dispatch_outbox WHERE task=? AND account=?)",task.id,a);
        if(kind==='generation')f.db.rows("UPDATE deployment_runs SET generation='other' WHERE task=?",task.id);
        if(kind==='unfinished')f.db.rows("UPDATE deployment_runs SET finished=NULL,status='running' WHERE task=?",task.id);
        await expect(fuse(f)).rejects.toThrow();expect(f.transport).not.toHaveBeenCalled();
    });
    it('rechecks deployment CAS after decrypting retained source',async()=>{
        const {f}=await deployed();const original=SealedStore.prototype.get;
        vi.spyOn(SealedStore.prototype,'get').mockImplementation(async function(this:SealedStore,context){const value=await original.call(this,context);f.put('deploy:cmliu',{...f.value(),note:'newer-user-edit'});return value;});
        await expect(fuse(f)).rejects.toThrow('CONFLICT');expect(f.transport).not.toHaveBeenCalled();
    });

    it('rejects management workers in custom fuse before admission',async()=>{
        const {f}=await deployed();
        const planner=new BusinessPlanner(f.config,{ring,protected:{workers:[{account:a,worker:'one'}],namespaces:[]},customSource:new RetainedCustomSource(f.db,new SealedStore(f.db,ring)),source:{transport:f.transport}});
        await expect(planner.prepare('manager',{key:'protected',targets:[{account:a,actions:[{kind:'fuse',template:'cmliu',echTokenEnabled:false}]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
});

// Cross-component contract: use real ledger output, not a hand-written deploy record.
it('exports completed official ledger state as a complete strict generation source',async()=>{const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);f.finish(task,b);const source={schema:1,records:completeGenerationDomains(f.config.readAll().records),runtime:{revision:0,value:{}},credentialPolicy:{observationUntil:0,revocations:[]}};const prepared=await prepareGenerationData(source,ring,{credentials:'strict_v2'});expect(prepared.records.find(r=>r.domain==='deploy:cmliu')!.value).toEqual(f.value());});
it('uses the public account::worker contract for failed targets read by Cron and config views',async()=>{const f=await fixture(),task=await f.submit(await f.plan());f.activate(task.id);f.finish(task,a);f.finish(task,b,['failed']);expect(f.value().pendingTargets).toEqual([b+'::two']);expect(f.value('deployJournal')[0].failed).toEqual([b+'::two']);});

it('recovers fixed custom bytes from a verified archived full deployment without restoring old tasks',async()=>{const f=await fixture(),code='export default {fetch(){return new Response("archived custom")}}',task=await f.submit(await f.plan('archive-custom',null,{kind:'custom',code}));f.activate(task.id);f.finish(task,a);f.finish(task,b);f.config.setMaintenance(true,2);const authority=new CredentialAuthority(f.db,f.config,f.dispatch,ring);await authority.initialize('g1',3);const sealed=new SealedStore(f.db,ring),archive=new AuthorityArchive(f.db,sealed,'manager',{role:'global'});await archive.create('backup1','g1',3);const source=await archiveGenerationSource(archive,'backup1');const prepared=await prepareGenerationData(source.data,ring,{credentials:'strict_v2',resolveCustom:source.resolveCustom});expect(prepared.customSources).toMatchObject([{artifact:{kind:'custom',code},provenance:{generation:'g1',account:a,task:task.id,keyId:'local'}}]);const before=f.db.rows('SELECT * FROM dispatch_outbox');const imports=new GenerationImport(f.db,f.config,sealed,ring,new Uint8Array(32).fill(8),id=>archiveGenerationSource(archive,id));await imports.begin({id:'move',target:'g2',source:'backup1',baseGeneration:'g1',epoch:3,credentials:'strict_v2'});await imports.resume('move',20);expect((await imports.verified('move')).data.customSources).toEqual(prepared.customSources);expect(f.db.rows('SELECT * FROM dispatch_outbox')).toEqual(before);expect(f.config.status().generation).toBe('g1');});
it.each(['unfinished','partial','damaged'])('refuses unverified archived fixed custom source: %s',async reason=>{const f=await fixture(),code='export default {fetch(){return new Response("archived custom")}}',task=await f.submit(await f.plan('archive-custom',null,{kind:'custom',code}));f.activate(task.id);f.finish(task,a);f.finish(task,b);f.config.setMaintenance(true,2);const authority=new CredentialAuthority(f.db,f.config,f.dispatch,ring);await authority.initialize('g1',3);if(reason==='unfinished')f.db.rows('UPDATE deployment_runs SET finished=NULL');if(reason==='partial')f.db.rows("UPDATE deployment_runs SET scope='partial'");if(reason==='damaged')f.db.rows("UPDATE sealed_chunks SET ciphertext='AAAA'");const archive=new AuthorityArchive(f.db,new SealedStore(f.db,ring),'manager',{role:'global'});await archive.create('backup1','g1',3);const source=await archiveGenerationSource(archive,'backup1');await expect(prepareGenerationData(source.data,ring,{credentials:'strict_v2',resolveCustom:source.resolveCustom})).rejects.toThrow(reason==='damaged'?'INVALID':'NOT_READY');expect(f.config.status().generation).toBe('g1');});


it('retains and archives a pooled large custom source with complete verified lineage',async()=>{
 const f=await fixture(),code='/*'+'x'.repeat(70000)+'*/export default {};';const accounts=f.value('accounts');accounts[0].workers_cmliu.push('extra');f.put('accounts',accounts);
 const plan=await f.plan('pooled-custom',null,{kind:'custom',code});expect((plan.targets[0].operation as any).operation.schema).toBe(2);
 const task=await f.submit(plan);f.activate(task.id);f.finish(task,a);f.finish(task,b);const sealed=new SealedStore(f.db,ring);
 const retained=await new RetainedCustomSource(f.db,sealed).load('g1','cmliu',f.value().currentCustomSha);expect(retained.code).toBe(code);expect(f.transport).not.toHaveBeenCalled();
 f.config.setMaintenance(true,2);await new CredentialAuthority(f.db,f.config,f.dispatch,ring).initialize('g1',3);const archive=new AuthorityArchive(f.db,sealed,'manager',{role:'global'});await archive.create('pooled_archive','g1',3);
 const source=await archiveGenerationSource(archive,'pooled_archive'),prepared=await prepareGenerationData(source.data,ring,{credentials:'strict_v2',resolveCustom:source.resolveCustom});expect(prepared.customSources[0].artifact.code).toBe(code);
});
