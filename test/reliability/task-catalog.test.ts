import {afterEach,describe,it,expect,vi} from 'vitest';
import {sqliteFixture} from './sqlite-fixture';
import {ConfigStore} from '../../src/reliability/config-store';
import {BusinessAdmission} from '../../src/reliability/business-admission';
import {BusinessEffects} from '../../src/reliability/business-effects';
import {TaskDispatch} from '../../src/reliability/task-dispatch';
import {TaskCatalog} from '../../src/reliability/task-catalog';
import {SealedStore} from '../../src/reliability/sealed-store';
const opened:ReturnType<typeof sqliteFixture>[]=[];
async function fixture(){const f=sqliteFixture();opened.push(f);const secret=new Uint8Array(32).fill(7),config=new ConfigStore(f.db),dispatch=new TaskDispatch(f.db,secret),sealed=new SealedStore(f.db,{currentId:'test',keys:{test:'task-catalog-test-material-not-production'}});new BusinessEffects(f.db);f.db.rows('CREATE TABLE automation_lanes (cycle TEXT,template TEXT,state TEXT,task TEXT,notice TEXT)');const admission=new BusinessAdmission(f.db,config,sealed,dispatch,{prepare:async()=>{throw new Error('not a catalog operation');}},async()=>{throw new Error('not a catalog operation');},secret),make=()=>new TaskCatalog(f.db,dispatch,admission,secret);let n=0;const submit=async(scope='manager',automation=false)=>{const key='task-'+(++n),task=await dispatch.submit({scope,key,targets:[{account:'a'.repeat(32),snapshot:'private_snapshot_'+key,steps:['upload']}]});if(automation)f.db.rows('INSERT INTO automation_lanes VALUES (?,?,?,?,NULL)','cycle_'+key,'cmliu','running',task.id);else f.db.rows('INSERT INTO business_admissions VALUES (?,?,?,?,?,?,NULL)',key,'receipt_'+key,'private_digest',await admission.ownerForCatalog(scope),'g1',task.id);return task.id;};return {...f,dispatch,make,submit,admission};}
afterEach(()=>opened.splice(0).forEach(f=>f.sql.close()));
describe('installation task catalog',()=>{
 it('lists and inspects manual and Cron tasks under one authenticated owner without leaking receipts or snapshots',async()=>{const f=await fixture(),manual=await f.submit(),cron=await f.submit('automation',true),other=await f.submit('other'),list:any=await f.make().list('manager',{limit:20,cursor:null});expect(list.items.map((i:any)=>i.id)).toEqual([cron,manual]);expect(JSON.stringify(list)).not.toMatch(/private_snapshot|private_digest|receipt_|token/);expect((await f.make().inspect('manager',cron) as any).trigger).toBe('automation');await expect(f.make().inspect('other',cron)).rejects.toThrow('NOT_READY');await expect(f.make().inspect('manager',other)).rejects.toThrow('NOT_READY');});
 it('pages by signed global task sequence across restarts and scope isolation',async()=>{const f=await fixture();for(let i=0;i<4;i++)await f.submit(i===1?'automation':'manager',i===1);const one:any=await f.make().list('manager',{limit:2,cursor:null}),two:any=await f.make().list('manager',{limit:2,cursor:one.cursor});expect(one.cursor).toMatch(/^v2./);expect(two.cursor).toBeNull();expect(new Set([...one.items,...two.items].map(i=>i.id)).size).toBe(4);await expect(f.make().list('other',{limit:2,cursor:one.cursor})).rejects.toThrow();await expect(f.make().list('manager',{limit:2,cursor:one.cursor.slice(0,-1)+'z'})).rejects.toThrow();});
 it('shows durable unknown and retains the dispatch permit; no wake or write is performed by reads',async()=>{const f=await fixture(),id=await f.submit(),delivery=f.dispatch.reserve()[0];f.dispatch.acknowledge(id,delivery.account,delivery.token);f.db.rows('INSERT INTO business_step_state VALUES (?,?,0,?)',id,delivery.account,'unknown');const view:any=await f.make().inspect('manager',id);expect(view).toMatchObject({state:'needs_review',terminal:false});expect(view.targets[0].state).toBe('accepted');expect(f.dispatch.inspect(id)[0].state).toBe('accepted');});
 it('a verified fact is not terminal task success and only whitelisted result fields are exposed',async()=>{const f=await fixture(),id=await f.submit(),account='a'.repeat(32);f.db.rows('INSERT INTO business_step_state VALUES (?,?,0,?)',id,account,'verified');f.db.rows('INSERT INTO business_facts(task,account,ordinal,state,payload) VALUES (?,?,0,?,?)',id,account,'verified',JSON.stringify({result:{worker:'one',scriptVerified:true,provider:'private-provider-body',apiToken:'private-api-token'}}));const view:any=await f.make().inspect('manager',id);expect(view.terminal).toBe(false);expect(view.state).toBe('queued');expect(view.targets[0].steps[0].result).toEqual({worker:'one',scriptVerified:true});expect(JSON.stringify(view)).not.toContain('private-');});
 it.each([{limit:0,cursor:null},{limit:51,cursor:null},{limit:1,cursor:'not-signed'},{limit:1,cursor:null,scope:'other'}])('rejects malformed list request %j',async input=>{const f=await fixture();await expect(f.make().list('manager',input)).rejects.toThrow('INVALID');});
});

it('keeps successful task and unknown webhook separate, retaining the notification barrier across reconstruction',async()=>{const f=await fixture(),id=await f.submit('automation',true),d=f.dispatch.reserve()[0];f.dispatch.complete(id,d.account,d.token,'succeeded','a'.repeat(64));f.db.rows("UPDATE automation_lanes SET state='notification_unknown',notice='private_notice' WHERE task=?",id);const view:any=await f.make().inspect('manager',id);expect(view).toMatchObject({state:'succeeded',terminal:true,notification:'unknown'});expect(JSON.stringify(view)).not.toContain('private_notice');});

it('projects operator-attested failure explicitly without exposing private evidence or provider bytes',async()=>{const f=await fixture(),id=await f.submit(),account='a'.repeat(32);f.db.rows('INSERT INTO business_step_state VALUES (?,?,0,?)',id,account,'failed');f.db.rows('INSERT INTO business_facts(task,account,ordinal,state,payload) VALUES (?,?,0,?,?)',id,account,'failed',JSON.stringify({result:{kind:'upload',code:'OPERATOR_CLOSED_UNCONFIRMED',adjudication:'decision_1',document:'private-document',permit:'private-permit',provider:'private-response'}}));const view:any=await f.make().inspect('manager',id);expect(view.humanSettlements).toBe(1);expect(view.targets[0].steps[0].result).toEqual({code:'OPERATOR_CLOSED_UNCONFIRMED',adjudication:'decision_1',settlement:'operator_attested',machineVerified:false,externalSuccessClaimed:false});expect(JSON.stringify(view)).not.toContain('private-document');expect(JSON.stringify(view)).not.toContain('private-permit');expect(JSON.stringify(view)).not.toContain('private-response');});

it('distinguishes unsupported configured notification from unconfigured on successful tasks',async()=>{const f=await fixture(),id=await f.submit('automation',true),d=f.dispatch.reserve()[0];f.dispatch.complete(id,d.account,d.token,'succeeded','a'.repeat(64));f.db.rows("UPDATE automation_lanes SET state='notification_unsupported' WHERE task=?",id);const view:any=await f.make().inspect('manager',id);expect(view).toMatchObject({state:'succeeded',terminal:true,notification:'unsupported'});expect(JSON.stringify(view)).not.toContain('private_');expect((await f.make().inspect('manager',id) as any).notification).toBe('unsupported');});

it.each(['failed','partial_failed','cancelled','partial_cancelled'])('marks terminal %s automation notifications as not sent rather than pending',async outcome=>{const f=await fixture(),id=await f.submit('automation',true),d=f.dispatch.reserve()[0];f.dispatch.complete(id,d.account,d.token,outcome as any,'a'.repeat(64));const view:any=await f.make().inspect('manager',id);expect(view.terminal).toBe(true);expect(view.notification).toBe('not_sent');expect(f.dispatch.inspect(id)[0].outcome).toBe(outcome);});


it.each(['partial_failed','partial_cancelled'] as const)('preserves terminal %s receipts even when no per-step projection is available', async outcome => {
 const f=await fixture(),id=await f.submit(),delivery=f.dispatch.reserve()[0];
 f.dispatch.complete(id,delivery.account,delivery.token,outcome,'a'.repeat(64));
 expect(await f.make().inspect('manager',id)).toMatchObject({state:outcome,terminal:true});
});

it('bounds task-list SQL work independently of the number of accounts and steps, without schema writes', async () => {
 const f=await fixture(),owner=await f.admission.ownerForCatalog('manager');
 for(let i=0;i<2;i++) {
  const task=await f.dispatch.submit({scope:'manager',key:'large_'+i,targets:[1,2,3,4].map(n=>({account:String(n).repeat(32),snapshot:'snapshot_'+i+'_'+n,steps:Array(40).fill('upload')}))});
  f.db.rows('INSERT INTO business_admissions VALUES (?,?,?,?,?,?,NULL)','large_'+i,'receipt_large_'+i,'digest',owner,'g1',task.id);
 }
 const catalog=f.make(),queries=vi.spyOn(f.db,'rows');
 try {
  const page:any=await catalog.list('manager',{limit:1,cursor:null});
  const sql=queries.mock.calls.map(([query])=>query);
  console.info('TASK_CATALOG_SQL',JSON.stringify({statements:sql.length,schemaStatements:sql.filter(q=>/^CREATE /i.test(q)).length,returnedTasks:page.items.length,steps:page.items[0].targets.reduce((n:any,t:any)=>n+t.steps.length,0)}));
  expect(page.items).toHaveLength(1);expect(page.cursor).not.toBeNull();expect(page.items[0].targets).toHaveLength(4);
  expect(page.items[0].targets.every((t:any)=>t.steps.length===40&&t.steps.every((s:any)=>s.state==='pending'))).toBe(true);
  expect(sql.filter(q=>/^CREATE |^INSERT |^UPDATE |^DELETE /i.test(q))).toEqual([]);
  expect(sql.length).toBeLessThanOrEqual(12);
 } finally { queries.mockRestore(); }
});

it('projects the current fact after unknown is resolved, keeping other accounts and tasks isolated', async () => {
 const f=await fixture(),id=await f.submit(),other=await f.submit(),account='a'.repeat(32);
 f.db.rows('INSERT INTO business_step_state VALUES (?,?,0,?)',id,account,'failed');
 for(const [task,state,result] of [[id,'unknown',null],[id,'failed',{code:'PROVIDER_REJECTED'}],[other,'verified',{worker:'other-task',scriptVerified:true}]] as const) {
  f.db.rows('INSERT INTO business_facts(task,account,ordinal,state,payload) VALUES (?,?,0,?,?)',task,account,state,JSON.stringify({result}));
 }
 const page:any=await f.make().list('manager',{limit:20,cursor:null});
 expect(page.items.find((t:any)=>t.id===id).targets[0].steps[0]).toMatchObject({state:'failed',result:{code:'PROVIDER_REJECTED'}});
 expect(page.items.find((t:any)=>t.id===other).targets[0].steps[0]).toMatchObject({state:'pending',result:null});
});
