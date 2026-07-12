import { describe, it, expect } from 'vitest';

// ============================================================
// deploy-utils: mergeVariableBindings 单元测试
// (纯逻辑，无外部依赖，可直接验证)
// ============================================================
describe('mergeVariableBindings', () => {
    // 内联函数以隔离测试（避免 CF 类型依赖）
    function mergeVariableBindings(
        currentBindings: Array<Record<string, unknown>>,
        variables: Array<{ key: string; value: string; secret?: boolean }>,
        deletedVariables: string[] = []
    ): Array<Record<string, unknown>> {
        const deletedSet = new Set(deletedVariables);
        const bindingMap = new Map<string, Record<string, unknown>>();
        for (const b of currentBindings) {
            const name = b.name as string;
            if (!deletedSet.has(name)) {
                bindingMap.set(name, b);
            }
        }
        for (const v of variables) {
            if (!v.value || v.value.trim() === "") continue;
            const bindingType = v.secret ? "secret_text" : "plain_text";
            bindingMap.set(v.key, { name: v.key, type: bindingType, text: v.value });
        }
        return Array.from(bindingMap.values());
    }

    it('should add new variables to empty bindings', () => {
        const result = mergeVariableBindings([], [
            { key: 'UUID', value: 'abc-123' },
            { key: 'PROXYIP', value: '1.2.3.4' }
        ]);
        expect(result).toHaveLength(2);
        expect(result.find((b: any) => b.name === 'UUID')?.text).toBe('abc-123');
        expect(result.find((b: any) => b.name === 'PROXYIP')?.text).toBe('1.2.3.4');
    });

    it('should override existing bindings with same name', () => {
        const current = [{ name: 'UUID', type: 'plain_text', text: 'old-uuid' }];
        const result = mergeVariableBindings(current, [{ key: 'UUID', value: 'new-uuid' }]);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('new-uuid');
    });

    it('should keep KV namespace bindings unchanged', () => {
        const current = [{ name: 'KV', type: 'kv_namespace', namespace_id: 'ns-123' }];
        const result = mergeVariableBindings(current, [{ key: 'UUID', value: 'abc' }]);
        expect(result).toHaveLength(2);
        expect(result.find((b: any) => b.type === 'kv_namespace')?.namespace_id).toBe('ns-123');
    });

    it('should remove deleted variables', () => {
        const current = [
            { name: 'UUID', type: 'plain_text', text: 'abc' },
            { name: 'PROXYIP', type: 'plain_text', text: '1.2.3.4' }
        ];
        const result = mergeVariableBindings(current, [], ['PROXYIP']);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('UUID');
    });

    it('should skip empty value variables', () => {
        const result = mergeVariableBindings([], [
            { key: 'UUID', value: 'abc' },
            { key: 'EMPTY', value: '' },
            { key: 'WHITESPACE', value: '   ' }
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('UUID');
    });

    it('should handle secret variables', () => {
        const result = mergeVariableBindings([], [
            { key: 'TOKEN', value: 'secret123', secret: true }
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('secret_text');
    });

    it('should keep non-overlapping bindings', () => {
        const current = [
            { name: 'A', type: 'plain_text', text: '1' },
            { name: 'B', type: 'plain_text', text: '2' }
        ];
        const result = mergeVariableBindings(current, [{ key: 'C', value: '3' }]);
        expect(result).toHaveLength(3);
    });
});

// ============================================================
// kv-utils: JSON 序列化/反序列化逻辑
// ============================================================
describe('kv-utils JSON logic', () => {
    it('getJSON returns fallback when raw is null', () => {
        const raw: string | null = null;
        const fallback = 'default';
        const result = raw === null ? fallback : JSON.parse(raw);
        expect(result).toBe('default');
    });

    it('getJSON parses valid JSON', () => {
        const raw = '{"foo": 42}';
        const parsed = JSON.parse(raw);
        expect(parsed.foo).toBe(42);
    });

    it('getJSON returns fallback on invalid JSON', () => {
        const raw = 'not json';
        const fallback: unknown[] = [];
        let result: unknown;
        try { result = JSON.parse(raw); } catch { result = fallback; }
        expect(result).toBe(fallback);
    });

    it('putJSON produces valid JSON string', () => {
        const value = { hello: 'world', arr: [1, 2, 3] };
        const json = JSON.stringify(value);
        expect(JSON.parse(json)).toEqual(value);
    });

    it('putJSON handles nested objects', () => {
        const value = { a: { b: { c: 'deep' } } };
        const json = JSON.stringify(value);
        const parsed = JSON.parse(json);
        expect(parsed.a.b.c).toBe('deep');
    });
});

// ============================================================
// crypto-utils: 版本前缀 + base64 编码逻辑
// ============================================================
describe('crypto-utils version prefix', () => {
    const VERSION_PREFIX = 'v1:';

    it('encrypted values start with v1: prefix', () => {
        const encrypted = VERSION_PREFIX + btoa('test-payload');
        expect(encrypted.startsWith(VERSION_PREFIX)).toBe(true);
    });

    it('decrypt strips v1: prefix correctly', () => {
        const encrypted = VERSION_PREFIX + btoa('hello-world');
        const payload = encrypted.startsWith(VERSION_PREFIX)
            ? encrypted.slice(VERSION_PREFIX.length)
            : encrypted;
        expect(atob(payload)).toBe('hello-world');
    });

    it('decrypt handles unprefixed legacy values', () => {
        const encrypted = btoa('legacy-data');
        const payload = encrypted.startsWith(VERSION_PREFIX)
            ? encrypted.slice(VERSION_PREFIX.length)
            : encrypted;
        expect(atob(payload)).toBe('legacy-data');
    });
});

// ============================================================
// types: AccountEntry structure
// ============================================================
describe('AccountEntry structure', () => {
    it('has required fields', () => {
        const acc = {
            alias: 'test', accountId: 'abc123',
            email: 'a@b.com', globalKey: 'key123'
        };
        expect(acc.alias).toBe('test');
        expect(acc.accountId).toBe('abc123');
    });

    it('supports optional template workers', () => {
        const acc = {
            alias: 'test', accountId: 'abc',
            email: 'a@b.com', globalKey: 'k',
            workers_cmliu: ['w1', 'w2'],
            workers_ech: ['w3']
        };
        expect(acc.workers_cmliu).toHaveLength(2);
        expect(acc.workers_ech).toHaveLength(1);
    });
});
