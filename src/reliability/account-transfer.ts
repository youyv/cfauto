import {validateAccountsPayload} from '../lib/validate';
import type {AccountEntry} from '../lib/types';
import {migrateCredentialAccounts,readCredentialAccounts} from './credential-accounts';
import type {KeyRing} from './credential-envelope';
import {canonical,encoded,identifier,revision,ReliabilityError,type ConfigRecord,type Json} from './protocol';
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
function shape(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,any>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))invalid();
}
function keyIds(accounts:AccountEntry[]):string[]{
 const ids=new Set<string>();
 for(const account of accounts)for(const field of ['apiToken','globalKey'] as const){const value=account[field];if(!value)continue;const parts=value.split(':');if(parts.length!==3||parts[0]!=='v2')invalid();identifier(parts[1]);ids.add(parts[1]);}
 return [...ids].sort();
}
/** A credential transfer file, NOT a disaster recovery backup. No policy, task,
 * runtime, source artifact, session, encryption material or live KV is included. */
export async function accountExport(view:{generation:string;epoch:number;records:ConfigRecord[]},ring:KeyRing):Promise<Json>{
 const frozen=JSON.parse(encoded(view)) as typeof view;identifier(frozen.generation);revision(frozen.epoch);
 if(frozen.records.length!==1||frozen.records[0].domain!=='accounts'||frozen.records[0].revision<1)invalid();
 revision(frozen.records[0].revision);
 const accounts=frozen.records[0].value as unknown as AccountEntry[];
 await readCredentialAccounts(accounts,ring); // Verify ALL live values before exporting even one.
 return {format:'cfauto.accounts',version:2,source:{generation:frozen.generation,epoch:frozen.epoch,revision:frozen.records[0].revision},keyIds:keyIds(accounts),accounts:accounts as unknown as Json};
}
/** Pure preparation; ConfigEditor commits via CredentialAuthority's CAS and receipt.
 * Identity is accountId only. Existing worker inventories and unrelated metadata
 * remain authoritative; importing credentials never replaces those fields. */
export async function prepareAccountImport(raw:unknown,existing:AccountEntry[],ring:KeyRing):Promise<{accounts:AccountEntry[];added:number;merged:number;total:number}>{
 const input:unknown=JSON.parse(encoded(raw));shape(input,['file'],['unprefixed']);
 if(input.unprefixed!==undefined&&!['plaintext','encrypted'].includes(input.unprefixed))invalid();
 const currentValues=JSON.parse(encoded(existing)) as AccountEntry[];
 const file=input.file;let accounts:AccountEntry[],strict=false,declaredKeys:unknown;
 if(Array.isArray(file))accounts=file;
 else if(file&&typeof file==='object'&&file.format==='cfauto.accounts'){
  shape(file,['format','version','source','keyIds','accounts']);if(file.version!==2||input.unprefixed!==undefined)invalid();
  shape(file.source,['generation','epoch','revision']);identifier(file.source.generation);revision(file.source.epoch);revision(file.source.revision);if(file.source.revision<1)invalid();
  if(!Array.isArray(file.keyIds)||file.keyIds.length>1000)invalid();file.keyIds.forEach(identifier);
  accounts=file.accounts;strict=true;declaredKeys=file.keyIds;
 }else{
  shape(file,['_format','accounts'],['_time','_encryptionFingerprint']);if(file._format!=='worker-pro-accounts@2')invalid();
  if(file._time!==undefined&&(typeof file._time!=='string'||file._time.length>40||!Number.isFinite(Date.parse(file._time))))invalid();
  // This legacy hint is neither key material nor proof. GCM verification is mandatory.
  if(file._encryptionFingerprint!==undefined&&file._encryptionFingerprint!==null&&(typeof file._encryptionFingerprint!=='string'||file._encryptionFingerprint.length>256))invalid();
  accounts=file.accounts;
 }
 if(!Array.isArray(accounts)||!accounts.length)invalid();
 if(accounts.some(a=>!a||typeof a.accountId!=='string'||! /^[a-f0-9]{32}$/.test(a.accountId)))invalid();
 const incoming= strict ? await readCredentialAccounts(accounts,ring) : await readCredentialAccounts(await migrateCredentialAccounts(accounts,ring,input.unprefixed),ring);
 if(strict&&canonical(declaredKeys)!==canonical(keyIds(accounts)))invalid();
 const current=await readCredentialAccounts(currentValues,ring);
 for(const account of incoming){
  if(account.authMode==='token'?!account.apiToken:account.authMode==='key'?!account.globalKey||!account.email.trim():!account.apiToken&&(!account.globalKey||!account.email.trim()))invalid();
 }
 const merged=current.map(a=>({...a}));let added=0,changed=0;
 for(const account of incoming){
  const index=merged.findIndex(a=>a.accountId===account.accountId);
  if(index<0){const next={...account};delete next.credentialRevision;delete next.stats;merged.push(next);added++;}
  else{const next={...merged[index],alias:account.alias,email:account.email,apiToken:account.apiToken,globalKey:account.globalKey};if(account.authMode===undefined)delete next.authMode;else next.authMode=account.authMode;merged[index]=next;changed++;}
 }
 const aliases=new Set<string>();for(const account of merged){const alias=account.alias.trim();if(aliases.has(alias))invalid();aliases.add(alias);}
 if(!validateAccountsPayload(merged).ok)invalid();
 return {accounts:merged,added,merged:changed,total:merged.length};
}
