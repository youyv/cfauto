/**
 * 路由注册中心 — 组装 CRUD 路由 + 懒加载路由
 */
import { registerCrudRoutes } from './crud';
import { registerLazyRoutes } from './loader';
import type { AppEnv } from "../config/env";

export type RouteHandler = (req: Request, env: AppEnv) => Promise<Response>;

type Handler = RouteHandler;

const ROUTES = new Map<string, Handler>();

registerCrudRoutes(ROUTES);
registerLazyRoutes(ROUTES);

/** 获取路由处理器 — 按 METHOD PATH 查找，未匹配返回 null */
export function getRoute(method: string, pathname: string): Handler | null {
    return ROUTES.get(method + ' ' + pathname) || null;
}
