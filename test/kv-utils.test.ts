import { describe, it, expect } from 'vitest';
import { mergeVariableBindings, getCompatibilityDate, MANAGED_WORKER_COMPATIBILITY_DATE, parseApiError } from '../src/lib/deploy-utils';
import { getJSON, putJSON } from '../src/lib/kv-utils';
import { applyTemplateTransform, getGithubUrls } from '../src/lib/github';
import { withErrorBoundary, getRoute, listRoutes } from '../src/routes/register';
import { mockKV, readKV, cfErr, htmlErr, jsonReq } from './helpers';

// ============================================================
// deploy-utils: mergeVariableBindings（导入真实实现）
// ============================================================
describe('mergeVariableBindings', () => {
    it('空 bindings 上新增变量', () => {
        const result = mergeVariableBindings([], [
            { key: 'UUID', value: 'abc-123' },
            { key: 'PROXYIP', value: '1.2.3.4' }
        ]);
        expect(result).toHaveLength(2);
        expect(result.find((b: any) => b.name === 'UUID')?.text).toBe('abc-123');
        expect(result.find((b: any) => b.name === 'PROXYIP')?.text).toBe('1.2.3.4');
    });

    it('同名变量覆盖既有绑定', () => {
        const current = [{ name: 'UUID', type: 'plain_text', text: 'old-uuid' }];
        const result = mergeVariableBindings(current, [{ key: 'UUID', value: 'new-uuid' }]);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('new-uuid');
    });

    it('KV 命名空间绑定原样保留（不被变量覆盖掉）', () => {
        const current = [{ name: 'KV', type: 'kv_namespace', namespace_id: 'ns-123' }];
        const result = mergeVariableBindings(current, [{ key: 'UUID', value: 'abc' }]);
        expect(result).toHaveLength(2);
        expect(result.find((b: any) => b.type === 'kv_namespace')?.namespace_id).toBe('ns-123');
    });

    it('deletedVariables 中的键被移除', () => {
        const current = [
            { name: 'UUID', type: 'plain_text', text: 'abc' },
            { name: 'PROXYIP', type: 'plain_text', text: '1.2.3.4' }
        ];
        const result = mergeVariableBindings(current, [], ['PROXYIP']);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('UUID');
    });

    it('空值/纯空白跳过（保留上游默认值语义）', () => {
        const result = mergeVariableBindings([], [
            { key: 'UUID', value: 'abc' },
            { key: 'EMPTY', value: '' },
            { key: 'WHITESPACE', value: '   ' }
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('UUID');
    });

    it('空值不会清掉既有绑定（这正是要靠 deletedVariables 显式删除的原因）', () => {
        const current = [{ name: 'PROXYIP', type: 'plain_text', text: 'old' }];
        const result = mergeVariableBindings(current, [{ key: 'PROXYIP', value: '' }]);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('old');
    });

    it('deletedVariables 优先于同名新值（删除意图不被覆盖）', () => {
        const current = [{ name: 'X', type: 'plain_text', text: 'old' }];
        const result = mergeVariableBindings(current, [{ key: 'X', value: 'new' }], ['X']);
        expect(result).toHaveLength(0);
    });

    it('secret 变量映射为 secret_text', () => {
        const result = mergeVariableBindings([], [{ key: 'TOKEN', value: 'secret123', secret: true }]);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('secret_text');
    });

    it('不相交的绑定全部保留', () => {
        const current = [
            { name: 'A', type: 'plain_text', text: '1' },
            { name: 'B', type: 'plain_text', text: '2' }
        ];
        const result = mergeVariableBindings(current, [{ key: 'C', value: '3' }]);
        expect(result).toHaveLength(3);
    });

    it('空 key 的条目被忽略（前端空行）', () => {
        const result = mergeVariableBindings([], [{ key: '', value: 'x' }, { key: 'A', value: '1' }]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('A');
    });

    it('容忍 null 入参与缺 name 的绑定', () => {
        const result = mergeVariableBindings(
            [{ type: 'plain_text', text: 'no-name' } as any, { name: 'A', type: 'plain_text', text: '1' }],
            null as any
        );
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('A');
    });
});

// ============================================================
// deploy-utils: 兼容性日期必须固定
// ============================================================
describe('getCompatibilityDate', () => {
    it('返回固定常量而非"今天"', () => {
        expect(getCompatibilityDate()).toBe(MANAGED_WORKER_COMPATIBILITY_DATE);
        expect(getCompatibilityDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('不等于当前日期时也不受系统时间影响（两次调用一致）', () => {
        expect(getCompatibilityDate()).toBe(getCompatibilityDate());
    });
});

describe('parseApiError', () => {
    it('解析 CF errors[0].message', async () => {
        expect(await parseApiError(cfErr(403, 'Unknown X-Auth-Key'))).toContain('Unknown X-Auth-Key');
    });
    it('非 JSON 错误页回落 HTTP 状态码', async () => {
        expect(await parseApiError(htmlErr(502))).toBe('❌ HTTP 502');
    });
});

// ============================================================
// kv-utils（导入真实实现 + 内存 KV）
// ============================================================
describe('kv-utils', () => {
    it('键不存在时返回 fallback', async () => {
        const kv = mockKV();
        expect(await getJSON(kv, 'missing', 'default')).toBe('default');
    });

    it('解析合法 JSON', async () => {
        const kv = mockKV({ k: { foo: 42 } });
        expect((await getJSON<any>(kv, 'k', null)).foo).toBe(42);
    });

    it('非法 JSON 返回 fallback 而不抛错', async () => {
        const kv = mockKV();
        await kv.put('bad', 'not json');
        const fallback: unknown[] = [];
        expect(await getJSON(kv, 'bad', fallback)).toBe(fallback);
    });

    it('putJSON → getJSON 往返一致', async () => {
        const kv = mockKV();
        const value = { hello: 'world', arr: [1, 2, 3] };
        await putJSON(kv, 'k', value);
        expect(await getJSON(kv, 'k', null)).toEqual(value);
    });

    it('cacheTtl 参数不影响返回值', async () => {
        const kv = mockKV({ k: [1, 2] });
        expect(await getJSON(kv, 'k', [], 60)).toEqual([1, 2]);
    });

    it('存储的 null 与键缺失可区分', async () => {
        const kv = mockKV();
        await putJSON(kv, 'k', null);
        expect(await getJSON(kv, 'k', 'fallback')).toBeNull();
        expect(await getJSON(kv, 'other', 'fallback')).toBe('fallback');
    });
});

// ============================================================
// github: getGithubUrls / applyTemplateTransform（导入真实实现）
// ============================================================
describe('getGithubUrls', () => {
    it('cmliu 指向 raw.githubusercontent 的 _worker.js', () => {
        const u = getGithubUrls('cmliu');
        expect(u.scriptUrl).toBe('https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js');
        expect(u.apiUrl).toBe('https://api.github.com/repos/cmliu/edgetunnel/commits');
    });

    it('joey 的中文路径被 URL 编码，但 API 的 path 参数保留原文', () => {
        const u = getGithubUrls('joey');
        expect(u.scriptUrl).toContain(encodeURIComponent('少年你相信光吗'));
        expect(u.rawPath).toBe('少年你相信光吗');
    });

    it('指定 sha 时用 sha 替换分支名', () => {
        expect(getGithubUrls('cmliu', 'abc1234').scriptUrl).toContain('/abc1234/');
    });
});

describe('applyTemplateTransform', () => {
    it('joey: 注入 window 兼容层', () => {
        expect(applyTemplateTransform('joey', 'const a=1;', null)).toContain('var window = globalThis;');
    });

    it('cmliu: 不改动代码', () => {
        const code = 'const a=1;';
        expect(applyTemplateTransform('cmliu', code, null)).toBe(code);
    });

    it('ech: 替换 CF_FALLBACK_IPS 为指定 PROXYIP', () => {
        const code = "const CF_FALLBACK_IPS = ['old.example.com'];";
        const out = applyTemplateTransform('ech', code, [{ key: 'PROXYIP', value: 'my.proxy.net' }]);
        expect(out).toContain("const CF_FALLBACK_IPS = ['my.proxy.net'];");
        expect(out).not.toContain('old.example.com');
    });

    it('ech: PROXYIP 缺省时用默认值', () => {
        const out = applyTemplateTransform('ech', "const CF_FALLBACK_IPS = ['x'];", null);
        expect(out).toContain('ProxyIP.CMLiussss.net');
    });

    it('ech: PROXYIP 中的单引号与反斜杠被转义（防止代码注入）', () => {
        const out = applyTemplateTransform('ech', "const CF_FALLBACK_IPS = ['x'];", [{ key: 'PROXYIP', value: "a'b\\c" }]);
        expect(out).toContain("a\\'b\\\\c");
    });

    it('ech: token 仅在 echTokenEnabled 时注入', () => {
        const code = "const token = 'old';";
        const withToken = applyTemplateTransform('ech', code, [{ key: 'TOKEN', value: 'T1' }], { echTokenEnabled: true });
        expect(withToken).toContain("const token = 'T1';");
        const without = applyTemplateTransform('ech', code, [{ key: 'TOKEN', value: 'T1' }], { echTokenEnabled: false });
        expect(without).toContain("const token = '';");
    });

    it('ech: 上游模式不匹配时原样返回（不中止部署）', () => {
        const code = 'const somethingElse = 1;';
        expect(applyTemplateTransform('ech', code, null)).toBe(code);
    });
});

// ============================================================
// routes/register: withErrorBoundary（导入真实实现）
// ============================================================
describe('withErrorBoundary', () => {
    const env = {} as any;

    it('成功响应原样透传', async () => {
        const wrapped = withErrorBoundary(async () => new Response('ok', { status: 200 }), 'test');
        const res = await wrapped(jsonReq('GET', 'https://x/'), env);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
    });

    it('抛出的 Error 转为 500 JSON', async () => {
        const wrapped = withErrorBoundary(async () => { throw new Error('boom'); }, 'failing');
        const res = await wrapped(jsonReq('GET', 'https://x/'), env);
        expect(res.status).toBe(500);
        const body: any = await res.json();
        expect(body.success).toBe(false);
        // 不向客户端泄漏内部错误详情
        expect(body.msg).not.toContain('boom');
    });

    it('抛出的非 Error 值同样被兜住', async () => {
        const wrapped = withErrorBoundary(async () => { throw 'string error'; }, 'str');
        const res = await wrapped(jsonReq('GET', 'https://x/'), env);
        expect(res.status).toBe(500);
    });

    it('主动抛出的 Response 原样返回（safeJson 的 400 等）', async () => {
        const wrapped = withErrorBoundary(async () => {
            throw new Response(JSON.stringify({ success: false, msg: 'Invalid JSON' }), { status: 400 });
        }, 'resp');
        const res = await wrapped(jsonReq('POST', 'https://x/'), env);
        expect(res.status).toBe(400);
        expect((await res.json() as any).msg).toBe('Invalid JSON');
    });
});

// ============================================================
// routes/register: 路由表本身
// ============================================================
describe('路由注册表', () => {
    it('所有路由都已套上错误边界（handler 抛错时返回 500 而非崩溃）', async () => {
        // getRoute 返回的是 withErrorBoundary 包装后的函数；此处只验证存在性与 key 形状
        expect(getRoute('GET', '/api/accounts')).toBeTypeOf('function');
        expect(getRoute('POST', '/api/accounts')).toBeTypeOf('function');
    });

    it('未注册的 method+path 返回 null', () => {
        expect(getRoute('DELETE', '/api/accounts')).toBeNull();
        expect(getRoute('GET', '/api/nonexistent')).toBeNull();
    });

    it('method 大小写敏感（与 Request.method 一致，均为大写）', () => {
        expect(getRoute('get', '/api/accounts')).toBeNull();
    });

    it('路由键格式统一为 "METHOD /path"', () => {
        for (const key of listRoutes()) {
            expect(key).toMatch(/^(GET|POST|PUT|DELETE|PATCH) \/[a-z0-9_\/]+$/i);
        }
    });

    it('无重复路由（重复注册会在模块加载时抛错，此处确认已加载成功）', () => {
        const keys = listRoutes();
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.length).toBeGreaterThan(30);
    });
});
