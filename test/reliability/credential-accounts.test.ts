import { describe, it, expect } from 'vitest';
import { readCredentialAccounts, migrateCredentialAccounts, writeCredentialAccounts } from '../../src/reliability/credential-accounts';
import { decryptCredential, encryptCredential } from '../../src/reliability/credential-envelope';
import { readAccounts, readAccountsMasked, writeAccounts } from '../../src/lib/account-store';
import { encryptKey } from '../../src/lib/crypto-utils';
import { mockEnv, mockKV } from '../helpers';
import { KV_KEYS } from '../../src/config/templates';
import type { AccountEntry } from '../../src/lib/types';
const ring = { currentId: 'new', keys: { new: 'n'.repeat(64), old: 'o'.repeat(64) }, legacySecret: 'legacy-test-only' };
const base = (): AccountEntry => ({ accountId: 'a'.repeat(32), alias: 'first', email: 'test@example.invalid', globalKey: '', apiToken: 'test-token-1234567890', authMode: 'token', workers_cmliu: ['worker-one'], stats: { total: 1, max: 100000 } });
const policy = (now = 100, observationUntil = 0) => ({ ring, now, observationUntil });
const migrated = () => migrateCredentialAccounts([base()], ring, 'plaintext');
const edit = (patch: Partial<AccountEntry> = {}) => ({ ...base(), apiToken: '***', ...patch });

describe('credential account validation and explicit migration', () => {
    it('migrates mixed plaintext/v1/v2 with explicit classification and keeps the original generation untouched', async () => {
        const env = mockEnv(mockKV(), { ENCRYPTION_SECRET: ring.legacySecret });
        const accounts = [base(), { ...base(), alias: 'second', accountId: 'b'.repeat(32), apiToken: await encryptKey(env, 'old-token') }, { ...base(), alias: 'third', accountId: 'c'.repeat(32), credentialRevision: 4, apiToken: await encryptCredential('v2-token', { accountId: 'c'.repeat(32), field: 'apiToken', revision: 4 }, { ...ring, currentId: 'old' }) }];
        const before = structuredClone(accounts);
        const result = await migrateCredentialAccounts(accounts, ring, 'plaintext');
        expect(accounts).toEqual(before);
        expect(result.map(a => a.credentialRevision)).toEqual([1, 1, 4]);
        expect(result.every(a => a.apiToken?.startsWith('v2:new:'))).toBe(true);
        expect((await readCredentialAccounts(result, ring)).map(a => a.apiToken)).toEqual([base().apiToken, 'old-token', 'v2-token']);
    });
    it('does not guess unprefixed ciphertext/plaintext and supports explicitly classified legacy ciphertext', async () => {
        await expect(migrateCredentialAccounts([base()], ring)).rejects.toThrow(/^INVALID$/);
        const cipher = await encryptKey(mockEnv(mockKV(), { ENCRYPTION_SECRET: ring.legacySecret }), 'legacy-token');
        const result = await migrateCredentialAccounts([{ ...base(), apiToken: cipher.slice(3) }], ring, 'encrypted');
        expect((await readCredentialAccounts(result, ring))[0].apiToken).toBe('legacy-token');
        await expect(migrateCredentialAccounts([base()], ring, 'encrypted')).rejects.toThrow(/^INVALID$/);
    });
    it.each(['***', '123456...7890', 'malformed...mask', 'v1:broken', 'v2:new:broken', 'v9:future', 'V2:future'])('never migrates masks or damaged/versioned credentials: %s', async apiToken => {
        await expect(migrateCredentialAccounts([{ ...base(), apiToken }], ring, 'plaintext')).rejects.toThrow(/^INVALID$/);
    });
    it('fails all entries on a wrong legacy key, without returning partial data', async () => {
        const cipher = await encryptKey(mockEnv(mockKV(), { ENCRYPTION_SECRET: ring.legacySecret }), 'private-token');
        const accounts = [base(), { ...base(), alias: 'second', accountId: 'b'.repeat(32), apiToken: cipher }];
        const before = structuredClone(accounts);
        await expect(migrateCredentialAccounts(accounts, { ...ring, legacySecret: 'wrong' }, 'plaintext')).rejects.toThrow(/^INVALID$/);
        expect(accounts).toEqual(before);
    });
    it.each([null, false, 0, {}, []].map(value => [value]))('rejects non-string secret values rather than coercing them: %s', async value => {
        await expect(migrateCredentialAccounts([{ ...base(), globalKey: value } as any], ring, 'plaintext')).rejects.toThrow(/^INVALID$/);
        await expect(writeCredentialAccounts([{ ...base(), apiToken: value } as any], [], policy())).rejects.toThrow(/^INVALID$/);
    });
    it.each([
        { alias: '' }, { alias: 7 }, { email: null }, { authMode: 'wrong' }, { authMode: null },
        { dailyLimit: -1 }, { dailyLimit: NaN }, { defaultZoneName: {} }, { defaultZoneId: false },
        { workers_cmliu: 'worker' }, { workers_future: [null] }, { workers_cmliu: new Array(1) },
        { stats: { total: -1, max: 1 } }, { stats: { total: 1, max: Infinity } }, { stats: { total: 0, max: 1, secret: 'no' } },
        { credentialRevision: 0 }, { credentialRevision: 1.5 }, { credentialRevision: null }, { hiddenSecret: 'not-allowed' }
    ])('validates every account field: %j', async patch => {
        await expect(migrateCredentialAccounts([{ ...base(), ...patch } as any], ring, 'plaintext')).rejects.toThrow(/^INVALID$/);
    });
    it('rejects malformed arrays, duplicate identities/aliases and accessor properties', async () => {
        for (const values of [null, {}, [null], new Array(1), [base(), base()], [base(), { ...base(), accountId: 'b'.repeat(32) }]]) {
            await expect(migrateCredentialAccounts(values as any, ring, 'plaintext')).rejects.toThrow(/^INVALID$/);
        }
        const account = base(); Object.defineProperty(account, 'apiToken', { get() { throw new Error('getter ran'); }, enumerable: true });
        await expect(migrateCredentialAccounts([account], ring, 'plaintext')).rejects.toThrow(/^INVALID$/);
    });
    it('rejects array accessors and non-JSON properties without executing them', async () => {
        const accounts = [base()]; Object.defineProperty(accounts, '0', { get() { throw new Error('getter ran'); }, enumerable: true });
        await expect(migrateCredentialAccounts(accounts, ring, 'plaintext')).rejects.toThrow(/^INVALID$/);
        const workers = ['safe']; Object.defineProperty(workers, '0', { get() { throw new Error('getter ran'); }, enumerable: true });
        await expect(migrateCredentialAccounts([{ ...base(), workers_cmliu: workers }], ring, 'plaintext')).rejects.toThrow(/^INVALID$/);
    });
    it('validates key slots even for an empty account list', async () => {
        for (const bad of [{ currentId: 'missing', keys: {} }, { currentId: 'new', keys: { new: 'weak' } }, null]) {
            await expect(readCredentialAccounts([], bad as any)).rejects.toThrow(/^INVALID$/);
        }
    });
    it('accepts read-model statistics metadata without making it account authority', async () => {
        const stored = await migrated();
        // /api/stats returns accountId/alias display metadata; a page echoing the read
        // model back must not fail an otherwise valid worker-list edit.
        const stats = { total: 7, max: 100000, alias: 'legacy display', accountId: base().accountId };
        const result = await writeCredentialAccounts([{ ...base(), stats, workers_cmliu: ['worker-two'] }], stored, policy());
        expect(result[0].stats).toEqual(stats);
        expect(result[0].workers_cmliu).toEqual(['worker-two']);
        expect(result[0].credentialRevision).toBe(1);
        // Unknown statistics fields are still rejected, never silently dropped.
        await expect(writeCredentialAccounts([{ ...base(), stats: { total: 1, max: 1, unreviewed: true } } as any], stored, policy())).rejects.toThrow(/^INVALID$/);
    });
    it('freezes nested input and key material before asynchronous work', async () => {
        const accounts = [base()], mutableRing = structuredClone(ring), before = structuredClone(accounts);
        const pending = migrateCredentialAccounts(accounts, mutableRing, 'plaintext');
        accounts[0].workers_cmliu!.push('changed'); accounts[0].stats!.total = 99; accounts[0].apiToken = 'changed'; mutableRing.keys.new = 'changed';
        const decoded = await readCredentialAccounts(await pending, ring);
        expect(decoded[0]).toEqual({ ...before[0], credentialRevision: 1 });
    });
    it('requires positive stored revisions and v2-only online data', async () => {
        await expect(readCredentialAccounts([{ ...base(), credentialRevision: 1 }], ring)).rejects.toThrow(/^INVALID$/);
        const stored = await migrated(); delete stored[0].credentialRevision;
        await expect(readCredentialAccounts(stored, ring)).rejects.toThrow(/^INVALID$/);
    });
    it('detects account, field, revision and ciphertext tampering through AAD', async () => {
        const [stored] = await migrated();
        for (const patch of [{ accountId: 'b'.repeat(32) }, { credentialRevision: 2 }, { apiToken: '', globalKey: stored.apiToken }, { apiToken: stored.apiToken!.slice(0, -4) + 'AAAA' }]) {
            await expect(readCredentialAccounts([{ ...stored, ...patch }], ring)).rejects.toThrow(/^INVALID$/);
        }
    });
});

describe('online credential edits and observation window', () => {
    it.each(['', undefined, '***', 'test-t...7890'])('retains existing ciphertext/revision for an empty or masked edit: %s', async apiToken => {
        const stored = await migrated(); const result = await writeCredentialAccounts([edit({ apiToken, alias: 'renamed', workers_cmliu: ['new-worker'], credentialRevision: 999 })], stored, policy(1, 100));
        expect(result[0].apiToken).toBe(stored[0].apiToken); expect(result[0].credentialRevision).toBe(1);
        expect(result[0].workers_cmliu).toEqual(['new-worker']); expect(result[0].alias).toBe('renamed');
    });
    it('keeps identical plaintext unchanged for internal worker-list updates', async () => {
        const stored = await migrated(); const plain = await readCredentialAccounts(stored, ring); plain[0].workers_cmliu!.push('new-worker');
        const updated = await writeCredentialAccounts(plain, stored, policy(1, 100));
        expect(updated[0].apiToken).toBe(stored[0].apiToken);
    });
    it('increments the revision and rewraps both fields on either credential or email change', async () => {
        const stored = await migrateCredentialAccounts([{ ...base(), authMode: undefined, globalKey: 'global-key' }], ring, 'plaintext');
        const updated = await writeCredentialAccounts([{ ...base(), authMode: undefined, globalKey: '***', apiToken: 'replacement-token' }], stored, policy());
        expect(updated[0].credentialRevision).toBe(2); expect(updated[0].globalKey).not.toBe(stored[0].globalKey);
        expect((await readCredentialAccounts(updated, ring))[0]).toMatchObject({ globalKey: 'global-key', apiToken: 'replacement-token' });
        const email = await writeCredentialAccounts([{ ...base(), authMode: undefined, globalKey: '***', apiToken: '***', email: 'new@example.invalid' }], stored, policy());
        expect(email[0].credentialRevision).toBe(2);
    });
    it('explicit auth-mode switch clears only the other side and needs usable selected credentials', async () => {
        const stored = await migrated();
        await expect(writeCredentialAccounts([edit({ authMode: 'key', globalKey: '' })], stored, policy())).rejects.toThrow(/^INVALID$/);
        const result = await writeCredentialAccounts([edit({ authMode: 'key', globalKey: 'new-global-key' })], stored, policy());
        expect(result[0].apiToken).toBe(''); expect(result[0].credentialRevision).toBe(2);
        expect((await readCredentialAccounts(result, ring))[0].globalKey).toBe('new-global-key');
    });
    it('never borrows secrets by alias/email when accountId changes', async () => {
        const stored = await migrated();
        for (const apiToken of ['', '***', 'test-t...7890']) await expect(writeCredentialAccounts([edit({ accountId: 'b'.repeat(32), apiToken })], stored, policy())).rejects.toThrow(/^INVALID$/);
        const updated = await writeCredentialAccounts([{ ...base(), accountId: 'b'.repeat(32) }], stored, policy());
        expect(updated[0].credentialRevision).toBe(1);
        expect(await decryptCredential(updated[0].apiToken!, { accountId: base().accountId, field: 'apiToken', revision: 1 }, ring)).toEqual({ status: 'invalid' });
    });
    it('freezes credential edits, account removal/addition and identity changes for seven-day observation', async () => {
        const stored = await migrated();
        for (const incoming of [[], [edit({ apiToken: 'new-token' })], [edit({ email: 'new@example.invalid' })], [{ ...base(), accountId: 'b'.repeat(32) }], [edit(), { ...base(), alias: 'second', accountId: 'b'.repeat(32) }]]) {
            await expect(writeCredentialAccounts(incoming, stored, policy(1, 100))).rejects.toThrow(/^MAINTENANCE$/);
        }
        expect(await writeCredentialAccounts([], stored, policy(100, 100))).toEqual([]);
    });
    it.each(['v1:old', 'v2:new:fake', 'v9:future', 'v2:abc...7890', 'malformed...mask'])('rejects ciphertext and ambiguous masks from browsers: %s', async apiToken => {
        await expect(writeCredentialAccounts([edit({ apiToken })], await migrated(), policy())).rejects.toThrow(/^INVALID$/);
    });
    it('checks inactive fields too, and refuses revision overflow', async () => {
        await expect(writeCredentialAccounts([edit({ globalKey: 'v2:new:fake' })], await migrated(), policy())).rejects.toThrow(/^INVALID$/);
        const stored = await migrateCredentialAccounts([{ ...base(), credentialRevision: Number.MAX_SAFE_INTEGER }], ring, 'plaintext');
        await expect(writeCredentialAccounts([edit({ apiToken: 'replacement' })], stored, policy())).rejects.toThrow(/^INVALID$/);
    });
    it('freezes policy and nested incoming/existing values across await', async () => {
        const stored = await migrated(), incoming = [edit()], p = structuredClone(policy(1, 100));
        const pending = writeCredentialAccounts(incoming, stored, p);
        incoming[0].apiToken = 'changed'; incoming[0].workers_cmliu!.push('changed'); stored[0].stats!.total = 999; p.now = 999; p.ring.keys.new = 'wrong';
        const result = await pending;
        expect((await readCredentialAccounts(result, ring))[0].apiToken).toBe(base().apiToken); expect(result[0].workers_cmliu).toEqual(['worker-one']);
    });
    it.each([-1, NaN, Infinity, 0.5])('rejects untrusted observation clocks: %s', async now => {
        await expect(writeCredentialAccounts([], [], policy(now))).rejects.toThrow(/^INVALID$/);
    });
});

describe('account-store opt-in integration (no production activation)', () => {
    it('reads masked v2 and writes only encrypted values when trusted policy is injected', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: await migrated() }); const env = mockEnv(kv, { reliabilityCredentials: policy() });
        expect((await readAccounts(env))[0].apiToken).toBe(base().apiToken);
        const masked = await readAccountsMasked(env); expect(masked[0].apiToken).toBe('test-t...7890');
        masked[0].workers_cmliu!.push('worker-two'); await writeAccounts(env, masked);
        const stored = JSON.parse((await kv.get(KV_KEYS.ACCOUNTS))!); expect(stored[0].apiToken).toMatch(/^v2:new:/); expect(stored[0].credentialRevision).toBe(1);
        expect(stored[0].workers_cmliu).toEqual(['worker-one', 'worker-two']);
    });
    it('leaves storage untouched on validation/observation failure and fails closed without v2 policy', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: await migrated() }); const before = await kv.get(KV_KEYS.ACCOUNTS);
        await expect(writeAccounts(mockEnv(kv, { reliabilityCredentials: policy(1, 100) }), [edit({ apiToken: 'replacement' })])).rejects.toThrow(/^MAINTENANCE$/);
        expect(await kv.get(KV_KEYS.ACCOUNTS)).toBe(before);
        await expect(readAccounts(mockEnv(kv))).rejects.toThrow(/^INVALID$/);
    });
});


describe('legacy statistics alias is retained metadata, not a credential identity', () => {
    it('migrates v1 credentials and preserves the complete legacy statistics object through v2 reads', async () => {
        const env = mockEnv(mockKV(), { ENCRYPTION_SECRET: ring.legacySecret });
        const old = { ...base(), apiToken: await encryptKey(env, 'old-statistics-token'), stats: { alias: 'old display name', total: 7, max: 100000 } };
        const before = JSON.stringify(old);
        const result = await migrateCredentialAccounts([old], ring, 'encrypted');
        expect(result[0].stats).toEqual(old.stats);
        expect((await readCredentialAccounts(result, ring))[0]).toMatchObject({ accountId: old.accountId, alias: old.alias, apiToken: 'old-statistics-token', stats: old.stats });
        expect(JSON.stringify(old)).toBe(before);
    });
    it.each([null, 1, false, {}, 'x'.repeat(1025)])('rejects malformed or unbounded legacy stats aliases (%s)', async value => {
        const account = base(); account.stats = { ...account.stats!, alias: value as any };
        await expect(migrateCredentialAccounts([account], ring, 'plaintext')).rejects.toThrow();
    });
    it('continues rejecting unknown statistics fields instead of accepting arbitrary legacy objects', async () => {
        const account = base(); (account.stats as any).unreviewed = 'discarding this would lose data';
        await expect(migrateCredentialAccounts([account], ring, 'plaintext')).rejects.toThrow();
    });
});
