/**
 * 懒加载路由工厂 — 业务处理器按需加载
 */
import { KV_KEYS } from '../config/templates';
import { jsonError } from '../lib/cloudflare-api';

type Handler = (req: Request, env: any) => Promise<Response>;

export function registerLazyRoutes(ROUTES: Map<string, Handler>) {
const getHandler = async (name: string) => {
    switch (name) {
        case 'checkUpdate': {
            const { handleCheckUpdate } = await import('./check');
            return (req: Request, env: any) => {
                const url = new URL(req.url);
                return handleCheckUpdate(env, url.searchParams.get('type') || '', url.searchParams.get('mode') || undefined, parseInt(url.searchParams.get('limit') || '10'));
            };
        }
        case 'getCode': {
            const { handleGetCode } = await import('./check');
            return (req: Request, env: any) => handleGetCode(env, new URL(req.url).searchParams.get('type') || '');
        }
        case 'deploy': {
            const { handleManualDeploy } = await import('./deploy');
            return async (req: Request, env: any) => {
                const type = new URL(req.url).searchParams.get('type') || '';
                const { variables, deletedVariables, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds } = await req.json() as any;
                return handleManualDeploy(env, type, variables, deletedVariables, KV_KEYS.ACCOUNTS, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds);
            };
        }
        case 'batchDeploy': {
            const { handleBatchDeploy } = await import('./deploy');
            return async (req: Request, env: any) => handleBatchDeploy(env, await req.json(), KV_KEYS.ACCOUNTS);
        }
        case 'zones': {
            const { handleGetZones } = await import('./zones');
            return async (req: Request, _env: any) => {
                const { accountId, email, globalKey } = await req.json() as any;
                return handleGetZones(accountId, email, globalKey);
            };
        }
        case 'allWorkers': {
            const { handleGetAllWorkers } = await import('./zones');
            return async (req: Request, _env: any) => {
                const { accountId, email, globalKey } = await req.json() as any;
                return handleGetAllWorkers(accountId, email, globalKey);
            };
        }
        case 'deleteWorker': {
            const { handleDeleteWorker } = await import('./zones');
            return async (req: Request, env: any) => {
                const { accountId, email, globalKey, workerName, deleteKv } = await req.json() as any;
                return handleDeleteWorker(env, accountId, email, globalKey, workerName, deleteKv);
            };
        }
        case 'fetchBindings': {
            const { handleFetchBindings } = await import('./zones');
            return async (req: Request, _env: any) => {
                const { accountId, email, globalKey, workerName } = await req.json() as any;
                return handleFetchBindings(accountId, email, globalKey, workerName);
            };
        }
        case 'getSubdomain': {
            const { handleGetSubdomain } = await import('./zones');
            return async (req: Request, _env: any) => {
                const { accountId, email, globalKey } = await req.json() as any;
                return handleGetSubdomain(accountId, email, globalKey);
            };
        }
        case 'changeSubdomain': {
            const { handleChangeSubdomain } = await import('./zones');
            return async (req: Request, _env: any) => {
                const { accountId, email, globalKey, newSubdomain } = await req.json() as any;
                return handleChangeSubdomain(accountId, email, globalKey, newSubdomain);
            };
        }
        case 'stats': {
            const { handleStats } = await import('./check');
            return (_req: Request, env: any) => handleStats(env, KV_KEYS.ACCOUNTS);
        }
        case 'fix1101': {
            const { handleFix1101 } = await import('./fix1101');
            return async (req: Request, env: any) => handleFix1101(env, (await req.json() as any).type);
        }
        case 'regionsData': {
            const { handleGetRegionsData } = await import('./yxip');
            return () => handleGetRegionsData();
        }
        case 'saveYxip': {
            const { handleSaveYxip } = await import('./yxip');
            return async (req: Request, env: any) => handleSaveYxip(env, await req.json(), KV_KEYS.ACCOUNTS);
        }
    }
    return null;
};

// --- 注册懒加载业务路由 ---
    const lazyRoutes: [string, string, string][] = [
    ['GET', '/api/check_update', 'checkUpdate'],
    ['GET', '/api/get_code', 'getCode'],
    ['POST', '/api/deploy', 'deploy'],
    ['POST', '/api/batch_deploy', 'batchDeploy'],
    ['POST', '/api/zones', 'zones'],
    ['POST', '/api/all_workers', 'allWorkers'],
    ['POST', '/api/delete_worker', 'deleteWorker'],
    ['POST', '/api/fetch_bindings', 'fetchBindings'],
    ['POST', '/api/get_subdomain', 'getSubdomain'],
    ['POST', '/api/change_subdomain', 'changeSubdomain'],
    ['GET', '/api/stats', 'stats'],
    ['POST', '/api/fix_1101', 'fix1101'],
    ['GET', '/api/get_regions_data', 'regionsData'],
    ['POST', '/api/save_yxip', 'saveYxip'],
];

for (const [method, path, handlerName] of lazyRoutes) {
    ROUTES.set(method + ' ' + path, async (req, env) => {
        const handler = await getHandler(handlerName);
        if (!handler) return jsonError('Handler not found: ' + handlerName);
        return handler(req, env);
    });
}
}
