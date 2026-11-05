import type {ProductionConfig,ReliabilityEnv} from './production-config';
import type {InitialCutoverPin} from './initial-cutover-pin';
import type {KeyRing} from './credential-envelope';
import {ReliabilityError} from './protocol';
/** A one-migration read capability, explicitly selected by the deployment-pinned
 * source approval. Never used by normal CredentialAuthority or productionConfig.
 * It reads an already retained legacy binding in-place; does not create a new
 * secret slot, export a key, infer a fallback, or reuse it for v2/RPC/snapshots.
 * Correctness is authenticated by decrypting EVERY original legacy credential. */
export function initialCredentialRing(env:ReliabilityEnv,config:ProductionConfig,pin:InitialCutoverPin|undefined):KeyRing {
 if(!pin||pin.legacyKeySource==='explicit_slot')return config.credentials;
 const material=pin.legacyKeySource==='retained_ACCESS_CODE'?env.ACCESS_CODE:pin.legacyKeySource==='retained_ENCRYPTION_SECRET'?env.ENCRYPTION_SECRET:undefined;
 const deny=():never=>{throw new ReliabilityError('NOT_READY',503);};
 if(typeof material!=='string'||!material||new TextEncoder().encode(material).length>8192)return deny();
 const forbidden=[config.rpcSecret,config.idempotencySecret,config.evidenceSecret,...Object.values(config.credentials.keys),...Object.values(config.snapshots.keys),...Object.values(config.maintenance?.operators??{}).map(o=>o.secret)];
 if(forbidden.includes(material)||(config.credentials.legacySecret!==undefined&&config.credentials.legacySecret!==material))return deny();
 return Object.freeze({currentId:config.credentials.currentId,keys:config.credentials.keys,legacySecret:material});
}
