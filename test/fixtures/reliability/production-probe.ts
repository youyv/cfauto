import {sha256} from '../../../src/reliability/protocol';
import {signMaintenance,type MaintenanceCommand} from '../../../src/reliability/maintenance-protocol';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName } from '../../../src/reliability/coordinator-rpc';
import type { ReliabilityEnv } from '../../../src/reliability/production-config';
/** Loopback test driver only. The production class itself has NO test/probe API. */
export async function productionProbe(request: Request, env: ReliabilityEnv): Promise<Response> {
    const { action,cursor=null } = await request.json() as { action:string;cursor?:string|null };
    const account = 'e'.repeat(32), rpc = new CoordinatorRpc(env.RELIABILITY_RPC_SECRET);
    const target = (name: string) => env.RELIABILITY_COORDINATOR.get(env.RELIABILITY_COORDINATOR.idFromName(name));
    let response: Response;
    if(action.startsWith('maintenance')) {
        const command:MaintenanceCommand=action==='maintenanceList'?{id:'local_audit_list_'+(cursor?(await sha256(cursor)).slice(0,32):'first'),action:'audit_list',expected:null,args:{limit:2,cursor}}:action==='maintenanceFreeze'||action==='maintenanceWrongKey'||action==='maintenanceWrongTarget'||action==='maintenanceWrongObject'||action==='maintenanceReaderDenied'?{id:'local_maintenance_freeze',action:'set_maintenance',expected:{generation:null,epoch:0,maintenance:1},args:{enabled:true}}:action==='maintenanceAudit'?{id:'local_maintenance_audit',action:'audit',expected:null,args:{id:'local_maintenance_freeze'}}:action==='maintenanceConflict'?{id:'local_maintenance_freeze',action:'set_maintenance',expected:{generation:null,epoch:0,maintenance:1},args:{enabled:false}}:{id:'local_maintenance_status',action:'status',expected:null,args:{}};
        const operator=action==='maintenanceReaderDenied'?'reader':'ops';
        const signed=await signMaintenance({version:1,target:{account:env.RELIABILITY_MANAGER_ACCOUNT,worker:action==='maintenanceWrongTarget'?'other-manager':env.RELIABILITY_MANAGER_WORKER,namespace:env.RELIABILITY_CONFIG_NAMESPACE},operator,at:Date.now(),nonce:crypto.randomUUID(),command},action==='maintenanceWrongKey'?env.RELIABILITY_RPC_SECRET:operator==='reader'?'7'.repeat(64):'6'.repeat(64));
        response=await target(action==='maintenanceWrongObject'?accountObjectName(account):GLOBAL_OBJECT_NAME).fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='maintenanceUnsigned'?{command}:signed)}));
    }
    else if (action === 'unsigned') response = await target(GLOBAL_OBJECT_NAME).fetch(new Request('http://localhost/bootstrap',{method:'POST',body:'{}'}));
    else if (action === 'misaddress') response = await target(accountObjectName('d'.repeat(32))).fetch(await rpc.request('deliver',account,{}));
    else if (action === 'gatewayWrongManager') response = await target(GLOBAL_OBJECT_NAME).fetch(await rpc.request('inspect_task',account,{id:'absent'}));
    else if (action === 'gatewayUnavailable') response = await target(GLOBAL_OBJECT_NAME).fetch(await rpc.request('submit_task',env.RELIABILITY_MANAGER_ACCOUNT,{request:{key:'not-initialized',targets:[{account,actions:[{kind:'delete_worker',template:'cmliu',worker:'demo'}]}]}}));
    else if (action === 'deliver') response = await target(accountObjectName(account)).fetch(await rpc.request('deliver',account,{task:'production_probe_task',account,digest:'a'.repeat(64),snapshot:'probe_no_snapshot',steps:['delete_worker'],token:'probe_token',generation:'probe_no_generation',credentialRevision:1}));
    else if (action === 'private') {
        const stub = target(GLOBAL_OBJECT_NAME) as any, rejected: string[] = [];
        for (const method of ['bootstrap','bindTrusted','submit','status','execute','config','rpc']) {
            try { await stub[method](); } catch { rejected.push(method); }
        }
        return Response.json({result:{rejected}});
    } else return Response.json({error:'INVALID'},{status:400});
    return Response.json({result:{status:response.status,body:await response.json()}});
}
