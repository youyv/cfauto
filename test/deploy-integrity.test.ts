/**
 * 部署可信度回归测试 —— 对应线上那次「面板显示已更新、实际没更新」故障。
 *
 * 三条必须同时成立，缺一条就会出现"账本说已是最新、Worker 停在旧代码且永不重试"：
 *  1. 上传响应必须看响应体，HTTP 200 + success:false 不能算成功；
 *  2. 上传后要回读脚本内容，内容对不上要按失败处理；
 *  3. 只有「全量目标」的部署才允许推进版本账本，子集部署（熔断/修复/批量/重试）不能。
 */
import { describe, it, expect } from 'vitest';
import { getRoute } from '../src/routes/register';
import { coreDeployLogic, finalizeDeploy, mergeSubsetPending } from '../src/lib/auto-update';
import { uploadWorker } from '../src/lib/deploy-utils';
import { writeAccounts } from '../src/lib/account-store';
import { KV_KEYS } from '../src/config/templates';
import { mockKV, mockEnv, readKV, cfOk, cfErr, cfScript, cfRaw, scriptEndpoint, stubFetch } from './helpers';
import type { AppEnv } from '../src/config/env';
import type { AccountEntry, DeployConfig, DeployLogEntry } from '../src/lib/types';

const AID_A = 'a'.repeat(32);
const STUB_CODE = 'const CF_FALLBACK_IPS = [];';

function acct(over: Partial<AccountEntry> = {}): AccountEntry {
    return { alias: 'acc-a', accountId: AID_A, email: 'a@x.com', globalKey: 'KEY_A', ...over };
}

function githubRoutes(sha = 'sha-remote', code = STUB_CODE) {
    return [
        { match: 'raw.githubusercontent.com', respond: () => new Response(code, { status: 200 }) },
        {
            match: 'api.github.com',
            respond: () => new Response(JSON.stringify([{
                sha,
                commit: { message: 'm', author: { name: 'n', date: '2026-01-01T00:00:00Z' }, committer: { date: '2026-01-01T00:00:00Z' } }
            }]), { status: 200 })
        }
    ];
}

async function seed(env: AppEnv, accounts: AccountEntry[]) {
    await writeAccounts(env, accounts);
}

function okLog(targetKey: string): DeployLogEntry {
    return { name: 'acc -> [w]', success: true, msg: 'ok', targetKey };
}

// ============================================================
// 1. 上传响应判定
// ============================================================
describe('uploadWorker — 不能被 HTTP 200 蒙混', () => {
    const cred = { accountId: AID_A, email: 'a@x.com', globalKey: 'KEY_A' };

    it('HTTP 200 但响应体 success:false → 判为失败并带出上游原因', async () => {
        const stub = stubFetch([{
            match: '/workers/scripts/',
            respond: () => cfRaw({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null })
        }]);
        try {
            const res = await uploadWorker(cred, 'w1', STUB_CODE, []);
            expect(res.ok).toBe(false);
            expect(res.error).toContain('Authentication error');
            expect(res.error).toContain('success:false');
        } finally { stub.restore(); }
    });

    it('HTTP 非 2xx → 失败并带出状态码', async () => {
        const stub = stubFetch([{ match: '/workers/scripts/', respond: () => cfErr(500, 'boom') }]);
        try {
            const res = await uploadWorker(cred, 'w1', STUB_CODE, []);
            expect(res.ok).toBe(false);
            expect(res.error).toContain('boom');
        } finally { stub.restore(); }
    });

    it('正常 200 + success:true → 成功', async () => {
        const stub = stubFetch([{ match: '/workers/scripts/', respond: () => cfOk({ id: 'w1' }) }]);
        try {
            const res = await uploadWorker(cred, 'w1', STUB_CODE, []);
            expect(res.ok).toBe(true);
            expect(res.error).toBeUndefined();
        } finally { stub.restore(); }
    });
});

// ============================================================
// 2. 回读校验
// ============================================================
describe('coreDeployLogic — 上传后回读校验', () => {
    it('回读内容对不上 → 目标判失败、账本不推进、进重试队列', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seed(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            // 上传成功，但回读回来的是另一份脚本 —— 模拟"写进去了却没生效"
            { match: /\/workers\/scripts\/[^/?]+$/, respond: (c) => c.method === 'GET' ? cfScript('别人的脚本') : cfOk({}) }
        ]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [] });
            expect(logs[0].success).toBe(false);
            expect(logs[0].verify).toBe('mismatch');
            expect(logs[0].msg).toContain('回读校验');
            const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
            expect(cfg.currentSha).toBeUndefined();
            expect(cfg.pendingTargets).toEqual([AID_A + '::w1']);
        } finally { stub.restore(); }
    });

    it('回读内容一致（含 BOM / CRLF 差异）→ 判成功并标记 verified', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seed(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: /\/workers\/scripts\/[^/?]+$/, respond: (c) => c.method === 'GET' ? cfScript('\uFEFF' + STUB_CODE.replace(/\n/g, '\r\n')) : cfOk({}) }
        ]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [] });
            expect(logs[0].success).toBe(true);
            expect(logs[0].verify).toBe('verified');
        } finally { stub.restore(); }
    });

    it('回读请求失败 → 不误判失败，标记 unverified', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seed(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            { match: /\/workers\/scripts\/[^/?]+$/, respond: (c) => c.method === 'GET' ? cfErr(502, 'gateway') : cfOk({}) }
        ]);
        try {
            const logs = await coreDeployLogic(env, { type: 'cmliu', variables: [] });
            expect(logs[0].success).toBe(true);
            expect(logs[0].verify).toBe('unverified');
            expect(logs[0].msg).toContain('回读校验不可用');
        } finally { stub.restore(); }
    });
});

// ============================================================
// 3. 版本账本只在「全量 + 全成功」时推进
// ============================================================
describe('finalizeDeploy — 作用域与账本完整性', () => {
    function seededKv(prev: Partial<DeployConfig> = {}) {
        return mockKV({
            [KV_KEYS.deployConfig('cmliu')]: { mode: 'latest', currentSha: 'sha-old', deployTime: '2026-01-01T00:00:00Z', ...prev }
        });
    }

    it('子集作用域全部成功 → 账本一动不动', async () => {
        const kv = seededKv();
        const stub = stubFetch(githubRoutes());
        try {
            await finalizeDeploy(mockEnv(kv), 'cmliu', true, 'sha-new', [okLog(AID_A + '::w1')], '', 'partial');
        } finally { stub.restore(); }
        const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
        expect(cfg.currentSha).toBe('sha-old');
        expect(cfg.deployTime).toBe('2026-01-01T00:00:00Z');
    });

    it('子集作用域：只移除本轮成功的 pending 项，其余原样保留', async () => {
        const kv = seededKv({ pendingTargets: [AID_A + '::w1', AID_A + '::w2'], pendingSha: 'sha-old' });
        const stub = stubFetch(githubRoutes());
        try {
            await finalizeDeploy(mockEnv(kv), 'cmliu', true, 'sha-old', [okLog(AID_A + '::w1')], '', 'partial');
        } finally { stub.restore(); }
        const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
        expect(cfg.currentSha).toBe('sha-old');
        expect(cfg.pendingTargets).toEqual([AID_A + '::w2']);
        expect(cfg.pendingSha).toBe('sha-old');
    });

    it('全量作用域全部成功 → 账本推进（保持原有语义）', async () => {
        const kv = seededKv();
        const stub = stubFetch(githubRoutes());
        try {
            await finalizeDeploy(mockEnv(kv), 'cmliu', true, 'sha-new', [okLog(AID_A + '::w1')], '', 'full');
        } finally { stub.restore(); }
        const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
        expect(cfg.currentSha).toBe('sha-new');
        expect(cfg.pendingTargets).toEqual([]);
    });

    it('mergeSubsetPending: 本轮没碰到的目标不会被抹掉', () => {
        const prev: DeployConfig = { mode: 'latest', pendingTargets: ['a::w1', 'a::w2', 'a::w3'], pendingSha: 'sha-old' };
        const logs: DeployLogEntry[] = [
            okLog('a::w1'),
            { name: 'x', success: false, msg: 'err', targetKey: 'a::w4' }
        ];
        expect(mergeSubsetPending(prev, logs)).toEqual(['a::w2', 'a::w3', 'a::w4']);
    });

    it('子集部署（熔断轮换）不会把账本推进到新 SHA', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seed(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([]) },
            scriptEndpoint(STUB_CODE)
        ]);
        try {
            await coreDeployLogic(env, { type: 'cmliu', variables: [], targetAccountIds: [AID_A] });
        } finally { stub.restore(); }
        const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
        expect(cfg.currentSha).toBeUndefined();
    });
});

// ============================================================
// 4. 系统诊断里的实况漂移检测
// ============================================================
describe('/api/diag — 账本 vs 实况漂移', () => {
    it('脚本修改时间早于部署时间 → 报 drifted；账本里有但 CF 上没有 → 报 missing', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seed(env, [acct({ workers_cmliu: ['old-script', 'vanished'] })]);
        await kv.put(KV_KEYS.deployConfig('cmliu'), JSON.stringify({
            mode: 'latest', currentSha: 'sha-remote', deployTime: '2026-09-11T00:00:00Z'
        }));
        const stub = stubFetch([{
            match: '/workers/scripts',
            respond: () => cfOk([{ id: 'old-script', modified_on: '2026-09-01T00:00:00Z' }])
        }]);
        try {
            const handler = getRoute('GET', '/api/diag');
            expect(handler).toBeTruthy();
            const body: any = await (await handler!(new Request('https://x/api/diag'), env)).json();
            expect(body.__deploy_drift.checked).toBe(2);
            expect(body.__deploy_drift.drifted).toHaveLength(1);
            expect(body.__deploy_drift.drifted[0]).toContain('old-script');
            expect(body.__deploy_drift.missing).toHaveLength(1);
            expect(body.__deploy_drift.missing[0]).toContain('vanished');
        } finally { stub.restore(); }
    });

    it('脚本修改时间晚于部署时间 → 不算漂移', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await seed(env, [acct({ workers_cmliu: ['fresh'] })]);
        await kv.put(KV_KEYS.deployConfig('cmliu'), JSON.stringify({
            mode: 'latest', currentSha: 'sha-remote', deployTime: '2026-09-11T00:00:00Z'
        }));
        const stub = stubFetch([{
            match: '/workers/scripts',
            respond: () => cfOk([{ id: 'fresh', modified_on: '2026-09-11T00:01:00Z' }])
        }]);
        try {
            const handler = getRoute('GET', '/api/diag')!;
            const body: any = await (await handler(new Request('https://x/api/diag'), env)).json();
            expect(body.__deploy_drift.drifted).toEqual([]);
            expect(body.__deploy_drift.missing).toEqual([]);
        } finally { stub.restore(); }
    });
});
