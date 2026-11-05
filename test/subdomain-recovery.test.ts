import { describe, it, expect } from 'vitest';
import { handleChangeSubdomain } from '../src/routes/zones';
import { mockEnv, mockKV, stubFetch, cfOk, cfErr } from './helpers';
import { KV_KEYS } from '../src/config/templates';
const aid = 'a'.repeat(32);
describe('rename recovery protects remote state', () => {
    it.each(['new-name', 'someone-else', '', 'invalid', 'network'])('read-back %s is respected', async current => {
        let deleted = false;
        const env = mockEnv(mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: aid, apiToken: 'token' }] }));
        const stub = stubFetch([{ match: '/subdomain', respond: c => {
            if (c.method === 'GET') return cfOk({ subdomain: deleted ? (current === 'invalid' ? null : current) : 'old-name' });
            if (c.method === 'DELETE') { deleted = true; return cfOk({}); }
            if (!deleted) return cfErr(409, 'account already has subdomain');
            if (current === 'network') throw new Error('connection lost');
            return cfErr(200, 'rejected');
        } }]);
        try {
            const pending = handleChangeSubdomain(env, aid, 'new-name');
            const body: any = await (await pending).json();
            const restores = stub.calls.filter(c => c.method === 'PUT' && c.body?.includes('old-name'));
            expect(restores).toHaveLength(current === '' ? 1 : 0);
            expect(body.success).toBe(current === 'new-name');
            if (current === '') { expect(body.msg).toContain('恢复未确认'); expect(body.msg).not.toContain('已恢复'); }
            if (current === 'someone-else') expect(body.msg).toContain('未覆盖现有值');
            if (current === 'network') expect(body.msg).toContain('最终状态未知');
        } finally { stub.restore(); }
    });
});
