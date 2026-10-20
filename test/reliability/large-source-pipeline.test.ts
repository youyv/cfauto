import {afterEach,describe,expect,it,vi} from 'vitest';
import {sqliteFixture} from './sqlite-fixture';
import {ConfigStore} from '../../src/reliability/config-store';
import {migrateCredentialAccounts} from '../../src/reliability/credential-accounts';
import {manifestDigest} from '../../src/reliability/protocol';
import {BusinessPlanner} from '../../src/reliability/business-planner';
import {TaskPreparation} from '../../src/reliability/task-preparation';
import {TaskDispatch} from '../../src/reliability/task-dispatch';
import {SealedStore} from '../../src/reliability/sealed-store';
import {AutomationCycles} from '../../src/reliability/automation-cycle';
import {AutomationPlanner} from '../../src/reliability/automation-planner';
import {AutomationFlow} from '../../src/reliability/automation-flow';
import {WebhookOutbox} from '../../src/reliability/webhook-outbox';
import {AccountQueue} from '../../src/reliability/account-queue';
import {AccountRunner} from '../../src/reliability/account-runner';
import {executeBusinessOperation} from '../../src/reliability/business-executor';
import {loadSourceArtifact} from '../../src/reliability/source-artifact';
const opened:ReturnType<typeof sqliteFixture>[]=[];
const secret='6'.repeat(64),ring={currentId:'test',keys:{test:'5'.repeat(64)}},commit='d'.repeat(40),resources={workers:[],namespaces:[]};
const codeOfSize=(bytes:number)=>{const end='*/export default {};\n';return '/*'+'x'.repeat(bytes-2-end.length)+end;};
function source(code:string){return vi.fn(async(url:string)=>url.startsWith('https://api.github.com/')?Response.json({sha:commit}):new Response(code));}
async function fixture(owners:number,workers:number,code:string,template='cmliu'){
 const f=sqliteFixture();opened.push(f);const config=new ConfigStore(f.db),sealed=new SealedStore(f.db,ring),key=new TextEncoder().encode(secret),dispatch=new TaskDispatch(f.db,key),preparation=new TaskPreparation(config,sealed,dispatch,key);
 const accounts=Array.from({length:owners},(_,i)=>({accountId:(i+1).toString(16).padStart(32,'0'),alias:'large-source-'+i,email:'',globalKey:'',apiToken:'NONFUNCTIONAL_LARGE_SOURCE_TEST',authMode:'token' as const,['workers_'+template]:Array.from({length:workers},(_,n)=>'worker-'+n)}));
 const records=[{domain:'accounts',revision:1,value:await migrateCredentialAccounts(accounts,ring,'plaintext') as any},{domain:'autoConfig',revision:1,value:{enabled:true,interval:1,fuseThreshold:0}}];
 config.beginImport('g1',await manifestDigest(records),records.length);records.forEach(r=>config.stage('g1',r));await config.activateInitial('g1',0);config.setMaintenance(false,1);
 const network=source(code),planner=new BusinessPlanner(config,{ring,protected:resources,source:{transport:network}});return {...f,config,sealed,dispatch,preparation,accounts,network,planner};
}
afterEach(()=>{for(const f of opened.splice(0))f.sql.close();vi.restoreAllMocks();});
describe('current upstream sizes across the complete durable pipeline',()=>{
 it('accepts a bounded source the size of the observed official Joey commit, not only tiny fixtures',async()=>{
  // 2026-10-05 read-only evidence: official byJoey/cfnew source was 1,726,148 bytes.
  // Synthetic comment bytes avoid copying third-party source into the test suite.
  const code=codeOfSize(1726148),network=source(code);
  const artifact=await loadSourceArtifact({template:'joey',selection:{path:'',branch:''},ref:'latest'},{transport:network});
  expect(artifact.code).toBe(code);expect(artifact.commit).toBe(commit);expect(network).toHaveBeenCalledTimes(2);
 });
 it('retains one shared large source across six Workers without dropping targets or exceeding a per-object budget',async()=>{
  const code=codeOfSize(1726148),uploaded='var window = globalThis;\n'+code,f=await fixture(1,6,code,'joey'),account=f.accounts[0];
  const actions=account.workers_joey.map((worker:string)=>({kind:'upload' as const,template:'joey',worker,ref:'latest',overrides:'apply' as const,echTokenEnabled:false}));
  const plan=await f.planner.prepare('manager',{key:'large-shared-source',targets:[{account:account.accountId,actions}]});
  expect(plan.targets[0].steps).toHaveLength(6);const admitted=await f.preparation.submit(plan),delivery=f.dispatch.reserve()[0];expect(delivery.task).toBe(admitted.id);
  const local=sqliteFixture();opened.push(local);const queue=new AccountQueue(local.db),sealed=new SealedStore(local.db,ring);queue.enqueue(admitted.id,delivery.digest,delivery.snapshot,delivery.steps);
  let writes=0;const transport=vi.fn(async(url:string,init:any={})=>{if(init.method==='PUT'){writes++;expect(await init.body.get('script').text()).toBe(uploaded);return Response.json({success:true,result:{}});}if(url.endsWith('/bindings'))return Response.json({success:true,result:[]});return new Response(uploaded);});
  const runner=new AccountRunner(local.db,queue,sealed,{account:account.accountId,generation:'g1',digestSecret:secret,transport,authorize:async()=>{},loadSnapshot:async()=>{const value=await f.sealed.get({id:delivery.snapshot,kind:'task_snapshot',account:account.accountId,generation:'g1'}) as any;return value.operation;},execute:(operation,step)=>executeBusinessOperation(account.accountId,operation,step,resources)});
  for(let i=0;i<6;i++)expect((await runner.tick())?.state).toBe(i===5?'succeeded':'running');
  expect(writes).toBe(6);expect(f.network).toHaveBeenCalledTimes(2);expect(await runner.tick()).toBe(null);expect(writes).toBe(6);
 },60000);
 it('admits a ten-account Cron plan with shared source rather than failing the aggregate decision manifest',async()=>{
  const code=codeOfSize(1726148),f=await fixture(10,1,code),cycles=new AutomationCycles(f.db,f.config,f.sealed);
  const planner=new AutomationPlanner(f.db,f.config,cycles,{ring,protected:resources,source:{transport:f.network}}),now=1800000000000;
  const flow=new AutomationFlow(f.db,f.config,cycles,f.sealed,planner,f.dispatch,new WebhookOutbox(f.db,f.sealed),{submit:(plan,guard)=>f.preparation.submit(plan,guard),arm:async()=>{},now:()=>now});
  const result=await flow.start(now) as any;expect(result.state).toBe('active');expect(result.lanes).toHaveLength(1);expect(result.lanes[0].state).toBe('running');
  expect(f.dispatch.inspect(result.lanes[0].task)).toHaveLength(10);expect(f.network).toHaveBeenCalledTimes(2);
 },60000);
});
