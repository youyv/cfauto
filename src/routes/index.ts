/**
 * 路由注册中心 — 所有 API 端点的 Map
 */

import { KV_KEYS } from '../config/templates';
import { jsonError } from '../lib/cloudflare-api';

/**
 * 构建路由表 — 每次请求调用，env 通过闭包注入到所有 handler
 * 
 * 路由分两类：
 *   1. KV CRUD — 直接内联（访问 env.CONFIG_KV）
 *   2. 业务路由 — 延迟加载（动态 import 对应模块，首次访问时初始化）
 * 
 * 注意：POST /api/login 在 src/index.ts 中内联处理，不在此路由表中
 */
export function createRoutes(env: any) {
    const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    const m = new Map<string, (req: Request, env: any) => Promise<Response>>();

    // --- 业务路由（延迟加载避免循环依赖） ---
    const getHandler = async (name: string) => {
        switch (name) {
            case 'checkUpdate': {
                const { handleCheckUpdate } = await import('./check');
                return (req: Request) => {
                    const url = new URL(req.url);
                    return handleCheckUpdate(env, url.searchParams.get('type') || '', url.searchParams.get('mode') || undefined, parseInt(url.searchParams.get('limit') || '10'));
                };
            }
            case 'getCode': {
                const { handleGetCode } = await import('./check');
                return (req: Request) => handleGetCode(env, new URL(req.url).searchParams.get('type') || '');
            }
            case 'deploy': {
                const { handleManualDeploy } = await import('./deploy');
                return async (req: Request) => {
                    const { type, variables, deletedVariables, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds } = await req.json() as any;
                    return handleManualDeploy(env, type, variables, deletedVariables, KV_KEYS.ACCOUNTS, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds);
                };
            }
            case 'batchDeploy': {
                const { handleBatchDeploy } = await import('./deploy');
                return async (req: Request) => handleBatchDeploy(env, await req.json(), KV_KEYS.ACCOUNTS);
            }
            case 'zones': {
                const { handleGetZones } = await import('./zones');
                return async (req: Request) => {
                    const { accountId, email, globalKey } = await req.json() as any;
                    return handleGetZones(accountId, email, globalKey);
                };
            }
            case 'allWorkers': {
                const { handleGetAllWorkers } = await import('./zones');
                return async (req: Request) => {
                    const { accountId, email, globalKey } = await req.json() as any;
                    return handleGetAllWorkers(accountId, email, globalKey);
                };
            }
            case 'deleteWorker': {
                const { handleDeleteWorker } = await import('./zones');
                return async (req: Request) => {
                    const { accountId, email, globalKey, workerName, deleteKv } = await req.json() as any;
                    return handleDeleteWorker(env, accountId, email, globalKey, workerName, deleteKv);
                };
            }
            case 'fetchBindings': {
                const { handleFetchBindings } = await import('./zones');
                return async (req: Request) => {
                    const { accountId, email, globalKey, workerName } = await req.json() as any;
                    return handleFetchBindings(accountId, email, globalKey, workerName);
                };
            }
            case 'getSubdomain': {
                const { handleGetSubdomain } = await import('./zones');
                return async (req: Request) => {
                    const { accountId, email, globalKey } = await req.json() as any;
                    return handleGetSubdomain(accountId, email, globalKey);
                };
            }
            case 'changeSubdomain': {
                const { handleChangeSubdomain } = await import('./zones');
                return async (req: Request) => {
                    const { accountId, email, globalKey, newSubdomain } = await req.json() as any;
                    return handleChangeSubdomain(accountId, email, globalKey, newSubdomain);
                };
            }
            case 'stats': {
                const { handleStats } = await import('./check');
                return (req: Request) => handleStats(env, KV_KEYS.ACCOUNTS);
            }
            case 'fix1101': {
                const { handleFix1101 } = await import('./fix1101');
                return async (req: Request) => handleFix1101(env, (await req.json() as any).type);
            }
            case 'regionsData': {
                const { handleGetRegionsData } = await import('./yxip');
                return () => handleGetRegionsData();
            }
            case 'saveYxip': {
                const { handleSaveYxip } = await import('./yxip');
                return async (req: Request) => handleSaveYxip(env, await req.json(), KV_KEYS.ACCOUNTS);
            }
        }
        return null;
    };

    // --- 诊断端点（验证 KV 是否正常） ---
    m.set('GET /api/diag', async () => {
        const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG];
        const results: Record<string, unknown> = {};
        for (const k of keys) {
            try {
                const v = await env.CONFIG_KV.get(k);
                results[k] = v === null ? '(null)' : (v.length > 200 ? v.substring(0, 200) + '...' : v);
            } catch (e: any) { results[k] = `ERROR: ${e.message}`; }
        }
        results['__kv_bound'] = !!env.CONFIG_KV;
        results['__kv_keys'] = KV_KEYS;
        return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json' } });
    });

    // --- KV CRUD 路由（可直接内联） ---
    m.set('GET /api/accounts', async (_req) => {
        return new Response(await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS) || '[]', { headers: { 'Content-Type': 'application/json' } });
    });
    m.set('POST /api/accounts', async (req) => {
        await env.CONFIG_KV.put(KV_KEYS.ACCOUNTS, JSON.stringify(await req.json()));
        return json({ success: true });
    });
    m.set('GET /api/settings', async (req) => {
        const type = new URL(req.url).searchParams.get('type');
        return new Response(await env.CONFIG_KV.get(KV_KEYS.vars(type || '')) || 'null', { headers: { 'Content-Type': 'application/json' } });
    });
    m.set('POST /api/settings', async (req) => {
        const type = new URL(req.url).searchParams.get('type');
        await env.CONFIG_KV.put(KV_KEYS.vars(type || ''), JSON.stringify(await req.json()));
        return json({ success: true });
    });
    m.set('GET /api/deploy_config', async (req) => {
        const type = new URL(req.url).searchParams.get('type');
        const key = KV_KEYS.deployConfig(type || '');
        const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
        return new Response(await env.CONFIG_KV.get(key) || JSON.stringify(defaultCfg), { headers: { 'Content-Type': 'application/json' } });
    });
    m.set('GET /api/favorites', async (req) => {
        const type = new URL(req.url).searchParams.get('type');
        return new Response(await env.CONFIG_KV.get(KV_KEYS.favorites(type || '')) || '[]', { headers: { 'Content-Type': 'application/json' } });
    });
    m.set('POST /api/favorites', async (req) => {
        const type = new URL(req.url).searchParams.get('type');
        const key = KV_KEYS.favorites(type || '');
        const { action, item } = await req.json() as any;
        let favs = JSON.parse(await env.CONFIG_KV.get(key) || '[]');
        if (action === 'add') { if (!favs.find((f: any) => f.sha === item.sha)) favs.unshift(item); }
        else if (action === 'remove') { favs = favs.filter((f: any) => f.sha !== item.sha); }
        await env.CONFIG_KV.put(key, JSON.stringify(favs));
        return json({ success: true, favorites: favs });
    });
    m.set('GET /api/auto_config', async () => {
        return new Response(await env.CONFIG_KV.get(KV_KEYS.GLOBAL_CONFIG) || '{}', { headers: { 'Content-Type': 'application/json' } });
    });
    m.set('POST /api/auto_config', async (req) => {
        await env.CONFIG_KV.put(KV_KEYS.GLOBAL_CONFIG, JSON.stringify(await req.json()));
        return json({ success: true });
    });

    // --- 业务路由（延迟绑定） ---
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
        m.set(`${method} ${path}`, async (req) => {
            const handler = await getHandler(handlerName);
            if (!handler) return jsonError(`Handler not found: ${handlerName}`);
            return handler!(req);
        });
    }

    return m;
}
