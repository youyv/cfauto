import type {SqlDatabase} from './config-store';
import {canonical,identifier,revision,ReliabilityError} from './protocol';
export interface AuthorityBasis {storeIdentity:string;generation:string;epoch:number;maintenance:number;watermark:number;revisions:Array<{domain:string;revision:number}>;runtime:Array<{domain:string;revision:number}>;policy:Array<{generation:string;observation_until:number}>;revocations:Array<{account:string;revision:number}>}
/** Non-secret revision basis. It must be captured with the original source snapshot,
 * not invented when an older archive is later selected for import. */
export function authorityBasis(db:SqlDatabase):AuthorityBasis {
 const meta=db.rows<{generation:string|null;epoch:number;maintenance:number}>('SELECT generation,epoch,maintenance FROM config_meta WHERE id=1')[0];if(!meta?.generation)throw new ReliabilityError('NOT_READY',503);
 const has=(name:string)=>db.rows('SELECT name FROM sqlite_master WHERE type=? AND name=?','table',name).length>0;
 return {storeIdentity:db.rows<{identity:string}>('SELECT identity FROM authority_identity WHERE id=1')[0].identity,generation:meta.generation,epoch:meta.epoch,maintenance:meta.maintenance,watermark:db.rows<{n:number}>('SELECT COALESCE(MAX(id),0) AS n FROM config_outbox')[0].n,
 revisions:db.rows<{domain:string;revision:number}>('SELECT domain,revision FROM config_records WHERE generation=? ORDER BY domain',meta.generation).map(r=>({...r})),runtime:db.rows<{domain:string;revision:number}>('SELECT domain,revision FROM runtime_records ORDER BY domain').map(r=>({...r})),
 policy:has('credential_policy')?db.rows<{generation:string;observation_until:number}>('SELECT generation,observation_until FROM credential_policy WHERE generation=?',meta.generation).map(r=>({...r})):[],revocations:has('credential_revocations')?db.rows<{account:string;revision:number}>('SELECT account,revision FROM credential_revocations WHERE generation=? ORDER BY account,revision',meta.generation).map(r=>({...r})):[]};
}
export function validateAuthorityBasis(raw:unknown):AuthorityBasis {
 const value=JSON.parse(canonical(raw));const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
 const shape=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))invalid();};
 shape(value,['storeIdentity','generation','epoch','maintenance','watermark','revisions','runtime','policy','revocations']);identifier(value.storeIdentity);identifier(value.generation);revision(value.epoch);revision(value.watermark);if(![0,1].includes(value.maintenance))invalid();
 for(const name of ['revisions','runtime','policy','revocations'])if(!Array.isArray(value[name])||value[name].length>10000)invalid();
 for(const name of ['revisions','runtime']){let previous='';for(const row of value[name]){shape(row,['domain','revision']);if(typeof row.domain!=='string'||row.domain<=previous||row.domain.length>160)invalid();previous=row.domain;revision(row.revision);}}
 if(value.policy.length!==1)invalid();shape(value.policy[0],['generation','observation_until']);if(value.policy[0].generation!==value.generation)invalid();revision(value.policy[0].observation_until);
 let prev='';for(const row of value.revocations){shape(row,['account','revision']);identifier(row.account);revision(row.revision);const key=row.account+':'+String(row.revision).padStart(16,'0');if(!row.revision||key<=prev)invalid();prev=key;}
 return value;
}
