import { describe, it, expect, afterEach } from 'vitest';
import { pooledMap, pooledMapSettled, DEFAULT_CONCURRENCY } from '../src/lib/concurrency';
import { readApiJson, readApiResult, jsonError, json, safeJson, fetchWithTimeout, cf, getAuthHeaders } from '../src/lib/cloudflare-api';
import { fetchInternalStats } from '../src/lib/stats';
import { isFuseTriggered } from '../src/cron';
import { mergePendingTargets, resolveUpdatePlan, rotateUuidField, deployTargetKey } from '../src/lib/auto-update';
import { rebuildBindings, randomSubdomain } from '../src/routes/fix1101';
import { parseRegionPools, YXIP_TARGET_JOEY_VAR } from '../src/routes/yxip';
import { mockKV, jsonReq, cfOk, cfErr, htmlErr, stubFetch } from './helpers';
import type { DeployConfig, DeployLogEntry, AccountEntry } from '../src/lib/types';

// ============================================================
// concurrency: pooledMap / pooledMapSettled
// ============================================================
describe('pooledMap', () => {
    it('保持输入顺序', async () => {
        const out = await pooledMap([1, 2, 3, 4, 5], async (n) => {
            await new Promise(r => setTimeout(r, (6 - n) * 5));   // 故意倒序完成
            return n * 10;
        }, 3);
        expect(out).toEqual([10, 20, 30, 40, 50]);
    });

    it('遵守并发上限', async () => {
        let inFlight = 0, peak = 0;
        await pooledMap(Array.from({ length: 20 }, (_, i) => i), async () => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
        }, 4);
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBeGreaterThan(1);   // 确实并发了
    });

    it('空数组返回空数组，不启动 worker', async () => {
        let called = 0;
        expect(await pooledMap([], async () => { called++; return 1; })).toEqual([]);
        expect(called).toBe(0);
    });

    it('并发度 <= 0 归一为 1（串行）', async () => {
        let inFlight = 0, peak = 0;
        await pooledMap([1, 2, 3], async () => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 1));
            inFlight--;
        }, 0);
        expect(peak).toBe(1);
    });

    it('并发度大于元素数时不出错', async () => {
        expect(await pooledMap([1, 2], async (n) => n, 100)).toEqual([1, 2]);
    });

    it('任一任务抛错则整体 reject（调用方需自行包裹）', async () => {
        await expect(pooledMap([1, 2, 3], async (n) => {
            if (n === 2) throw new Error('boom');
            return n;
        }, 2)).rejects.toThrow('boom');
    });

    it('worker 收到正确的索引', async () => {
        expect(await pooledMap(['a', 'b', 'c'], async (item, i) => item + i, 2)).toEqual(['a0', 'b1', 'c2']);
    });

    it('默认并发度为 5（兼顾吞吐与 CF 限流余量）', () => {
        expect(DEFAULT_CONCURRENCY).toBe(5);
    });
});

describe('pooledMapSettled', () => {
    it('单项失败不影响其余项', async () => {
        const out = await pooledMapSettled([1, 2, 3], async (n) => {
            if (n === 2) throw new Error('fail-' + n);
            return n * 2;
        }, 2);
        expect(out[0]).toEqual({ ok: true, value: 2 });
        expect(out[1].ok).toBe(false);
        if (!out[1].ok) expect(out[1].error.message).toBe('fail-2');
        expect(out[2]).toEqual({ ok: true, value: 6 });
    });

    it('非 Error 抛出被包成 Error', async () => {
        const out = await pooledMapSettled([1], async () => { throw 'str'; });
        expect(out[0].ok).toBe(false);
        if (!out[0].ok) expect(out[0].error).toBeInstanceOf(Error);
    });
});

// ============================================================
// cloudflare-api: readApiJson / readApiResult
// ============================================================
describe('readApiJson', () => {
    it('2xx JSON 正常解析', async () => {
        const body = await readApiJson<{ result: number }>(cfOk(42), 'test');
        expect(body.result).toBe(42);
    });

    it('非 2xx 抛错并带上上游错误消息（不再静默变成 TypeError）', async () => {
        await expect(readApiJson(cfErr(403, 'Unknown X-Auth-Key'), '读取绑定'))
            .rejects.toThrow(/读取绑定.*Unknown X-Auth-Key.*403/);
    });

    it('非 2xx 且响应体是 HTML 时保留状态码', async () => {
        await expect(readApiJson(htmlErr(502), '读取列表')).rejects.toThrow(/读取列表.*502/);
    });

    it('2xx 但响应体不是 JSON → 明确报错而非 TypeError', async () => {
        const res = new Response('plain text', { status: 200 });
        await expect(readApiJson(res, '读取')).rejects.toThrow(/不是合法 JSON/);
    });

    it('readApiResult 直接取 result 字段', async () => {
        expect(await readApiResult(cfOk([{ id: 'x' }]), 'test')).toEqual([{ id: 'x' }]);
    });

    it('readApiResult 在 result 缺失时返回 undefined（调用方用 || [] 兜底）', async () => {
        const res = new Response(JSON.stringify({ success: true }), { status: 200 });
        expect(await readApiResult(res, 'test')).toBeUndefined();
    });
});

describe('json / jsonError 响应头', () => {
    it('jsonError 带安全头与可选错误码', async () => {
        const res = jsonError('bad', 400, 'VALIDATION_ERROR');
        expect(res.status).toBe(400);
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('X-Frame-Options')).toBe('DENY');
        const body: any = await res.json();
        expect(body).toEqual({ success: false, msg: 'bad', code: 'VALIDATION_ERROR' });
    });

    it('json 支持数字状态码与 ResponseInit 两种形态', async () => {
        expect(json({ a: 1 }, 201).status).toBe(201);
        const withHeaders = json({ a: 1 }, { headers: [['Set-Cookie', 'x=1']] });
        expect(withHeaders.headers.get('Content-Type')).toContain('application/json');
        expect(withHeaders.headers.get('X-Frame-Options')).toBe('DENY');
    });
});

describe('safeJson', () => {
    it('合法 JSON 正常解析', async () => {
        expect(await safeJson(jsonReq('POST', 'https://x/', { a: 1 }))).toEqual({ a: 1 });
    });
    it('非法 JSON 抛出 400 Response（由错误边界原样返回）', async () => {
        const req = new Request('https://x/', { method: 'POST', body: '{bad' });
        await expect(safeJson(req)).rejects.toBeInstanceOf(Response);
    });
});

describe('fetchWithTimeout', () => {
    afterEach(() => { /* stub 在各用例内自行 restore */ });

    it('正常响应直接返回', async () => {
        const stub = stubFetch([{ match: 'example.com', respond: () => new Response('ok') }]);
        try {
            const res = await fetchWithTimeout('https://example.com/');
            expect(await res.text()).toBe('ok');
        } finally { stub.restore(); }
    });

    it('超时后 abort（不会无限挂起耗尽 CPU 预算）', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = ((_url: any, init?: RequestInit) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        })) as typeof fetch;
        try {
            await expect(fetchWithTimeout('https://slow.example.com/', {}, 20)).rejects.toThrow();
        } finally { globalThis.fetch = original; }
    });
});

describe('cf URL 构建器', () => {
    it('生成的 URL 都指向 CF v4 API', () => {
        const aid = 'a'.repeat(32);
        expect(cf.workerScript(aid, 'w')).toBe('https://api.cloudflare.com/client/v4/accounts/' + aid + '/workers/scripts/w');
        expect(cf.workerBindings(aid, 'w')).toContain('/bindings');
        expect(cf.account(aid)).toBe('https://api.cloudflare.com/client/v4/accounts/' + aid);
        expect(cf.graphql()).toContain('/graphql');
    });

    it('verify_credentials 不再使用只支持 Bearer 的 /user/tokens/verify', () => {
        expect(cf.account('x')).not.toContain('/user/tokens/verify');
    });

    it('getAuthHeaders: 上传场景不带 Content-Type（交给 FormData）', () => {
        expect(getAuthHeaders('e@x.com', 'K')['Content-Type']).toBe('application/json');
        expect('Content-Type' in getAuthHeaders('e@x.com', 'K', true)).toBe(false);
    });
});

// ============================================================
// stats: fetchInternalStats（stub fetch，验证错误路径）
// ============================================================
describe('fetchInternalStats', () => {
    const acc = (over: Partial<AccountEntry> = {}): AccountEntry =>
        ({ alias: 'a1', accountId: 'a'.repeat(32), email: 'e@x.com', globalKey: 'K', ...over });

    it('正常返回累加后的请求数', async () => {
        const stub = stubFetch([{
            match: '/graphql',
            respond: () => new Response(JSON.stringify({
                data: {
                    viewer: {
                        accounts: [{
                            workersInvocationsAdaptive: [{ sum: { requests: 100 } }, { sum: { requests: 50 } }],
                            pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 7 } }]
                        }]
                    }
                }
            }), { status: 200 })
        }]);
        try {
            const out = await fetchInternalStats([acc()]);
            expect(out[0].total).toBe(157);
            expect(out[0].error).toBeUndefined();
        } finally { stub.restore(); }
    });

    it('GraphQL limit 使用 1000（10000 超出 adaptive 数据集上限会让所有账号恒失败）', async () => {
        const stub = stubFetch([{ match: '/graphql', respond: () => new Response('{"data":{}}', { status: 200 }) }]);
        try {
            await fetchInternalStats([acc()]);
            expect(stub.calls[0].body).toContain('limit: 1000');
            expect(stub.calls[0].body).not.toContain('limit: 10000');
        } finally { stub.restore(); }
    });

    it('HTTP 错误（HTML 错误页）→ 返回 error 字段而非抛异常', async () => {
        const stub = stubFetch([{ match: '/graphql', respond: () => htmlErr(403) }]);
        try {
            const out = await fetchInternalStats([acc()]);
            expect(out[0].error).toContain('HTTP 403');
            expect(out[0].total).toBe(0);
        } finally { stub.restore(); }
    });

    it('GraphQL errors → 透出上游消息', async () => {
        const stub = stubFetch([{
            match: '/graphql',
            respond: () => new Response(JSON.stringify({ errors: [{ message: 'insufficient permissions' }] }), { status: 200 })
        }]);
        try {
            expect((await fetchInternalStats([acc()]))[0].error).toBe('insufficient permissions');
        } finally { stub.restore(); }
    });

    it('accounts 为空数组 → 明确提示检查 Account ID', async () => {
        const stub = stubFetch([{
            match: '/graphql',
            respond: () => new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), { status: 200 })
        }]);
        try {
            expect((await fetchInternalStats([acc()]))[0].error).toContain('Account ID');
        } finally { stub.restore(); }
    });

    it('globalKey 缺失 → 不发请求，直接给可操作提示', async () => {
        const stub = stubFetch([], () => { throw new Error('不应发起请求'); });
        try {
            const out = await fetchInternalStats([acc({ globalKey: '' })]);
            expect(out[0].error).toContain('解密失败');
            expect(stub.calls).toHaveLength(0);
        } finally { stub.restore(); }
    });

    it('用量 > 10 万时推断为付费计划（免费计划硬上限 10 万）', async () => {
        const stub = stubFetch([{
            match: '/graphql',
            respond: () => new Response(JSON.stringify({
                data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 200000 } }] }] } }
            }), { status: 200 })
        }]);
        try {
            expect((await fetchInternalStats([acc()]))[0].max).toBe(10000000);
        } finally { stub.restore(); }
    });

    it('显式 dailyLimit 优先于推断值', async () => {
        const stub = stubFetch([{
            match: '/graphql',
            respond: () => new Response(JSON.stringify({
                data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 500000 } }] }] } }
            }), { status: 200 })
        }]);
        try {
            expect((await fetchInternalStats([acc({ dailyLimit: 123456 })]))[0].max).toBe(123456);
        } finally { stub.restore(); }
    });
});

// ============================================================
// cron: isFuseTriggered
// ============================================================
describe('isFuseTriggered', () => {
    it('阈值为 0 视为关闭熔断', () => {
        expect(isFuseTriggered({ total: 999999, max: 100000 }, 0)).toBe(false);
    });
    it('stats 缺失或报错时不触发（避免误判）', () => {
        expect(isFuseTriggered(undefined, 90)).toBe(false);
        expect(isFuseTriggered({ total: 100000, max: 100000, error: 'x' }, 90)).toBe(false);
    });
    it('达到阈值触发', () => {
        expect(isFuseTriggered({ total: 90000, max: 100000 }, 90)).toBe(true);
        expect(isFuseTriggered({ total: 89999, max: 100000 }, 90)).toBe(false);
    });
    it('max 为 0 时不触发（避免除零得到 Infinity）', () => {
        expect(isFuseTriggered({ total: 1, max: 0 }, 90)).toBe(false);
    });
    it('阈值 100 需要真正达到 100%', () => {
        expect(isFuseTriggered({ total: 99999, max: 100000 }, 100)).toBe(false);
        expect(isFuseTriggered({ total: 100000, max: 100000 }, 100)).toBe(true);
    });
});

// ============================================================
// auto-update: pendingTargets / 更新计划 / UUID 轮换
// ============================================================
describe('deployTargetKey', () => {
    it('由 accountId + workerName 构成稳定标识', () => {
        expect(deployTargetKey('acc1', 'w1')).toBe('acc1::w1');
        expect(deployTargetKey('acc1', 'w1')).not.toBe(deployTargetKey('acc2', 'w1'));
    });
});

describe('mergePendingTargets', () => {
    const log = (targetKey: string, success: boolean): DeployLogEntry => ({ name: targetKey, success, msg: '', targetKey });

    it('全部成功 → 空集合', () => {
        const prev: DeployConfig = { mode: 'latest', pendingSha: 'sha1', pendingTargets: ['a::1'] };
        expect(mergePendingTargets(prev, 'sha1', [log('a::1', true)])).toEqual([]);
    });

    it('失败项进入 pending', () => {
        const prev: DeployConfig = { mode: 'latest' };
        expect(mergePendingTargets(prev, 'sha1', [log('a::1', false), log('a::2', true)])).toEqual(['a::1']);
    });

    it('同 SHA 下保留上一轮未处理的 pending', () => {
        const prev: DeployConfig = { mode: 'latest', pendingSha: 'sha1', pendingTargets: ['a::1', 'a::2'] };
        // 本轮只重试了 a::1 且成功
        expect(mergePendingTargets(prev, 'sha1', [log('a::1', true)])).toEqual(['a::2']);
    });

    it('SHA 变化 → 丢弃旧 pending（旧目标已无意义）', () => {
        const prev: DeployConfig = { mode: 'latest', pendingSha: 'sha1', pendingTargets: ['a::1'] };
        expect(mergePendingTargets(prev, 'sha2', [log('a::2', false)])).toEqual(['a::2']);
    });

    it('忽略无 targetKey 的汇总日志', () => {
        const prev: DeployConfig = { mode: 'latest' };
        expect(mergePendingTargets(prev, 'sha1', [{ name: '提示', success: false, msg: '无账号配置' }])).toEqual([]);
    });
});

describe('resolveUpdatePlan', () => {
    it('无本地 SHA → 全量部署', () => {
        const p = resolveUpdatePlan({ localSha: null, remoteSha: 'r1', pendingTargets: [] }, null);
        expect(p.shouldDeploy).toBe(true);
        expect(p.targetKeys).toBeNull();
        expect(p.reason).toBe('upstream-ahead');
    });

    it('上游前进 → 全量部署', () => {
        const p = resolveUpdatePlan({ localSha: 'l1', remoteSha: 'r1', pendingTargets: [] }, null);
        expect(p.shouldDeploy).toBe(true);
        expect(p.targetKeys).toBeNull();
    });

    it('SHA 一致且无 pending → 不部署', () => {
        const p = resolveUpdatePlan({ localSha: 'same', remoteSha: 'same', pendingTargets: [] }, null);
        expect(p.shouldDeploy).toBe(false);
        expect(p.reason).toBe('up-to-date');
    });

    it('SHA 一致但有 pending → 只重试 pending 目标（此前会永久跳过）', () => {
        const p = resolveUpdatePlan({ localSha: 'same', remoteSha: 'same', pendingTargets: ['a::1'] }, 'same');
        expect(p.shouldDeploy).toBe(true);
        expect(p.targetKeys).toEqual(['a::1']);
        expect(p.reason).toBe('retry-pending');
    });

    it('pendingSha 与当前远端不一致 → 视为过期 pending，不重试', () => {
        const p = resolveUpdatePlan({ localSha: 'same', remoteSha: 'same', pendingTargets: ['a::1'] }, 'old-sha');
        expect(p.shouldDeploy).toBe(false);
    });

    it('远端 SHA 缺失 → 不部署（GitHub 异常时不应误部署）', () => {
        const p = resolveUpdatePlan({ localSha: 'l', remoteSha: '', pendingTargets: [] }, null);
        expect(p.shouldDeploy).toBe(false);
        expect(p.reason).toBe('no-remote-sha');
    });
});

describe('rotateUuidField', () => {
    it('替换既有 UUID 字段', () => {
        const out = rotateUuidField([{ key: 'UUID', value: 'old' }, { key: 'X', value: '1' }], 'UUID', 'new');
        expect(out.find(v => v.key === 'UUID')!.value).toBe('new');
        expect(out.find(v => v.key === 'X')!.value).toBe('1');
    });

    it('字段缺失时追加', () => {
        const out = rotateUuidField([{ key: 'X', value: '1' }], 'UUID', 'new');
        expect(out).toHaveLength(2);
        expect(out.find(v => v.key === 'UUID')!.value).toBe('new');
    });

    it('不原地修改入参（避免污染调用方持有的全局变量数组）', () => {
        const input = [{ key: 'UUID', value: 'old' }];
        rotateUuidField(input, 'UUID', 'new');
        expect(input[0].value).toBe('old');
    });
});

// ============================================================
// fix1101: rebuildBindings / randomSubdomain
// ============================================================
describe('rebuildBindings', () => {
    it('KV 变量值优先于 CF 返回的旧值', () => {
        const { bindings } = rebuildBindings(
            [{ name: 'UUID', type: 'plain_text', text: 'old' }],
            [{ key: 'UUID', value: 'from-kv' }]
        );
        expect(bindings.find(b => b.name === 'UUID')!.text).toBe('from-kv');
    });

    it('KV 无值时沿用 CF 返回值', () => {
        const { bindings } = rebuildBindings([{ name: 'UUID', type: 'plain_text', text: 'keep' }], []);
        expect(bindings.find(b => b.name === 'UUID')!.text).toBe('keep');
    });

    it('secret_text 且 KV 无值 → 跳过并报告（写空值会覆盖真实 secret）', () => {
        const { bindings, secretSkipped } = rebuildBindings([{ name: 'TOKEN', type: 'secret_text' }], []);
        expect(bindings.find(b => b.name === 'TOKEN')).toBeUndefined();
        expect(secretSkipped).toEqual(['TOKEN']);
    });

    it('secret_text 有 KV 值 → 用 KV 值恢复', () => {
        const { bindings, secretSkipped } = rebuildBindings(
            [{ name: 'TOKEN', type: 'secret_text' }],
            [{ key: 'TOKEN', value: 'S' }]
        );
        expect(bindings.find(b => b.name === 'TOKEN')!.text).toBe('S');
        expect(secretSkipped).toEqual([]);
    });

    it('KV 命名空间绑定保留 namespace_id', () => {
        const { bindings } = rebuildBindings([{ name: 'KV', type: 'kv_namespace', namespace_id: 'ns1' }], []);
        expect(bindings[0]).toEqual({ name: 'KV', type: 'kv_namespace', namespace_id: 'ns1' });
    });

    it('KV 中新增的变量被补上', () => {
        const { bindings } = rebuildBindings([], [{ key: 'NEW', value: 'v' }]);
        expect(bindings).toEqual([{ name: 'NEW', type: 'plain_text', text: 'v' }]);
    });

    it('未知绑定类型原样保留（如 durable_object / service）', () => {
        const { bindings } = rebuildBindings([{ name: 'DO', type: 'durable_object_namespace', class_name: 'C' }], []);
        expect(bindings[0].type).toBe('durable_object_namespace');
    });

    it('跳过无 name 的脏数据', () => {
        const { bindings } = rebuildBindings([{ type: 'plain_text', text: 'x' } as any], []);
        expect(bindings).toHaveLength(0);
    });
});

describe('randomSubdomain', () => {
    it('形如 w + 6 位字符 + 数字，符合 CF 子域名规则', () => {
        for (let i = 0; i < 20; i++) {
            const s = randomSubdomain();
            expect(s).toMatch(/^w[a-z0-9]{6}\d{1,2}$/);
            expect(s.length).toBeLessThanOrEqual(63);
        }
    });
    it('多次生成不重复（加密安全随机，非 Math.random）', () => {
        const set = new Set(Array.from({ length: 50 }, () => randomSubdomain()));
        expect(set.size).toBeGreaterThan(45);
    });
});

// ============================================================
// yxip: parseRegionPools
// ============================================================
describe('parseRegionPools', () => {
    it('按国家代码分组', () => {
        const pools = parseRegionPools('1.1.1.1:443#HK\n2.2.2.2:443#HK\n3.3.3.3:80#JP');
        expect(Object.keys(pools).sort()).toEqual(['HK', 'JP']);
        expect(pools.HK).toHaveLength(2);
        expect(pools.HK[0].ipPort).toBe('1.1.1.1:443');
    });

    it('剥离 BOM', () => {
        const pools = parseRegionPools('\uFEFF1.1.1.1:443#HK');
        expect(pools.HK).toHaveLength(1);
    });

    it('代码统一大写', () => {
        expect(parseRegionPools('1.1.1.1:443#hk').HK).toHaveLength(1);
    });

    it('忽略无 # 的行、空行与纯注释行', () => {
        const pools = parseRegionPools('no-hash-line\n\n# comment\n1.1.1.1:443#HK');
        expect(Object.keys(pools)).toEqual(['HK']);
    });

    it('缺 ipPort 或缺代码的行被丢弃', () => {
        const pools = parseRegionPools('#HK\n1.1.1.1:443#\n2.2.2.2:443#JP');
        expect(Object.keys(pools)).toEqual(['JP']);
    });

    it('HTML 错误页解析不出任何区域（配合 res.ok 检查双重防御）', () => {
        expect(Object.keys(parseRegionPools('<html><body>502 Bad Gateway</body></html>'))).toEqual([]);
    });

    it('joey_var 常量与后端约定一致', () => {
        expect(YXIP_TARGET_JOEY_VAR).toBe('joey_var');
    });
});
