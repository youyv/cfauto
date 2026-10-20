import {ConfigStore,type SqlDatabase} from './config-store';
import {AuthorityDrain} from './authority-drain';
import {canonical,ReliabilityError,type Json} from './protocol';
import {maintenanceCommand,archiveAction,type MaintenanceMessage} from './maintenance-protocol';
export async function maintenanceIntent(raw:MaintenanceMessage,intentKey?:string):Promise<string>{
 const message=JSON.parse(canonical(raw)) as MaintenanceMessage,command=maintenanceCommand(message.command);let recordedCommand=command;
 if(command.action==='review_attest'){if(!intentKey||intentKey.length<32)throw new ReliabilityError('NOT_READY',503);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(intentKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);const args=command.args as Record<string,Json>,bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonical(['maintenance-attestation-v1',args.reference,args.document]))),digest=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');recordedCommand={...command,args:{...args,reference:'hmac:'+digest,document:'hmac:'+digest}};}
 if(archiveAction(command)==='archive_import_frame'||command.action==='initial_source_frame'){
  if(!intentKey||intentKey.length<32)throw new ReliabilityError('NOT_READY',503);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(intentKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const outer=command.args as Record<string,Json>,args=(command.action==='account_archive'?outer.args:outer) as {id:string;ordinal:number;data:string};
  const mac=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonical(['maintenance-frame-intent-v1',args.data]))),safe={...args,data:'hmac:'+Array.from(new Uint8Array(mac),b=>b.toString(16).padStart(2,'0')).join('')};
  recordedCommand={...command,args:command.action==='account_archive'?{...outer,args:safe}:safe};
 }
 return canonical({target:message.target,operator:message.operator,command:recordedCommand});
}
interface Receipt extends Record<string,unknown>{id:string;operator:string;intent:string;state:string;result:string|null;attempts:number;error:string|null}
/** Called only AFTER independent authentication and global physical-address check.
 * No raw SQL, force-unlock, unknown retry, legacy activation or deletion operation.
 * Audit records contain typed IDs/preconditions, never keys or config/backup values. */
export class MaintenanceService {
 private readonly pending=new Map<string,{intent:string;work:Promise<Json>}>();
 constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly drain:AuthorityDrain,private readonly now:()=>number=Date.now,private readonly observe?: (message:MaintenanceMessage)=>Promise<Json>,private readonly admission?: (message:MaintenanceMessage)=>Promise<Json>,private readonly archival?: (message:MaintenanceMessage)=>Promise<Json>,private readonly intentKey?:string,private readonly generation?:(message:MaintenanceMessage,atomicAck:(receipt:Json)=>void)=>Promise<Json>,private readonly adjudication?:(message:MaintenanceMessage)=>Promise<Json>,private readonly initial?:(message:MaintenanceMessage,atomicAck:(receipt:Json)=>void)=>Promise<Json>){db.rows('CREATE TABLE IF NOT EXISTS maintenance_receipts (id TEXT PRIMARY KEY,operator TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL,result TEXT,attempts INTEGER NOT NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');db.rows('CREATE TABLE IF NOT EXISTS maintenance_attempts (seq INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,operator TEXT NOT NULL,intent TEXT NOT NULL,outcome TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');}
 private row(id:string):Receipt|undefined{return this.db.rows<Receipt>('SELECT * FROM maintenance_receipts WHERE id=?',id)[0];}
 private inspect(id:string):Json {const row=this.row(id);if(!row)throw new ReliabilityError('NOT_READY',503);return {id:row.id,operator:row.operator,intent:JSON.parse(row.intent),state:row.state,attempts:row.attempts,error:row.error,result:row.result===null?null:JSON.parse(row.result)};}
 private status():Json{return {...this.config.status(),scope:'authority_managed_tasks',legacyDrainProven:false,blockers:this.drain.blockers()};}
 private async auditMac(message:MaintenanceMessage,watermark:number,before:number):Promise<string>{
  if(!this.intentKey||this.intentKey.length<32)throw new ReliabilityError('NOT_READY',503);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(this.intentKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);const data=canonical(['cfauto-maintenance-audit-page-v1',message.target,message.operator,watermark,before]);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(data))),b=>b.toString(16).padStart(2,'0')).join('');
 }
 private async listAttempts(message:MaintenanceMessage):Promise<Json>{
  if(!this.intentKey||this.intentKey.length<32)throw new ReliabilityError('NOT_READY',503);
  const args=message.command.args as {limit:number;cursor:string|null};let watermark:number|null=null,before=Number.MAX_SAFE_INTEGER;
  if(args.cursor!==null){const parts=args.cursor.split('.');watermark=Number(parts[1]);before=Number(parts[2]);if(!Number.isSafeInteger(watermark)||!Number.isSafeInteger(before)||before>watermark||parts[3]!==await this.auditMac(message,watermark,before))throw new ReliabilityError('INVALID',400);}
  const snapshot=this.db.transaction(()=>{const maximum=this.db.rows<{n:number}>('SELECT COALESCE(MAX(seq),0) AS n FROM maintenance_attempts')[0].n;const high=watermark??maximum;if(high>maximum)throw new ReliabilityError('CONFLICT',409);const rows=this.db.rows<Record<string,any>>('SELECT seq,command_id,operator,intent,outcome,error,created_at,updated_at FROM maintenance_attempts WHERE seq<=? AND seq<? ORDER BY seq DESC LIMIT ?',high,before,args.limit+1);return {high,rows};});
  const more=snapshot.rows.length>args.limit,rows=snapshot.rows.slice(0,args.limit),items=rows.map(row=>{const intent=JSON.parse(row.intent),action=intent?.command?.action;if(typeof action!=='string'||!['started','complete','rejected'].includes(row.outcome)||(row.error!==null&&!['INVALID','CONFLICT','MAINTENANCE','NOT_READY'].includes(row.error)))throw new ReliabilityError('NOT_READY',503);return {seq:row.seq,command:row.command_id,operator:row.operator,action,outcome:row.outcome,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at};});
  const last=rows.at(-1)?.seq,cursor=more?'a1.'+snapshot.high+'.'+last+'.'+await this.auditMac(message,snapshot.high,last):null;
  return {items,cursor,watermark:snapshot.high,scope:'maintenance_attempts',outcomes:'observed_per_page',snapshotOfExternalExecution:false};
 }
 async execute(raw:MaintenanceMessage):Promise<Json>{
  const command=maintenanceCommand(raw.command),message=JSON.parse(canonical({...raw,command})) as MaintenanceMessage;
  const intent=await maintenanceIntent(message,this.intentKey);
  // Admission evidence commits BEFORE effects. A failed config transaction must
  // not erase who attempted it. No signature, key or unvalidated payload is stored.
  const attempt=this.db.rows<{seq:number}>("INSERT INTO maintenance_attempts (command_id,operator,intent,outcome,error,created_at,updated_at) VALUES (?,?,?,'started',NULL,?,?) RETURNING seq",command.id,message.operator,intent,this.now(),this.now())[0].seq;
  try {
   const active=this.pending.get(command.id);let work:Promise<Json>;
   if(active){if(active.intent!==intent)throw new ReliabilityError('CONFLICT',409);work=active.work;}
   else {work=this.run(message,intent).finally(()=>this.pending.delete(command.id));this.pending.set(command.id,{intent,work});}
   const result=await work;this.db.rows("UPDATE maintenance_attempts SET outcome='complete',updated_at=? WHERE seq=?",this.now(),attempt);return result;
  }catch(error){const known=error instanceof ReliabilityError;this.db.rows("UPDATE maintenance_attempts SET outcome='rejected',error=?,updated_at=? WHERE seq=?",known?error.code:'NOT_READY',this.now(),attempt);throw new ReliabilityError(known?error.code:'NOT_READY',known?error.status:503);}
 }
 private admit(message:MaintenanceMessage,intent:string):Json|undefined {
  const command=message.command,old=this.row(command.id);
  if(old){if(old.intent!==intent)throw new ReliabilityError('CONFLICT',409);if(old.state==='complete'){if(old.result===null)throw new ReliabilityError('NOT_READY',503);return JSON.parse(old.result);}}
  if(!(old&&command.action==='review_close_failed')&&command.expected!==null&&canonical({...this.config.status()})!==canonical(command.expected))throw new ReliabilityError('CONFLICT',409);
  if(!old)this.db.rows("INSERT INTO maintenance_receipts VALUES (?,?,?,'pending',NULL,1,NULL,?,?)",command.id,message.operator,intent,this.now(),this.now());
  else this.db.rows('UPDATE maintenance_receipts SET attempts=attempts+1,error=NULL,updated_at=? WHERE id=?',this.now(),command.id);
 }
 private complete(id:string,result:Json):Json{this.db.rows("UPDATE maintenance_receipts SET state='complete',result=?,error=NULL,updated_at=? WHERE id=?",canonical(result),this.now(),id);return result;}
 private async run(message:MaintenanceMessage,intent:string):Promise<Json>{
  const command=message.command,args=command.args as Record<string,any>;
  // Synchronous state transition and its audit ACK are one transaction. If receipt
  // persistence fails, maintenance/drain_begin changes roll back together.
  if(!command.action.startsWith('initial_')&&!command.action.startsWith('generation_')&&!(command.action.startsWith('archive_')||command.action==='account_archive')&&!['audit_list','review_candidates','review_attest','review_close_failed','drain_advance','drain_release','review_observe','admission_list','admission_recover'].includes(command.action))return this.db.transaction(()=>{const replay=this.admit(message,intent);if(replay!==undefined)return replay;let result:Json;
   switch(command.action){case 'status':result=this.status();break;case 'audit':if(args.id===command.id)throw new ReliabilityError('INVALID',400);result=this.inspect(args.id);break;case 'set_maintenance':result={...this.config.setMaintenanceInTransaction(args.enabled,command.expected!.epoch)} as Json;break;case 'drain_begin':result=this.drain.beginInTransaction(args.id);break;case 'drain_inspect':result=this.drain.inspect(args.id);break;default:throw new ReliabilityError('INVALID',400);}
   return this.complete(command.id,result);
  });
  const replay=this.db.transaction(()=>this.admit(message,intent));
  const receiptValue=(result:Json):Json=>{if(archiveAction(command)!=='archive_export_frame')return result;const frame=result as {id:string;ordinal:number;data:string;digest:string};return {archiveFrame:{id:frame.id,ordinal:frame.ordinal,digest:frame.digest}};};
  if(replay!==undefined){if(archiveAction(command)!=='archive_export_frame')return replay;if(!this.archival)throw new ReliabilityError('NOT_READY',503);const result=await this.archival(message);if(canonical(receiptValue(result))!==canonical(replay))throw new ReliabilityError('CONFLICT',409);return result;}
  const atomicAck=(receipt:Json)=>{const row=this.row(command.id);if(!row||row.intent!==intent)throw new ReliabilityError('CONFLICT',409);this.complete(command.id,receipt);};
  try {if(command.action.startsWith('initial_')&&!this.initial)throw new ReliabilityError('NOT_READY',503);if(['review_candidates','review_attest','review_close_failed'].includes(command.action)&&!this.adjudication)throw new ReliabilityError('NOT_READY',503);if(command.action.startsWith('generation_')&&!this.generation)throw new ReliabilityError('NOT_READY',503);if((command.action.startsWith('archive_')||command.action==='account_archive')&&!this.archival)throw new ReliabilityError('NOT_READY',503);if(['admission_list','admission_recover'].includes(command.action)&&!this.admission)throw new ReliabilityError('NOT_READY',503);if(command.action==='review_observe'&&!this.observe)throw new ReliabilityError('NOT_READY',503);const result=command.action.startsWith('initial_')?await this.initial!(message,atomicAck):command.action==='audit_list'?await this.listAttempts(message):['review_candidates','review_attest','review_close_failed'].includes(command.action)?await this.adjudication!(message):command.action.startsWith('generation_')?await this.generation!(message,atomicAck):(command.action.startsWith('archive_')||command.action==='account_archive')?await this.archival!(message):['admission_list','admission_recover'].includes(command.action)?await this.admission!(message):command.action==='review_observe'?await this.observe!(message):command.action==='drain_advance'?await this.drain.advance(args.id,args.limit):await this.drain.release(args.id);return this.db.transaction(()=>{const row=this.row(command.id);if(row?.state==='complete'){if(row.result!==canonical(receiptValue(result)))throw new ReliabilityError('CONFLICT',409);}else this.complete(command.id,receiptValue(result));return result;});}
  catch(error){const known=error instanceof ReliabilityError;this.db.rows('UPDATE maintenance_receipts SET error=?,updated_at=? WHERE id=?',known?error.code:'NOT_READY',this.now(),command.id);throw new ReliabilityError(known?error.code:'NOT_READY',known?error.status:503);}
 }
}
