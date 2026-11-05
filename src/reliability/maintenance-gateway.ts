import {productionConfig,type ReliabilityEnv} from './production-config';
import {GLOBAL_OBJECT_NAME} from './coordinator-rpc';
import {MaintenanceAuthentication,readMaintenanceRequest} from './maintenance-protocol';
import {ReliabilityError} from './protocol';
/** Independent maintenance entrypoint, intentionally not registered in index.ts
 * until the complete production ingress/cutover audit passes. Does NOT accept a
 * login session or use an RPC key to sign operator-selected commands. */
export async function maintenanceGateway(request:Request,env:ReliabilityEnv):Promise<Response>{
 try{
  const url=new URL(request.url);if(url.protocol!=='https:'||url.pathname!=='/api/reliability/maintenance'||url.search||url.hash||request.method!=='POST')throw new ReliabilityError('INVALID',403);
  const config=productionConfig(env);if(!config.maintenance)throw new ReliabilityError('NOT_READY',503);
  const body=await readMaintenanceRequest(new Request('https://maintenance.internal/v1',{method:request.method,headers:request.headers,body:request.body,duplex:'half'} as RequestInit));
  await new MaintenanceAuthentication(config.maintenance,{account:env.RELIABILITY_MANAGER_ACCOUNT,worker:env.RELIABILITY_MANAGER_WORKER,namespace:env.RELIABILITY_CONFIG_NAMESPACE}).verify(body);
  // Forward the same signed semantic envelope. The global DO independently checks
  // operator ACL, freshness, exact installation and physical address again.
  return await env.RELIABILITY_COORDINATOR.get(env.RELIABILITY_COORDINATOR.idFromName(GLOBAL_OBJECT_NAME)).fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 }catch(error){const known=error instanceof ReliabilityError;return Response.json({error:known?error.code:'NOT_READY'},{status:known?error.status:503,headers:{'Cache-Control':'no-store'}});}
}
