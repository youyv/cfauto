import {afterEach,describe,expect,it,vi} from 'vitest';
import {UnknownObservation,type ObservationRequest} from '../../src/reliability/unknown-observation';
import {ExecutionJournal} from '../../src/reliability/execution-journal';
import {SealedStore} from '../../src/reliability/sealed-store';
import {AccountQueue} from '../../src/reliability/account-queue';
import {canonical} from '../../src/reliability/protocol';
import {sqliteFixture} from './sqlite-fixture';
const opened:ReturnType<typeof sqliteFixture>[]=[];
const account='a'.repeat(32), secret='only-local-evidence-secret-32-bytes', ring={currentId:'local',keys:{local:'only-local-sealed-secret-32-bytes'}};
const base='https://api.cloudflare.com/client/v4/accounts/'+account;
async function fixture(path='/workers/scripts/demo',method='PUT'){
 const f=sqliteFixture();opened.push(f);const sealed=new SealedStore(f.db,ring),queue=new AccountQueue(f.db);
 queue.enqueue('task1','d'.repeat(64),'snapshot1',['upload']);const step=queue.claim()!;
 const permit={task:'task1',account,generation:'g1',snapshot:'snapshot1',token:'permit1',credentialRevision:1};
 f.db.rows('CREATE TABLE coordinator_inbox (task TEXT PRIMARY KEY,delivery TEXT NOT NULL)');
 f.db.rows('INSERT INTO coordinator_inbox VALUES (?,?)','task1',canonical({...permit,digest:'d'.repeat(64),steps:['upload']}));
 const journal=new ExecutionJournal(f.db,sealed,{job:'task1_0',account,generation:'g1'},{digestSecret:secret,authorizeMutation:async()=>{},transport:async()=>{throw new Error('lost');}});
 await expect(journal.request(base+path,{method,headers:{Authorization:'Bearer private-token'},body:'private-intent'})).rejects.toThrow();
 queue.finish(step.job,step.ordinal,step.token,'unknown','e'.repeat(64));
 const request:ObservationRequest={id:'review1',operator:'operator1',permit,epoch:2,accountsRevision:1,step:0,call:0};
 const authorize=vi.fn(async()=>{}),transport=vi.fn(async()=>Response.json({success:true,result:{private:'private-response'}}));
 let executing=false;const make=()=>new UnknownObservation(f.db,sealed,account,{digestSecret:secret,authorize,transport,isExecuting:()=>executing});
 return {...f,sealed,queue,step,request,authorize,transport,make,setExecuting:(v:boolean)=>{executing=v;}};
}
afterEach(()=>{for(const f of opened.splice(0))f.sql.close();vi.restoreAllMocks();});
describe('unknown fixed GET observations, not adjudication',()=>{
 it('binds immutable evidence and only sends fixed GETs without settling unknown',async()=>{
  const f=await fixture(),before=f.queue.inspect('task1');const result=await f.make().capture(f.request);
  expect(result).toMatchObject({id:'review1',task:'task1',step:0,call:0,state:'observed',possibleInFlight:true,settled:false});
  expect(f.transport.mock.calls.map(c=>c[0])).toEqual([base+'/workers/scripts/demo',base+'/workers/scripts/demo/bindings',base+'/workers/scripts/demo/subdomain']);
  for(const [,init] of f.transport.mock.calls as any){expect(init.method).toBe('GET');expect(init.body).toBeUndefined();expect(init.redirect).toBe('manual');expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-token');}
  expect(f.queue.inspect('task1')).toEqual(before);expect(f.db.rows('SELECT state FROM execution_calls')).toEqual([{state:'unknown'}]);
  expect(JSON.stringify(result)).not.toMatch(/private-token|private-intent|private-response/);
  expect(JSON.stringify(f.db.rows('SELECT * FROM unknown_observations'))).not.toMatch(/private-token|private-intent|private-response/);
  const replay=await f.make().capture(f.request);expect(replay).toEqual(result);expect(f.transport).toHaveBeenCalledTimes(3);
 });
 it('rejects changed intent, step, permit, operator and generation rather than rebinding evidence',async()=>{
  const f=await fixture();await f.make().capture(f.request);
  for(const patch of [{operator:'other'},{call:1},{step:1},{epoch:3},{accountsRevision:2}])await expect(f.make().capture({...f.request,...patch})).rejects.toThrow();
  for(const patch of [{account:'b'.repeat(32)},{task:'other'},{token:'other'},{snapshot:'other'},{generation:'other'},{credentialRevision:2}])await expect(f.make().capture({...f.request,permit:{...f.request.permit,...patch}})).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(3);
 });
 it('refuses a running executor and never observes a non-unknown step',async()=>{
  const f=await fixture();f.setExecuting(true);await expect(f.make().capture(f.request)).rejects.toThrow(/^CONFLICT$/);f.setExecuting(false);
  f.db.rows("UPDATE account_steps SET state='in_flight'");await expect(f.make().capture(f.request)).rejects.toThrow(/^CONFLICT$/);expect(f.transport).not.toHaveBeenCalled();
 });
 it('checks current authorization before every GET and before evidence publication',async()=>{
  const f=await fixture();f.transport.mockImplementationOnce(async()=>{f.authorize.mockRejectedValue(new Error('revoked'));return Response.json({success:true,result:{}});});
  await expect(f.make().capture(f.request)).rejects.toThrow();expect(f.transport).toHaveBeenCalledTimes(1);expect(f.queue.inspect('task1').state).toBe('needs_review');
  expect(f.db.rows('SELECT state FROM unknown_observations')[0].state).not.toBe('complete');
 });
 it('rejects current authorization even when replaying an old observation receipt',async()=>{
  const f=await fixture();await f.make().capture(f.request);f.authorize.mockRejectedValue(new Error('revoked'));await expect(f.make().capture(f.request)).rejects.toThrow();expect(f.transport).toHaveBeenCalledTimes(3);
 });
 it('does not hide changed step evidence across asynchronous authorization',async()=>{
  const f=await fixture();f.authorize.mockImplementationOnce(async()=>{f.db.rows("UPDATE account_steps SET evidence=?",'f'.repeat(64));});await expect(f.make().capture(f.request)).rejects.toThrow(/^CONFLICT$/);expect(f.transport).not.toHaveBeenCalled();
 });
 it.each(['/workers/scripts/demo?force=true','/workers/scripts/demo/secrets','/storage/kv/namespaces/'+ 'b'.repeat(32) +'/bulk'])('fails closed for unsupported original mutation target %s',async path=>{
  const f=await fixture(path);await expect(f.make().capture(f.request)).rejects.toThrow(/^INVALID$/);expect(f.transport).not.toHaveBeenCalled();
 });
 it('does not treat a 403, 404 or redirected response as deletion proof',async()=>{
  for(const status of [403,404,302]){const f=await fixture('/workers/scripts/demo','DELETE');f.transport.mockImplementation(async()=>new Response('private-response',{status,headers:{Location:'https://other.test'}}));const result=await f.make().capture(f.request) as any;expect(result.reads.every((r:any)=>r.resourceState==='unconfirmed')).toBe(true);expect(result.settled).toBe(false);}
 });
 it('records known Worker absence only for the precise 404+10007 contract, without settling',async()=>{
  const f=await fixture('/workers/scripts/demo','DELETE');f.transport.mockImplementation(async()=>Response.json({success:false,errors:[{code:10007}]},{status:404}));const result=await f.make().capture(f.request) as any;expect(result.reads[0].resourceState).toBe('absent');expect(result.possibleInFlight).toBe(true);expect(result.settled).toBe(false);
 });
 it('keeps list observations explicitly incomplete instead of claiming full namespace inventory',async()=>{
  const f=await fixture('/storage/kv/namespaces','POST');const result=await f.make().capture(f.request) as any;expect(result.reads[0].completeInventory).toBe(false);expect(f.transport.mock.calls[0][0]).toBe(base+'/storage/kv/namespaces?page=1&per_page=100');
 });
 it('rejects a sealed-evidence persistence failure without creating a completed observation',async()=>{
  const f=await fixture();vi.spyOn(f.sealed,'put').mockRejectedValueOnce(new Error('storage'));await expect(f.make().capture(f.request)).rejects.toThrow();expect(f.db.rows('SELECT state FROM unknown_observations')[0].state).not.toBe('complete');expect(f.queue.inspect('task1').state).toBe('needs_review');
 });
 it('bounds uncooperative transport and response bodies while preserving the unknown task',async()=>{
  for(const body of [false,true]){const f=await fixture();f.transport.mockImplementation(async()=>body?new Response(new ReadableStream({cancel:()=>new Promise(()=>{})})):await new Promise<Response>(()=>{}));const service=new UnknownObservation(f.db,f.sealed,account,{digestSecret:secret,authorize:f.authorize,transport:f.transport,isExecuting:()=>false,timeoutMs:10});await expect(service.capture(f.request)).rejects.toThrow(/^NOT_READY$/);expect(f.queue.inspect('task1').state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(1);}
 });
 it('strictly paginates collections without inventing completeness for duplicate or drifting pages',async()=>{
  for(const corrupt of [false,true]){const f=await fixture('/storage/kv/namespaces','POST');f.transport.mockImplementation(async(url:string)=>{const page=Number(new URL(url).searchParams.get('page'));return Response.json({success:true,result:page===1?Array.from({length:100},(_,i)=>({id:String(i)})):[{id:corrupt?'0':'100'}],result_info:{page,per_page:100,total_count:101,total_pages:2}});});const result=await f.make().capture(f.request) as any;expect(result.reads).toHaveLength(2);expect(result.reads[1].completeInventory).toBe(!corrupt);expect(result.settled).toBe(false);}
 });
 it('rejects corrupted sealed replay and retains partial observations without silently issuing new GETs',async()=>{
  const f=await fixture();await f.make().capture(f.request);f.db.rows("UPDATE sealed_chunks SET ciphertext='AAAA' WHERE id=?",'observation_review1');await expect(f.make().capture(f.request)).rejects.toThrow();expect(f.transport).toHaveBeenCalledTimes(3);
  const g=await fixture();g.transport.mockRejectedValueOnce(new Error('offline'));await expect(g.make().capture(g.request)).rejects.toThrow();await expect(g.make().capture(g.request)).rejects.toThrow();expect(g.transport).toHaveBeenCalledTimes(1);
 });
 it('coalesces a concurrent stable intent but rejects another operator using its ID',async()=>{
  const f=await fixture(),service=f.make();const first=service.capture(f.request),second=service.capture(f.request);await expect(service.capture({...f.request,operator:'other'})).rejects.toThrow(/^CONFLICT$/);expect(await first).toEqual(await second);expect(f.transport).toHaveBeenCalledTimes(3);
 });
 it('commits a previously sealed root after a lost local ACK without another GET',async()=>{
  const f=await fixture(),rows=f.db.rows.bind(f.db);let fail=true;vi.spyOn(f.db,'rows').mockImplementation((query,...params)=>{if(fail&&query.startsWith("UPDATE unknown_observations SET state='complete'")){fail=false;throw new Error('lost local commit');}return rows(query,...params);});await expect(f.make().capture(f.request)).rejects.toThrow();expect(f.db.rows('SELECT state FROM unknown_observations')[0].state).toBe('pending');expect((await f.make().capture(f.request) as any).state).toBe('observed');expect(f.transport).toHaveBeenCalledTimes(3);
 });

});
