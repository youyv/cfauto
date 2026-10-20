/** B4 strict primitives only. Existing credential reads/writes are NOT switched. */
import { canonical, identifier, revision, ReliabilityError } from './protocol';
export interface CredentialContext { accountId: string; field: 'globalKey' | 'apiToken'; revision: number }
export interface KeyRing { currentId: string; keys: Record<string, string>; legacySecret?: string }
export type StrictCredential = { status: 'empty' } | { status: 'decrypted' | 'legacy_plaintext'; plaintext: string } | { status: 'invalid' };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function contextData(context: CredentialContext, keyId: string): Uint8Array {
    identifier(context.accountId); revision(context.revision); identifier(keyId);
    if (!['globalKey', 'apiToken'].includes(context.field)) throw new ReliabilityError('INVALID', 400);
    return encoder.encode(canonical({ version: 2, keyId, ...context }));
}
function decode64(value: string): Uint8Array {
    if (!value || value.length > 32768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid envelope');
    const result = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    if (result.length < 29) throw new Error('Invalid envelope');
    return result;
}
async function v2Key(material: string, keyId: string): Promise<CryptoKey> {
    if (typeof material !== 'string' || encoder.encode(material).length < 32) throw new Error('Invalid key material');
    const base = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('cfauto:credential:v2'), info: encoder.encode('AES-GCM:' + keyId) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function legacyDecrypt(value: string, secret?: string): Promise<string> {
    if (!secret) throw new Error('Missing legacy key');
    const bytes = decode64(value);
    const material = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
    const key = await crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['decrypt']);
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
}
export async function encryptCredential(plaintext: string, context: CredentialContext, ring: KeyRing): Promise<string> {
    if (typeof plaintext !== 'string' || encoder.encode(plaintext).length > 8192) throw new ReliabilityError('INVALID', 400);
    if (!plaintext) return '';
    const keyId = ring.currentId;
    const aad = contextData(context, keyId);
    if (!Object.hasOwn(ring.keys, keyId)) throw new ReliabilityError('INVALID', 400);
    const key = await v2Key(ring.keys[keyId], keyId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(plaintext)));
    const all = new Uint8Array(12 + encrypted.length); all.set(iv); all.set(encrypted, 12);
    return 'v2:' + keyId + ':' + btoa(String.fromCharCode(...all));
}
/** Unprefixed data requires an explicit classification. A failed v1/v2 is never plaintext. */
export async function decryptCredential(value: string, context: CredentialContext, ring: KeyRing, unprefixed?: 'encrypted' | 'plaintext'): Promise<StrictCredential> {
    if (value === '') return { status: 'empty' };
    if (typeof value !== 'string' || value.length > 32768) return { status: 'invalid' };
    try {
        if (value.startsWith('v2:')) {
            const parts = value.split(':');
            if (parts.length !== 3 || !Object.hasOwn(ring.keys, parts[1])) return { status: 'invalid' };
            const aad = contextData(context, parts[1]);
            const key = await v2Key(ring.keys[parts[1]], parts[1]);
            const bytes = decode64(parts[2]);
            const plaintext = decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad }, key, bytes.slice(12)));
            return { status: 'decrypted', plaintext };
        }
        if (value.startsWith('v1:')) return { status: 'decrypted', plaintext: await legacyDecrypt(value.slice(3), ring.legacySecret) };
        if (/^v[0-9]+:/.test(value)) return { status: 'invalid' };
        if (unprefixed === 'encrypted') return { status: 'decrypted', plaintext: await legacyDecrypt(value, ring.legacySecret) };
        if (unprefixed === 'plaintext') return { status: 'legacy_plaintext', plaintext: value };
    } catch { /* Fail closed, without returning ciphertext as a supposed plaintext credential. */ }
    return { status: 'invalid' };
}
export interface CredentialEntry { context: CredentialContext; ciphertext: string; unprefixed?: 'encrypted' | 'plaintext' }
/** Pure preparation: verify ALL old entries before producing any replacement. No storage/network calls. */
export async function prepareCredentialGeneration(entries: CredentialEntry[], ring: KeyRing): Promise<CredentialEntry[]> {
    if (!Array.isArray(entries) || entries.length > 20000) throw new ReliabilityError('INVALID', 400);
    // Freeze caller-owned inputs before the first asynchronous cryptographic operation.
    entries = entries.map(entry => ({ context: { ...entry.context }, ciphertext: entry.ciphertext, unprefixed: entry.unprefixed }));
    ring = { ...ring, keys: { ...ring.keys } };
    const identities = new Set<string>();
    const decoded: StrictCredential[] = [];
    for (const entry of entries) {
        contextData(entry.context, ring.currentId);
        const identity = canonical({ accountId: entry.context.accountId, field: entry.context.field });
        if (identities.has(identity)) throw new ReliabilityError('INVALID', 400);
        identities.add(identity);
        const result = await decryptCredential(entry.ciphertext, entry.context, ring, entry.unprefixed);
        if (result.status === 'invalid') throw new ReliabilityError('INVALID', 400);
        decoded.push(result);
    }
    const prepared: CredentialEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
        const result = decoded[i];
        const plaintext = result.status === 'decrypted' || result.status === 'legacy_plaintext' ? result.plaintext : '';
        const ciphertext = await encryptCredential(plaintext, entries[i].context, ring);
        const verified = await decryptCredential(ciphertext, entries[i].context, ring);
        if (plaintext ? verified.status !== 'decrypted' || verified.plaintext !== plaintext : verified.status !== 'empty') throw new ReliabilityError('INVALID', 400);
        prepared.push({ context: { ...entries[i].context }, ciphertext });
    }
    return prepared;
}
