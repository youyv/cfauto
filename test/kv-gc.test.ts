/**
 * KV 回收测试 —— 日志裁剪 / 孤儿键判定 / list 翻页 / 账号删除即时清理 / cron 节流。
 *
 * 全部 import 真实实现，用 test/helpers.ts 的内存 KV（已支持 list 分页语义）。
 */
import { describe, it, expect } from 'vitest';
import {
    pruneJournal, collectOrphanKeys, runKvGc, readLiveAccountIds, deleteAccountVarsFor,
    JOURNAL_MAX_ENTRIES, JOURNAL_RETENTION_DAYS, JOURNAL_SUMMARY_MAX, JOURNAL_FAILED_MAX,
    GC_INTERVAL_MS
} from '../src/lib/kv-gc';
import { listAllKeys } from '../src/lib/kv-utils';
import { shouldRunGc, handleCronJob } from '../src/cron';
import { KV_KEYS, TEMPLATES } from '../src/config/templates';
import { writeAccounts } from '../src/lib/account-store';
import { finalizeDeploy } from '../src/lib/auto-update';
import { getRoute } from '../src/routes/register';
import { mockKV, mockEnv, readKV, stubFetch } from './helpers';
import type { JournalEntry, AutoUpdateConfig, AccountEntry } from '../src/lib/types';

const AID_A = 'a'.repeat(32);
const AID_B = 'b'.repeat(32);

function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
    return {
        time: new Date().toISOString(), type: 'cmliu', sha: 'abc1234',
        accounts: 1, total: 1, summary: 'ok', ...overrides
    };
}

// ============================================================
// pruneJournal
// ============================================================
describe('pruneJournal', () => {
    it('条数超限 → 截到上限', () => {
        const entries = Array.from({ length: 150 }, (_, i) => journalEntry({ sha: 'sha' + i }));
        const { kept, removed } = pruneJournal(entries);
        expect(kept).toHaveLength(JOURNAL_MAX_ENTRIES);
        expect(removed).toBe(50);
        // 保留最新的（数组头部）
        expect(kept[0].sha).toBe('sha0');
    });

    it('超过保留天数的条目被丢弃', () => {
        const now = Date.UTC(2026, 5, 30);
        const old = new Date(now - (JOURNAL_RETENTION_DAYS + 1) * 24 * 3600 * 1000).toISOString();
        const fresh = new Date(now - 3600 * 1000).toISOString();
        const { kept, removed } = pruneJournal(
            [journalEntry({ time: fresh, sha: 'new' }), journalEntry({ time: old, sha: 'old' })],
            now
        );
        expect(kept.map(e => e.sha)).toEqual(['new']);
        expect(removed).toBe(1);
    });

    it('时间不可解析的条目保留（不因脏数据删历史）', () => {
        const { kept } = pruneJournal([journalEntry({ time: 'not-a-date', sha: 'weird' })], Date.now());
        expect(kept.map(e => e.sha)).toEqual(['weird']);
    });

    it('summary 超长被截断', () => {
        const { kept, trimmed } = pruneJournal([journalEntry({ summary: 'x'.repeat(2000) })]);
        expect(kept[0].summary).toHaveLength(JOURNAL_SUMMARY_MAX);
        expect(trimmed).toBe(1);
    });

    it('failed 数组超长 → 截断并追加 "+N more"', () => {
        const failed = Array.from({ length: 100 }, (_, i) => 'acc -> [w' + i + ']');
        const { kept, trimmed } = pruneJournal([journalEntry({ failed })]);
        expect(kept[0].failed).toHaveLength(JOURNAL_FAILED_MAX + 1);
        expect(kept[0].failed![JOURNAL_FAILED_MAX]).toBe('+' + (100 - JOURNAL_FAILED_MAX) + ' more');
        expect(trimmed).toBe(1);
    });

    it('无需改动时 removed / trimmed 均为 0', () => {
        const { kept, removed, trimmed } = pruneJournal([journalEntry()]);
        expect(kept).toHaveLength(1);
        expect(removed).toBe(0);
        expect(trimmed).toBe(0);
    });

    it('非数组输入 → 空结果（不抛）', () => {
        expect(pruneJournal(null as unknown as JournalEntry[]).kept).toEqual([]);
    });

    it('剔除 null / 非对象条目', () => {
        const { kept } = pruneJournal([journalEntry(), null as unknown as JournalEntry, 'x' as unknown as JournalEntry]);
        expect(kept).toHaveLength(1);
    });
});

// ============================================================
// collectOrphanKeys
// ============================================================
describe('collectOrphanKeys', () => {
    it('accountId 已不存在 → 判为孤儿', () => {
        const keys = [KV_KEYS.accountVars('cmliu', AID_A), KV_KEYS.accountVars('cmliu', AID_B)];
        expect(collectOrphanKeys(keys, new Set([AID_A]))).toEqual([KV_KEYS.accountVars('cmliu', AID_B)]);
    });

    it('模板级全局变量键 VARS_<type> 不是孤儿', () => {
        const keys = Object.keys(TEMPLATES).map(t => KV_KEYS.vars(t));
        expect(collectOrphanKeys(keys, new Set())).toEqual([]);
    });

    it('未知模板的账号级键 → 孤儿（模板下线后的残留）', () => {
        expect(collectOrphanKeys(['VARS_removedtpl_ACC_' + AID_A], new Set([AID_A])))
            .toEqual(['VARS_removedtpl_ACC_' + AID_A]);
    });

    it('畸形键名 → 孤儿（防 restore 注入的脏键长期占用）', () => {
        const bad = ['VARS_cmliu_ACC_', 'VARS_cmliu_ACC_bad!id', 'VARS_evil'];
        expect(collectOrphanKeys(bad, new Set([AID_A]))).toEqual(bad);
    });

    it('账号仍存在 → 保留（不误删熔断状态）', () => {
        const key = KV_KEYS.accountVars('joey', AID_A);
        expect(collectOrphanKeys([key], new Set([AID_A, AID_B]))).toEqual([]);
    });
});

// ============================================================
// readLiveAccountIds —— 「不可信」必须返回 null，而非空集合
// ============================================================
describe('readLiveAccountIds', () => {
    it('键不存在 → 可信的空集合', async () => {
        const ids = await readLiveAccountIds(mockKV());
        expect(ids).toEqual(new Set());
    });

    it('正常账号表 → accountId 集合', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: AID_A }, { alias: 'b', accountId: AID_B }] });
        expect(await readLiveAccountIds(kv)).toEqual(new Set([AID_A, AID_B]));
    });

    it('JSON 损坏 → null（调用方须放弃回收，否则会删光账号级覆盖）', async () => {
        const kv = mockKV();
        await kv.put(KV_KEYS.ACCOUNTS, '{ broken json');
        expect(await readLiveAccountIds(kv)).toBeNull();
    });

    it('值不是数组 → null', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: { not: 'an array' } });
        expect(await readLiveAccountIds(kv)).toBeNull();
    });

    it('get 抛错 → null', async () => {
        const kv = mockKV();
        kv.get = async () => { throw new Error('KV down'); };
        expect(await readLiveAccountIds(kv)).toBeNull();
    });
});

// ============================================================
// listAllKeys 翻页
// ============================================================
describe('listAllKeys', () => {
    it('跨页枚举出全部键', async () => {
        const kv = mockKV();
        for (let i = 0; i < 25; i++) await kv.put('VARS_cmliu_ACC_' + String(i).padStart(32, '0'), '[]');
        kv._listPageSize = 10;   // 强制分 3 页
        const { names, complete } = await listAllKeys(kv, 'VARS_');
        expect(names).toHaveLength(25);
        expect(complete).toBe(true);
    });

    it('达到翻页上限 → complete: false', async () => {
        const kv = mockKV();
        for (let i = 0; i < 20; i++) await kv.put('VARS_k' + i, '[]');
        kv._listPageSize = 1;
        const { names, complete } = await listAllKeys(kv, 'VARS_', 3);
        expect(names).toHaveLength(3);
        expect(complete).toBe(false);
    });

    it('前缀过滤生效', async () => {
        const kv = mockKV({ 'VARS_cmliu': '[]', 'SESSION_x': 'y', [KV_KEYS.ACCOUNTS]: [] });
        const { names } = await listAllKeys(kv, 'VARS_');
        expect(names).toEqual(['VARS_cmliu']);
    });
});

// ============================================================
// runKvGc
// ============================================================
describe('runKvGc', () => {
    it('删除孤儿键，保留存活账号的键与模板级键', async () => {
        const unknownTplKey = 'VARS_unknown_ACC_' + AID_A;
        const kv = mockKV({
            [KV_KEYS.vars('cmliu')]: [{ key: 'UUID', value: 'g' }],
            [KV_KEYS.accountVars('cmliu', AID_A)]: [{ key: 'UUID', value: 'live' }],
            [KV_KEYS.accountVars('cmliu', AID_B)]: [{ key: 'UUID', value: 'dead' }],
            [unknownTplKey]: [{ key: 'x', value: '1' }]
        });
        const r = await runKvGc(mockEnv(kv), new Set([AID_A]));
        expect(r.orphansDeleted).toBe(2);
        expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_A))).not.toBeNull();
        expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_B))).toBeNull();
        expect(readKV(kv, unknownTplKey)).toBeNull();
        expect(readKV(kv, KV_KEYS.vars('cmliu'))).not.toBeNull();
    });

    it('裁剪超限的部署日志', async () => {
        const kv = mockKV({
            [KV_KEYS.DEPLOY_JOURNAL]: Array.from({ length: 130 }, () => journalEntry())
        });
        const r = await runKvGc(mockEnv(kv), new Set());
        expect(r.journalRemoved).toBe(30);
        expect(readKV<JournalEntry[]>(kv, KV_KEYS.DEPLOY_JOURNAL)).toHaveLength(JOURNAL_MAX_ENTRIES);
    });

    it('无垃圾时不写 KV（避免每天一次无谓写入）', async () => {
        const kv = mockKV({ [KV_KEYS.DEPLOY_JOURNAL]: [journalEntry()] });
        const before = kv._puts;
        const r = await runKvGc(mockEnv(kv), new Set());
        expect(r.journalRemoved).toBe(0);
        expect(r.orphansDeleted).toBe(0);
        expect(kv._puts).toBe(before);
    });

    it('list 未列完 → listComplete: false（供 cron 记录告警）', async () => {
        const kv = mockKV();
        for (let i = 0; i < 30; i++) await kv.put('VARS_x' + i, '[]');
        kv._listPageSize = 1;
        // maxPages 默认 20 < 30 个键
        const r = await runKvGc(mockEnv(kv), new Set());
        expect(r.listComplete).toBe(false);
    });

    it('单个 delete 失败不中断其余键', async () => {
        const kv = mockKV({
            [KV_KEYS.accountVars('cmliu', AID_A)]: [],
            [KV_KEYS.accountVars('joey', AID_A)]: []
        });
        const realDelete = kv.delete.bind(kv);
        let first = true;
        kv.delete = async (key: string) => {
            if (first) { first = false; throw new Error('delete failed'); }
            return realDelete(key);
        };
        const r = await runKvGc(mockEnv(kv), new Set());   // AID_A 不在存活集合 → 两个都是孤儿
        expect(r.orphansDeleted).toBe(1);
    });
});

// ============================================================
// 账号删除 → 即时清理账号级覆盖
// ============================================================
describe('writeAccounts 删除账号时清理 accountVars', () => {
    const acc = (accountId: string, alias: string): AccountEntry => ({
        alias, accountId, email: alias + '@e.com', globalKey: 'k-' + alias
    });

    it('账号被移除 → 其所有模板的 accountVars 一并删除', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acc(AID_A, 'a'), acc(AID_B, 'b')]);
        await kv.put(KV_KEYS.accountVars('cmliu', AID_B), '[{"key":"UUID","value":"x"}]');
        await kv.put(KV_KEYS.accountVars('joey', AID_B), '[]');

        await writeAccounts(env, [acc(AID_A, 'a')]);   // 删掉 B

        expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_B))).toBeNull();
        expect(readKV(kv, KV_KEYS.accountVars('joey', AID_B))).toBeNull();
    });

    it('账号仍在 → 不动它的 accountVars（熔断状态必须保住）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acc(AID_A, 'a')]);
        await kv.put(KV_KEYS.accountVars('cmliu', AID_A), '[{"key":"UUID","value":"rotated"}]');

        await writeAccounts(env, [acc(AID_A, 'a'), acc(AID_B, 'b')]);   // 新增 B

        expect(readKV<any[]>(kv, KV_KEYS.accountVars('cmliu', AID_A))![0].value).toBe('rotated');
    });

    it('清理失败不影响账号保存本身', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [acc(AID_A, 'a'), acc(AID_B, 'b')]);
        kv.delete = async () => { throw new Error('delete down'); };
        await expect(writeAccounts(env, [acc(AID_A, 'a')])).resolves.toBeUndefined();
        expect(readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)).toHaveLength(1);
    });
});

describe('deleteAccountVarsFor', () => {
    it('按模板数量删键', async () => {
        const kv = mockKV();
        const n = await deleteAccountVarsFor(kv, [AID_A]);
        expect(n).toBe(Object.keys(TEMPLATES).length);
        expect(kv._deletes).toContain(KV_KEYS.accountVars('cmliu', AID_A));
    });
});

// ============================================================
// 写入侧裁剪：finalizeDeploy 不再写入无上限的 failed 数组
// ============================================================
describe('finalizeDeploy journal 体积', () => {
    it('大量失败目标 → failed 被截断，summary 不超上限', async () => {
        const kv = mockKV();
        const logs = Array.from({ length: 60 }, (_, i) => ({
            name: 'acc -> [w' + i + ']', success: false, msg: '❌ '.repeat(40), targetKey: AID_A + '::w' + i
        }));
        await finalizeDeploy(mockEnv(kv), 'cmliu', true, 'sha-x', logs, '');
        const journal = readKV<JournalEntry[]>(kv, KV_KEYS.DEPLOY_JOURNAL)!;
        expect(journal[0].failed!.length).toBe(JOURNAL_FAILED_MAX + 1);
        expect(journal[0].summary.length).toBeLessThanOrEqual(JOURNAL_SUMMARY_MAX);
    });
});

// ============================================================
// cron 节流与解耦
// ============================================================
describe('shouldRunGc', () => {
    it('从未执行过 → 立即执行', () => {
        expect(shouldRunGc(undefined, Date.now())).toBe(true);
    });
    it('间隔未到 → 跳过', () => {
        const now = Date.now();
        expect(shouldRunGc(now - 3600 * 1000, now)).toBe(false);
    });
    it('间隔已到 → 执行', () => {
        const now = Date.now();
        expect(shouldRunGc(now - GC_INTERVAL_MS - 1, now)).toBe(true);
    });
});

describe('handleCronJob 的 KV 回收', () => {
    it('自动更新关闭时依然回收（垃圾的产生与开关无关）', async () => {
        const kv = mockKV({
            [KV_KEYS.GLOBAL_CONFIG]: { enabled: false },
            [KV_KEYS.ACCOUNTS]: [],
            [KV_KEYS.accountVars('cmliu', AID_A)]: [{ key: 'UUID', value: 'stale' }]
        });
        const stub = stubFetch([], () => { throw new Error('不应发起网络请求'); });
        try {
            await handleCronJob(mockEnv(kv));
            expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_A))).toBeNull();
            expect(readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!.lastGc).toBeGreaterThan(0);
            // 未启用时不应推进 lastCheck
            expect(readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!.lastCheck).toBeUndefined();
        } finally { stub.restore(); }
    });

    it('lastGc 未到 24h → 不回收', async () => {
        const kv = mockKV({
            [KV_KEYS.GLOBAL_CONFIG]: { enabled: false, lastGc: Date.now() },
            [KV_KEYS.ACCOUNTS]: [],
            [KV_KEYS.accountVars('cmliu', AID_A)]: []
        });
        const stub = stubFetch([], () => { throw new Error('不应发起网络请求'); });
        try {
            await handleCronJob(mockEnv(kv));
            expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_A))).not.toBeNull();
        } finally { stub.restore(); }
    });

    it('账号表损坏 → 跳过回收，绝不删任何账号级覆盖', async () => {
        const kv = mockKV({
            [KV_KEYS.GLOBAL_CONFIG]: { enabled: false },
            [KV_KEYS.accountVars('cmliu', AID_A)]: [{ key: 'UUID', value: 'keep-me' }]
        });
        await kv.put(KV_KEYS.ACCOUNTS, '{ corrupted');
        const stub = stubFetch([], () => { throw new Error('不应发起网络请求'); });
        try {
            await handleCronJob(mockEnv(kv));
            expect(readKV(kv, KV_KEYS.accountVars('cmliu', AID_A))).not.toBeNull();
            // 跳过时不推进 lastGc，下轮还会再试
            expect(readKV<AutoUpdateConfig>(kv, KV_KEYS.GLOBAL_CONFIG)!.lastGc).toBeUndefined();
        } finally { stub.restore(); }
    });

    it('回收异常不影响 cron 整体（不抛出到 scheduled）', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: false } });
        kv.list = async () => { throw new Error('list down'); };
        const stub = stubFetch([], () => { throw new Error('不应发起网络请求'); });
        try {
            await expect(handleCronJob(mockEnv(kv))).resolves.toBeUndefined();
        } finally { stub.restore(); }
    });
});

// ============================================================
// /api/diag 的 KV 用量概览
// ============================================================
describe('GET /api/diag 的 __kv_usage', () => {
    it('报告键数量、孤儿数、日志体积与上次回收时间', async () => {
        const kv = mockKV({
            [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: AID_A }],
            [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, lastGc: Date.UTC(2026, 0, 2) },
            [KV_KEYS.DEPLOY_JOURNAL]: [journalEntry(), journalEntry()],
            [KV_KEYS.accountVars('cmliu', AID_A)]: [],
            [KV_KEYS.accountVars('cmliu', AID_B)]: [],
            'SESSION_tok': 'csrf',
            'RATE_LIMIT_1.2.3.4': '3'
        });
        const handler = getRoute('GET', '/api/diag')!;
        const body = await (await handler(new Request('https://x/api/diag'), mockEnv(kv))).json() as any;
        const usage = body.__kv_usage;
        expect(usage.sessions).toBe(1);
        expect(usage.rateLimits).toBe(1);
        expect(usage.accountVars).toBe(2);
        expect(usage.orphanAccountVars).toBe(1);   // AID_B 已不在账号表
        expect(usage.journalEntries).toBe(2);
        expect(usage.journalBytes).toBeGreaterThan(0);
        expect(usage.lastGc).toBe('2026-01-02T00:00:00.000Z');
    });

    it('账号表不可信时不报数字，而是明确说明', async () => {
        const kv = mockKV();
        await kv.put(KV_KEYS.ACCOUNTS, 'not json');
        const handler = getRoute('GET', '/api/diag')!;
        const body = await (await handler(new Request('https://x/api/diag'), mockEnv(kv))).json() as any;
        expect(String(body.__kv_usage.orphanAccountVars)).toContain('不可信');
    });

    it('从未回收过 → lastGc 显示 (never)', async () => {
        const handler = getRoute('GET', '/api/diag')!;
        const body = await (await handler(new Request('https://x/api/diag'), mockEnv(mockKV()))).json() as any;
        expect(body.__kv_usage.lastGc).toBe('(never)');
    });
});

// ============================================================
// backup 的完整枚举（此前只读 list 第一页）
// ============================================================
describe('GET /api/backup 枚举账号级变量', () => {
    it('键数超过单页上限时仍全部备份', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [] });
        const ids = Array.from({ length: 15 }, (_, i) => String(i).padStart(32, '0'));
        for (const id of ids) await kv.put(KV_KEYS.accountVars('cmliu', id), '[{"key":"UUID","value":"' + id + '"}]');
        kv._listPageSize = 5;   // 强制 3 页

        const handler = getRoute('GET', '/api/backup')!;
        const body = await (await handler(new Request('https://x/api/backup'), mockEnv(kv))).json() as any;
        for (const id of ids) {
            expect(body[KV_KEYS.accountVars('cmliu', id)]).toEqual([{ key: 'UUID', value: id }]);
        }
        expect(body._warning).toBeUndefined();
    });
});
