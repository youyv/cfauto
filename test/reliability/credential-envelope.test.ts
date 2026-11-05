import { describe, it, expect } from 'vitest';
import { encryptCredential, decryptCredential, prepareCredentialGeneration } from '../../src/reliability/credential-envelope';
import { encryptKey } from '../../src/lib/crypto-utils';
import { mockEnv, mockKV } from '../helpers';
const context = { accountId: 'account-one', field: 'apiToken' as const, revision: 1 };
const ring = { currentId: 'key-new', keys: { 'key-new': 'n'.repeat(64), 'key-old': 'o'.repeat(64) }, legacySecret: 'legacy-test-only' };
describe('strict B4 envelope primitives (not active migration)', () => {
    it('uses randomized IVs and authenticated context for v2', async () => {
        const first = await encryptCredential('test-token', context, ring);
        const second = await encryptCredential('test-token', context, ring);
        expect(first).not.toBe(second); expect(first).toMatch(/^v2:key-new:/);
        expect(await decryptCredential(first, context, ring)).toEqual({ status: 'decrypted', plaintext: 'test-token' });
        for (const altered of [{ ...context, accountId: 'other' }, { ...context, field: 'globalKey' as const }, { ...context, revision: 2 }]) {
            expect(await decryptCredential(first, altered, ring)).toEqual({ status: 'invalid' });
        }
    });
    it('does not downgrade corrupt/versioned values to plaintext', async () => {
        for (const value of ['v1:broken', 'v2:key-new:broken', 'v9:future', 'v2:unknown:AAAA']) {
            expect(await decryptCredential(value, context, ring, 'plaintext')).toEqual({ status: 'invalid' });
        }
        const encrypted = await encryptCredential('test-token', context, ring);
        const parts = encrypted.split(':'); const bytes = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0)); bytes[15] ^= 1;
        parts[2] = btoa(String.fromCharCode(...bytes));
        expect(await decryptCredential(parts.join(':'), context, ring)).toEqual({ status: 'invalid' });
    });
    it('requires explicit classification of unprefixed old data', async () => {
        expect(await decryptCredential('legacy-plain', context, ring)).toEqual({ status: 'invalid' });
        expect(await decryptCredential('legacy-plain', context, ring, 'encrypted')).toEqual({ status: 'invalid' });
        expect(await decryptCredential('legacy-plain', context, ring, 'plaintext')).toEqual({ status: 'legacy_plaintext', plaintext: 'legacy-plain' });
    });
    it('reads current v1 format strictly and rejects wrong legacy keys', async () => {
        const env = mockEnv(mockKV(), { ENCRYPTION_SECRET: ring.legacySecret });
        const old = await encryptKey(env, 'old-token');
        expect(await decryptCredential(old, context, ring)).toEqual({ status: 'decrypted', plaintext: 'old-token' });
        expect(await decryptCredential(old, context, { ...ring, legacySecret: 'wrong' }, 'plaintext')).toEqual({ status: 'invalid' });
        expect(await decryptCredential(old.slice(3), context, ring, 'encrypted')).toEqual({ status: 'decrypted', plaintext: 'old-token' });
    });
    it('prepares a verified nonactive generation without mutating its input', async () => {
        const old = await encryptCredential('token-A', context, { ...ring, currentId: 'key-old' });
        const entries = [{ context, ciphertext: old }, { context: { ...context, field: 'globalKey' as const }, ciphertext: '' }];
        const before = structuredClone(entries);
        const prepared = await prepareCredentialGeneration(entries, ring);
        expect(entries).toEqual(before);
        expect(prepared[0].ciphertext).toMatch(/^v2:key-new:/);
        expect(await decryptCredential(prepared[0].ciphertext, context, ring)).toEqual({ status: 'decrypted', plaintext: 'token-A' });
        expect(prepared[1].ciphertext).toBe('');
    });
    it('fails the entire preparation for invalid/duplicate entries without exposing secrets', async () => {
        const input = [{ context, ciphertext: 'secret-plain', unprefixed: 'plaintext' as const }, { context: { ...context, field: 'globalKey' as const }, ciphertext: 'v1:broken' }];
        await expect(prepareCredentialGeneration(input, ring)).rejects.toThrow(/^INVALID$/);
        await expect(prepareCredentialGeneration([input[0], input[0]], ring)).rejects.toThrow(/^INVALID$/);
        expect(input[0].ciphertext).toBe('secret-plain');
    });
    it('freezes migration context across async reads and preserves Unicode BOM', async () => {
        const mutable = [{ context: { ...context }, ciphertext: '\uFEFFtoken', unprefixed: 'plaintext' as const }];
        const pending = prepareCredentialGeneration(mutable, ring);
        mutable[0].context.accountId = 'changed';
        mutable[0].ciphertext = 'changed';
        const result = await pending;
        expect(result[0].context).toEqual(context);
        expect(await decryptCredential(result[0].ciphertext, context, ring)).toEqual({ status: 'decrypted', plaintext: '\uFEFFtoken' });
    });
    it('rejects missing/short new key material', async () => {
        await expect(encryptCredential('token', context, { currentId: 'missing', keys: {} })).rejects.toThrow();
        await expect(encryptCredential('token', context, { currentId: 'short', keys: { short: 'weak' } })).rejects.toThrow();
    });
});
