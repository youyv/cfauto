import type {AppEnv} from '../config/env';
import {handleGetRegionsData} from '../routes/yxip';
import {businessGateway} from './business-gateway';
import {maintenanceGateway} from './maintenance-gateway';
import {productionConfig,type ReliabilityEnv} from './production-config';
import {CoordinatorRpc} from './coordinator-rpc';
import {sendCoordinatorRpc} from './production-rpc';
import {revision,ReliabilityError} from './protocol';
/** Default is authority/fail-closed. Legacy must be explicitly selected AND have
 * no reliability slots at all. Losing every binding must not silently reactivate
 * stale KV. Mode is server configuration, never a request field. */
export function reliabilityConfigured(env:AppEnv):boolean {return env.CFAUTO_STORAGE_MODE!=='legacy'||Object.keys(env).some(key=>key.startsWith('RELIABILITY_'));}
const failure=(error:unknown)=>Response.json({error:error instanceof ReliabilityError?error.code:'NOT_READY'},{status:error instanceof ReliabilityError?error.status:503,headers:{'Cache-Control':'no-store'}});
export async function authorityHttp(request:Request,env:AppEnv):Promise<Response>{
 try{if(!reliabilityConfigured(env))throw new ReliabilityError('NOT_READY',503);productionConfig(env as ReliabilityEnv);
  const url=new URL(request.url);if(url.pathname==='/api/reliability/maintenance')return maintenanceGateway(request,env as ReliabilityEnv);
  // The only non-authority business route is a fixed public, credential-free
  // region data GET. It receives neither env nor a caller-selected URL.
  if(url.pathname==='/api/get_regions_data'&&request.method==='GET')return handleGetRegionsData();
  return businessGateway(request,env as AppEnv&ReliabilityEnv);
 }catch(error){return failure(error);}
}
/** Caller supplies the platform scheduled timestamp. No direct legacy Cron,
 * provider mutation, KV runtime write or fallback lives on this path. */
export async function authorityScheduled(event:ScheduledEvent,env:AppEnv):Promise<void>{
 if(!reliabilityConfigured(env))throw new ReliabilityError('NOT_READY',503);revision(event.scheduledTime);const config=productionConfig(env as ReliabilityEnv);
 await sendCoordinatorRpc(env.RELIABILITY_COORDINATOR!,new CoordinatorRpc(config.rpcSecret),'cron_cycle',env.RELIABILITY_MANAGER_ACCOUNT!,{scheduledAt:event.scheduledTime});
}
/** Explicit legacy capability response, used only behind the normal auth chain.
 * Errors/partial authority configuration never select this mode. */
export function legacyRecoveryInfo():Response{return Response.json({format:'cfauto.recovery-workflow',version:1,mode:'legacy',protocol:1,transactional:false},{headers:{'Cache-Control':'no-store'}});}
