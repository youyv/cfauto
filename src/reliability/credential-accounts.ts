import type { AccountEntry } from '../lib/types';
import { decryptCredential, encryptCredential, type KeyRing } from './credential-envelope';
import { canonical, identifier, revision, ReliabilityError } from './protocol';
export interface CredentialPolicy { ring: KeyRing; observationUntil: number; now: number }
const fields = ['globalKey', 'apiToken'] as const;
const encoder = new TextEncoder();
function invalid(): never { throw new ReliabilityError('INVALID', 400); }
function accountRevision(account: AccountEntry): number {
    const value = account.credentialRevision;
    if (!Number.isSafeInteger(value) || value! < 1) invalid();
    return value!;
}
function text(value: unknown, max: number): asserts value is string {
    if (typeof value !== 'string' || encoder.encode(value).length > max) invalid();
}
function object(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid();
    // Do not execute accessors, retain hidden data, or accept non-JSON properties.
    for (const key of Reflect.ownKeys(value)) {
        const desc = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== 'string' || !desc.enumerable || !('value' in desc)) invalid();
    }
}
function array(value: unknown, max: number): asserts value is unknown[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalid();
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) invalid();
    }
    for (let i = 0; i < value.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, String(i));
        if (!desc || !desc.enumerable || !('value' in desc)) invalid();
    }
}
function mask(value: string): boolean { return value === '***' || /^.{6}\.\.\..{4}$/u.test(value); }
function plaintext(value: string): void {
    text(value, 8192);
    if (/^v[0-9]+:/i.test(value) || value === '***' || value.includes('...')) invalid();
}
/** Freeze and validate EVERY field before the first await, including nested worker
 * lists/stats. Unknown data is rejected, never silently dropped during migration. */
function copy(accounts: AccountEntry[]): AccountEntry[] {
    array(accounts, 1000);
    const ids = new Set<string>(), aliases = new Set<string>();
    return Array.from(accounts, account => {
        object(account); identifier(account.accountId);
        text(account.alias, 1024); text(account.email, 1024);
        if (!account.alias.trim() || ids.has(account.accountId) || aliases.has(account.alias.trim())) invalid();
        ids.add(account.accountId); aliases.add(account.alias.trim());
        for (const [key, value] of Object.entries(account)) {
            if (['alias', 'email', 'accountId'].includes(key)) continue;
            // Only omitted/undefined optional fields mean absent, not null/false/0.
            if (fields.includes(key as typeof fields[number])) { if (value !== undefined) text(value, 32768); }
            else if (key === 'authMode') { if (value !== undefined && value !== 'token' && value !== 'key') invalid(); }
            else if (key === 'credentialRevision') { if (value !== undefined) accountRevision(account); }
            else if (key === 'dailyLimit') { if (value !== undefined) revision(value as number); }
            else if (key === 'defaultZoneName' || key === 'defaultZoneId') { if (value !== undefined) text(value, 1024); }
            else if (/^workers_[a-z_]+$/.test(key)) {
                if (value !== undefined) {
                    array(value, 10000);
                    for (const worker of value) { text(worker, 1024); if (!worker.trim()) invalid(); }
                }
            } else if (key === 'stats') {
                if (value !== undefined) {
                    object(value);
                    for (const stat of Object.keys(value)) if (!['total', 'max', 'error', 'alias', 'accountId'].includes(stat)) invalid();
                    for (const stat of ['total', 'max']) if (typeof value[stat] !== 'number' || !Number.isFinite(value[stat]) || (value[stat] as number) < 0) invalid();
                    if (value.error !== undefined) text(value.error, 8192);
                    // Legacy statistics carried a display alias. Retain it exactly;
                    // it is descriptive metadata, never an account identity key.
                    if (value.alias !== undefined) text(value.alias, 1024);
                    // /api/stats also returns the account id as display metadata. Accept
                    // it as descriptive data so a page that echoes the read model back
                    // does not fail a config edit; never use it as an identity key.
                    if (value.accountId !== undefined) text(value.accountId, 1024);
                }
            } else invalid();
        }
        // Optional undefined fields are omitted by JSON as they are by KV storage.
        return JSON.parse(JSON.stringify(account)) as AccountEntry;
    });
}
function keyRing(ring: KeyRing): KeyRing {
    object(ring); identifier(ring.currentId); object(ring.keys);
    const keys: Record<string, string> = {};
    for (const [id, material] of Object.entries(ring.keys)) {
        identifier(id); text(material, 8192);
        if (encoder.encode(material).length < 32) invalid();
        Object.defineProperty(keys, id, { value: material, enumerable: true });
    }
    if (!Object.hasOwn(keys, ring.currentId)) invalid();
    if (ring.legacySecret !== undefined) { text(ring.legacySecret, 8192); if (!ring.legacySecret) invalid(); }
    return { currentId: ring.currentId, keys, legacySecret: ring.legacySecret };
}
async function decode(account: AccountEntry, ring: KeyRing, legacy = false, unprefixed?: 'plaintext' | 'encrypted'): Promise<AccountEntry> {
    const rev = legacy && account.credentialRevision === undefined ? 1 : accountRevision(account);
    const result = { ...account, credentialRevision: rev };
    for (const field of fields) {
        const value = account[field] ?? '';
        // Live storage never downgrades to v1/plaintext, even with a legacy key present.
        if (!legacy && value && !value.startsWith('v2:')) invalid();
        const decoded = await decryptCredential(value, { accountId: account.accountId, field, revision: rev }, ring, legacy ? unprefixed : undefined);
        if (decoded.status === 'invalid') invalid();
        result[field] = decoded.status === 'empty' ? '' : decoded.plaintext;
        plaintext(result[field]!); // Never turn an exported mask into a live secret.
    }
    return result;
}
export async function readCredentialAccounts(accounts: AccountEntry[], ring: KeyRing): Promise<AccountEntry[]> {
    accounts = copy(accounts); ring = keyRing(ring);
    const result: AccountEntry[] = [];
    for (const account of accounts) result.push(await decode(account, ring));
    return result;
}
/** Pure preparation; unprefixed old values require an explicit classification.
 * Verify every old entry before encrypting replacements. No persistence/activation. */
export async function migrateCredentialAccounts(accounts: AccountEntry[], ring: KeyRing, unprefixed?: 'plaintext' | 'encrypted'): Promise<AccountEntry[]> {
    accounts = copy(accounts); ring = keyRing(ring);
    if (unprefixed !== undefined && unprefixed !== 'plaintext' && unprefixed !== 'encrypted') invalid();
    const decoded: AccountEntry[] = [];
    for (const account of accounts) decoded.push(await decode(account, ring, true, unprefixed));
    const result: AccountEntry[] = [];
    for (const account of decoded) {
        const next = { ...account };
        for (const field of fields) next[field] = await encryptCredential(account[field] ?? '', { accountId: account.accountId, field, revision: accountRevision(account) }, ring);
        if (canonical(await decode(next, ring)) !== canonical(account)) invalid();
        result.push(next);
    }
    return result;
}
/** Online edits preserve unchanged ciphertext/revision. Identity never falls back
 * to alias/email; changing accountId needs explicit credentials and fresh AAD.
 * The coordinator MUST recheck active permits/revocation in the commit transaction. */
export async function writeCredentialAccounts(incoming: AccountEntry[], existing: AccountEntry[], policy: CredentialPolicy): Promise<AccountEntry[]> {
    incoming = copy(incoming); existing = copy(existing);
    object(policy);
    policy = { ring: keyRing(policy.ring), now: policy.now, observationUntil: policy.observationUntil };
    revision(policy.now); revision(policy.observationUntil);
    const decoded = await readCredentialAccounts(existing, policy.ring);
    const result: AccountEntry[] = [];
    if (policy.now < policy.observationUntil && existing.some(a => !incoming.some(n => n.accountId === a.accountId))) throw new ReliabilityError('MAINTENANCE', 409);
    for (const account of incoming) {
        const old = existing.find(a => a.accountId === account.accountId), plain = decoded.find(a => a.accountId === account.accountId);
        const values = { globalKey: '', apiToken: '' };
        for (const field of fields) {
            const value = account[field] ?? '';
            if (/^v[0-9]+:/i.test(value)) invalid();
            const preserve = value === '' || mask(value);
            if (!preserve) plaintext(value); // Also validate the inactive auth field.
            const inactive = (account.authMode === 'token' && field === 'globalKey') || (account.authMode === 'key' && field === 'apiToken');
            if (!inactive && mask(value) && !plain?.[field]) invalid();
            values[field] = inactive ? '' : preserve ? plain?.[field] ?? '' : value;
        }
        // A new identity or auth-mode switch must not silently save a credentialless account.
        if (account.authMode === 'token' ? !values.apiToken : account.authMode === 'key' ? !values.globalKey || !account.email.trim() : !values.apiToken && (!values.globalKey || !account.email.trim())) invalid();
        const changed = !old || account.email !== old.email || account.authMode !== old.authMode || fields.some(f => values[f] !== (plain?.[f] ?? ''));
        if (changed && policy.now < policy.observationUntil) throw new ReliabilityError('MAINTENANCE', 409);
        const nextRevision = old ? accountRevision(old) + (changed ? 1 : 0) : 1;
        revision(nextRevision);
        const next = { ...account, credentialRevision: nextRevision };
        for (const field of fields) next[field] = !changed ? old![field] ?? '' : await encryptCredential(values[field], { accountId: account.accountId, field, revision: nextRevision }, policy.ring);
        result.push(next);
    }
    return result;
}
