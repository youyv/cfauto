import { describe, it, expect } from 'vitest';

// ============================================================
// 回归测试：本轮审计修复的关键逻辑
// 后端纯逻辑内联复刻（避免 CF Workers 运行时依赖）
// ============================================================

describe('writeAccounts 掩码/空值保护（防凭证覆盖丢失）', () => {
    function isMaskedKey(key: string): boolean {
        return key.includes('...') || key === '***';
    }
    function encryptKey(plain: string): string {
        return 'v1:' + Buffer.from(plain).toString('base64');
    }
    /** 复刻 account-store.ts writeAccounts 的 key 决策逻辑 */
    function resolveKey(
        incoming: { accountId: string; alias: string; email: string; globalKey?: string },
        existing: Array<{ accountId: string; alias: string; email: string; globalKey: string }>
    ): string {
        if (incoming.globalKey && !isMaskedKey(incoming.globalKey)) {
            return encryptKey(incoming.globalKey);
        }
        const old = existing.find(e => e.accountId === incoming.accountId)
                 || existing.find(e => e.alias === incoming.alias && e.email === incoming.email);
        return (old && old.globalKey) || '';
    }

    const existing = [{ alias: 'a1', accountId: 'acc1', email: 'e1@x.com', globalKey: encryptKey('REAL_KEY') }];

    it('编辑时 key 留空 → 保留旧密文', () => {
        const r = resolveKey({ accountId: 'acc1', alias: 'a1', email: 'e1@x.com' }, existing);
        expect(r).toBe(encryptKey('REAL_KEY'));
    });

    it('编辑时传入掩码值 → 保留旧密文（不把掩码加密入库）', () => {
        const r = resolveKey({ accountId: 'acc1', alias: 'a1', email: 'e1@x.com', globalKey: 'REAL_...KEY' }, existing);
        expect(r).toBe(encryptKey('REAL_KEY'));
    });

    it('编辑时改了 accountId → 用 alias+email 兜底保留旧密文', () => {
        const r = resolveKey({ accountId: 'ACC_NEW', alias: 'a1', email: 'e1@x.com' }, existing);
        expect(r).toBe(encryptKey('REAL_KEY'));
    });

    it('传入真实新 key → 加密入库', () => {
        const r = resolveKey({ accountId: 'acc1', alias: 'a1', email: 'e1@x.com', globalKey: 'NEW_KEY' }, existing);
        expect(r).toBe(encryptKey('NEW_KEY'));
    });

    it('全新账号无匹配 → 空串（不会误绑旧凭证）', () => {
        const r = resolveKey({ accountId: 'zzz', alias: 'zzz', email: 'z@x.com' }, existing);
        expect(r).toBe('');
    });

    it('*** 掩码也被识别', () => {
        expect(isMaskedKey('***')).toBe(true);
        expect(isMaskedKey('abc...wxyz')).toBe(true);
        expect(isMaskedKey('1234567890abcdef')).toBe(false);
    });
});

describe('restore 白名单精确匹配（防前缀注入）', () => {
    const TEMPLATE_TYPES = ['cmliu', 'joey', 'ech'];
    const allowedPrefixes = ['ACCOUNTS_UNIFIED_STORAGE', 'AUTO_UPDATE_CFG_GLOBAL', 'DEPLOY_JOURNAL'];

    /** 复刻 crud.ts restore 的白名单判定 */
    function isAllowed(k: string): boolean {
        return allowedPrefixes.some(p => k === p)
            || TEMPLATE_TYPES.some(t => k === 'VARS_' + t || k === 'DEPLOY_CONFIG_' + t || k === 'FAVORITES_' + t);
    }

    it('系统键精确匹配通过', () => {
        expect(isAllowed('ACCOUNTS_UNIFIED_STORAGE')).toBe(true);
        expect(isAllowed('AUTO_UPDATE_CFG_GLOBAL')).toBe(true);
        expect(isAllowed('DEPLOY_JOURNAL')).toBe(true);
    });

    it('已知模板派生键通过', () => {
        expect(isAllowed('VARS_cmliu')).toBe(true);
        expect(isAllowed('DEPLOY_CONFIG_joey')).toBe(true);
        expect(isAllowed('FAVORITES_ech')).toBe(true);
    });

    it('前缀注入被拒绝', () => {
        expect(isAllowed('VARS_cmliuX')).toBe(false);
        expect(isAllowed('ACCOUNTS_UNIFIED_STORAGE_EVIL')).toBe(false);
        expect(isAllowed('DEPLOY_JOURNAL_BACKDOOR')).toBe(false);
        expect(isAllowed('VARS_unknown')).toBe(false);
    });

    it('完全无关的键被拒绝', () => {
        expect(isAllowed('RATE_LIMIT_1.2.3.4')).toBe(false);
        expect(isAllowed('SESSION_abcdef')).toBe(false);
    });
});

describe('stats resolveLimit（dailyLimit=0 不被 falsy 覆盖）', () => {
    interface Acc { dailyLimit?: number }
    /** 复刻 stats.ts resolveLimit */
    function resolveLimit(acc: Acc): number {
        return (acc.dailyLimit !== undefined && acc.dailyLimit > 0) ? acc.dailyLimit : 100000;
    }

    it('显式设置正数 → 用该值', () => {
        expect(resolveLimit({ dailyLimit: 50000 })).toBe(50000);
    });
    it('未设置 → 默认 10 万', () => {
        expect(resolveLimit({})).toBe(100000);
    });
    it('设置为 0 → 回落默认（0 不是有效配额）', () => {
        expect(resolveLimit({ dailyLimit: 0 })).toBe(100000);
    });
    it('负数 → 回落默认', () => {
        expect(resolveLimit({ dailyLimit: -5 })).toBe(100000);
    });
});

describe('API 404 判定（未匹配 /api/* 返回 JSON 而非 HTML）', () => {
    /** 复刻 index.ts 的路径判定 */
    function shouldReturn404Json(pathname: string, hasHandler: boolean): boolean {
        if (hasHandler) return false;
        return pathname.startsWith('/api/');
    }

    it('未注册的 API 路径 → 404 JSON', () => {
        expect(shouldReturn404Json('/api/migrate_encrypt_keys', false)).toBe(true);
        expect(shouldReturn404Json('/api/typo', false)).toBe(true);
    });
    it('已注册路径 → 交给 handler', () => {
        expect(shouldReturn404Json('/api/accounts', true)).toBe(false);
    });
    it('非 API 路径 → 回退面板 HTML', () => {
        expect(shouldReturn404Json('/', false)).toBe(false);
        expect(shouldReturn404Json('/dashboard', false)).toBe(false);
    });
});

describe('history 竞态守卫（reqId 机制）', () => {
    it('过期请求结果被丢弃', () => {
        let counter = 0;
        const results: string[] = [];
        function simulate(type: string) {
            const myId = ++counter;
            return (currentCounter: number) => {
                if (myId !== currentCounter) return;   // 守卫
                results.push(type);
            };
        }
        const slow = simulate('cmliu');   // myId = 1
        const fast = simulate('joey');    // myId = 2
        fast(counter);   // counter=2, myId=2 → 接受
        slow(counter);   // counter=2, myId=1 → 丢弃
        expect(results).toEqual(['joey']);
    });
});

describe('renderTable stats 兜底（防 undefined 崩溃）', () => {
    /** 复刻 accounts.js 的排序比较器 */
    function sortAccounts(accounts: Array<{ alias: string; stats?: { total: number } }>) {
        return [...accounts].sort((a, b) => ((b.stats && b.stats.total) || 0) - ((a.stats && a.stats.total) || 0));
    }

    it('stats 缺失不抛异常且排在后面', () => {
        const r = sortAccounts([
            { alias: 'no-stats' },
            { alias: 'has-stats', stats: { total: 100 } },
        ]);
        expect(r[0].alias).toBe('has-stats');
        expect(r[1].alias).toBe('no-stats');
    });

    it('全部缺失 stats 也不崩溃', () => {
        expect(() => sortAccounts([{ alias: 'a' }, { alias: 'b' }])).not.toThrow();
    });
});
