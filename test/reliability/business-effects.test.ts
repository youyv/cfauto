import { TEMPLATES } from '../../src/config/templates';
import { afterEach, describe, expect, it } from 'vitest';
import { BusinessEffects } from '../../src/reliability/business-effects';
import { ConfigStore } from '../../src/reliability/config-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { manifestDigest, sha256 } from '../../src/reliability/protocol';
import { migrateCredentialAccounts, readCredentialAccounts } from '../../src/reliability/credential-accounts';
import { sqliteFixture } from './sqlite-fixture';
const account='a'.repeat(32), other='b'.repeat(32), namespace='c'.repeat(32), commit='d'.repeat(40), evidence='e'.repeat(64);
const ring={currentId:'test',keys:{test:'test-only-at-least-thirty-two-bytes'}};
const open:ReturnType<typeof sqliteFixture>[]=[];
afterEach(()=>open.splice(0).forEach(f=>f.sql.close()));
async function fixture(deleting=false, replacing=false, manual?: 'custom' | 'upstream', repairing=false, removing=false, cleanupKv=false) {
    const f=sqliteFixture();open.push(f);const config=new ConfigStore(f.db),dispatch=new TaskDispatch(f.db,new Uint8Array(32).fill(7)),effects=new BusinessEffects(f.db);
    const accounts=await migrateCredentialAccounts([{accountId:account,alias:'first',email:'',globalKey:'',apiToken:'secret-token',workers_cmliu:['keep','old']},{accountId:other,alias:'second',email:'',globalKey:'',apiToken:'other-secret',workers_cmliu:['other-worker']}],ring,'plaintext');
    const cleanup=Object.keys(TEMPLATES).flatMap(t=>['deploy:'+t,'vars:'+t,'favorites:'+t,'override:'+t+':'+account]).sort().map(domain=>({domain,revision:1}));
    const records=[{domain:'accounts',revision:1,value:accounts as any},...(removing?cleanup.map(row=>({...row,value:row.domain.startsWith('deploy:')?{mode:'fixed',currentSha:commit}:row.domain.startsWith('favorites:')?[commit]:[{key:'UUID',value:'private-value'}]})):[])];config.beginImport('g1',await manifestDigest(records),records.length);for(const row of records)config.stage('g1',row);await config.activateInitial('g1',0);config.setMaintenance(false,1);
    const code='export default {};';
    const command={kind:replacing?'replace_worker':'create_worker',template:'cmliu',worker:'new-worker',artifact:{template:'cmliu',repository:'cmliu/edgetunnel',path:'_worker.js',commit,code,digest:await sha256(code)},variables:[],namespaceTitle:'test',echTokenEnabled:false};
    const manualCommand={kind:'manual_upload',template:'cmliu',worker:'new-worker',artifact:manual==='custom'?{kind:'custom',template:'cmliu',code,digest:await sha256(code)}:command.artifact,variables:[],deletedVariables:[],echTokenEnabled:false};
    const repairCommand={kind:'repair_worker',template:'cmliu',worker:'old',artifact:command.artifact,variables:[],echTokenEnabled:true};
    const commands=removing?[{kind:'remove_worker',worker:'old',namespaces:cleanupKv?[namespace]:null,cleanup},...(cleanupKv?[{kind:'cleanup_kv',worker:'old',namespace}]:[])]:deleting ? [{kind:'delete_worker',template:'cmliu',worker:'old'}] : [repairing?repairCommand:manual?manualCommand:command,{kind:'configure_domain',template:'cmliu',worker:'new-worker',enabled:true,hostname:'',zone:''}];
    const operation={schema:1,account,credential:{email:'',globalKey:'',apiToken:'secret-token',authMode:'token'},commands};
    const task=await dispatch.submit({scope:'test',key:'one',targets:[{account,snapshot:'snap',steps:commands.map(c=>c.kind)}]});const delivery=dispatch.reserve()[0];
    const permit={task:task.id,account,generation:'g1',credentialRevision:1,snapshot:'snap',token:delivery.token};
    const created=()=>({ordinal:0,kind:command.kind,state:'verified',evidence,result:{kind:command.kind,worker:'new-worker',commit,scriptVerified:true,bindingsAccepted:true,namespace,bindingsVerified:true}});
    const failed=()=>({ordinal:1,kind:'configure_domain',state:'failed',evidence,result:{kind:'configure_domain',code:'PROVIDER_REJECTED'}});
    const apply=(facts:any[],p=permit,op=operation)=>effects.apply(p,op as any,facts);
    return {...f,config,dispatch,effects,accounts,permit,created,failed,operation,apply};
}
describe('authoritative external fact commit',()=>{
    it('atomically commits creation to the current encrypted account list and projection outbox',async()=>{
        const f=await fixture();f.apply([f.created()]);const r=f.config.read(['accounts']).records[0];
        expect(r.revision).toBe(2);expect((r.value as any)[0].workers_cmliu).toEqual(['keep','old','new-worker']);expect((r.value as any)[0].apiToken).toBe(f.accounts[0].apiToken);expect((r.value as any)[1]).toEqual(f.accounts[1]);
        expect((await readCredentialAccounts(r.value as any,ring))[0].apiToken).toBe('secret-token');
        expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(1);expect(JSON.stringify(f.db.rows('SELECT * FROM business_facts'))).not.toMatch(/secret-token|other-secret|v2:/);expect(f.config.pendingProjection()).toHaveLength(2);
    });
    it('does not lose a concurrent metadata or another-account Worker update',async()=>{
        const f=await fixture(),value=JSON.parse(JSON.stringify(f.accounts));value[0].alias='edited';value[1].workers_cmliu.push('concurrent-worker');f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value}]);f.apply([f.created()]);
        const rows=f.config.read(['accounts']).records;expect(rows[0].revision).toBe(3);expect((rows[0].value as any)[0].alias).toBe('edited');expect((rows[0].value as any)[1].workers_cmliu).toContain('concurrent-worker');
    });
    it('settles verified writes in maintenance and retains creation even if a later domain step fails',async()=>{
        const f=await fixture();f.config.setMaintenance(true,2);f.apply([f.created(),f.failed()]);expect((f.config.read(['accounts']).records[0].value as any)[0].workers_cmliu).toContain('new-worker');
        f.effects.assertComplete(f.permit.task,account,2,'partial_failed');expect(()=>f.effects.assertComplete(f.permit.task,account,2,'succeeded')).toThrow('CONFLICT');expect(f.config.status().maintenance).toBe(1);
    });
    it('never releases a terminal task before all facts have committed',async()=>{
        const f=await fixture();expect(()=>f.effects.assertComplete(f.permit.task,account,2,'succeeded')).toThrow('CONFLICT');f.apply([f.created()]);expect(()=>f.effects.assertComplete(f.permit.task,account,2,'succeeded')).toThrow('CONFLICT');
    });
    it('deduplicates full progress replay without bumping revision or appending logs again',async()=>{
        const f=await fixture();f.apply([f.created(),f.failed()]);const before=f.config.readAll();new BusinessEffects(f.db).apply(f.permit,f.operation as any,[f.created(),f.failed()]);expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(2);
        f.dispatch.complete(f.permit.task,account,f.permit.token,'partial_failed',evidence);f.apply([f.created(),f.failed()]);expect(f.config.readAll()).toEqual(before);
    });
    it('stores unknown without inventing the Worker, then appends authenticated reconciliation evidence',async()=>{
        const f=await fixture();f.apply([{...f.created(),state:'unknown',result:null}]);expect((f.config.read(['accounts']).records[0].value as any)[0].workers_cmliu).not.toContain('new-worker');f.apply([f.created()]);expect(f.db.rows('SELECT state FROM business_facts ORDER BY seq').map(r=>r.state)).toEqual(['unknown','verified']);expect((f.config.read(['accounts']).records[0].value as any)[0].workers_cmliu).toContain('new-worker');
    });
    it.each([{token:'wrong'},{snapshot:'wrong'},{generation:'old-generation'},{account:other}])('rejects mismatched permit %j',async patch=>{
        const f=await fixture();expect(()=>f.apply([f.created()],{...f.permit,...patch})).toThrow();expect(f.config.read(['accounts']).records[0].revision).toBe(1);expect(f.db.rows('SELECT * FROM business_facts')).toEqual([]);
    });
    it.each([{scriptVerified:false},{bindingsVerified:false},{worker:'someone-else'},{commit:'f'.repeat(40)},{namespace:'../elsewhere'},{token:'secret-in-a-log'}])('rejects forged or secret-bearing fact %j before any commit',async patch=>{
        const f=await fixture(),fact=f.created();Object.assign(fact.result,patch);expect(()=>f.apply([fact])).toThrow('INVALID');expect(f.db.rows('SELECT * FROM business_facts')).toEqual([]);expect(f.config.read(['accounts']).records[0].revision).toBe(1);
    });
    it('rejects changed evidence after terminal state and keeps old receipt and list',async()=>{
        const f=await fixture();f.apply([f.created()]);expect(()=>f.apply([{...f.created(),evidence:'f'.repeat(64)}])).toThrow('CONFLICT');expect(()=>f.apply([{...f.created(),state:'unknown',result:null}])).toThrow('CONFLICT');expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(1);
    });
    it('rolls back the whole progress batch if a later receipt conflicts',async()=>{
        const f=await fixture();f.apply([f.failed()]);expect(()=>f.apply([f.created(),{...f.failed(),evidence:'f'.repeat(64)}])).toThrow('CONFLICT');expect((f.config.read(['accounts']).records[0].value as any)[0].workers_cmliu).not.toContain('new-worker');expect(f.config.pendingProjection()).toHaveLength(1);
    });
    it('will not resurrect an account removed from current authority',async()=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:[f.accounts[1]] as any}]);expect(()=>f.apply([f.created()])).toThrow('CONFLICT');expect(f.config.read(['accounts']).records[0].value).toEqual([f.accounts[1]]);
    });
    it('deletes only the observed Worker from current authority and preserves all credentials',async()=>{
        const f=await fixture(true);f.apply([{ordinal:0,kind:'delete_worker',state:'verified',evidence,result:{kind:'delete_worker',worker:'old',confirmed:true}}]);
        const a=(f.config.read(['accounts']).records[0].value as any)[0];expect(a.workers_cmliu).toEqual(['keep']);expect(a.apiToken).toBe(f.accounts[0].apiToken);
    });
});


describe('replacement fact semantics',()=>{
    it('records replacement evidence without replacing accounts, dropping metadata or adding a duplicate Worker',async()=>{
        const f=await fixture(false,true),before=f.config.readAll();f.apply([f.created(),f.failed()]);
        expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(2);f.effects.assertComplete(f.permit.task,account,2,'partial_failed');
        new BusinessEffects(f.db).apply(f.permit,f.operation as any,[f.created(),f.failed()]);expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(2);
    });
    it.each(['bindingsVerified','namespace','commit'])('rejects invalid replacement proof %s',async field=>{
        const f=await fixture(false,true),fact=f.created();(fact.result as any)[field]=field==='bindingsVerified'?false:field==='namespace'?'':'f'.repeat(40);
        expect(()=>f.apply([fact])).toThrow('INVALID');expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(0);expect(f.config.read(['accounts']).records[0].revision).toBe(1);
    });
});


describe('manual deployment immutable source facts',()=>{
    const fact=async(kind:'custom'|'upstream')=>({ordinal:0,kind:'manual_upload',state:'verified',evidence,result:{kind:'manual_upload',worker:'new-worker',source:{kind,digest:await sha256('export default {};'),...(kind==='upstream'?{commit}:{})},scriptVerified:true,bindingsVerified:true}});
    it.each(['custom','upstream'] as const)('records %s source identity, not source bytes or an invented commit',async kind=>{
        const f=await fixture(false,false,kind),before=f.config.readAll(),proof=await fact(kind);f.apply([proof,f.failed()]);expect(f.config.readAll()).toEqual(before);
        f.effects.assertComplete(f.permit.task,account,2,'partial_failed');f.apply([proof,f.failed()]);expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(2);
        const payload=JSON.stringify(f.db.rows('SELECT * FROM business_facts'));expect(payload).not.toMatch(/export default|secret-token/);if(kind==='custom')expect(payload).not.toContain('commit');
    });
    it.each(['digest','commit','source-code','unverified-bindings','unverified-script'])('rejects forged manual fact %s',async mode=>{
        const f=await fixture(false,false,'custom'),proof:any=await fact('custom');if(mode==='digest')proof.result.source.digest='f'.repeat(64);if(mode==='commit')proof.result.source.commit=commit;if(mode==='source-code')proof.result.source.code='secret';if(mode==='unverified-bindings')proof.result.bindingsVerified=false;if(mode==='unverified-script')proof.result.scriptVerified=false;
        expect(()=>f.apply([proof])).toThrow('INVALID');expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(0);
    });
});


describe('fully verified repair facts',()=>{
    const fact=()=>({ordinal:0,kind:'repair_worker',state:'verified',evidence,result:{kind:'repair_worker',worker:'old',commit,scriptVerified:true,bindingsVerified:true,domainsVerified:true,subdomainVerified:true}});
    it('records verified repair without removing/readding its managed registry or changing credentials',async()=>{
        const f=await fixture(false,false,undefined,true),before=f.config.readAll();f.apply([fact()]);f.apply([fact()]);
        expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(1);
    });
    it.each([{scriptVerified:false},{bindingsVerified:false},{domainsVerified:false},{subdomainVerified:false},{commit:'0'.repeat(40)},{code:'secret-source'}])('rejects partial or dishonest repair evidence %j',async patch=>{
        const f=await fixture(false,false,undefined,true),x=fact();Object.assign(x.result,patch);expect(()=>f.apply([x])).toThrow('INVALID');expect(f.db.rows('SELECT * FROM business_facts')).toHaveLength(0);
    });
});


describe('conditional config cleanup after confirmed resource removal',()=>{
    const fact=()=>({ordinal:0,kind:'remove_worker',state:'verified',evidence,result:{kind:'remove_worker',worker:'old',confirmed:true}});
    const setup=()=>fixture(false,false,undefined,false,true);
    it('removes across template registries but retains config while another worker exists',async()=>{
        const f=await setup(),accounts=structuredClone(f.accounts);accounts[0].workers_joey=['old'];
        f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:accounts as any}]);f.apply([fact()]);
        const current=f.config.read(['accounts']).records[0].value as any;expect(current[0].workers_cmliu).toEqual(['keep']);expect(current[0].workers_joey).toEqual([]);expect(current[0].apiToken).toBe(f.accounts[0].apiToken);
        expect(f.config.read(['vars:cmliu']).records[0].value).toEqual([{key:'UUID',value:'private-value'}]);expect(f.config.read(['vars:joey']).records[0].value).toEqual([]);
    });
    it('resets deployment/vars/favorites/override after the last worker with unchanged revisions',async()=>{
        const f=await setup(),accounts=structuredClone(f.accounts);accounts[0].workers_cmliu=['old'];accounts[1].workers_cmliu=[];
        f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:accounts as any}]);f.apply([fact()]);
        expect(f.config.read(['deploy:cmliu']).records[0].value).toEqual({mode:'latest'});expect(f.config.read(['vars:cmliu','favorites:cmliu']).records.map(r=>r.value)).toEqual([[],[]]);expect(f.config.read(['override:cmliu:'+account]).records[0].value).toBe(null);
        const before=f.config.readAll();f.apply([fact()]);expect(f.config.readAll()).toEqual(before);
    });
    it('never wipes a newer config edit even if the last worker disappears',async()=>{
        const f=await setup(),accounts=structuredClone(f.accounts);accounts[0].workers_cmliu=['old'];accounts[1].workers_cmliu=[];
        f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:accounts as any},{domain:'vars:cmliu',expectedRevision:1,value:[{key:'UUID',value:'new-edit'}]}]);f.apply([fact()]);
        expect(f.config.read(['vars:cmliu']).records[0].value).toEqual([{key:'UUID',value:'new-edit'}]);expect(f.config.read(['vars:cmliu']).records[0].revision).toBe(2);
    });
    it('retains an unrelated account worker added during execution and its shared template config',async()=>{
        const f=await setup(),accounts=structuredClone(f.accounts);accounts[0].workers_cmliu=['old'];accounts[1].workers_cmliu=['concurrent'];
        f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:accounts as any}]);f.apply([fact()]);expect(f.config.read(['vars:cmliu']).records[0].value).not.toEqual([]);expect((f.config.read(['accounts']).records[0].value as any)[1].workers_cmliu).toEqual(['concurrent']);
    });
    it('keeps accounts and config untouched for an unregistered deletion, unknown or failed result',async()=>{
        for(const state of ['unregistered','unknown','failed']){
            const f=await setup();if(state==='unregistered'){const accounts=structuredClone(f.accounts);accounts[0].workers_cmliu=['keep'];f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:accounts as any}]);}
            const before=f.config.readAll();f.apply([{...fact(),...(state==='unknown'?{state,result:null}:state==='failed'?{state,result:{kind:'remove_worker',code:'PROVIDER_REJECTED'}}:{})}]);expect(f.config.readAll()).toEqual(before);
        }
    });
    it.each(['retained_shared','deleted'])('records KV %s distinctly without changing account secrets',async disposition=>{
        const f=await fixture(false,false,undefined,false,true,true);f.apply([fact(),{ordinal:1,kind:'cleanup_kv',state:'verified',evidence,result:{kind:'cleanup_kv',worker:'old',namespace,disposition}}]);
        f.effects.assertComplete(f.permit.task,account,2,'succeeded');expect((f.config.read(['accounts']).records[0].value as any)[0].apiToken).toBe(f.accounts[0].apiToken);expect(JSON.stringify(f.db.rows('SELECT * FROM business_facts'))).toContain(disposition);
    });
    it('does not erase the confirmed Worker deletion when later KV cleanup fails',async()=>{
        const f=await fixture(false,false,undefined,false,true,true);f.apply([fact(),{ordinal:1,kind:'cleanup_kv',state:'failed',evidence,result:{kind:'cleanup_kv',code:'PROVIDER_REJECTED'}}]);
        f.effects.assertComplete(f.permit.task,account,2,'partial_failed');expect((f.config.read(['accounts']).records[0].value as any)[0].workers_cmliu).not.toContain('old');
    });
});
