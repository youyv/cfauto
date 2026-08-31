import { describe, it, expect } from 'vitest';
import { getRoute } from '../src/routes/register';
import { handleCronJob } from '../src/cron';
import { coreDeployLogic, finalizeDeploy, rotateUUIDAndDeploy, mergeVarLists } from '../src/lib/auto-update';
import { handleManualDeploy } from '../src/routes/deploy';
import { writeAccounts } from '../src/lib/account-store';
import { KV_KEYS } from '../src/config/templates';
import { mockKV, mockEnv, readKV, jsonReq, cfOk, cfErr, htmlErr, stubFetch, type MockKV } from './helpers';
import type { AppEnv } from '../src/config/env';
import type { AccountEntry, DeployConfig, DeployLogEntry, JournalEntry, AutoUpdateConfig } from '../src/lib/types';

const AID_A = 'a'.repeat(32);
const AID_B = 'b'.repeat(32);

function acct(over: Partial<AccountEntry> = {}): AccountEntry {
    return { alias: 'acc-a', accountId: AID_A, email: 'a@x.com', globalKey: 'KEY_A', ...over };
}

async function seedAccounts(env: AppEnv, accounts: AccountEntry[]) {
    await writeAccounts(env, accounts);
}

/** GitHub 与 CF 的常用 stub 路由 */
function githubRoutes(sha = 'sha-remote', code = 'const CF_FALLBACK_IPS = [];') {
    return [
        { match: 'raw.githubusercontent.com', respond: () => new Response(code, { status: 200 }) },
        {
            match: 'api.github.com',
            respond: () => new Response(JSON.stringify([{
                sha,
                commit: { message: 'msg', author: { name: 'n', date: '2026-01-01T00:00:00Z' }, committer: { date: '2026-01-01T00:00:00Z' } }
            }]), { status: 200 })
        }
    ];
}

// ============================================================
// 部署链路：部分失败不推进 SHA，并记录 pendingTargets
// ============================================================
describe('coreDeployLogic — 部分失败语义', () => {
    it('全部成功 → 推进 currentSha 且 pendingTargets 清空', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1', 'w2'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({ id: 'w' }) }
        ]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [] });
            expect(logs.every(l => l.success)).toBe(true);
            const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
            expect(cfg.currentSha).toBe('sha-remote');
            expect(cfg.pendingTargets).toEqual([]);
        } finally { stub.restore(); }
    });

    it('部分失败 → currentSha 不推进，失败目标记入 pendingTargets', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['ok-worker', 'bad-worker'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            {
                match: '/workers/scripts/',
                respond: (call) => call.url.includes('bad-worker') ? cfErr(500, 'upload failed') : cfOk({ id: 'w' })
            }
        ]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [] });
            expect(logs.filter(l => l.success)).toHaveLength(1);
            const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
            // 关键：不能因为「有一个成功」就把 SHA 前进，否则 cron 判定已是最新，失败目标永远落后
            expect(cfg.currentSha).toBeUndefined();
            expect(cfg.pendingTargets).toEqual([AID_A + '::bad-worker']);
            expect(cfg.pendingSha).toBe('sha-remote');
            expect(cfg.lastAttempt).toBeTruthy();
        } finally { stub.restore(); }
    });

    it('bindings 读取失败 → 中止该 Worker 部署（保护既有 KV/secret 绑定）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        let uploadCalled = false;
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => htmlErr(500) },
            { match: '/workers/scripts/', respond: () => { uploadCalled = true; return cfOk({}); } }
        ]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [{ key: 'UUID', value: 'x' }] });
            expect(logs[0].success).toBe(false);
            expect(logs[0].msg).toContain('保护既有绑定');
            expect(uploadCalled).toBe(false);
        } finally { stub.restore(); }
    });

    it('targetKeys 过滤只部署指定目标（pending 重试路径）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1', 'w2', 'w3'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            const logs = await coreDeployLogic(env, {
                type: 'cmliu', variables: [], targetKeys: [AID_A + '::w2']
            });
            expect(logs).toHaveLength(1);
            expect(logs[0].name).toContain('w2');
        } finally { stub.restore(); }
    });

    it('targetAccountIds 过滤账号', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [
            acct({ workers_cmliu: ['wa'] }),
            acct({ alias: 'acc-b', accountId: AID_B, email: 'b@x.com', globalKey: 'KEY_B', workers_cmliu: ['wb'] })
        ]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [], targetAccountIds: [AID_B] });
            expect(logs).toHaveLength(1);
            expect(logs[0].name).toContain('acc-b');
        } finally { stub.restore(); }
    });

    it('GitHub 拉取失败 → 返回网络错误且不写部署配置', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([{ match: 'raw.githubusercontent.com', respond: () => htmlErr(404) }]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [] });
            expect(logs[0].success).toBe(false);
            expect(logs[0].name).toBe('网络错误');
            expect(readKV(kv, KV_KEYS.deployConfig('cmliu'))).toBeNull();
        } finally { stub.restore(); }
    });

    it('无匹配 Worker 时给出明确提示', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct()]);   // 没有 workers_cmliu
        const stub = stubFetch(githubRoutes());
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [] });
            expect(logs[0].success).toBe(false);
            expect(logs[0].msg).toContain('无该模板的 Worker');
        } finally { stub.restore(); }
    });

    it('部署日志写入 journal，含失败目标清单', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        const logs: DeployLogEntry[] = [
            { name: 'a -> [w1]', success: true, msg: 'ok', targetKey: 'a::w1' },
            { name: 'a -> [w2]', success: false, msg: 'err', targetKey: 'a::w2' }
        ];
        const stub = stubFetch(githubRoutes());
        try {
            await finalizeDeploy(env, 'cmliu', true, 'sha1', logs, '');
            const journal = readKV<JournalEntry[]>(kv, KV_KEYS.DEPLOY_JOURNAL)!;
            expect(journal[0].accounts).toBe(1);
            expect(journal[0].total).toBe(2);
            expect(journal[0].failed).toEqual(['a -> [w2]']);
        } finally { stub.restore(); }
    });

    it('journal 只保留最近 100 条', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        const existing = Array.from({ length: 100 }, (_, i) => ({ time: 't' + i, type: 'cmliu', sha: 's', accounts: 1, total: 1, summary: '' }));
        await kv.put(KV_KEYS.DEPLOY_JOURNAL, JSON.stringify(existing));
        const stub = stubFetch(githubRoutes());
        try {
            await finalizeDeploy(env, 'cmliu', true, 'sha-new', [{ name: 'x', success: true, msg: '', targetKey: 'a::1' }], '');
            expect(readKV<JournalEntry[]>(kv, KV_KEYS.DEPLOY_JOURNAL)!).toHaveLength(100);
        } finally { stub.restore(); }
    });
});

// ============================================================
// 熔断：只轮换超限账号，不波及其他账号
// ============================================================
describe('rotateUUIDAndDeploy — 熔断作用域', () => {
    it('只写目标账号的账号级变量键，全局 VARS 不变', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [
            acct({ workers_cmliu: ['wa'] }),
            acct({ alias: 'acc-b', accountId: AID_B, email: 'b@x.com', globalKey: 'KEY_B', workers_cmliu: ['wb'] })
        ]);
        await kv.put(KV_KEYS.vars('cmliu'), JSON.stringify([{ key: 'UUID', value: 'global-uuid' }]));
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            await rotateUUIDAndDeploy(env, 'cmliu', [AID_A]);
            // 全局变量不动 → 未超限账号的 UUID 不受影响
            expect(readKV<any[]>(kv, KV_KEYS.vars('cmliu'))![0].value).toBe('global-uuid');
            // 目标账号有了自己的覆盖
            const accVars = readKV<any[]>(kv, KV_KEYS.accountVars('cmliu', AID_A))!;
            expect(accVars.find(v => v.key === 'UUID')!.value).not.toBe('global-uuid');
            expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_B))).toBeNull();
        } finally { stub.restore(); }
    });

    it('只对目标账号发起部署请求', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [
            acct({ workers_cmliu: ['wa'] }),
            acct({ alias: 'acc-b', accountId: AID_B, email: 'b@x.com', globalKey: 'KEY_B', workers_cmliu: ['wb'] })
        ]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            await rotateUUIDAndDeploy(env, 'cmliu', [AID_A]);
            const uploads = stub.calls.filter(c => c.method === 'PUT' && c.url.includes('/workers/scripts/'));
            expect(uploads).toHaveLength(1);
            expect(uploads[0].url).toContain(AID_A);
            expect(uploads[0].url).not.toContain(AID_B);
        } finally { stub.restore(); }
    });

    it('accountIds 为空 → 拒绝执行（防止退化为全局轮换）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['wa'] })]);
        const stub = stubFetch([], () => { throw new Error('不应发起任何请求'); });
        try {
            await rotateUUIDAndDeploy(env, 'cmliu', []);
            expect(stub.calls).toHaveLength(0);
        } finally { stub.restore(); }
    });

    it('无 uuidField 的模板（ech）直接返回', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        const stub = stubFetch([], () => { throw new Error('不应发起任何请求'); });
        try {
            await rotateUUIDAndDeploy(env, 'ech', [AID_A]);
            expect(stub.calls).toHaveLength(0);
        } finally { stub.restore(); }
    });

    it('mergeVarLists: override 覆盖同名键，其余全局键保留', () => {
        const merged = mergeVarLists(
            [{ key: 'UUID', value: 'g-uuid' }, { key: 'PROXYIP', value: 'g-ip' }],
            [{ key: 'UUID', value: 'rotated' }]
        );
        expect(merged.find(v => v.key === 'UUID')!.value).toBe('rotated');
        expect(merged.find(v => v.key === 'PROXYIP')!.value).toBe('g-ip');
    });

    it('cron 自动更新时账号级 UUID 覆盖不被全局变量冲掉', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        await kv.put(KV_KEYS.vars('cmliu'), JSON.stringify([{ key: 'UUID', value: 'global-uuid' }, { key: 'PROXYIP', value: 'gip' }]));
        await kv.put(KV_KEYS.accountVars('cmliu', AID_A), JSON.stringify([{ key: 'UUID', value: 'rotated-uuid' }]));
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            // cron 路径（默认 accountOverrides: 'apply'）
            await coreDeployLogic(env, {
                type: 'cmliu',
                variables: [{ key: 'UUID', value: 'global-uuid' }, { key: 'PROXYIP', value: 'gip' }]
            });
            // 覆盖仍在，未被清除
            expect(readKV<any[]>(kv, KV_KEYS.accountVars('cmliu', AID_A))![0].value).toBe('rotated-uuid');
        } finally { stub.restore(); }
    });

    it('手动部署清除账号级覆盖（界面显示的全局变量即实际部署内容）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        await kv.put(KV_KEYS.accountVars('cmliu', AID_A), JSON.stringify([{ key: 'UUID', value: 'rotated' }]));
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            await handleManualDeploy(env, { type: 'cmliu', variables: [{ key: 'UUID', value: 'manual' }] });
            expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_A))).toBeNull();
        } finally { stub.restore(); }
    });
});

// ============================================================
// cron：ech 参与更新 + 熔断不再阻断更新 + lastCheck 兜底
// ============================================================
describe('handleCronJob', () => {
    function statsResponse(requests: number) {
        return new Response(JSON.stringify({
            data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests } }] }] } }
        }), { status: 200 });
    }

    it('未启用 → 直接返回，不写 lastCheck', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: false } });
        const stub = stubFetch([], () => { throw new Error('不应发起请求'); });
        try {
            await handleCronJob(mockEnv(kv));
            expect(readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!.lastCheck).toBeUndefined();
        } finally { stub.restore(); }
    });

    it('间隔未到 → 跳过（不发请求）', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 30, lastCheck: Date.now() } });
        const stub = stubFetch([], () => { throw new Error('不应发起请求'); });
        try {
            await handleCronJob(mockEnv(kv));
            expect(stub.calls).toHaveLength(0);
        } finally { stub.restore(); }
    });

    it('无账号 → 更新 lastCheck 避免重复触发', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 1, lastCheck: 0 } });
        const stub = stubFetch([]);
        try {
            await handleCronJob(mockEnv(kv));
            expect(readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!.lastCheck).toBeGreaterThan(0);
        } finally { stub.restore(); }
    });

    it('ech 参与版本检查（此前被 uuidField 条件静默排除，UI 开关形同虚设）', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 1, lastCheck: 0, fuseThreshold: 0 } });
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_ech: ['e1'] })]);
        const stub = stubFetch([
            { match: '/graphql', respond: () => statsResponse(10) },
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) },
            { match: '/subdomain', respond: () => cfOk({}) }
        ]);
        try {
            await handleCronJob(env);
            // ech 的 Worker 被上传 → 说明它进入了自动更新流程
            const echUpload = stub.calls.find(c => c.method === 'PUT' && c.url.includes('/scripts/e1'));
            expect(echUpload).toBeDefined();
        } finally { stub.restore(); }
    });

    it('模板开关关闭 → 该模板不部署', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 1, lastCheck: 0, autoEch: false } });
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_ech: ['e1'] })]);
        const stub = stubFetch([
            { match: '/graphql', respond: () => statsResponse(10) },
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) },
            { match: '/subdomain', respond: () => cfOk({}) }
        ]);
        try {
            await handleCronJob(env);
            expect(stub.calls.find(c => c.method === 'PUT' && c.url.includes('/scripts/e1'))).toBeUndefined();
        } finally { stub.restore(); }
    });

    it('熔断触发时仍继续做版本更新（不再互斥）', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 1, lastCheck: 0, fuseThreshold: 50 } });
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1'], dailyLimit: 100 })]);
        const stub = stubFetch([
            { match: '/graphql', respond: () => statsResponse(100) },   // 100/100 = 100% ≥ 50%
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/', respond: () => cfOk({}) },
            { match: '/subdomain', respond: () => cfOk({}) }
        ]);
        try {
            await handleCronJob(env);
            // 熔断轮换写了账号级变量
            expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_A))).not.toBeNull();
            // 同时 deployConfig 也被写（说明版本检查也跑了）
            expect(readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))).not.toBeNull();
        } finally { stub.restore(); }
    });

    it('所有账号 stats 都失败 → 跳过本轮（避免误判触发熔断）', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 1, lastCheck: 0, fuseThreshold: 50 } });
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([{ match: '/graphql', respond: () => htmlErr(403) }]);
        try {
            await handleCronJob(env);
            expect(stub.calls.filter(c => c.url.includes('/workers/scripts/'))).toHaveLength(0);
        } finally { stub.restore(); }
    });

    it('异常路径也持久化 lastCheck（防止每次调度都重跑）', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 1, lastCheck: 0 } });
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([
            { match: '/graphql', respond: () => statsResponse(1) },
            { match: 'raw.githubusercontent.com', respond: () => { throw new Error('network down'); } },
            { match: 'api.github.com', respond: () => { throw new Error('network down'); } }
        ]);
        try {
            await handleCronJob(env);
            expect(readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!.lastCheck).toBeGreaterThan(0);
        } finally { stub.restore(); }
    });

    it('lastCheck 写入不覆盖本轮其他字段（重读后合并）', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 1, lastCheck: 0, fuseWebhook: 'https://h/x' } });
        const stub = stubFetch([]);
        try {
            await handleCronJob(mockEnv(kv));
            const cfg = readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!;
            expect(cfg.fuseWebhook).toBe('https://h/x');
            expect(cfg.enabled).toBe(true);
        } finally { stub.restore(); }
    });
});

// ============================================================
// CRUD 路由：真实 handler + 内存 KV
// ============================================================
describe('CRUD 路由', () => {
    async function call(method: string, path: string, env: AppEnv, body?: unknown): Promise<Response> {
        const handler = getRoute(method, path.split('?')[0]);
        expect(handler, method + ' ' + path).toBeTypeOf('function');
        return handler!(jsonReq(method, 'https://x' + path, body), env);
    }

    it('POST /api/settings 拒绝非数组（此前任意 JSON 直接落 KV）', async () => {
        const kv = mockKV();
        const res = await call('POST', '/api/settings?type=cmliu', mockEnv(kv), { UUID: 'x' });
        expect(res.status).toBe(400);
        expect(readKV(kv, KV_KEYS.vars('cmliu'))).toBeNull();
    });

    it('POST /api/settings 接受合法数组并归一化', async () => {
        const kv = mockKV();
        const res = await call('POST', '/api/settings?type=cmliu', mockEnv(kv), [{ key: 'UUID', value: 'x', junk: 1 }]);
        expect(res.status).toBe(200);
        expect(readKV<any[]>(kv, KV_KEYS.vars('cmliu'))).toEqual([{ key: 'UUID', value: 'x' }]);
    });

    it('GET /api/settings 未知模板类型 → 400', async () => {
        const res = await call('GET', '/api/settings?type=evil', mockEnv(mockKV()));
        expect(res.status).toBe(400);
    });

    it('POST /api/accounts 拒绝重复 alias', async () => {
        const kv = mockKV();
        const res = await call('POST', '/api/accounts', mockEnv(kv), [
            { alias: 'dup', accountId: AID_A, email: 'a@x.com', globalKey: 'K' },
            { alias: 'dup', accountId: AID_B, email: 'b@x.com', globalKey: 'K' }
        ]);
        expect(res.status).toBe(400);
        expect((await res.json() as any).msg).toContain('重复');
    });

    it('GET /api/accounts 返回脱敏后的 key', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ globalKey: '1234567890abcdef' })]);
        const body: any = await (await call('GET', '/api/accounts', env)).json();
        expect(body[0].globalKey).toBe('123456...cdef');
    });

    it('POST /api/auto_config 校验并保留 lastCheck', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { lastCheck: 999 } });
        const env = mockEnv(kv);
        const bad = await call('POST', '/api/auto_config', env, { interval: 99999 });
        expect(bad.status).toBe(400);
        const ok = await call('POST', '/api/auto_config', env, { enabled: true, interval: 30, fuseThreshold: 90 });
        expect(ok.status).toBe(200);
        const saved = readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!;
        expect(saved.lastCheck).toBe(999);
        expect(saved.interval).toBe(30);
    });

    it('POST /api/favorites 校验 action 与 sha', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        expect((await call('POST', '/api/favorites?type=cmliu', env, { action: 'evil', item: { sha: 'abcdefg' } })).status).toBe(400);
        expect((await call('POST', '/api/favorites?type=cmliu', env, { action: 'add', item: {} })).status).toBe(400);
        expect((await call('POST', '/api/favorites?type=cmliu', env, { action: 'add', item: { sha: 'zzz' } })).status).toBe(400);
        const ok = await call('POST', '/api/favorites?type=cmliu', env, { action: 'add', item: { sha: 'abc1234', message: 'm', evil: 'x' } });
        expect(ok.status).toBe(200);
        const favs = readKV<any[]>(kv, KV_KEYS.favorites('cmliu'))!;
        expect(favs).toHaveLength(1);
        expect('evil' in favs[0]).toBe(false);
    });

    it('POST /api/favorites remove 幂等', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await call('POST', '/api/favorites?type=cmliu', env, { action: 'add', item: { sha: 'abc1234' } });
        await call('POST', '/api/favorites?type=cmliu', env, { action: 'remove', item: { sha: 'abc1234' } });
        await call('POST', '/api/favorites?type=cmliu', env, { action: 'remove', item: { sha: 'abc1234' } });
        expect(readKV<any[]>(kv, KV_KEYS.favorites('cmliu'))).toEqual([]);
    });

    it('POST /api/restore 拒绝白名单外的键并报告', async () => {
        const kv = mockKV();
        const res = await call('POST', '/api/restore', mockEnv(kv), {
            [KV_KEYS.ACCOUNTS]: [],
            'VARS_cmliuX': ['evil'],
            'SESSION_forged': 'x'
        });
        const body: any = await res.json();
        expect(body.restored).toBe(1);
        expect(body.rejected).toBe(2);
        expect(await kv.get('SESSION_forged')).toBeNull();
    });

    it('GET /api/backup 带密钥指纹，恢复时可校验', async () => {
        const kv = mockKV();
        const env = mockEnv(kv, { ENCRYPTION_SECRET: 's1' });
        await seedAccounts(env, [acct()]);
        const body: any = await (await call('GET', '/api/backup', env)).json();
        expect(body._encryptionFingerprint).toMatch(/^[0-9a-f]{8}$/);
        const res = await call('POST', '/api/restore', mockEnv(kv, { ENCRYPTION_SECRET: 's2' }), body);
        expect((await res.json() as any).warning).toContain('不同的加密密钥');
    });

    it('GET /api/backup 包含账号级变量覆盖键', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await kv.put(KV_KEYS.accountVars('cmliu', AID_A), JSON.stringify([{ key: 'UUID', value: 'x' }]));
        const body: any = await (await call('GET', '/api/backup', env)).json();
        expect(body[KV_KEYS.accountVars('cmliu', AID_A)]).toEqual([{ key: 'UUID', value: 'x' }]);
    });

    it('账号导出/导入往返（同密钥）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv, { ENCRYPTION_SECRET: 'same' });
        await seedAccounts(env, [acct({ globalKey: 'ORIGINAL_KEY' })]);
        const exported: any = await (await call('GET', '/api/accounts/export', env)).json();
        expect(exported._format).toBe('worker-pro-accounts@2');

        const kv2 = mockKV();
        const env2 = mockEnv(kv2, { ENCRYPTION_SECRET: 'same' });
        const res = await call('POST', '/api/accounts/import', env2, exported);
        expect((await res.json() as any).added).toBe(1);
        const stored = readKV<AccountEntry[]>(kv2, KV_KEYS.ACCOUNTS)!;
        expect(stored[0].globalKey.startsWith('v1:')).toBe(true);
    });

    it('账号导入：密钥不匹配时清空 key 并给出警告（不双重加密）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv, { ENCRYPTION_SECRET: 's1' });
        await seedAccounts(env, [acct()]);
        const exported: any = await (await call('GET', '/api/accounts/export', env)).json();

        const kv2 = mockKV();
        const env2 = mockEnv(kv2, { ENCRYPTION_SECRET: 's2' });
        const body: any = await (await call('POST', '/api/accounts/import', env2, exported)).json();
        expect(body.warning).toContain('解密失败');
        expect(readKV<AccountEntry[]>(kv2, KV_KEYS.ACCOUNTS)![0].globalKey).toBe('');
    });

    it('账号导入兼容旧版裸数组格式', async () => {
        const kv = mockKV();
        const res = await call('POST', '/api/accounts/import', mockEnv(kv), [
            { alias: 'legacy', accountId: AID_A, email: 'e@x.com', globalKey: 'PLAIN' }
        ]);
        expect((await res.json() as any).added).toBe(1);
    });

    it('账号导入拒绝非法结构', async () => {
        expect((await call('POST', '/api/accounts/import', mockEnv(mockKV()), { foo: 1 })).status).toBe(400);
    });

    it('GET /api/diag 报告密钥配置状态但不泄漏值', async () => {
        const kv = mockKV();
        const env = mockEnv(kv, { GITHUB_TOKEN: 'ghp_secret', ENCRYPTION_SECRET: 'enc_secret' });
        const text = await (await call('GET', '/api/diag', env)).text();
        expect(text).toContain('"__github_token_set": true');
        expect(text).toContain('"__encryption_secret_set": true');
        expect(text).not.toContain('ghp_secret');
        expect(text).not.toContain('enc_secret');
    });

    it('GET /api/deploy/preview 提示密钥缺失的账号', async () => {
        const kv = mockKV({
            [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: AID_A, email: 'e', globalKey: '', workers_cmliu: ['w1'] }]
        });
        const body: any = await (await call('GET', '/api/deploy/preview?type=cmliu', mockEnv(kv))).json();
        expect(body.workers).toBe(1);
        expect(body.warning).toContain('密钥缺失');
    });

    it('GET /api/init_data 一次返回 accounts/vars/deployConfigs 且 key 已脱敏', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct({ globalKey: '1234567890abcdef' })]);
        await kv.put(KV_KEYS.vars('cmliu'), JSON.stringify([{ key: 'UUID', value: 'u' }]));
        const body: any = await (await call('GET', '/api/init_data', env)).json();
        expect(body.accounts[0].globalKey).toBe('123456...cdef');
        expect(body.vars.cmliu).toEqual([{ key: 'UUID', value: 'u' }]);
        expect(Object.keys(body.deployConfigs).length).toBeGreaterThan(0);
    });

    it('GET /api/init_data 对损坏的 KV 值降级为 null 而非整体失败', async () => {
        const kv = mockKV();
        await kv.put(KV_KEYS.vars('cmliu'), 'not json');
        const body: any = await (await call('GET', '/api/init_data', mockEnv(kv))).json();
        expect(body.vars.cmliu).toBeNull();
    });

    it('GET /api/verify_credentials 前置校验不发无意义请求', async () => {
        const kv = mockKV({
            [KV_KEYS.ACCOUNTS]: [
                { alias: 'no-key', accountId: AID_A, email: 'e', globalKey: '' },
                { alias: 'no-id', accountId: '', email: 'e', globalKey: 'K' }
            ]
        });
        const stub = stubFetch([], () => { throw new Error('不应发起请求'); });
        try {
            const body: any = await (await call('GET', '/api/verify_credentials', mockEnv(kv))).json();
            expect(body[0].error).toContain('解密失败');
            expect(body[1].error).toContain('Account ID');
            expect(stub.calls).toHaveLength(0);
        } finally { stub.restore(); }
    });

    it('GET /api/verify_credentials 透出 CF 原始错误消息', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seedAccounts(env, [acct()]);
        const stub = stubFetch([{ match: '/accounts/', respond: () => cfErr(403, 'Unknown X-Auth-Key or X-Auth-Email', 9103) }]);
        try {
            const body: any = await (await call('GET', '/api/verify_credentials', env)).json();
            expect(body[0].ok).toBe(false);
            expect(body[0].error).toBe('Unknown X-Auth-Key or X-Auth-Email');
        } finally { stub.restore(); }
    });
});
