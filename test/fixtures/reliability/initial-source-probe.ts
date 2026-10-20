import {productionConfig} from '../../../src/reliability/production-config';
import {readCredentialAccounts} from '../../../src/reliability/credential-accounts';
/** LOOPBACK TEST FIXTURE ONLY. Never export from a production entry or deploy. */
import {ProductionCoordinator} from '../../../src/reliability/production-coordinator';
import type {ReliabilityEnv} from '../../../src/reliability/production-config';
import {GLOBAL_OBJECT_NAME} from '../../../src/reliability/coordinator-rpc';
import {canonical} from '../../../src/reliability/protocol';
import {signMaintenance,type MaintenanceCommand} from '../../../src/reliability/maintenance-protocol';
export interface InitialProbeEnv extends ReliabilityEnv {LOCAL_HARNESS:string;LOCAL_INITIAL_PRODUCTION:DurableObjectNamespace}
const keys={inspector:'8'.repeat(64),importer:'9'.repeat(64),activator:'a'.repeat(64)};
export class LocalInitialProductionCoordinator extends ProductionCoordinator {
 #local:InitialProbeEnv;#state:DurableObjectState;
 constructor(ctx:DurableObjectState,env:InitialProbeEnv){
  if(env.LOCAL_HARNESS!=='test-only')throw Error('LOCAL_ONLY');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS local_initial_fixture_pin (id INTEGER PRIMARY KEY,pin TEXT NOT NULL)');const saved=ctx.storage.sql.exec('SELECT pin FROM local_initial_fixture_pin WHERE id=1').toArray()[0]?.pin as string|undefined;
  super(ctx,{...env,RELIABILITY_COORDINATOR:env.LOCAL_INITIAL_PRODUCTION,RELIABILITY_MANAGER_WORKER:'local-initial-manager',RELIABILITY_INITIAL_CUTOVER_PIN:saved,RELIABILITY_MAINTENANCE_KEYS:canonical({operators:{inspector:{secret:keys.inspector,permissions:['inspect']},importer:{secret:keys.importer,permissions:['migrate']},activator:{secret:keys.activator,permissions:['activate']}}})});this.#local=env;this.#state=ctx;
 }
 async fetch(request:Request):Promise<Response>{
  const url=new URL(request.url);if(!['/__local_initial_pin','/__local_initial_state'].includes(url.pathname))return super.fetch(request);
  if(this.#local.LOCAL_HARNESS!=='test-only'||!['localhost','127.0.0.1'].includes(url.hostname)||!this.#state.id.equals(this.#local.LOCAL_INITIAL_PRODUCTION.idFromName(GLOBAL_OBJECT_NAME)))return new Response('Forbidden',{status:403});
  if(url.pathname==='/__local_initial_state'){const sql=this.#state.storage.sql,status=sql.exec('SELECT generation,epoch,maintenance FROM config_meta WHERE id=1').toArray()[0],heads=sql.exec('SELECT config_generation,credential_generation,runtime_generation,epoch FROM authority_heads').toArray(),proofs=sql.exec('SELECT state FROM initial_cutover_proofs').toArray(),runtime=sql.exec('SELECT domain,revision,payload FROM runtime_records').toArray();let credentialsVerified=false;if(status?.generation){const row=sql.exec("SELECT payload FROM config_records WHERE generation=? AND domain='accounts'",status.generation as string).toArray()[0];const accounts=await readCredentialAccounts(JSON.parse(row.payload as string),productionConfig(this.env).credentials);credentialsVerified=accounts[0]?.apiToken==='native-local-token';}return Response.json({status,heads,proofs,runtime:runtime.map(r=>({...r,payload:JSON.parse(r.payload as string)})),credentialsVerified});}
  const body=await request.json() as {pin:unknown},pin=canonical(body.pin),old=this.#state.storage.sql.exec('SELECT pin FROM local_initial_fixture_pin WHERE id=1').toArray()[0]?.pin;if(old&&old!==pin)return new Response('Conflict',{status:409});if(!old)this.#state.storage.sql.exec('INSERT INTO local_initial_fixture_pin VALUES (1,?)',pin);return Response.json({localFakeAnchorStored:true,requiresRuntimeRestart:true});
 }
}
export async function initialSourceProbe(request:Request,env:InitialProbeEnv):Promise<Response>{
 if(env.LOCAL_HARNESS!=='test-only'||!['127.0.0.1','localhost'].includes(new URL(request.url).hostname))return new Response('Forbidden',{status:403});const b=await request.json() as {action:string;pin?:unknown;command?:MaintenanceCommand;operator?:keyof typeof keys;loseAck?:boolean};const stub=env.LOCAL_INITIAL_PRODUCTION.get(env.LOCAL_INITIAL_PRODUCTION.idFromName(GLOBAL_OBJECT_NAME));
 if(b.action==='state'){const r=await stub.fetch(new Request('http://127.0.0.1/__local_initial_state',{method:'POST'}));return Response.json({result:{status:r.status,body:await r.json()}});}
 if(b.action==='installPin'){const r=await stub.fetch(new Request('http://127.0.0.1/__local_initial_pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:b.pin})}));return Response.json({result:{status:r.status,body:await r.json()}});}
 const command=b.command;if(b.action!=='command'||!command)return new Response('Invalid',{status:400});const operator=b.operator??'inspector';if(!keys[operator])return new Response('Invalid',{status:400});
 const signed=await signMaintenance({version:1,target:{account:env.RELIABILITY_MANAGER_ACCOUNT,worker:'local-initial-manager',namespace:env.RELIABILITY_CONFIG_NAMESPACE},operator,at:Date.now(),nonce:crypto.randomUUID(),command},keys[operator]);const r=await stub.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(signed)}));const body=await r.json();if(b.loseAck&&r.status===200)return Response.json({error:'LOCAL_LOST_INITIAL_ACK'},{status:500});return Response.json({result:{status:r.status,body}});
}
