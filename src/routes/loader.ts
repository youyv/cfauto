/**
 * 路由注册 — 业务处理器（构建时已打包，统一静态导入）
 */
import { safeJson } from '../lib/cloudflare-api';
import type { AccountCredentials } from '../config/env';
import type { AppEnv } from "../config/env";
import type { RouteHandler } from "./index";
import { handleCheckUpdate, handleGetCode, handleStats, handleDiff } from './check';
import { handleManualDeploy, handleBatchDeploy } from './deploy';
import { handleGetZones, handleGetAllWorkers, handleDeleteWorker, handleFetchBindings, handleGetSubdomain, handleChangeSubdomain } from './zones';
import { handleFix1101 } from './fix1101';
import { handleGetRegionsData, handleSaveYxip } from './yxip';



export function registerLazyRoutes(ROUTES: Map<string, RouteHandler>) {
async function safeJson(req: Request): Promise<any> {
    try { return await req.json(); }
    catch { throw new Response(JSON.stringify({ success: false, msg: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
}


ROUTES.set('GET /api/check_update', (req, env) => {
    const url = new URL(req.url);
    return handleCheckUpdate(env, url.searchParams.get('type') || '', url.searchParams.get('mode') || undefined, parseInt(url.searchParams.get('limit') || '10'));
});

ROUTES.set('GET /api/get_code', (req, env) =>
    handleGetCode(env, new URL(req.url).searchParams.get('type') || ''));

ROUTES.set('POST /api/deploy', async (req, env) => {
    const url = new URL(req.url);
    const body = await safeJson(req) as any;
    return handleManualDeploy(env, {
        type: url.searchParams.get('type') || '',
        variables: body.variables,
        deletedVariables: body.deletedVariables,
        targetSha: body.targetSha,
        customCode: body.customCode,
        ech: body.echTokenEnabled !== undefined ? { tokenEnabled: body.echTokenEnabled, disableWorkersDev: body.echDisableWorkersDev } : undefined,
        targetAccountIds: body.targetAccountIds
    });
});

ROUTES.set('POST /api/batch_deploy', async (req, env) =>
    handleBatchDeploy(env, await safeJson(req)));

ROUTES.set('POST /api/zones', async (req, _env) => {
    const cred: AccountCredentials = await safeJson(req);
    return handleGetZones(cred);
});

ROUTES.set('POST /api/all_workers', async (req, _env) => {
    const cred: AccountCredentials = await safeJson(req);
    return handleGetAllWorkers(cred);
});

ROUTES.set('POST /api/delete_worker', async (req, env) => {
    const { workerName, deleteKv, ...cred } = await safeJson(req) as any;
    return handleDeleteWorker(env, cred as AccountCredentials, workerName, deleteKv);
});

ROUTES.set('POST /api/fetch_bindings', async (req, _env) => {
    const { workerName, ...cred } = await safeJson(req) as any;
    return handleFetchBindings(cred as AccountCredentials, workerName);
});

ROUTES.set('POST /api/get_subdomain', async (req, _env) => {
    const cred: AccountCredentials = await safeJson(req);
    return handleGetSubdomain(cred);
});

ROUTES.set('POST /api/change_subdomain', async (req, _env) => {
    const { newSubdomain, ...cred } = await safeJson(req) as any;
    return handleChangeSubdomain(cred as AccountCredentials, newSubdomain);
});

ROUTES.set('GET /api/diff', (req, env) => {
    const url = new URL(req.url);
    return handleDiff(env, url.searchParams.get('type') || '');
});

ROUTES.set('GET /api/stats', (_req, env) => handleStats(env));

ROUTES.set('POST /api/fix_1101', async (req, env) =>
    handleFix1101(env, (await safeJson(req) as any).type));

ROUTES.set('GET /api/get_regions_data', () => handleGetRegionsData());

ROUTES.set('POST /api/save_yxip', async (req, env) =>
    handleSaveYxip(env, await safeJson(req)));

}
