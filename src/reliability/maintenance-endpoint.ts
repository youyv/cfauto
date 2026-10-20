import {GLOBAL_OBJECT_NAME} from './coordinator-rpc';
import {MaintenanceAuthentication,readMaintenanceRequest} from './maintenance-protocol';
import type {MaintenanceService} from './maintenance-service';
import {ReliabilityError} from './protocol';
/** Authentication and physical installation address precede all service creation.
 * Kept in a JS private field on the production DO. Not a public RPC method. */
export class MaintenanceEndpoint {
 constructor(private readonly auth:MaintenanceAuthentication,private readonly isObject:(name:string)=>boolean,private readonly service:()=>MaintenanceService){}
 async fetch(request:Request):Promise<Response>{try{if(!this.isObject(GLOBAL_OBJECT_NAME))throw new ReliabilityError('INVALID',403);const message=await this.auth.verify(await readMaintenanceRequest(request));const value=await this.service().execute(message);return Response.json({value},{headers:{'Cache-Control':'no-store'}});}catch(error){const known=error instanceof ReliabilityError;return Response.json({error:known?error.code:'NOT_READY'},{status:known?error.status:503,headers:{'Cache-Control':'no-store'}});}}
}
