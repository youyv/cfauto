import {MAX_SOURCE_BYTES,MAX_SCRIPT_RESPONSE_BYTES} from './payload-limits';
import {boundedReadResponse} from './read-response';
import {AsyncLocalStorage} from 'node:async_hooks';
import {TEMPLATES} from '../config/templates';
import {BILLING_METRICS_QUERY} from '../lib/billing-query';
import {ReliabilityError} from './protocol';
interface ReadPolicy {accounts:readonly string[];assertCurrent:()=>void}
const context=new AsyncLocalStorage<ReadPolicy>();
const denied=():never=>{throw new ReliabilityError('INVALID',403);};
/** Scoped to a trusted read invocation, never enabled by a public header. Applies
 * to direct transport as well as normal helpers; no redirects and no mutations. */
export function withReadOnlyNetwork<T>(policy:ReadPolicy,run:()=>Promise<T>):Promise<T>{
 if(policy.accounts.some(a=>!/^[a-f0-9]{32}$/.test(a)))return denied();
 return context.run({accounts:[...policy.accounts],assertCurrent:policy.assertCurrent},run);
}
export function enforceReadOnlyNetwork(url:string,init?:RequestInit):RequestInit|undefined {
 const policy=context.getStore();if(!policy)return init;
 policy.assertCurrent();
 const u=new URL(url),method=(init?.method||'GET').toUpperCase(),h=new Headers(init?.headers);
 if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port)return denied();
 if(u.hostname==='api.cloudflare.com'){
  if(method==='POST'){
   if(u.pathname!=='/client/v4/graphql'||u.search||typeof init?.body!=='string')return denied();
   let body:any;try{body=JSON.parse(init.body);}catch{return denied();}
   if(!body||typeof body!=='object'||Array.isArray(body))return denied();
   const v=body.variables,filter=v?.filter;
   if(Object.keys(body).sort().join(',')!=='query,variables'||body.query!==BILLING_METRICS_QUERY||!v||Object.keys(v).sort().join(',')!=='AccountID,filter'||!policy.accounts.includes(v.AccountID)||!filter||Object.keys(filter).sort().join(',')!=='datetime_geq,datetime_leq'||!['datetime_geq','datetime_leq'].every(k=>typeof filter[k]==='string'&&Number.isFinite(Date.parse(filter[k]))))return denied();
  } else {
   if(!['GET','HEAD'].includes(method)||init?.body!=null)return denied();
   const account=/^\/client\/v4\/accounts\/([a-f0-9]{32})(?:\/|$)/.exec(u.pathname);
   if(account){if(!policy.accounts.includes(account[1]))return denied();}
   else if(u.pathname!=='/client/v4/zones'||u.searchParams.getAll('account.id').length!==1||!policy.accounts.includes(u.searchParams.get('account.id')!))return denied();
  }
 } else {
  if(!['GET','HEAD'].includes(method)||init?.body!=null||h.has('x-auth-key')||h.has('x-auth-email'))return denied();
  const repos=Object.values(TEMPLATES).map(t=>t.ghUser+'/'+t.ghRepo);
  if(u.hostname==='api.github.com'){if(!repos.some(repo=>u.pathname==='/repos/'+repo||u.pathname.startsWith('/repos/'+repo+'/')))return denied();}
  else if(u.hostname==='raw.githubusercontent.com'){if(h.has('authorization')||!repos.some(repo=>u.pathname.startsWith('/'+repo+'/')))return denied();}
  else return denied();
 }
 return {...init,redirect:'manual'};
}

export async function boundReadOnlyResponse(response:Response,deadline:number,url?:string,method='GET'):Promise<Response>{
 if(!context.getStore())return response;
 let limit=2*1024*1024;
 if(url&&method.toUpperCase()==='GET'){
  const u=new URL(url);
  if(u.origin==='https://raw.githubusercontent.com'&&Object.values(TEMPLATES).some(t=>u.pathname.startsWith('/'+t.ghUser+'/'+t.ghRepo+'/')))limit=MAX_SOURCE_BYTES;
  else if(u.origin==='https://api.cloudflare.com'&&/^\/client\/v4\/accounts\/[a-f0-9]{32}\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}(?:\/content)?$/.test(u.pathname))limit=MAX_SCRIPT_RESPONSE_BYTES;
 }
 return boundedReadResponse(response,deadline,limit);
}
