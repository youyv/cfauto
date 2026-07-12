/**
 * 路由注册 — 业务处理器（构建时已打包，统一静态导入）
 */
import { safeJson } from '../lib/cloudflare-api';
import type { AppEnv } from "../config/env";
import type { RouteHandler } from "./index";
import type { DeployBody, ZoneBody, WorkerBody, SubdomainBody, Fix1101Body } from '../lib/types';
import { handleCheckUpdate, handleGetCode, handleStats, handleDiff } from './check';
import { handleManualDeploy, handleBatchDeploy } from './deploy';
import { handleGetZones, handleGetAllWorkers, handleDeleteWorker, handleFetchBindings, handleGetSubdomain, handleChangeSubdomain } from './zones';
import { handleFix1101 } from './fix1101';
import { handleGetRegionsData, handleSaveYxip } from './yxip';



export function registerLazyRoutes(ROUTES: Map<string, RouteHandler>) {

ROUTES.set('GET /api/check_update', (req, env) => {
    const url = new URL(req.url);
    return handleCheckUpdate(env, url.searchParams.get('type') || '', url.searchParams.get('mode') || undefined, parseInt(url.searchParams.get('limit') || '10'));
});

ROUTES.set('GET /api/get_code', (req, env) =>
    handleGetCode(env, new URL(req.url).searchParams.get('type') || ''));

ROUTES.set('POST /api/deploy', async (req, env) => {
    const url = new URL(req.url);
    const body = await safeJson<DeployBody>(req);
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

ROUTES.set('POST /api/zones', async (req, env) => {
    const { accountId } = await safeJson<ZoneBody>(req);
    return handleGetZones(env, accountId);
});

ROUTES.set('POST /api/all_workers', async (req, env) => {
    const { accountId } = await safeJson<ZoneBody>(req);
    return handleGetAllWorkers(env, accountId);
});

ROUTES.set('POST /api/delete_worker', async (req, env) => {
    const { accountId, workerName, deleteKv } = await safeJson<WorkerBody>(req);
    return handleDeleteWorker(env, accountId, workerName, deleteKv);
});

ROUTES.set('POST /api/fetch_bindings', async (req, env) => {
    const { accountId, workerName } = await safeJson<Pick<WorkerBody, 'accountId' | 'workerName'>>(req);
    return handleFetchBindings(env, accountId, workerName);
});

ROUTES.set('POST /api/get_subdomain', async (req, env) => {
    const { accountId } = await safeJson<ZoneBody>(req);
    return handleGetSubdomain(env, accountId);
});

ROUTES.set('POST /api/change_subdomain', async (req, env) => {
    const { accountId, newSubdomain } = await safeJson<SubdomainBody>(req);
    return handleChangeSubdomain(env, accountId, newSubdomain);
});

ROUTES.set('GET /api/diff', (req, env) => {
    const url = new URL(req.url);
    return handleDiff(env, url.searchParams.get('type') || '');
});

ROUTES.set('GET /api/stats', (_req, env) => handleStats(env));

ROUTES.set('POST /api/fix_1101', async (req, env) =>
    handleFix1101(env, (await safeJson<Fix1101Body>(req)).type));

ROUTES.set('GET /api/get_regions_data', () => handleGetRegionsData());

ROUTES.set('POST /api/save_yxip', async (req, env) =>
    handleSaveYxip(env, await safeJson(req)));

}
