import { describe, it, expect } from 'vitest';
import { readAccounts, readAccountsMasked, writeAccounts, getWorkerNames, setWorkerNames, addWorkerName, removeWorkerName, hasAnyWorker, findAccount } from '../src/lib/account-store';
import { encryptKey, decryptKey, secretFingerprint, VERSION_PREFIX } from '../src/lib/crypto-utils';
import { resolveLimit, FREE_PLAN_DAILY_LIMIT } from '../src/lib/stats';
import { isRestorableKey, backupKeys } from '../src/routes/crud';
import { isAccountVarsKey, KV_KEYS, autoUpdateTypes, fuseRotatableTypes, autoFlagKey, TEMPLATES } from '../src/config/templates';
import { validateAccountsPayload, normalizeVariables, normalizeAutoConfig, requireTemplateType, validateRequired } from '../src/lib/validate';
import { mockKV, mockEnv, readKV } from './helpers';
import type { AccountEntry } from '../src/lib/types';

// ============================================================
// account-store: 凭证保护（真实模块 + 真实 AES-GCM 加解密）
// ============================================================
describe('writeAccounts 掩码/空值保护（防凭证覆盖丢失）', () => {
    const base = (over: Partial<AccountEntry> = {}): AccountEntry => ({
        alias: 'a1', accountId: 'a'.repeat(32), email: 'e1@x.com', globalKey: 'REAL_KEY', ...over
    });

    it('首次写入：明文 key 被加密（带 v1: 前缀）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [base()]);
        const stored = readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)!;
        expect(stored[0].globalKey.startsWith(VERSION_PREFIX)).toBe(true);
        expect(stored[0].globalKey).not.toContain('REAL_KEY');
        // 读回时自动解密
        expect((await readAccounts(env))[0].globalKey).toBe('REAL_KEY');
    });

    it('编辑时 key 留空 → 保留旧密文', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [base()]);
        const before = readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)![0].globalKey;
        await writeAccounts(env, [base({ globalKey: '', email: 'changed@x.com' })]);
        const after = readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)![0];
        expect(after.globalKey).toBe(before);
        expect(after.email).toBe('changed@x.com');
    });

    it('编辑时传入掩码值 → 保留旧密文（不把掩码加密入库）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [base()]);
        const before = readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)![0].globalKey;
        await writeAccounts(env, [base({ globalKey: 'REAL_...KEY' })]);
        expect(readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)![0].globalKey).toBe(before);
        expect((await readAccounts(env))[0].globalKey).toBe('REAL_KEY');
    });

    it('*** 掩码同样被识别（短 key 的脱敏形态）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [base()]);
        await writeAccounts(env, [base({ globalKey: '***' })]);
        expect((await readAccounts(env))[0].globalKey).toBe('REAL_KEY');
    });

    it('编辑时改了 accountId → 用 alias+email 兜底保留旧密文', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [base()]);
        await writeAccounts(env, [base({ accountId: 'b'.repeat(32), globalKey: '' })]);
        expect((await readAccounts(env))[0].globalKey).toBe('REAL_KEY');
    });

    it('传入真实新 key → 加密入库并覆盖旧值', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [base()]);
        await writeAccounts(env, [base({ globalKey: 'NEW_KEY' })]);
        expect((await readAccounts(env))[0].globalKey).toBe('NEW_KEY');
    });

    it('全新账号且 key 为空 → 落空字符串（无旧值可保留）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [base({ globalKey: '' })]);
        expect(readKV<AccountEntry[]>(kv, KV_KEYS.ACCOUNTS)![0].globalKey).toBe('');
    });

    it('不原地修改调用者传入的数组（避免调用方拿到密文）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        const input = [base()];
        await writeAccounts(env, input);
        expect(input[0].globalKey).toBe('REAL_KEY');
    });
});

describe('readAccounts 解密失败处理', () => {
    it('密钥变更导致解密失败 → globalKey 清空（不把密文当 API Key 用）', async () => {
        const kv = mockKV();
        // 用旧密钥加密
        await writeAccounts(mockEnv(kv, { ACCESS_CODE: 'old-secret' }), [
            { alias: 'a', accountId: 'a'.repeat(32), email: 'e@x.com', globalKey: 'SECRET' }
        ]);
        // 换新密钥读取
        const accounts = await readAccounts(mockEnv(kv, { ACCESS_CODE: 'new-secret' }));
        expect(accounts[0].globalKey).toBe('');
    });

    it('存量明文（无 v1: 前缀）原样返回，不被清空', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'x', email: 'e', globalKey: 'PLAIN_KEY' }] });
        const accounts = await readAccounts(mockEnv(kv));
        expect(accounts[0].globalKey).toBe('PLAIN_KEY');
    });

    it('ENCRYPTION_SECRET 存在时，改 ACCESS_CODE 不影响解密', async () => {
        const kv = mockKV();
        const envA = mockEnv(kv, { ACCESS_CODE: 'pass-1', ENCRYPTION_SECRET: 'stable-secret' });
        await writeAccounts(envA, [{ alias: 'a', accountId: 'a'.repeat(32), email: 'e@x.com', globalKey: 'K' }]);
        const envB = mockEnv(kv, { ACCESS_CODE: 'pass-2', ENCRYPTION_SECRET: 'stable-secret' });
        expect((await readAccounts(envB))[0].globalKey).toBe('K');
    });
});

describe('readAccountsMasked 脱敏', () => {
    it('长 key 保留前 6 后 4', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [{ alias: 'a', accountId: 'a'.repeat(32), email: 'e@x.com', globalKey: '1234567890abcdef' }]);
        expect((await readAccountsMasked(env))[0].globalKey).toBe('123456...cdef');
    });

    it('短 key 用 *** 而非暴露原文', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'x', email: 'e', globalKey: 'short' }] });
        expect((await readAccountsMasked(mockEnv(kv)))[0].globalKey).toBe('***');
    });

    it('空 key 返回空串（前端据此显示"密钥缺失"）', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'x', email: 'e', globalKey: '' }] });
        expect((await readAccountsMasked(mockEnv(kv)))[0].globalKey).toBe('');
    });
});

describe('crypto-utils', () => {
    it('加解密往返一致', async () => {
        const env = mockEnv(mockKV());
        const enc = await encryptKey(env, 'hello-世界');
        expect(enc.startsWith(VERSION_PREFIX)).toBe(true);
        expect(await decryptKey(env, enc)).toBe('hello-世界');
    });

    it('相同明文两次加密结果不同（随机 IV）', async () => {
        const env = mockEnv(mockKV());
        expect(await encryptKey(env, 'x')).not.toBe(await encryptKey(env, 'x'));
    });

    it('空串加密返回空串', async () => {
        expect(await encryptKey(mockEnv(mockKV()), '')).toBe('');
    });

    it('密钥指纹稳定且不泄漏 secret', async () => {
        const env = mockEnv(mockKV(), { ENCRYPTION_SECRET: 'my-secret' });
        const fp = await secretFingerprint(env);
        expect(fp).toMatch(/^[0-9a-f]{8}$/);
        expect(await secretFingerprint(env)).toBe(fp);
        expect(fp).not.toContain('my-secret');
    });

    it('不同 secret 指纹不同（导入时可据此判定注定解密失败）', async () => {
        const a = await secretFingerprint(mockEnv(mockKV(), { ENCRYPTION_SECRET: 's1' }));
        const b = await secretFingerprint(mockEnv(mockKV(), { ENCRYPTION_SECRET: 's2' }));
        expect(a).not.toBe(b);
    });
});

// ============================================================
// account-store: workers_<type> 访问器（取代散落的字符串拼接）
// ============================================================
describe('Worker 列表访问器', () => {
    const acc = (): AccountEntry => ({ alias: 'a', accountId: 'x', email: 'e', globalKey: 'k', workers_cmliu: ['w1', 'w2'] });

    it('getWorkerNames 读取对应模板列表，缺失返回空数组', () => {
        expect(getWorkerNames(acc(), 'cmliu')).toEqual(['w1', 'w2']);
        expect(getWorkerNames(acc(), 'joey')).toEqual([]);
        expect(getWorkerNames(acc(), 'unknown')).toEqual([]);
    });

    it('setWorkerNames 覆盖列表', () => {
        const a = acc();
        setWorkerNames(a, 'cmliu', ['only']);
        expect(getWorkerNames(a, 'cmliu')).toEqual(['only']);
    });

    it('addWorkerName 去重并返回是否修改', () => {
        const a = acc();
        expect(addWorkerName(a, 'cmliu', 'w1')).toBe(false);
        expect(addWorkerName(a, 'cmliu', 'w3')).toBe(true);
        expect(getWorkerNames(a, 'cmliu')).toEqual(['w1', 'w2', 'w3']);
    });

    it('addWorkerName 可为全新模板建列表', () => {
        const a = acc();
        expect(addWorkerName(a, 'ech', 'e1')).toBe(true);
        expect(getWorkerNames(a, 'ech')).toEqual(['e1']);
    });

    it('removeWorkerName 返回是否修改', () => {
        const a = acc();
        expect(removeWorkerName(a, 'cmliu', 'nope')).toBe(false);
        expect(removeWorkerName(a, 'cmliu', 'w1')).toBe(true);
        expect(getWorkerNames(a, 'cmliu')).toEqual(['w2']);
    });

    it('hasAnyWorker 跨账号判定', () => {
        const list = [acc(), { alias: 'b', accountId: 'y', email: 'e', globalKey: 'k' } as AccountEntry];
        expect(hasAnyWorker(list, 'cmliu')).toBe(true);
        expect(hasAnyWorker(list, 'joey')).toBe(false);
        expect(hasAnyWorker([], 'cmliu')).toBe(false);
    });

    it('findAccount 按 accountId 精确查找', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        await writeAccounts(env, [
            { alias: 'a', accountId: 'a'.repeat(32), email: 'e@x.com', globalKey: 'K1' },
            { alias: 'b', accountId: 'b'.repeat(32), email: 'f@x.com', globalKey: 'K2' }
        ]);
        expect((await findAccount(env, 'b'.repeat(32)))!.alias).toBe('b');
        expect(await findAccount(env, 'c'.repeat(32))).toBeUndefined();
    });
});

// ============================================================
// restore 白名单（真实实现，防前缀注入）
// ============================================================
describe('restore 白名单', () => {
    it('放行已知固定键', () => {
        expect(isRestorableKey(KV_KEYS.ACCOUNTS)).toBe(true);
        expect(isRestorableKey(KV_KEYS.GLOBAL_CONFIG)).toBe(true);
        expect(isRestorableKey(KV_KEYS.DEPLOY_JOURNAL)).toBe(true);
    });

    it('放行已知模板的三类键', () => {
        for (const t of Object.keys(TEMPLATES)) {
            expect(isRestorableKey(KV_KEYS.vars(t))).toBe(true);
            expect(isRestorableKey(KV_KEYS.deployConfig(t))).toBe(true);
            expect(isRestorableKey(KV_KEYS.favorites(t))).toBe(true);
        }
    });

    it('拒绝前缀注入键', () => {
        expect(isRestorableKey('VARS_cmliuX')).toBe(false);
        expect(isRestorableKey('ACCOUNTS_UNIFIED_STORAGE_EVIL')).toBe(false);
        expect(isRestorableKey('DEPLOY_CONFIG_cmliu_extra')).toBe(false);
        expect(isRestorableKey('FAVORITES_')).toBe(false);
    });

    it('拒绝未知模板类型的键', () => {
        expect(isRestorableKey('VARS_unknowntemplate')).toBe(false);
    });

    it('拒绝会话与限流键（不可通过备份注入会话）', () => {
        expect(isRestorableKey('SESSION_' + 'a'.repeat(64))).toBe(false);
        expect(isRestorableKey('RATE_LIMIT_1.2.3.4')).toBe(false);
    });

    it('拒绝元数据键与空键', () => {
        expect(isRestorableKey('_time')).toBe(false);
        expect(isRestorableKey('_encryptionFingerprint')).toBe(false);
        expect(isRestorableKey('')).toBe(false);
    });

    it('放行合法的账号级变量键，拒绝伪造形态', () => {
        expect(isAccountVarsKey('VARS_cmliu_ACC_' + 'a'.repeat(32))).toBe(true);
        expect(isRestorableKey('VARS_cmliu_ACC_' + 'a'.repeat(32))).toBe(true);
        expect(isAccountVarsKey('VARS_unknown_ACC_' + 'a'.repeat(32))).toBe(false);
        expect(isAccountVarsKey('VARS_cmliu_ACC_')).toBe(false);
        expect(isAccountVarsKey('VARS_cmliu_ACC_bad!id')).toBe(false);
    });

    it('backupKeys 覆盖所有模板（新增模板自动纳入）', () => {
        const keys = backupKeys();
        expect(keys).toContain(KV_KEYS.ACCOUNTS);
        for (const t of Object.keys(TEMPLATES)) expect(keys).toContain(KV_KEYS.vars(t));
        expect(keys.length).toBe(3 + Object.keys(TEMPLATES).length * 3);
    });
});

// ============================================================
// stats: resolveLimit 边界（区分未设置与显式 0）
// ============================================================
describe('resolveLimit', () => {
    it('未设置 → 免费计划默认值', () => {
        expect(resolveLimit({})).toBe(FREE_PLAN_DAILY_LIMIT);
        expect(resolveLimit({ dailyLimit: undefined })).toBe(FREE_PLAN_DAILY_LIMIT);
    });
    it('显式 0 → 回落默认值而非 0（避免除零）', () => {
        expect(resolveLimit({ dailyLimit: 0 })).toBe(FREE_PLAN_DAILY_LIMIT);
    });
    it('负数 → 回落默认值', () => {
        expect(resolveLimit({ dailyLimit: -1 })).toBe(FREE_PLAN_DAILY_LIMIT);
    });
    it('正数 → 使用设定值', () => {
        expect(resolveLimit({ dailyLimit: 5000000 })).toBe(5000000);
    });
});

// ============================================================
// 模板配置派生（autoUpdate 与 uuidField 解耦）
// ============================================================
describe('模板类型派生', () => {
    it('autoUpdateTypes 包含 ech（其 uuidField 为空但仍需跟随上游更新）', () => {
        const types = autoUpdateTypes();
        expect(types).toContain('ech');
        expect(types).toContain('cmliu');
        expect(types).toContain('joey');
    });

    it('fuseRotatableTypes 排除 ech（无 UUID 无法轮换）', () => {
        const types = fuseRotatableTypes();
        expect(types).not.toContain('ech');
        expect(types).toContain('cmliu');
        expect(types).toContain('joey');
    });

    it('两者不是同一集合（这正是 ech 自动更新此前失效的根因）', () => {
        expect(autoUpdateTypes().length).toBeGreaterThan(fuseRotatableTypes().length);
    });

    it('autoFlagKey 生成配置字段名', () => {
        expect(autoFlagKey('cmliu')).toBe('autoCmliu');
        expect(autoFlagKey('joey')).toBe('autoJoey');
        expect(autoFlagKey('ech')).toBe('autoEch');
    });

    it('每个模板都声明了 autoUpdate 字段', () => {
        for (const [name, t] of Object.entries(TEMPLATES)) {
            expect(typeof t.autoUpdate, name).toBe('boolean');
        }
    });
});

// ============================================================
// validate: 账号 payload / 变量 / 自动更新配置
// ============================================================
describe('validateAccountsPayload', () => {
    const ok = (over: Record<string, unknown> = {}) => ({ alias: 'a', accountId: 'a'.repeat(32), email: 'e@x.com', ...over });

    it('合法数组通过', () => {
        const r = validateAccountsPayload([ok()]);
        expect(r.ok).toBe(true);
    });

    it('空数组通过（清空所有账号是合法操作）', () => {
        expect(validateAccountsPayload([]).ok).toBe(true);
    });

    it('非数组拒绝', () => {
        expect(validateAccountsPayload({}).ok).toBe(false);
        expect(validateAccountsPayload(null).ok).toBe(false);
        expect(validateAccountsPayload('x').ok).toBe(false);
    });

    it('超过 500 个拒绝', () => {
        const many = Array.from({ length: 501 }, (_, i) => ok({ alias: 'a' + i, accountId: i.toString(16).padStart(32, '0') }));
        expect(validateAccountsPayload(many).ok).toBe(false);
    });

    it('缺 alias 或 accountId 拒绝', () => {
        expect(validateAccountsPayload([ok({ alias: '' })]).ok).toBe(false);
        expect(validateAccountsPayload([ok({ accountId: '' })]).ok).toBe(false);
        expect(validateAccountsPayload([ok({ alias: '   ' })]).ok).toBe(false);
    });

    it('accountId 非 32 位十六进制拒绝', () => {
        expect(validateAccountsPayload([ok({ accountId: 'not-hex' })]).ok).toBe(false);
        expect(validateAccountsPayload([ok({ accountId: 'a'.repeat(31) })]).ok).toBe(false);
        expect(validateAccountsPayload([ok({ accountId: 'g'.repeat(32) })]).ok).toBe(false);
    });

    it('alias 重复拒绝（alias 是事实上的主键）', () => {
        const r = validateAccountsPayload([
            ok({ alias: 'dup', accountId: 'a'.repeat(32) }),
            ok({ alias: 'dup', accountId: 'b'.repeat(32) })
        ]);
        expect(r.ok).toBe(false);
    });

    it('accountId 重复拒绝', () => {
        const r = validateAccountsPayload([
            ok({ alias: 'x', accountId: 'a'.repeat(32) }),
            ok({ alias: 'y', accountId: 'a'.repeat(32) })
        ]);
        expect(r.ok).toBe(false);
    });

    it('workers_* 非字符串数组拒绝', () => {
        expect(validateAccountsPayload([ok({ workers_cmliu: 'not-array' })]).ok).toBe(false);
        expect(validateAccountsPayload([ok({ workers_cmliu: [1, 2] })]).ok).toBe(false);
        expect(validateAccountsPayload([ok({ workers_cmliu: ['w'] })]).ok).toBe(true);
    });

    it('条目非对象拒绝', () => {
        expect(validateAccountsPayload(['string']).ok).toBe(false);
        expect(validateAccountsPayload([null]).ok).toBe(false);
        expect(validateAccountsPayload([[]]).ok).toBe(false);
    });
});

describe('normalizeVariables', () => {
    it('合法数组通过并保留 secret 标记', () => {
        const r = normalizeVariables([{ key: 'A', value: '1' }, { key: 'T', value: 's', secret: true }]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toEqual([{ key: 'A', value: '1' }, { key: 'T', value: 's', secret: true }]);
    });

    it('非数组拒绝（此前对象会被直接写进 KV，读取侧 .map 崩溃）', () => {
        expect(normalizeVariables({ A: '1' }).ok).toBe(false);
        expect(normalizeVariables(null).ok).toBe(false);
        expect(normalizeVariables('[]').ok).toBe(false);
    });

    it('空 key 静默丢弃（前端空行）', () => {
        const r = normalizeVariables([{ key: '', value: 'x' }, { key: '  ', value: 'y' }, { key: 'A', value: '1' }]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toHaveLength(1);
    });

    it('非法变量名拒绝', () => {
        expect(normalizeVariables([{ key: '1BAD', value: 'x' }]).ok).toBe(false);
        expect(normalizeVariables([{ key: 'BAD-NAME', value: 'x' }]).ok).toBe(false);
        expect(normalizeVariables([{ key: 'BAD NAME', value: 'x' }]).ok).toBe(false);
    });

    it('重复变量名拒绝', () => {
        expect(normalizeVariables([{ key: 'A', value: '1' }, { key: 'A', value: '2' }]).ok).toBe(false);
    });

    it('value 缺失/null 归一为空串', () => {
        const r = normalizeVariables([{ key: 'A' }, { key: 'B', value: null }]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toEqual([{ key: 'A', value: '' }, { key: 'B', value: '' }]);
    });

    it('数量与长度超限拒绝', () => {
        const many = Array.from({ length: 129 }, (_, i) => ({ key: 'K' + i, value: 'v' }));
        expect(normalizeVariables(many).ok).toBe(false);
        expect(normalizeVariables([{ key: 'A', value: 'x'.repeat(8193) }]).ok).toBe(false);
    });

    it('条目非对象拒绝', () => {
        expect(normalizeVariables(['A=1']).ok).toBe(false);
    });

    it('剥离未知字段（不把任意负载写进 KV）', () => {
        const r = normalizeVariables([{ key: 'A', value: '1', evil: 'x' } as any]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(Object.keys(r.value[0]).sort()).toEqual(['key', 'value']);
    });
});

describe('normalizeAutoConfig', () => {
    it('合法配置归一为数字类型', () => {
        const r = normalizeAutoConfig({ enabled: true, interval: '45', fuseThreshold: '90', fuseWebhook: 'https://h.example.com/x' });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.interval).toBe(45);
        expect(r.value.fuseThreshold).toBe(90);
        expect(r.value.enabled).toBe(true);
    });

    it('非对象拒绝', () => {
        expect(normalizeAutoConfig([]).ok).toBe(false);
        expect(normalizeAutoConfig(null).ok).toBe(false);
        expect(normalizeAutoConfig('x').ok).toBe(false);
    });

    it('interval 越界拒绝', () => {
        expect(normalizeAutoConfig({ interval: 0 }).ok).toBe(false);
        expect(normalizeAutoConfig({ interval: 1441 }).ok).toBe(false);
        expect(normalizeAutoConfig({ interval: 'abc' }).ok).toBe(false);
    });

    it('fuseThreshold 越界拒绝，0 表示关闭', () => {
        expect(normalizeAutoConfig({ fuseThreshold: 101 }).ok).toBe(false);
        expect(normalizeAutoConfig({ fuseThreshold: -1 }).ok).toBe(false);
        const r = normalizeAutoConfig({ fuseThreshold: 0 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.fuseThreshold).toBe(0);
    });

    it('webhook 必须 https', () => {
        expect(normalizeAutoConfig({ fuseWebhook: 'http://h.example.com' }).ok).toBe(false);
        expect(normalizeAutoConfig({ fuseWebhook: 'not-a-url' }).ok).toBe(false);
        expect(normalizeAutoConfig({ fuseWebhook: '' }).ok).toBe(true);
    });

    it('保留 lastCheck（前端保存配置不会清零 cron 节流状态）', () => {
        const r = normalizeAutoConfig({ enabled: true, lastCheck: 1234567890 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.lastCheck).toBe(1234567890);
    });

    it('只接受已知模板的开关键，未知键被丢弃', () => {
        const r = normalizeAutoConfig({ enabled: true, autoCmliu: false, autoEvil: true });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.autoCmliu).toBe(false);
        expect('autoEvil' in r.value).toBe(false);
    });

    it('ech 开关被保留（对应 cron 中真实生效的自动更新）', () => {
        const r = normalizeAutoConfig({ enabled: true, autoEch: false });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.autoEch).toBe(false);
    });
});

describe('requireTemplateType / validateRequired', () => {
    it('已知模板通过', () => {
        expect(requireTemplateType('cmliu')).toBeNull();
    });
    it('未知模板拒绝', () => {
        expect(requireTemplateType('evil')).not.toBeNull();
    });
    it('required=false 时空值通过', () => {
        expect(requireTemplateType('', false)).toBeNull();
        expect(requireTemplateType('')).not.toBeNull();
    });
    it('validateRequired 检出缺失字段', () => {
        expect(validateRequired({ a: 1 }, ['a'])).toBeNull();
        expect(validateRequired({ a: 1 }, ['a', 'b'])).not.toBeNull();
        expect(validateRequired({ a: null }, ['a'])).not.toBeNull();
    });
    it('validateRequired 拒绝非对象请求体', () => {
        expect(validateRequired(null as any, ['a'])).not.toBeNull();
    });
});
