/**
 * 路由注册中心 — 唯一的路由注册入口。
 *
 * CRUD 路由在 crud.ts 内联注册；业务路由在此处集中绑定到 routes/*.ts 的 handler。
 * 此前 loader.ts 名为「懒加载」实为静态导入（构建后全部打进同一 bundle），已合并至此。
 * 所有 handler 统一套 withErrorBoundary —— 之前该函数已导出但从未被使用，异常靠
 * index.ts 顶层 catch 兜底，代价是丢失了出错路由名这一关键排障信息。
 */
import { registerCrudRoutes } from './crud';
import { safeJson } from '../lib/cloudflare-api';
import { requireTemplateType } from '../lib/validate';
import type { AppEnv } from "../config/env";
import { logger } from '../lib/logger';
import { jsonError } from '../lib/cloudflare-api';
import type { DeployBody, ZoneBody, WorkerBody, SubdomainBody, Fix1101Body } from '../lib/types';
import { handleCheckUpdate, handleGetCode, handleStats, handleDiff } from './check';
import { handleManualDeploy, handleBatchDeploy } from './deploy';
import { handleGetZones, handleGetAllWorkers, handleDeleteWorker, handleFetchBindings, handleGetSubdomain, handleChangeSubdomain } from './zones';
import { handleFix1101 } from './fix1101';
import { handleGetRegionsData, handleSaveYxip } from './yxip';
import { handleLogin } from './login';

export type RouteHandler = (req: Request, env: AppEnv) => Promise<Response>;

/** 路由错误边界 — 统一捕获未处理异常，输出结构化日志并返回 500 */
export function withErrorBoundary(handler: RouteHandler, routeName: string): RouteHandler {
    return async (req, env) => {
        try {
            return await handler(req, env);
        } catch (err: any) {
            // 主动抛出的 Response（safeJson 的 400、resolveCredentials 的 404）原样返回
            if (err instanceof Response) return err;
            logger.error('Route error: ' + routeName, err instanceof Error ? err : new Error(String(err)), { module: 'route', route: routeName });
            return jsonError('Internal server error', 500);
        }
    };
}

const ROUTES = new Map<string, RouteHandler>();

/** 路由注册函数签名 —— crud.ts 通过它注册，无需直接接触 ROUTES Map */
export type RouteRegistrar = (key: string, handler: RouteHandler) => void;

/** 注册一条路由并自动套上错误边界 */
const route: RouteRegistrar = (key, handler) => {
    if (ROUTES.has(key)) {
        // 重复注册意味着两处定义同一路径，后者会静默覆盖前者 —— 直接失败比 debug 更省事
        throw new Error('Duplicate route registration: ' + key);
    }
    ROUTES.set(key, withErrorBoundary(handler, key));
};

/** 业务路由注册 */
function registerBusinessRoutes(): void {
    route('POST /api/login', (req, env) => handleLogin(req, env));

    route('GET /api/check_update', (req, env) => {
        const url = new URL(req.url);
        return handleCheckUpdate(
            env,
            url.searchParams.get('type') || '',
            url.searchParams.get('mode') || undefined,
            parseInt(url.searchParams.get('limit') || '10', 10)
        );
    });

    route('GET /api/get_code', (req) =>
        handleGetCode(new URL(req.url).searchParams.get('type') || ''));

    route('POST /api/deploy', async (req, env) => {
        const url = new URL(req.url);
        const type = url.searchParams.get('type') || '';
        const templateErr = requireTemplateType(type);
        if (templateErr) return templateErr;
        const body = await safeJson<DeployBody>(req);
        return handleManualDeploy(env, {
            type,
            variables: body.variables || [],
            deletedVariables: body.deletedVariables,
            targetSha: body.targetSha,
            customCode: body.customCode,
            ech: body.echTokenEnabled !== undefined
                ? { tokenEnabled: body.echTokenEnabled, disableWorkersDev: body.echDisableWorkersDev }
                : undefined,
            targetAccountIds: body.targetAccountIds
        });
    });

    route('POST /api/batch_deploy', async (req, env) =>
        handleBatchDeploy(env, await safeJson(req)));

    route('POST /api/zones', async (req, env) => {
        const { accountId } = await safeJson<ZoneBody>(req);
        return handleGetZones(env, accountId);
    });

    route('POST /api/all_workers', async (req, env) => {
        const { accountId } = await safeJson<ZoneBody>(req);
        return handleGetAllWorkers(env, accountId);
    });

    route('POST /api/delete_worker', async (req, env) => {
        const { accountId, workerName, deleteKv } = await safeJson<WorkerBody>(req);
        return handleDeleteWorker(env, accountId, workerName, !!deleteKv);
    });

    route('POST /api/fetch_bindings', async (req, env) => {
        const { accountId, workerName } = await safeJson<Pick<WorkerBody, 'accountId' | 'workerName'>>(req);
        return handleFetchBindings(env, accountId, workerName);
    });

    route('POST /api/get_subdomain', async (req, env) => {
        const { accountId } = await safeJson<ZoneBody>(req);
        return handleGetSubdomain(env, accountId);
    });

    route('POST /api/change_subdomain', async (req, env) => {
        const { accountId, newSubdomain } = await safeJson<SubdomainBody>(req);
        return handleChangeSubdomain(env, accountId, newSubdomain);
    });

    route('GET /api/diff', (req, env) =>
        handleDiff(env, new URL(req.url).searchParams.get('type') || ''));

    route('GET /api/stats', (_req, env) => handleStats(env));

    route('POST /api/fix_1101', async (req, env) => {
        const { type } = await safeJson<Fix1101Body>(req);
        const templateErr = requireTemplateType(type);
        if (templateErr) return templateErr;
        return handleFix1101(env, type);
    });

    route('GET /api/get_regions_data', () => handleGetRegionsData());

    route('POST /api/save_yxip', async (req, env) =>
        handleSaveYxip(env, await safeJson(req)));
}

// 模块级注册，仅在 isolate 首次加载时执行一次
registerCrudRoutes({ set: route });
registerBusinessRoutes();

/** 获取路由处理器 — 按 METHOD PATH 查找，未匹配返回 null */
export function getRoute(method: string, pathname: string): RouteHandler | null {
    return ROUTES.get(method + ' ' + pathname) || null;
}

/** 已注册的路由键列表（诊断/测试用） */
export function listRoutes(): string[] {
    return Array.from(ROUTES.keys()).sort();
}
