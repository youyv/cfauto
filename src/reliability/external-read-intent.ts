import {accountId,shape,templateType,workerName} from './business-command';
import {businessJson} from './business-limits';
import {canonical,ReliabilityError,type Json} from './protocol';
import {normalizeUpstream} from '../lib/upstream';
export type ExternalReadIntent = {kind:'stats'|'verify'|'diag'} | {kind:'zones'|'workers'|'subdomain';account:string} | {kind:'bindings';account:string;worker:string} | {kind:'code'|'diff'|'preview_targets';template:string} | {kind:'version';template:string;history:boolean;limit:number} | {kind:'preview';template:string;draft:Json} | {kind:'validate_source';template:string;draft:{path:string;branch:string}};
export const EXTERNAL_READ_PATHS=['/api/stats','/api/verify_credentials','/api/diag','/api/zones','/api/all_workers','/api/fetch_bindings','/api/get_subdomain','/api/check_update','/api/get_code','/api/diff','/api/deploy/preview','/api/upstream/validate'] as const;
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
export function parseExternalRead(input:unknown):ExternalReadIntent {
 const v=JSON.parse(businessJson(input));
 if(!v||typeof v!=='object')return invalid();
 if(['stats','verify','diag'].includes(v.kind)){shape(v,'kind');return v as ExternalReadIntent;}
 if(['zones','workers','subdomain'].includes(v.kind)){shape(v,'kind,account');accountId(v.account);return v as ExternalReadIntent;}
 if(v.kind==='bindings'){shape(v,'kind,account,worker');accountId(v.account);workerName(v.worker);return v as ExternalReadIntent;}
 if(['code','diff','preview_targets'].includes(v.kind)){shape(v,'kind,template');templateType(v.template);return v as ExternalReadIntent;}
 if(v.kind==='version'){shape(v,'kind,template,history,limit');templateType(v.template);if(typeof v.history!=='boolean'||!Number.isSafeInteger(v.limit)||v.limit<1||v.limit>100)return invalid();return v as ExternalReadIntent;}
 if(v.kind==='validate_source'){shape(v,'kind,template,draft');templateType(v.template);shape(v.draft,'path,branch');try{v.draft=normalizeUpstream(v.draft);}catch{return invalid();}if(!v.draft.path)return invalid();return v as ExternalReadIntent;}
 if(v.kind==='preview'){shape(v,'kind,template,draft');templateType(v.template);if(!v.draft||typeof v.draft!=='object'||Array.isArray(v.draft))return invalid();return v as ExternalReadIntent;}
 return invalid();
}
export function externalReadIntent(request:Request,payload?:unknown):ExternalReadIntent {
 const u=new URL(request.url),p=u.pathname,m=request.method;
 if(u.hash||!(EXTERNAL_READ_PATHS as readonly string[]).includes(p))return invalid();
 const noQuery=()=>{if(u.search)return invalid();};
 const simple:Record<string,string>={'/api/stats':'stats','/api/verify_credentials':'verify','/api/diag':'diag'};
 if(simple[p]){noQuery();if(m!=='GET')return invalid();return parseExternalRead({kind:simple[p]});}
 const account:Record<string,string>={'/api/zones':'zones','/api/all_workers':'workers','/api/get_subdomain':'subdomain','/api/fetch_bindings':'bindings'};
 if(account[p]){noQuery();if(m!=='POST')return invalid();shape(payload,account[p]==='bindings'?'accountId,workerName':'accountId');return parseExternalRead({kind:account[p],account:payload.accountId,...(account[p]==='bindings'?{worker:payload.workerName}:{})});}
 const allowed=p==='/api/check_update'?['type','mode','limit']:['type'];
 if([...u.searchParams.keys()].some(k=>!allowed.includes(k))||allowed.some(k=>u.searchParams.getAll(k).length>1)||!u.searchParams.has('type'))return invalid();
 const template=u.searchParams.get('type');
 if(p==='/api/deploy/preview'){if(m==='GET')return parseExternalRead({kind:'preview_targets',template});if(m==='POST')return parseExternalRead({kind:'preview',template,draft:payload});return invalid();}
 if(p==='/api/upstream/validate'){if(m!=='POST')return invalid();return parseExternalRead({kind:'validate_source',template,draft:payload});}
 if(m!=='GET')return invalid();
 if(p==='/api/check_update'){const mode=u.searchParams.get('mode'),limit=u.searchParams.get('limit')??'10';if(mode!==null&&mode!=='history'||! /^[1-9][0-9]{0,2}$/.test(limit))return invalid();return parseExternalRead({kind:'version',template,history:mode==='history',limit:Number(limit)});}
 return parseExternalRead(JSON.parse(canonical({kind:p==='/api/get_code'?'code':'diff',template})));
}
