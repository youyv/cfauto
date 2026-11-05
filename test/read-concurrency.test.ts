import { afterEach, describe, expect, it, vi } from 'vitest';
import { pooledMap, pooledMapSettled, DEFAULT_CONCURRENCY } from '../src/lib/concurrency';
import { resolveAccountVariables } from '../src/lib/auto-update';
import { readAccounts } from '../src/lib/account-store';
import * as cryptoUtils from '../src/lib/crypto-utils';
import { fetchInternalStats } from '../src/lib/stats';
import { getRoute } from '../src/routes/register';
import { KV_KEYS, TEMPLATES } from '../src/config/templates';
import { mockEnv, mockKV } from './helpers';
import type { AccountEntry } from '../src/lib/types';

const accounts = (n: number): AccountEntry[] => Array.from({ length: n }, (_, i) => ({ alias: 'mock-' + i, accountId: i.toString(16).padStart(32, '0'), email: '', globalKey: '' }));
const delay = (ms = 1) => new Promise<void>(resolve => setTimeout(resolve, ms));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function meter() {
    let active = 0, peak = 0, calls = 0;
    return {
        enter() { active++; calls++; peak = Math.max(peak, active); },
        leave() { active--; },
        get active() { return active; }, get peak() { return peak; }, get calls() { return calls; }
    };
}

describe('C6 bounded account reads', () => {
    it('reads 200 account overrides with at most five in flight and no writes', async () => {
        const list = accounts(200), kv = mockKV(), env = mockEnv(kv), m = meter();
        const uuidKey = TEMPLATES.cmliu.uuidField!;
        const base = [{ key: uuidKey, value: 'global', secret: true }, { key: 'KEEP', value: 'kept', secret: false }];
        kv.get = async key => {
            m.enter();
            try { await delay(); return JSON.stringify([{ key: uuidKey, value: key, secret: true }, { key: 'KEEP', value: 'must-not-override', secret: false }]); }
            finally { m.leave(); }
        };
        const out = await resolveAccountVariables(env, 'cmliu', list, base, 'apply');
        expect(m.peak).toBe(DEFAULT_CONCURRENCY);
        expect(m.calls).toBe(200); expect(m.active).toBe(0); expect(out.size).toBe(200);
        for (const a of list) {
            expect(out.get(a.accountId)).toEqual([{ key: uuidKey, value: KV_KEYS.accountVars('cmliu', a.accountId), secret: true }, base[1]]);
        }
        expect(kv._puts).toBe(0); expect(kv._deletes).toEqual([]);
    });
    it('KV read failures reject the batch rather than silently deploying global defaults', async () => {
        vi.useFakeTimers();
        const kv = mockKV(), env = mockEnv(kv);
        kv.get = async key => { if (key.endsWith('0000')) throw new Error('mock KV unavailable'); await delay(); return null; };
        await expect(resolveAccountVariables(env, 'cmliu', accounts(12), [], 'apply')).rejects.toThrow('mock KV unavailable');
        // pooledMap does not promise cancellation of runners already started.
        await vi.runAllTimersAsync();
        expect(kv._puts).toBe(0); expect(kv._deletes).toEqual([]);
    });
    it('empty and ignore modes do not read account overrides', async () => {
        const kv = mockKV(), env = mockEnv(kv);
        expect((await resolveAccountVariables(env, 'cmliu', [], [], 'apply')).size).toBe(0);
        expect((await resolveAccountVariables(env, 'cmliu', accounts(200), [], 'ignore')).size).toBe(0);
        expect(kv._gets).toBe(0);
    });
    it('account decryption is bounded, ordered and retains fail-closed ciphertext handling', async () => {
        const list = accounts(200).map(a => ({ ...a, apiToken: a.alias === 'mock-7' ? 'v1:invalid-mock' : 'mock-input' }));
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: list }), m = meter();
        vi.spyOn(cryptoUtils, 'decryptKey').mockImplementation(async (_env, value) => {
            m.enter(); try { await delay(); return value.startsWith('v1:') ? value : 'mock-decrypted'; } finally { m.leave(); }
        });
        const result = await readAccounts(mockEnv(kv));
        expect(m.peak).toBe(DEFAULT_CONCURRENCY); expect(m.active).toBe(0);
        expect(result.map(a => a.alias)).toEqual(list.map(a => a.alias));
        expect(result[7].apiToken).toBe(''); expect(result[8].apiToken).toBe('mock-decrypted');
        expect(kv._gets).toBe(1); expect(kv._puts).toBe(0);
    });
    it.each([{}, { length: 0 }, 'not-an-array', 7, null])('rejects non-array account JSON: %j', async value => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: JSON.stringify(value) });
        await expect(readAccounts(mockEnv(kv))).rejects.toThrow('账号配置格式无效');
        expect(kv._puts).toBe(0); expect(kv._deletes).toEqual([]);
    });
    it('initialization deduplicates valid template names and rejects inherited property names', async () => {
        const kv = mockKV(), env = mockEnv(kv), names: string[] = [];
        const get = kv.get.bind(kv);
        kv.get = async key => { names.push(key); return get(key); };
        const types = [...Array(200).fill('cmliu'), ' joey ', 'constructor', 'toString', '__proto__', 'missing'].join(',');
        const res = await getRoute('GET', '/api/init_data')!(new Request('https://mock.invalid/api/init_data?types=' + encodeURIComponent(types)), env);
        const data: any = await res.json();
        expect(res.status).toBe(200); expect(Object.keys(data.vars)).toEqual(['cmliu', 'joey']);
        expect(names).toHaveLength(6); expect(new Set(names).size).toBe(6);
        expect(kv._puts).toBe(0);
    });
});

describe('C6 pool edge cases and partial failures', () => {
    it.each([NaN, Infinity, -Infinity])('normalizes non-finite concurrency %s without skipping work or unbounded fanout', async concurrency => {
        const m = meter();
        const out = await pooledMap(accounts(20), async a => { m.enter(); try { await delay(); return a.alias; } finally { m.leave(); } }, concurrency);
        expect(out).toEqual(accounts(20).map(a => a.alias)); expect(m.peak).toBe(DEFAULT_CONCURRENCY);
    });
    it('settled batches keep 200 ordered results including failures', async () => {
        const m = meter();
        const result = await pooledMapSettled(accounts(200), async (a, i) => {
            m.enter(); try { await delay(i % 3); if (i % 7 === 0) throw new Error('mock failure'); return a.alias; } finally { m.leave(); }
        });
        expect(m.peak).toBe(DEFAULT_CONCURRENCY); expect(m.active).toBe(0);
        expect(result).toHaveLength(200);
        result.forEach((r, i) => { expect(r.ok).toBe(i % 7 !== 0); if (r.ok) expect(r.value).toBe('mock-' + i); });
    });
    it('measures mock latency/peak tradeoff for 200 reads (not live Cloudflare performance)', async () => {
        vi.useFakeTimers();
        const measurements = [];
        for (const limit of [1, 3, 5, 10, 200]) {
            const m = meter(), start = Date.now();
            const pending = pooledMap(accounts(200), async () => { m.enter(); try { await delay(10); return true; } finally { m.leave(); } }, limit);
            await vi.runAllTimersAsync(); await pending;
            measurements.push({ limit, peak: m.peak, elapsedMs: Date.now() - start, reads: m.calls });
        }
        expect(measurements.map(m => m.peak)).toEqual([1, 3, 5, 10, 200]);
        expect(measurements.map(m => m.elapsedMs)).toEqual([2000, 670, 400, 200, 10]);
        console.log('C6 deterministic mock measurement:', JSON.stringify(measurements));
    });
});

// Count a connection until its body is consumed/cancelled, not merely until headers arrive.
function bodyMeter() {
    const m = meter(), open = new Set<Response>();
    const response = (status: number, data?: unknown) => {
        m.enter(); let released = false;
        const release = () => { if (!released) { released = true; m.leave(); } };
        const res = new Response(new ReadableStream({
            async pull(controller) {
                if (data === undefined) return; // unknown/unused body: caller must cancel
                await delay(); controller.enqueue(new TextEncoder().encode(JSON.stringify(data))); controller.close(); release();
            }, cancel() { release(); }
        }), { status });
        open.add(res); return res;
    };
    const cleanup = async () => { for (const res of open) if (!res.bodyUsed && !res.body?.locked) await res.body?.cancel(); };
    return { m, response, cleanup };
}
describe('C6 external read bodies and partial failures', () => {
    it('200 statistics reads preserve order and per-account errors while releasing failed HTTP bodies', async () => {
        const b = bodyMeter(); let count = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            const i = count++;
            if (i % 4 === 0) return b.response(429);
            if (i === 1) throw new Error('mock network failure');
            return b.response(200, { data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [], workersInvocationsAdaptive: [{ sum: { requests: i } }] }] } } });
        }));
        try {
            const result = await fetchInternalStats(accounts(200).map(a => ({ ...a, apiToken: 'mock-token' })));
            expect(result.map(a => a.alias)).toEqual(accounts(200).map(a => a.alias));
            expect(result.filter(a => a.error)).toHaveLength(51);
            expect(result[2].total).toBe(2); expect(result[0].error).toContain('429');
            expect(result[1].error).toBe('mock network failure');
            expect(b.m.peak).toBeLessThanOrEqual(DEFAULT_CONCURRENCY); expect(b.m.active).toBe(0);
        } finally { await b.cleanup(); }
    });
    it('credential checks cancel unused success bodies and continue after individual rejection', async () => {
        const b = bodyMeter(), kv = mockKV(), env = mockEnv(kv); let count = 0;
        const cipher = await cryptoUtils.encryptKey(env, 'mock-token-for-test');
        await kv.put(KV_KEYS.ACCOUNTS, JSON.stringify(accounts(200).map(a => ({ ...a, apiToken: cipher }))));
        vi.stubGlobal('fetch', vi.fn(async () => {
            const i = count++;
            if (i % 5 === 0) return b.response(403, { errors: [{ message: 'mock denied' }] });
            return b.response(200);
        }));
        try {
            const res = await getRoute('GET', '/api/verify_credentials')!(new Request('https://mock.invalid/api/verify_credentials'), env);
            const result: any = await res.json();
            expect(result).toHaveLength(200); expect(result.filter((r: any) => !r.ok)).toHaveLength(40);
            expect(result.map((r: any) => r.alias)).toEqual(accounts(200).map(a => a.alias));
            expect(b.m.peak).toBeLessThanOrEqual(DEFAULT_CONCURRENCY); expect(b.m.active).toBe(0);
            expect(kv._puts).toBe(1); // test setup only
        } finally { await b.cleanup(); }
    });
});
