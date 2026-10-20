/** TEST ONLY: isolated namespace and explicit loopback seed. Never deploy this class. */
import {ProductionCoordinator} from '../../../src/reliability/production-coordinator';
import {productionConfig,type ReliabilityEnv} from '../../../src/reliability/production-config';
import {ConfigStore,type SqlDatabase} from '../../../src/reliability/config-store';
import {TaskDispatch} from '../../../src/reliability/task-dispatch';
import {CredentialAuthority} from '../../../src/reliability/credential-authority';
import {migrateCredentialAccounts} from '../../../src/reliability/credential-accounts';
import {canonical,manifestDigest} from '../../../src/reliability/protocol';
import {CoordinatorRpc,GLOBAL_OBJECT_NAME,accountObjectName} from '../../../src/reliability/coordinator-rpc';
import {signMaintenance,type MaintenanceCommand} from '../../../src/reliability/maintenance-protocol';
export interface AccountArchiveProbeEnv extends ReliabilityEnv {LOCAL_PRODUCTION_ARCHIVE:DurableObjectNamespace;LOCAL_HARNESS:string}
const account='e'.repeat(32),secret='6'.repeat(64);
export class LocalProductionArchiveCoordinator extends ProductionCoordinator {
 #local:AccountArchiveProbeEnv;#state:DurableObjectState;
 constructor(ctx:DurableObjectState,env:AccountArchiveProbeEnv){super(ctx,{...env,RELIABILITY_COORDINATOR:env.LOCAL_PRODUCTION_ARCHIVE,RELIABILITY_MAINTENANCE_KEYS:canonical({operators:{ops:{secret,permissions:['archive','inspect']}}})});this.#local=env;this.#state=ctx;}
 async fetch(request:Request):Promise<Response>{
  if(new URL(request.url).pathname!=='/__local_seed')return super.fetch(request);
  if(this.#local.LOCAL_HARNESS!=='test-only'||!['localhost','127.0.0.1'].includes(new URL(request.url).hostname)||!this.#state.id.equals(this.#local.LOCAL_PRODUCTION_ARCHIVE.idFromName(GLOBAL_OBJECT_NAME)))return new Response('Forbidden',{status:403});
  const db:SqlDatabase={rows:<T extends Record<string,unknown>>(q:string,...p:(string|number|null)[])=>this.#state.storage.sql.exec(q,...p).toArray() as T[],transaction:f=>this.#state.storage.transactionSync(f)},config=new ConfigStore(db);
  if(!config.status().generation){const settings=productionConfig(this.env),dispatch=new TaskDispatch(db,new TextEncoder().encode(settings.idempotencySecret)),authority=new CredentialAuthority(db,config,dispatch,settings.credentials);
   const accounts=await migrateCredentialAccounts([{accountId:account,alias:'local',email:'',apiToken:'local-token-not-production',authMode:'token',workers_cmliu:['local-worker']}],settings.credentials,'plaintext'),record={domain:'accounts',revision:1,value:accounts as any};
   config.beginImport('g1',await manifestDigest([record]),1);config.stage('g1',record);await config.activateInitial('g1',0);await authority.initialize('g1',1);config.setMaintenance(false,1);config.setMaintenance(true,2);
  }
  return Response.json(config.status());
 }
}
export async function accountArchiveProbe(request:Request,env:AccountArchiveProbeEnv):Promise<Response>{
 const body=await request.json() as {action:string},target=(name:string)=>env.LOCAL_PRODUCTION_ARCHIVE.get(env.LOCAL_PRODUCTION_ARCHIVE.idFromName(name));
 if(body.action==='setup'){const r=await target(GLOBAL_OBJECT_NAME).fetch(new Request('http://127.0.0.1/__local_seed',{method:'POST'}));return Response.json({result:{status:r.status,value:await r.json()}});}
 const expected={generation:'g1',epoch:3,maintenance:1};let command:MaintenanceCommand;
 if(body.action==='list')command={id:'local_accounts',action:'archive_accounts',expected:null,args:{after:null,limit:20,digest:null}};
 else if(body.action==='create'||body.action==='createLost'||body.action==='denyRpc')command={id:body.action==='denyRpc'?'forged_account_archive':'local_account_backup',action:'account_archive',expected,args:{account,action:'archive_create',args:{id:'local_account_snapshot'}}};
 else if(body.action==='audit')command={id:'local_account_audit',action:'audit',expected:null,args:{id:'local_account_backup'}};
 else if(body.action==='export')command={id:'local_account_export',action:'account_archive',expected:null,args:{account,action:'archive_export_begin',args:{id:'local_account_transfer',archive:'local_account_snapshot',part:null}}};
 else if(body.action==='frame')command={id:'local_account_frame',action:'account_archive',expected:null,args:{account,action:'archive_export_frame',args:{id:'local_account_transfer',ordinal:0}}};
 else return new Response('Invalid',{status:400});
 const message={version:1 as const,target:{account:env.RELIABILITY_MANAGER_ACCOUNT,worker:env.RELIABILITY_MANAGER_WORKER,namespace:env.RELIABILITY_CONFIG_NAMESPACE},operator:'ops',at:Date.now(),nonce:crypto.randomUUID(),command};
 const r=body.action==='denyRpc'?await target(accountObjectName(account)).fetch(await new CoordinatorRpc(env.RELIABILITY_RPC_SECRET).request('account_archive',account,{message} as any)):await target(GLOBAL_OBJECT_NAME).fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance(message,secret))}));
 const result=await r.json();if(body.action==='createLost'&&r.status===200)return Response.json({error:'local lost archive ACK'},{status:500});return Response.json({result:{status:r.status,body:result}});
}
