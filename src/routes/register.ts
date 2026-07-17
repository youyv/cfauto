/**
 * 路由注册中心 — 唯一的路由注册入口，组装 CRUD + 业务路由
 */
import { registerCrudRoutes } from './crud';
import { registerLazyRoutes } from './loader';
import type { AppEnv } from "../config/env";
import { logger } from '../lib/logger';
import { jsonError } from '../lib/cloudflare-api';

export type RouteHandler = (req: Request, env: AppEnv) => Promise<Response>;

/** 路由错误边界 — 统一捕获未处理异常，输出结构化日志并返回 500 */
export function withErrorBoundary(handler: RouteHandler, routeName: string): RouteHandler {
    return async (req, env) => {
        try {
            return await handler(req, env);
        } catch (err: any) {
            if (err instanceof Response) return err;
            logger.error('Route error: ' + routeName, err instanceof Error ? err : new Error(String(err)), { module: 'route', route: routeName });
            return jsonError('Internal server error', 500);
        }
    };
}

type Handler = RouteHandler;

const ROUTES = new Map<string, Handler>();

registerCrudRoutes(ROUTES);
registerLazyRoutes(ROUTES);

/** 获取路由处理器 — 按 METHOD PATH 查找，未匹配返回 null */
export function getRoute(method: string, pathname: string): Handler | null {
    return ROUTES.get(method + ' ' + pathname) || null;
}
