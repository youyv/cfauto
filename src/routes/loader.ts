/**
 * 懒加载路由工厂 — 业务处理器按需加载
 */
import { KV_KEYS } from '../config/templates';
import { jsonError } from '../lib/cloudflare-api';
import type { AccountCredentials } from '../config/env';
import type { AppEnv } from "../config/env";

type Handler = (req: Request, env: AppEnv) => Promise<Response>;

export function registerLazyRoutes(ROUTES: Map<string, Handler>) {
const getHandler = async (name: string) => {
    switch (name) {
        case 'checkUpdate': {
            const { handleCheckUpdate } = await import('./check');
            return (req: Request, env: AppEnv) => {
                const url = new URL(req.url);
                return handleCheckUpdate(env, url.searchParams.get('type') || '', url.searchParams.get('mode') || undefined, parseInt(url.searchParams.get('limit') || '10'));
            };
        }
        case 'getCode': {
            const { handleGetCode } = await import('./check');
            return (req: Request, env: AppEnv) => handleGetCode(env, new URL(req.url).searchParams.get('type') || '');
        }
        case 'deploy': {
            const { handleManualDeploy } = await import('./deploy');
            return async (req: Request, env: AppEnv) => {
                const body = await req.json() as any;
                return handleManualDeploy(env, {
                    type: new URL(req.url).searchParams.get('type') || '',
                    variables: body.variables,
                    deletedVariables: body.deletedVariables,
                    targetSha: body.targetSha,
                    customCode: body.customCode,
                    ech: body.echTokenEnabled !== undefined ? { tokenEnabled: body.echTokenEnabled, disableWorkersDev: body.echDisableWorkersDev } : undefined,
                    targetAccountIds: body.targetAccountIds
                });
            };
        }
        case 'batchDeploy': {
            const { handleBatchDeploy } = await import('./deploy');
            return async (req: Request, env: AppEnv) => handleBatchDeploy(env, await req.json());
        }
        case 'zones': {
            const { handleGetZones } = await import('./zones');
            return async (req: Request, _env: AppEnv) => {
                const cred: AccountCredentials = await req.json();
                return handleGetZones(cred);
            };
        }
        case 'allWorkers': {
            const { handleGetAllWorkers } = await import('./zones');
            return async (req: Request, _env: AppEnv) => {
                const cred: AccountCredentials = await req.json();
                return handleGetAllWorkers(cred);
            };
        }
        case 'deleteWorker': {
            const { handleDeleteWorker } = await import('./zones');
            return async (req: Request, env: AppEnv) => {
                const { workerName, deleteKv, ...cred } = await req.json() as any;
                return handleDeleteWorker(env, cred as AccountCredentials, workerName, deleteKv);
            };
        }
        case 'fetchBindings': {
            const { handleFetchBindings } = await import('./zones');
            return async (req: Request, _env: AppEnv) => {
                const { workerName, ...cred } = await req.json() as any;
                return handleFetchBindings(cred as AccountCredentials, workerName);
            };
        }
        case 'getSubdomain': {
            const { handleGetSubdomain } = await import('./zones');
            return async (req: Request, _env: AppEnv) => {
                const cred: AccountCredentials = await req.json();
                return handleGetSubdomain(cred);
            };
        }
        case 'changeSubdomain': {
            const { handleChangeSubdomain } = await import('./zones');
            return async (req: Request, _env: AppEnv) => {
                const { newSubdomain, ...cred } = await req.json() as any;
                return handleChangeSubdomain(cred as AccountCredentials, newSubdomain);
            };
        }
        case 'stats': {
            const { handleStats } = await import('./check');
            return (_req: Request, env: AppEnv) => handleStats(env);
        }
        case 'fix1101': {
            const { handleFix1101 } = await import('./fix1101');
            return async (req: Request, env: AppEnv) => handleFix1101(env, (await req.json() as any).type);
        }
        case 'regionsData': {
            const { handleGetRegionsData } = await import('./yxip');
            return () => handleGetRegionsData();
        }
        case 'saveYxip': {
            const { handleSaveYxip } = await import('./yxip');
            return async (req: Request, env: AppEnv) => handleSaveYxip(env, await req.json());
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
