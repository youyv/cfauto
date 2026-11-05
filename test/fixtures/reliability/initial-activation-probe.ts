/** LOOPBACK TEST ONLY. Local fake proof is never a production drain certificate. */
import {type ConfigStore,type SqlDatabase} from '../../../src/reliability/config-store';
import {GenerationImport} from '../../../src/reliability/generation-import';
import {InitialGenerationActivation,type InitialCutoverBinding} from '../../../src/reliability/initial-generation-activation';
import {SealedStore} from '../../../src/reliability/sealed-store';
import {completeGenerationDomains} from '../../../src/reliability/generation-data';
import {canonical,ReliabilityError} from '../../../src/reliability/protocol';
export async function initialActivationProbe(db:SqlDatabase,config:ConfigStore,body:any):Promise<unknown>{
 const ring={currentId:'new',keys:{new:'local-test-only-new-credential-secret'}},sealed=new SealedStore(db,ring);
 const data={schema:1 as const,records:completeGenerationDomains([{domain:'accounts',revision:1,value:[{accountId:'a'.repeat(32),alias:'local-initial',email:'',apiToken:'local-only-token',globalKey:'',authMode:'token',workers_cmliu:['local-one']}]}]),runtime:{revision:1,value:{lastCheck:10,lastGc:20}},credentialPolicy:{observationUntil:0,revocations:[]}};
 const imports=new GenerationImport(db,config,sealed,ring,new Uint8Array(32).fill(9),async()=>({identity:'a'.repeat(64),data,blockers:{},migrationReady:false}),()=>1000);
 db.rows('CREATE TABLE IF NOT EXISTS local_initial_proof (id TEXT PRIMARY KEY,binding TEXT,state TEXT)');
 const proofs={verify:async(id:string,binding:InitialCutoverBinding)=>{const row=db.rows<{state:string;binding:string|null}>('SELECT * FROM local_initial_proof WHERE id=?',id)[0];if(row?.state!=='ready'||row.binding!==null&&row.binding!==canonical(binding))throw new ReliabilityError('CONFLICT',409);db.rows('UPDATE local_initial_proof SET binding=? WHERE id=?',canonical(binding),id);return {digest:'b'.repeat(64)};},consumeInTransaction:(id:string,binding:InitialCutoverBinding,digest:string)=>{const row=db.rows<{state:string;binding:string}>('SELECT * FROM local_initial_proof WHERE id=?',id)[0];if(row?.state!=='ready'||row.binding!==canonical(binding)||digest!=='b'.repeat(64))throw new ReliabilityError('CONFLICT',409);db.rows("UPDATE local_initial_proof SET state='consumed' WHERE id=?",id);}};
 const activation=new InitialGenerationActivation(db,config,imports,proofs,()=>2000),request={id:'first',importId:'initial-import',proofId:'initial-proof',epoch:0};
 if(body.action==='initialPrepare'){db.rows("INSERT OR IGNORE INTO local_initial_proof VALUES ('initial-proof',NULL,'ready')");await imports.begin({id:'initial-import',target:'initial-g1',source:'local-backup',baseGeneration:null,epoch:0,credentials:'migrate',unprefixed:'plaintext'});return imports.resume('initial-import',100);}
 if(body.action==='initialActivate')return activation.activate(request,body.auditFault?()=>{throw new ReliabilityError('NOT_READY',503);}:undefined);
 return {status:config.status(),heads:db.rows('SELECT * FROM authority_heads'),runtime:db.rows('SELECT domain,revision,payload FROM runtime_records'),policy:db.rows('SELECT * FROM credential_policy'),proof:db.rows('SELECT id,state FROM local_initial_proof'),imports:imports.inspect('initial-import'),outbox:db.rows<{n:number}>('SELECT COUNT(*) AS n FROM config_outbox')[0].n};
}
