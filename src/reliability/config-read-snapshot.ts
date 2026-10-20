import type {KVNamespace,KVGetOptions,KVListOptions} from '../config/env';
import {KV_KEYS,TEMPLATES} from '../config/templates';
import {canonical,ReliabilityError,type ConfigRecord} from './protocol';
/** Invocation-local compatibility facade over an already captured DO snapshot.
 * It is NOT KV storage, a cache, an export, or a fallback. No live binding is accepted.
 * Every mutation fails; cache absence is explicit, unknown key access fails closed. */
export class ConfigReadSnapshot implements KVNamespace {
 private readonly values=new Map<string,string|null>();
 constructor(records:ConfigRecord[]){
  const domains=new Map(records.map(r=>[r.domain,r.value]));
  const add=(key:string,domain:string)=>{const value=domains.get(domain);this.values.set(key,value===undefined||value===null?null:canonical(value));};
  add(KV_KEYS.ACCOUNTS,'accounts');add(KV_KEYS.GLOBAL_CONFIG,'autoConfig');add(KV_KEYS.DEPLOY_JOURNAL,'deployJournal');
  for(const t of Object.keys(TEMPLATES)){
   add(KV_KEYS.vars(t),'vars:'+t);add(KV_KEYS.deployConfig(t),'deploy:'+t);add(KV_KEYS.favorites(t),'favorites:'+t);add(KV_KEYS.upstream(t),'upstream:'+t);this.values.set(KV_KEYS.ghInfoCache(t),null);
   for(const domain of domains.keys()){const prefix='override:'+t+':';if(domain.startsWith(prefix)&&/^[a-f0-9]{32}$/.test(domain.slice(prefix.length)))add(KV_KEYS.accountVars(t,domain.slice(prefix.length)),domain);}
  }
 }
 async get(key:string,_options?:KVGetOptions):Promise<string|null>{
  if(this.values.has(key))return this.values.get(key)!;
  if(Object.keys(TEMPLATES).some(t=>new RegExp('^VARS_'+t+'_ACC_[a-f0-9]{32}$').test(key)))return null;
  throw new ReliabilityError('INVALID',403);
 }
 async put():Promise<void>{throw new ReliabilityError('INVALID',403);}
 async delete():Promise<void>{throw new ReliabilityError('INVALID',403);}
 async list(options?:KVListOptions):Promise<{keys:Array<{name:string}>;list_complete:boolean}>{
  if(options?.cursor)throw new ReliabilityError('INVALID',400);
  return {keys:[...this.values.entries()].filter(([key,value])=>value!==null&&key.startsWith(options?.prefix??'')).map(([name])=>({name})).sort((a,b)=>a.name.localeCompare(b.name)),list_complete:true};
 }
}
