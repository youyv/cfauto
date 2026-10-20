import {accountId,shape,workerName} from './business-command';
import {canonical,identifier,revision,ReliabilityError} from './protocol';
export interface InitialCutoverTarget {account:string;worker:string;namespace:string}
/** A deployment-controlled trust anchor for an ALREADY independently verified
 * current-window evidence package. It is not a provider certificate or a drain
 * detector. Never construct/provision it from a public request, a telemetry summary,
 * a historical missing log, an elapsed timeout or a caller's boolean attestation. */
export interface InitialCutoverEvidence {
 legacyDeployment:string;legacyVersion:string;freezeDeployment:string;freezeVersion:string;freezeArtifact:string;
 freezeEvidence:string;drainEvidence:string;backupManifest:string;verificationReport:string;
 frozenAt:number;drainedAt:number;backupStartedAt:number;backupCompletedAt:number;verifiedAt:number;expiresAt:number;
}
export interface InitialCutoverPin {
 schema:1;id:string;target:InitialCutoverTarget;installation:string;sourceId:string;importId:string;generation:string;epoch:number;
 packet:{id:string;digest:string;bytes:number;frames:number};evidence:InitialCutoverEvidence;unprefixed:'plaintext'|'encrypted';legacyKeySource:'explicit_slot'|'retained_ACCESS_CODE'|'retained_ENCRYPTION_SECRET';
}
export const INITIAL_FRAME_BYTES=3072;
export const INITIAL_MAX_PACKET_BYTES=8*1024*1024;
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
function digest(v:unknown):void{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))unavailable();}
function uuid(v:unknown):void{if(typeof v!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v))unavailable();}
export function initialCutoverEvidence(raw:unknown):InitialCutoverEvidence {
 const e=JSON.parse(canonical(raw));shape(e,'legacyDeployment,legacyVersion,freezeDeployment,freezeVersion,freezeArtifact,freezeEvidence,drainEvidence,backupManifest,verificationReport,frozenAt,drainedAt,backupStartedAt,backupCompletedAt,verifiedAt,expiresAt');
 for(const k of ['legacyDeployment','legacyVersion','freezeDeployment','freezeVersion'])uuid(e[k]);
 for(const k of ['freezeArtifact','freezeEvidence','drainEvidence','backupManifest','verificationReport'])digest(e[k]);
 const times=['frozenAt','drainedAt','backupStartedAt','backupCompletedAt','verifiedAt','expiresAt'];for(const k of times)revision(e[k]);
 if(e.frozenAt<1||times.some((k,i)=>i>0&&e[k]<e[times[i-1]])||e.expiresAt<=e.verifiedAt||e.expiresAt-e.verifiedAt>2*60*60*1000||e.freezeVersion===e.legacyVersion||e.freezeDeployment===e.legacyDeployment)unavailable();
 return e as InitialCutoverEvidence;
}
/** Optional; absence leaves initial source import/activation unavailable. A malformed
 * configured anchor fails all production initialization closed, without echoing it. */
export function initialCutoverPin(raw:unknown,expected:InitialCutoverTarget):InitialCutoverPin|undefined {
 if(raw===undefined)return undefined;
 try{if(typeof raw!=='string'||new TextEncoder().encode(raw).length>8192)unavailable();const p=JSON.parse(raw as string);if(canonical(p)!==raw)unavailable();shape(p,'schema,id,target,installation,sourceId,importId,generation,epoch,packet,evidence,unprefixed,legacyKeySource');if(p.schema!==1)unavailable();
  shape(p.target,'account,worker,namespace');accountId(p.target.account);accountId(p.target.namespace);workerName(p.target.worker);if(canonical(p.target)!==canonical(expected))unavailable();
  for(const k of ['id','installation','sourceId','importId','generation'])identifier(p[k]);if(p.sourceId.length>60||p.importId.length>60||p.id.length>60)unavailable();revision(p.epoch);
  shape(p.packet,'id,digest,bytes,frames');identifier(p.packet.id);digest(p.packet.digest);revision(p.packet.bytes);revision(p.packet.frames);if(p.packet.bytes<1||p.packet.bytes>INITIAL_MAX_PACKET_BYTES||p.packet.frames!==Math.ceil(p.packet.bytes/INITIAL_FRAME_BYTES)||p.packet.id!==p.sourceId+'_sealed')unavailable();
  if(!['plaintext','encrypted'].includes(p.unprefixed)||!['explicit_slot','retained_ACCESS_CODE','retained_ENCRYPTION_SECRET'].includes(p.legacyKeySource))unavailable();p.evidence=initialCutoverEvidence(p.evidence);
  Object.freeze(p.target);Object.freeze(p.packet);Object.freeze(p.evidence);return Object.freeze(p) as InitialCutoverPin;
 }catch{return unavailable();}
}
