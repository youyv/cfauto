import {afterEach,describe,expect,it,vi} from 'vitest';
import {MaintenanceGeneration} from '../../src/reliability/maintenance-generation';
import {MaintenanceService} from '../../src/reliability/maintenance-service';
import {MaintenanceAuthentication,maintenanceConfig,signMaintenance,type MaintenanceCommand,type MaintenanceMessage} from '../../src/reliability/maintenance-protocol';
import {switchFixture,ring} from './authority-switch-fixture';
import {sqliteFixture} from './sqlite-fixture';
import {canonical} from '../../src/reliability/protocol';
const opened:ReturnType<typeof sqliteFixture>[]=[];
const target={account:'a'.repeat(32),worker:'manager',namespace:'b'.repeat(32)},secret='c'.repeat(64);
const message=(command:MaintenanceCommand):MaintenanceMessage=>({version:1,target,operator:'ops',at:2000,nonce:'nonce',command});
async function fixture(){const f=await switchFixture(opened,true);const make=()=>{const generation=new MaintenanceGeneration(f.db,f.config,f.sealed,'local_manager',ring,new Uint8Array(32).fill(8),f.drain,()=>2000);return new MaintenanceService(f.db,f.config,f.drain,()=>2000,undefined,undefined,undefined,undefined,(m,commit)=>generation.execute(m,commit));};const service=make();return {...f,service,make,execute:(c:MaintenanceCommand)=>service.execute(message(c)),expected:()=>({...f.config.status()})};}
afterEach(()=>{vi.restoreAllMocks();opened.splice(0).forEach(f=>f.sql.close());});
describe('independent staged generation maintenance and atomic activation audit',()=>{
 it('imports a retained authority archive without activating, then requires actual drain',async()=>{
  const f=await fixture();await f.archive.create('backup','g1',3);
  await f.execute({id:'prepare',action:'generation_begin',expected:f.expected(),args:{id:'move',target:'g2',source:'backup',credentials:'migrate'}});
  const result=await f.execute({id:'stage',action:'generation_resume',expected:f.expected(),args:{id:'move',limit:100}}) as any;expect(result.state).toBe('verified');expect(f.config.status().generation).toBe('g1');
  const command:MaintenanceCommand={id:'activate',action:'generation_activate',expected:f.expected(),args:{importId:'move',drainId:'drain'}};await expect(f.execute(command)).rejects.toThrow();expect(f.config.status().generation).toBe('g1');await f.certify();const receipt=await f.execute(command) as any;expect(receipt.generation).toBe('g2');expect(receipt.legacyCutover).toBe(false);expect(f.config.status().maintenance).toBe(1);expect(f.db.rows('SELECT state FROM maintenance_receipts WHERE id=?','activate')).toEqual([{state:'complete'}]);
 });
 it('rolls back pointer, runtime, policy, drain and activation when the atomic maintenance ACK write fails',async()=>{
  const f=await fixture();await f.prepare();await f.certify();const command:MaintenanceCommand={id:'atomic',action:'generation_activate',expected:f.expected(),args:{importId:'move',drainId:'drain'}};
  const before=f.config.readAll(),rows=f.db.rows.bind(f.db);let fail=true;vi.spyOn(f.db,'rows').mockImplementation((q,...p)=>{if(fail&&q.startsWith("UPDATE maintenance_receipts SET state='complete'")&&p.at(-1)==='atomic'){fail=false;throw new Error('receipt failure');}return rows(q,...p);});
  await expect(f.execute(command)).rejects.toThrow();expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM generation_activations')).toEqual([]);expect(f.db.rows("SELECT state FROM generation_imports WHERE id='move'")[0].state).toBe('verified');
  expect((await f.make().execute(message(command)) as any).generation).toBe('g2');
 });
 it('replays the original activation after post-commit response failure despite its old expected epoch',async()=>{
  const f=await fixture();await f.prepare();await f.certify();const command:MaintenanceCommand={id:'lost_ack',action:'generation_activate',expected:f.expected(),args:{importId:'move',drainId:'drain'}};
  const rows=f.db.rows.bind(f.db);let fail=true;vi.spyOn(f.db,'rows').mockImplementation((q,...p)=>{if(fail&&q.startsWith("UPDATE maintenance_attempts SET outcome='complete'")){fail=false;throw new Error('ACK lost');}return rows(q,...p);});
  await expect(f.execute(command)).rejects.toThrow();expect(f.config.status().generation).toBe('g2');const before=f.config.readAll(),receipt=await f.make().execute(message(command)) as any;expect(receipt.generation).toBe('g2');expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM generation_activations')).toHaveLength(1);
  await expect(f.make().execute(message({...command,args:{importId:'other',drainId:'drain'}}))).rejects.toThrow('CONFLICT');
 });
 it('requires distinct migrate and activate permissions and rejects raw bypass fields',async()=>{
  const raw=canonical({operators:{ops:{secret,permissions:['migrate']}}}),auth=new MaintenanceAuthentication(maintenanceConfig(raw,[])!,target,()=>2000);
  const cmd:MaintenanceCommand={id:'activate',action:'generation_activate',expected:{generation:'g1',epoch:3,maintenance:1},args:{importId:'move',drainId:'drain'}};
  await expect(auth.verify(await signMaintenance(message(cmd),secret))).rejects.toThrow('INVALID');await expect(signMaintenance(message({...cmd,args:{importId:'move',drainId:'drain',force:true}}),secret)).rejects.toThrow();
 });
});

it('rejects a non-synchronous activation audit hook and rolls back the switch',async()=>{
 const f=await switchFixture(opened,true);await f.prepare();await f.certify();const before=f.config.readAll();
 await expect(f.activation.activate({id:'bad_hook',importId:'move',drainId:'drain'},(()=>true) as any)).rejects.toThrow('INVALID');
 expect(f.config.readAll()).toEqual(before);expect(f.db.rows('SELECT * FROM generation_activations')).toEqual([]);
});
