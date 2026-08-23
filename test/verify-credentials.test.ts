import { describe, it, expect } from 'vitest';

// ============================================================
// 回归测试：verify_credentials 端点与前置校验
//
// 背景：/user/tokens/verify 只支持 API Token（Authorization: Bearer），
// 用 Global API Key（X-Auth-Email + X-Auth-Key）调用必然返回 400
// "Missing Authorization header"，导致「验证凭据」无论 key 是否正确都失败。
// 已改用 /accounts/{aid}（支持 Global API Key，且同时验证 accountId 归属）。
// ============================================================

const CF_API = 'https://api.cloudflare.com/client/v4';

describe('cf.account 端点（替代 userTokenVerify）', () => {
    /** 复刻 cloudflare-api.ts 的 cf.account */
    const account = (aid: string) => `${CF_API}/accounts/${aid}`;

    it('生成正确的账号详情 URL', () => {
        expect(account('abc123')).toBe(CF_API + '/accounts/abc123');
    });

    it('不再指向只支持 Bearer 的 /user/tokens/verify', () => {
        expect(account('abc123')).not.toContain('/user/tokens/verify');
    });

    it('accountId 参与 URL 构建（能验证归属）', () => {
        expect(account('acc-A')).not.toBe(account('acc-B'));
    });
});

describe('verify_credentials 前置校验（避免无意义请求）', () => {
    interface Acc { alias: string; accountId: string; email: string; globalKey: string }

    /** 复刻 crud.ts 中每个账号的前置判定逻辑 */
    function precheck(acc: Acc): { ok: boolean; error?: string } | null {
        if (!acc.globalKey) return { ok: false, error: '密钥缺失或解密失败，请重新填写 API Key' };
        if (!acc.accountId) return { ok: false, error: '缺少 Account ID' };
        return null;   // null = 通过前置校验，需要发起真实请求
    }

    it('globalKey 为空（解密失败被清空）→ 明确提示，不发请求', () => {
        const r = precheck({ alias: 'a', accountId: 'acc1', email: 'e@x.com', globalKey: '' });
        expect(r).not.toBeNull();
        expect(r!.ok).toBe(false);
        expect(r!.error).toContain('解密失败');
    });

    it('accountId 缺失 → 明确提示', () => {
        const r = precheck({ alias: 'a', accountId: '', email: 'e@x.com', globalKey: 'KEY' });
        expect(r).not.toBeNull();
        expect(r!.error).toBe('缺少 Account ID');
    });

    it('凭据完整 → 通过前置校验（进入真实请求）', () => {
        expect(precheck({ alias: 'a', accountId: 'acc1', email: 'e@x.com', globalKey: 'KEY' })).toBeNull();
    });
});

describe('verify_credentials CF 错误消息解析', () => {
    /** 复刻错误消息提取逻辑 */
    function extractMsg(status: number, body: unknown): string {
        const b = body as { errors?: Array<{ message?: string }> } | null;
        const cfMsg = b && b.errors && b.errors[0] && b.errors[0].message;
        return cfMsg || ('HTTP ' + status);
    }

    it('凭据无效（9103）→ 返回 CF 原始消息', () => {
        expect(extractMsg(403, { errors: [{ code: 9103, message: 'Unknown X-Auth-Key or X-Auth-Email' }] }))
            .toBe('Unknown X-Auth-Key or X-Auth-Email');
    });

    it('accountId 无权限（7003）→ 返回 CF 原始消息', () => {
        expect(extractMsg(400, { errors: [{ code: 7003, message: 'Could not route to /accounts/xxx' }] }))
            .toBe('Could not route to /accounts/xxx');
    });

    it('无 errors 字段 → 回落 HTTP 状态码', () => {
        expect(extractMsg(500, {})).toBe('HTTP 500');
        expect(extractMsg(502, null)).toBe('HTTP 502');
    });

    it('errors 为空数组 → 回落 HTTP 状态码', () => {
        expect(extractMsg(429, { errors: [] })).toBe('HTTP 429');
    });
});

describe('verify_credentials 分批节流参数', () => {
    const BATCH_SIZE = 5;

    /** 复刻分批切片逻辑，验证不漏账号、批次数正确 */
    function batchIndices(total: number): number[][] {
        const batches: number[][] = [];
        const all = Array.from({ length: total }, (_, i) => i);
        for (let i = 0; i < all.length; i += BATCH_SIZE) {
            batches.push(all.slice(i, i + BATCH_SIZE));
        }
        return batches;
    }

    it('12 个账号 → 3 批（5/5/2），无遗漏', () => {
        const b = batchIndices(12);
        expect(b.length).toBe(3);
        expect(b.map(x => x.length)).toEqual([5, 5, 2]);
        expect(b.flat().length).toBe(12);
    });

    it('恰好 5 个 → 1 批', () => {
        expect(batchIndices(5).length).toBe(1);
    });

    it('0 个账号 → 0 批（不报错）', () => {
        expect(batchIndices(0)).toEqual([]);
    });
});
