import { describe, it, expect } from 'vitest';
import { handleGetSubdomain } from '../src/routes/zones';
import { handleSaveYxip } from '../src/routes/yxip';
import { KV_KEYS } from '../src/config/templates';
import { mockKV, mockEnv, stubFetch, cfErr, cfOk } from './helpers';
const aid = 'a'.repeat(32);
const privateValue = 'abcdefghijklmnopqrstuvwx';
function env() { return mockEnv(mockKV({ [KV_KEYS.ACCOUNTS]: [{ accountId: aid, alias: 'test', apiToken: 'credential', workers_cmliu: ['one'] }] })); }
describe('nonstandard diagnostic error envelopes', () => {
    it('redacts HTTP 200 business rejection from subdomain lookup', async () => {
        const stub = stubFetch([{ match: '/subdomain', respond: () => cfErr(200, 'Bearer ' + privateValue) }]);
        try {
            const response = await handleGetSubdomain(env(), aid);
            const body = await response.json() as any;
            expect(body.success).toBe(false);
            expect(body.msg).not.toContain(privateValue);
        } finally { stub.restore(); }
    });
    it.each([403, 200])('redacts per-Worker upstream node write failure (%s)', async status => {
        const stub = stubFetch([
            { match: '/bindings', respond: () => cfOk([{ type: 'kv_namespace', name: 'KV', namespace_id: 'ns' }]) },
            { match: '/values/', respond: () => cfErr(status, 'Bearer ' + privateValue) }
        ]);
        try {
            const body = await (await handleSaveYxip(env(), { type: 'cmliu', accountId: aid, rawContent: '1.1.1.1:443#HK' })).json() as any;
            expect(body[0].success).toBe(false);
            expect(body[0].msg).not.toContain(privateValue);
        } finally { stub.restore(); }
    });
    it('redacts local KV failure without modifying the saved node value', async () => {
        const target = env();
        target.CONFIG_KV.put = async () => { throw new Error('Bearer ' + privateValue); };
        const response = await handleSaveYxip(target, { type: 'joey_var', rawContent: '1.1.1.1:443#HK' });
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain(privateValue);
    });
});
