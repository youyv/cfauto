import { describe, it, expect } from 'vitest';
import { handleBatchDeploy } from '../src/routes/deploy';
import { handleGetZones, handleGetAllWorkers, handleDeleteWorker, handleFetchBindings, handleGetSubdomain, handleChangeSubdomain } from '../src/routes/zones';
import { handleSaveYxip, handleGetRegionsData } from '../src/routes/yxip';
import { handleFix1101 } from '../src/routes/fix1101';
import { handleCheckUpdate, handleGetCode } from '../src/routes/check';
import { writeAccounts, readAccounts, getWorkerNames } from '../src/lib/account-store';
import { KV_KEYS } from '../src/config/templates';
import { mockKV, mockEnv, readKV, cfOk, cfErr, htmlErr, stubFetch } from './helpers';
import type { AppEnv } from '../src/config/env';
import type { AccountEntry, DeployConfig } from '../src/lib/types';

const AID_A = 'a'.repeat(32);
const AID_B = 'b'.repeat(32);

function acct(over: Partial<AccountEntry> = {}): AccountEntry {
    return { alias: 'acc-a', accountId: AID_A, email: 'a@x.com', globalKey: 'KEY_A', ...over };
}

function githubRoutes(sha = 'sha-remote', code = 'const CF_FALLBACK_IPS = [];\nconst token = \'\';') {
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

// ============================================================
// 批量部署
// ============================================================
describe('handleBatchDeploy', () => {
    const base = {
        template: 'cmliu' as const,
        workerName: 'new-proxy',
        kvName: 'my-kv',
        config: { ADMIN: 'pw', UUID: 'u-1' },
        targetAccounts: ['acc-a'],
        enableKV: true
    };

    it('缺必填字段 → 400', async () => {
        const res = await handleBatchDeploy(mockEnv(mockKV()), { template: 'cmliu' } as any);
        expect(res.status).toBe(400);
    });

    it('未知模板 → 400', async () => {
        const res = await handleBatchDeploy(mockEnv(mockKV()), { ...base, template: 'evil' } as any);
        expect(res.status).toBe(400);
    });

    it('非法 Worker 名 → 400 且提示规则', async () => {
        const res = await handleBatchDeploy(mockEnv(mockKV()), { ...base, workerName: 'Bad Name!' });
        expect(res.status).toBe(400);
        expect((await res.json() as any)[0].msg).toContain('Worker 名称非法');
    });

    it('开启 KV 但未填 KV 名 → 400', async () => {
        const res = await handleBatchDeploy(mockEnv(mockKV()), { ...base, kvName: '' });
        expect(res.status).toBe(400);
    });

    it('目标账号列表为空 → 400', async () => {
        const res = await handleBatchDeploy(mockEnv(mockKV()), { ...base, targetAccounts: [] });
        expect(res.status).toBe(400);
    });

    it('目标账号密钥缺失 → 明确指出是哪个账号', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'acc-a', accountId: AID_A, email: 'e', globalKey: '' }] });
        const body: any = await (await handleBatchDeploy(mockEnv(kv), base)).json();
        expect(body[0].success).toBe(false);
        expect(body[0].msg).toContain('acc-a');
    });

    it('成功路径：创建 KV → 上传 → 配置域名 → 记入账号列表', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct()]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/storage/kv/namespaces', respond: (c) => c.method === 'POST' ? cfOk({ id: 'ns-new' }) : cfOk([]) },
            { match: '/workers/scripts/new-proxy/subdomain', respond: () => cfOk({}) },
            { match: '/workers/subdomain', respond: () => cfOk({ subdomain: 'mysub' }) },
            { match: '/workers/scripts/', respond: () => cfOk({ id: 'new-proxy' }) }
        ]);
        try {
            const logs: any = await (await handleBatchDeploy(env, base)).json();
            expect(logs[0].success).toBe(true);
            expect(logs[0].msg).toContain('mysub.workers.dev');
            // Worker 名必须落进账号记录，否则后续更新会完全遗漏它
            const saved = await readAccounts(env);
            expect(getWorkerNames(saved[0], 'cmliu')).toContain('new-proxy');
        } finally { stub.restore(); }
    });

    it('复用同名 KV 命名空间而非重复创建', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct()]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/storage/kv/namespaces', respond: (c) => {
                if (c.method === 'POST') throw new Error('不应创建新命名空间');
                return cfOk([{ title: 'my-kv', id: 'ns-existing' }]);
            } },
            { match: '/subdomain', respond: () => cfOk({ subdomain: 's' }) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            const logs: any = await (await handleBatchDeploy(env, base)).json();
            expect(logs[0].success).toBe(true);
            const upload = stub.calls.find(c => c.method === 'PUT' && c.url.includes('/workers/scripts/'));
            expect(upload!.body).toBeUndefined();   // FormData，不作为字符串
        } finally { stub.restore(); }
    });

    it('KV 列表读取失败 → 该账号失败但不抛异常', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct()]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/storage/kv/namespaces', respond: () => htmlErr(500) }
        ]);
        try {
            const logs: any = await (await handleBatchDeploy(env, base)).json();
            expect(logs[0].success).toBe(false);
            expect(logs[0].msg).toContain('读取 KV 列表');
        } finally { stub.restore(); }
    });

    it('部分账号失败 → 不推进 currentSha', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [
            acct(),
            acct({ alias: 'acc-b', accountId: AID_B, email: 'b@x.com', globalKey: 'KEY_B' })
        ]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/storage/kv/namespaces', respond: () => cfOk([{ title: 'my-kv', id: 'ns1' }]) },
            { match: '/subdomain', respond: () => cfOk({ subdomain: 's' }) },
            { match: '/workers/scripts/', respond: (c) => c.url.includes(AID_B) ? cfErr(500, 'nope') : cfOk({}) }
        ]);
        try {
            const logs: any = await (await handleBatchDeploy(env, { ...base, targetAccounts: ['acc-a', 'acc-b'] })).json();
            expect(logs.filter((l: any) => l.success)).toHaveLength(1);
            const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
            expect(cfg.currentSha).toBeUndefined();
            expect(cfg.pendingTargets).toEqual([AID_B + '::new-proxy']);
        } finally { stub.restore(); }
    });

    it('填了自定义域名前缀但账号无默认 Zone → 明确提示跳过', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct()]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/storage/kv/namespaces', respond: () => cfOk([{ title: 'my-kv', id: 'ns1' }]) },
            { match: '/subdomain', respond: () => cfOk({ subdomain: 's' }) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            const logs: any = await (await handleBatchDeploy(env, { ...base, customDomainPrefix: 'api' })).json();
            expect(logs[0].msg).toContain('未配置默认 Zone');
        } finally { stub.restore(); }
    });

    it('禁用 workers.dev 时不查询账号子域名', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct()]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/storage/kv/namespaces', respond: () => cfOk([{ title: 'my-kv', id: 'ns1' }]) },
            { match: '/workers/scripts/new-proxy/subdomain', respond: () => cfOk({}) },
            { match: '/workers/scripts/', respond: () => cfOk({}) }
        ]);
        try {
            const logs: any = await (await handleBatchDeploy(env, { ...base, disableWorkersDev: true })).json();
            expect(logs[0].msg).toContain('默认域名已禁用');
            expect(stub.calls.some(c => c.url.endsWith('/workers/subdomain'))).toBe(false);
        } finally { stub.restore(); }
    });
});

// ============================================================
// zones：凭据解析与 res.ok 检查
// ============================================================
describe('zones handlers', () => {
    async function withAccount(): Promise<{ env: AppEnv; kv: ReturnType<typeof mockKV> }> {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ defaultZoneId: 'z1', defaultZoneName: 'example.com', workers_cmliu: ['w1'] })]);
        return { env, kv };
    }

    it('accountId 缺失 → 400', async () => {
        const { env } = await withAccount();
        expect((await handleGetZones(env, '')).status).toBe(400);
    });

    it('账号未配置 → 404', async () => {
        const { env } = await withAccount();
        expect((await handleGetZones(env, AID_B)).status).toBe(404);
    });

    it('密钥缺失 → 400 且提示重新填写', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: AID_A, email: 'e', globalKey: '' }] });
        const res = await handleGetZones(mockEnv(kv), AID_A);
        expect(res.status).toBe(400);
        expect((await res.json() as any).msg).toContain('Global API Key');
    });

    it('handleGetZones 分页汇总', async () => {
        const { env } = await withAccount();
        const stub = stubFetch([{
            match: '/zones?',
            respond: (c) => {
                const page = Number(new URL(c.url).searchParams.get('page') || '1');
                return new Response(JSON.stringify({
                    success: true,
                    result: [{ id: 'z' + page, name: 'd' + page + '.com' }],
                    result_info: { total_pages: 3 }
                }), { status: 200 });
            }
        }]);
        try {
            const body: any = await (await handleGetZones(env, AID_A)).json();
            expect(body.zones).toHaveLength(3);
        } finally { stub.restore(); }
    });

    it('handleGetZones 上游报错 → 透出 CF 错误消息（不再是无信息的 "failed"）', async () => {
        const { env } = await withAccount();
        const stub = stubFetch([{ match: '/zones?', respond: () => cfErr(403, 'Invalid credentials', 9103) }]);
        try {
            const body: any = await (await handleGetZones(env, AID_A)).json();
            expect(body.msg).toContain('Invalid credentials');
        } finally { stub.restore(); }
    });

    it('handleGetAllWorkers 上游 HTML 错误页 → 报告状态码而非 TypeError', async () => {
        const { env } = await withAccount();
        const stub = stubFetch([{ match: '/workers/scripts', respond: () => htmlErr(502) }]);
        try {
            const body: any = await (await handleGetAllWorkers(env, AID_A)).json();
            expect(body.msg).toContain('502');
        } finally { stub.restore(); }
    });

    it('handleFetchBindings 返回 secret 标记（同步后不丢失 secret 属性）', async () => {
        const { env } = await withAccount();
        const stub = stubFetch([{
            match: '/bindings',
            respond: () => cfOk([
                { name: 'UUID', type: 'plain_text', text: 'u' },
                { name: 'TOKEN', type: 'secret_text' },
                { name: 'KV', type: 'kv_namespace', namespace_id: 'n' }
            ])
        }]);
        try {
            const body: any = await (await handleFetchBindings(env, AID_A, 'w1')).json();
            expect(body.data).toEqual([
                { key: 'UUID', value: 'u', secret: false },
                { key: 'TOKEN', value: '', secret: true }
            ]);
        } finally { stub.restore(); }
    });

    it('handleFetchBindings 缺 workerName → 400', async () => {
        const { env } = await withAccount();
        expect((await handleFetchBindings(env, AID_A, '')).status).toBe(400);
    });

    it('handleDeleteWorker 成功后从账号记录移除', async () => {
        const { env, kv } = await withAccount();
        const stub = stubFetch([
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/w1', respond: () => cfOk(null) }
        ]);
        try {
            const body: any = await (await handleDeleteWorker(env, AID_A, 'w1', false)).json();
            expect(body.success).toBe(true);
            const saved = readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)!;
            expect(saved[0].workers_cmliu).toEqual([]);
        } finally { stub.restore(); }
    });

    it('handleDeleteWorker 删除失败 → 透出 CF 消息，不动账号记录', async () => {
        const { env, kv } = await withAccount();
        const stub = stubFetch([
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/w1', respond: () => cfErr(400, 'script not found') }
        ]);
        try {
            const body: any = await (await handleDeleteWorker(env, AID_A, 'w1', false)).json();
            expect(body.success).toBe(false);
            expect(body.msg).toContain('script not found');
            expect(readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)![0].workers_cmliu).toEqual(['w1']);
        } finally { stub.restore(); }
    });

    it('handleDeleteWorker 删 KV 时 409 重试，最终失败给出警告', async () => {
        const { env } = await withAccount();
        let kvDeleteAttempts = 0;
        const stub = stubFetch([
            { match: '/bindings', respond: () => cfOk([{ type: 'kv_namespace', namespace_id: 'ns1' }]) },
            { match: '/storage/kv/namespaces/ns1', respond: () => { kvDeleteAttempts++; return cfErr(409, 'in use'); } },
            { match: '/workers/scripts/w1', respond: () => cfOk(null) }
        ]);
        try {
            const body: any = await (await handleDeleteWorker(env, AID_A, 'w1', true)).json();
            expect(body.kvWarnings).toContain('手动清理');
            expect(kvDeleteAttempts).toBe(5);
        } finally { stub.restore(); }
    }, 20000);

    it('handleGetSubdomain：CF 404 视为"未设置"而非错误', async () => {
        const { env } = await withAccount();
        const stub = stubFetch([{ match: '/workers/subdomain', respond: () => cfErr(404, 'not found') }]);
        try {
            const body: any = await (await handleGetSubdomain(env, AID_A)).json();
            expect(body.success).toBe(true);
            expect(body.subdomain).toBe('');
        } finally { stub.restore(); }
    });

    it('handleChangeSubdomain 校验格式（大写/非法字符/过长）', async () => {
        const { env } = await withAccount();
        for (const bad of ['-lead', 'trail-', 'has space', 'a'.repeat(64), '']) {
            const res = await handleChangeSubdomain(env, AID_A, bad);
            expect(res.status, bad).toBe(400);
        }
    });

    it('handleChangeSubdomain 直接成功路径', async () => {
        const { env } = await withAccount();
        const stub = stubFetch([{ match: '/workers/subdomain', respond: () => cfOk({ subdomain: 'newsub' }) }]);
        try {
            const body: any = await (await handleChangeSubdomain(env, AID_A, 'NewSub')).json();
            expect(body.success).toBe(true);
            // 大写被归一为小写
            expect(stub.calls[0].body).toContain('"newsub"');
        } finally { stub.restore(); }
    });

    it('handleChangeSubdomain 拿不到旧子域名时中止 DELETE（防不可恢复）', async () => {
        const { env } = await withAccount();
        let deleteCalled = false;
        const stub = stubFetch([{
            match: '/workers/subdomain',
            respond: (c) => {
                if (c.method === 'DELETE') { deleteCalled = true; return cfOk(null); }
                if (c.method === 'GET') return htmlErr(500);
                return cfErr(400, 'account already has a subdomain');
            }
        }]);
        try {
            const body: any = await (await handleChangeSubdomain(env, AID_A, 'newsub')).json();
            expect(body.success).toBe(false);
            expect(body.msg).toContain('已中止修改');
            expect(deleteCalled).toBe(false);
        } finally { stub.restore(); }
    });

    it('handleChangeSubdomain 新值失败后恢复旧子域名', async () => {
        const { env } = await withAccount();
        const putBodies: string[] = [];
        const stub = stubFetch([{
            match: '/workers/subdomain',
            respond: (c) => {
                if (c.method === 'GET') return cfOk({ subdomain: 'oldsub' });
                if (c.method === 'DELETE') return cfOk(null);
                putBodies.push(c.body || '');
                if ((c.body || '').includes('oldsub')) return cfOk({ subdomain: 'oldsub' });
                return cfErr(400, 'account already has a subdomain');
            }
        }]);
        try {
            const body: any = await (await handleChangeSubdomain(env, AID_A, 'newsub')).json();
            expect(body.success).toBe(false);
            expect(body.msg).toContain('已恢复原子域名: oldsub');
            expect(putBodies.some(b => b.includes('oldsub'))).toBe(true);
        } finally { stub.restore(); }
    }, 20000);
});

// ============================================================
// yxip
// ============================================================
describe('yxip handlers', () => {
    it('handleGetRegionsData：上游非 2xx → 502 而非 success:true 空数据', async () => {
        const stub = stubFetch([{ match: 'zip.cm.edu.kg', respond: () => htmlErr(503) }]);
        try {
            const res = await handleGetRegionsData();
            expect(res.status).toBe(502);
            expect((await res.json() as any).success).toBe(false);
        } finally { stub.restore(); }
    });

    it('handleGetRegionsData：上游返回 HTML（200）但解析不出区域 → 502', async () => {
        const stub = stubFetch([{ match: 'zip.cm.edu.kg', respond: () => new Response('<html>oops</html>', { status: 200 }) }]);
        try {
            expect((await handleGetRegionsData()).status).toBe(502);
        } finally { stub.restore(); }
    });

    it('handleGetRegionsData 正常解析', async () => {
        const stub = stubFetch([{ match: 'zip.cm.edu.kg', respond: () => new Response('1.1.1.1:443#HK\n2.2.2.2:443#JP', { status: 200 }) }]);
        try {
            const body: any = await (await handleGetRegionsData()).json();
            expect(body.success).toBe(true);
            expect(Object.keys(body.data).sort()).toEqual(['HK', 'JP']);
        } finally { stub.restore(); }
    });

    it('rawContent 为空 → 400', async () => {
        const res = await handleSaveYxip(mockEnv(mockKV()), { type: 'cmliu', accountId: AID_A, rawContent: '  ' });
        expect(res.status).toBe(400);
    });

    it('未知 type → 400', async () => {
        const res = await handleSaveYxip(mockEnv(mockKV()), { type: 'evil', rawContent: 'x' });
        expect(res.status).toBe(400);
    });

    it('ech 未配置 KV 优选 → 400 明确不支持', async () => {
        const res = await handleSaveYxip(mockEnv(mockKV()), { type: 'ech', accountId: AID_A, rawContent: 'x' });
        expect(res.status).toBe(400);
        expect((await res.json() as any)[0].msg).toContain('未配置 KV 优选节点');
    });

    it('joey_var 写入全局变量 yx', async () => {
        const kv = mockKV();
        const res = await handleSaveYxip(mockEnv(kv), { type: 'joey_var', rawContent: '1.1.1.1:443#HK' });
        expect((await res.json() as any)[0].success).toBe(true);
        const vars = readKV<any[]>(kv, KV_KEYS.vars('joey'))!;
        expect(vars.find(v => v.key === 'yx')!.value).toBe('1.1.1.1:443#HK');
    });

    it('joey_var 重复写入是覆盖而非追加', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await handleSaveYxip(env, { type: 'joey_var', rawContent: 'a' });
        await handleSaveYxip(env, { type: 'joey_var', rawContent: 'b' });
        const vars = readKV<any[]>(kv, KV_KEYS.vars('joey'))!;
        expect(vars.filter(v => v.key === 'yx')).toHaveLength(1);
        expect(vars.find(v => v.key === 'yx')!.value).toBe('b');
    });

    it('cmliu KV 模式：写入 ADD.txt 且使用服务端凭据', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([
            { match: '/bindings', respond: () => cfOk([{ type: 'kv_namespace', name: 'KV', namespace_id: 'ns1' }]) },
            { match: '/values/ADD.txt', respond: () => cfOk(null) }
        ]);
        try {
            const body: any = await (await handleSaveYxip(env, { type: 'cmliu', accountId: AID_A, rawContent: '1.1.1.1:443#HK' })).json();
            expect(body[0].success).toBe(true);
            const put = stub.calls.find(c => c.url.includes('/values/ADD.txt'))!;
            expect(put.headers['X-Auth-Key']).toBe('KEY_A');
            expect(put.body).toBe('1.1.1.1:443#HK');
        } finally { stub.restore(); }
    });

    it('joey KV 模式：内容被包装成 JSON 配置', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ workers_joey: ['j1'] })]);
        const stub = stubFetch([
            { match: '/bindings', respond: () => cfOk([{ type: 'kv_namespace', name: 'C', namespace_id: 'ns1' }]) },
            { match: '/values/c', respond: () => cfOk(null) }
        ]);
        try {
            await handleSaveYxip(env, { type: 'joey', accountId: AID_A, rawContent: '1.1.1.1:443#HK' });
            const put = stub.calls.find(c => c.url.includes('/values/c'))!;
            const parsed = JSON.parse(put.body!);
            expect(parsed.yx).toBe('1.1.1.1:443#HK');
            expect(parsed.ipv4).toBe('yes');
        } finally { stub.restore(); }
    });

    it('未绑定目标 KV → 明确指出绑定名', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([{ match: '/bindings', respond: () => cfOk([]) }]);
        try {
            const body: any = await (await handleSaveYxip(env, { type: 'cmliu', accountId: AID_A, rawContent: 'x' })).json();
            expect(body[0].success).toBe(false);
            expect(body[0].msg).toContain('KV');
        } finally { stub.restore(); }
    });

    it('账号密钥缺失 → 400', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: AID_A, email: 'e', globalKey: '', workers_cmliu: ['w1'] }] });
        const res = await handleSaveYxip(mockEnv(kv), { type: 'cmliu', accountId: AID_A, rawContent: 'x' });
        expect(res.status).toBe(400);
    });
});

// ============================================================
// fix1101
// ============================================================
describe('handleFix1101', () => {
    it('bindings 读取失败 → 不删除 Worker（保护既有绑定）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        let deleteCalled = false;
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => htmlErr(500) },
            { match: '/workers/scripts/w1', respond: (c) => { if (c.method === 'DELETE') deleteCalled = true; return cfOk(null); } }
        ]);
        try {
            const logs: any = await (await handleFix1101(env, 'cmliu')).json();
            expect(logs[0].success).toBe(false);
            expect(logs[0].msg).toContain('已中止修复');
            expect(deleteCalled).toBe(false);
        } finally { stub.restore(); }
    });

    it('密钥缺失的账号被跳过并提示', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: AID_A, email: 'e', globalKey: '', workers_cmliu: ['w1'] }] });
        const stub = stubFetch(githubRoutes());
        try {
            const logs: any = await (await handleFix1101(mockEnv(kv), 'cmliu')).json();
            expect(logs[0].msg).toContain('Global API Key');
        } finally { stub.restore(); }
    });

    it('无该模板 Worker 的账号被跳过', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct()]);
        const stub = stubFetch(githubRoutes());
        try {
            const logs: any = await (await handleFix1101(env, 'cmliu')).json();
            expect(logs[0].msg).toContain('跳过');
        } finally { stub.restore(); }
    });

    it('成功路径：首次上传即成功，不做多余退避等待', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        let uploadAttempts = 0;
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([{ name: 'UUID', type: 'plain_text', text: 'u' }]) },
            { match: '/workers/domains', respond: () => cfOk([]) },
            { match: '/workers/subdomain', respond: () => cfOk({ subdomain: 's' }) },
            { match: '/workers/scripts/w1', respond: (c) => {
                if (c.method === 'PUT') uploadAttempts++;
                return cfOk({});
            } }
        ]);
        try {
            const started = Date.now();
            const logs: any = await (await handleFix1101(env, 'cmliu')).json();
            const elapsed = Date.now() - started;
            expect(logs[0].success).toBe(true);
            expect(logs[0].msg).toContain('重建成功');
            expect(uploadAttempts).toBe(1);
            // 只有删除后的固定等待（1.5s），不再是"先睡 2s 再试"
            expect(elapsed).toBeLessThan(3500);
            const cfg = readKV<DeployConfig>(kv, KV_KEYS.deployConfig('cmliu'))!;
            expect(cfg.currentSha).toBe('sha-remote');
        } finally { stub.restore(); }
    }, 20000);

    it('secret 绑定无 KV 值 → 跳过并警告需手动重配', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        const stub = stubFetch([
            ...githubRoutes(),
            { match: '/bindings', respond: () => cfOk([{ name: 'TOKEN', type: 'secret_text' }]) },
            { match: '/workers/domains', respond: () => cfOk([]) },
            { match: '/workers/subdomain', respond: () => cfOk({ subdomain: 's' }) },
            { match: '/workers/scripts/w1', respond: () => cfOk({}) }
        ]);
        try {
            const logs: any = await (await handleFix1101(env, 'cmliu')).json();
            expect(logs[0].msg).toContain('secret 绑定无法从 API 恢复');
        } finally { stub.restore(); }
    }, 20000);
});

// ============================================================
// check 路由
// ============================================================
describe('check handlers', () => {
    it('handleGetCode 未知模板 → 400', async () => {
        expect((await handleGetCode('evil')).status).toBe(400);
    });

    it('handleGetCode 上游 404 → 502 且带原因', async () => {
        const stub = stubFetch([{ match: 'raw.githubusercontent.com', respond: () => htmlErr(404) }]);
        try {
            const res = await handleGetCode('cmliu');
            expect(res.status).toBe(502);
            expect((await res.json() as any).msg).toContain('404');
        } finally { stub.restore(); }
    });

    it('handleCheckUpdate 返回 pending 信息（前端据此提示 N 个 Worker 仍落后）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acct({ workers_cmliu: ['w1'] })]);
        await kv.put(KV_KEYS.deployConfig('cmliu'), JSON.stringify({
            mode: 'latest', currentSha: 'sha-remote', pendingTargets: [AID_A + '::w1'], pendingSha: 'sha-remote'
        }));
        const stub = stubFetch(githubRoutes());
        try {
            const body: any = await (await handleCheckUpdate(env, 'cmliu')).json();
            expect(body.pending).toEqual([AID_A + '::w1']);
        } finally { stub.restore(); }
    });

    it('handleCheckUpdate history 模式限制 per_page 上限', async () => {
        const stub = stubFetch(githubRoutes());
        try {
            await handleCheckUpdate(mockEnv(mockKV()), 'cmliu', 'history', 9999);
            const call = stub.calls.find(c => c.url.includes('api.github.com'))!;
            expect(new URL(call.url).searchParams.get('per_page')).toBe('100');
        } finally { stub.restore(); }
    });

    it('handleCheckUpdate GitHub 异常 → 502 而非 500', async () => {
        const stub = stubFetch([
            { match: 'raw.githubusercontent.com', respond: () => new Response('x') },
            { match: 'api.github.com', respond: () => htmlErr(403) }
        ]);
        try {
            expect((await handleCheckUpdate(mockEnv(mockKV()), 'cmliu')).status).toBe(502);
        } finally { stub.restore(); }
    });
});
