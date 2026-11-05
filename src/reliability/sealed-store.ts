import { encodeSealedPayload, decodeSealedPayload } from './sealed-payload';
import { MAX_SEALED_BYTES, MAX_SEALED_PLAINTEXT_BYTES } from './payload-limits';
export { MAX_SEALED_BYTES, MAX_SEALED_PLAINTEXT_BYTES } from './payload-limits';
import type { SqlDatabase } from './config-store';
import { canonical, identifier, revision, ReliabilityError, type Json } from './protocol';

export interface SealedKeyRing { currentId: string; keys: Record<string, string> }
export interface SealedContext { id: string; kind: 'task_snapshot' | 'artifact' | 'config_backup'; account: string; generation: string }
interface ObjectRow extends Record<string, unknown> { id: string; kind: string; account: string; generation: string; key_id: string; digest: string; bytes: number; chunks: number; created_at: number }
interface ChunkRow extends Record<string, unknown> { ordinal: number; ciphertext: string }
export interface SealedPacket { format: 'cfauto.sealed-object'; version: 1; object: ObjectRow; chunks: ChunkRow[]; proof: string }
const encoder = new TextEncoder();
const CHUNK_BYTES = 49152;

function fail(): never { throw new ReliabilityError('INVALID', 400); }
function conflict(): never { throw new ReliabilityError('CONFLICT', 409); }
function validateContext(context: SealedContext): void {
    identifier(context.id); identifier(context.account); identifier(context.generation);
    if (!['task_snapshot', 'artifact', 'config_backup'].includes(context.kind)) fail();
}
function base64(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i += 4096) result += String.fromCharCode(...bytes.subarray(i, i + 4096));
    return btoa(result);
}
function unbase64(value: string): Uint8Array {
    if (!value || value.length > 70000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    if (bytes.length < 28 || base64(bytes) !== value) fail();
    return bytes;
}
async function key(material: string, keyId: string, purpose: 'cipher' | 'digest'): Promise<CryptoKey> {
    identifier(keyId);
    if (typeof material !== 'string' || encoder.encode(material).length < 32) fail();
    const base = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveKey']);
    const params = { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('cfauto:sealed-store:v1'), info: encoder.encode(purpose + ':' + keyId) };
    return purpose === 'cipher'
        ? crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        : crypto.subtle.deriveKey(params, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
}
function aad(row: ObjectRow, ordinal: number): Uint8Array {
    return encoder.encode(canonical({ protocol: 1, id: row.id, kind: row.kind, account: row.account, generation: row.generation, keyId: row.key_id, digest: row.digest, bytes: row.bytes, chunks: row.chunks, ordinal }));
}
async function fingerprint(context: SealedContext, payload: string, material: string, keyId: string): Promise<string> {
    const signed = await crypto.subtle.sign('HMAC', await key(material, keyId, 'digest'), encoder.encode(canonical([context, payload])));
    return Array.from(new Uint8Array(signed), b => b.toString(16).padStart(2, '0')).join('');
}
/** Immutable encrypted objects. No automatic deletion: references/retention must be
 * coordinated before adding cleanup. All chunks and metadata commit in one transaction.
 * Plaintext and low-entropy payload hashes never enter the database or public metadata. */
export class SealedStore {
    private readonly ring: SealedKeyRing;
    constructor(private readonly db: SqlDatabase, ring: SealedKeyRing) {
        identifier(ring.currentId);
        if (!Object.hasOwn(ring.keys, ring.currentId)) fail();
        this.ring = { currentId: ring.currentId, keys: { ...ring.keys } };
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS sealed_objects (id TEXT PRIMARY KEY, kind TEXT NOT NULL, account TEXT NOT NULL, generation TEXT NOT NULL, key_id TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, chunks INTEGER NOT NULL, created_at INTEGER NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS sealed_chunks (id TEXT NOT NULL, ordinal INTEGER NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY(id,ordinal))');
        });
    }
    async put(context: SealedContext, value: Json, now = Date.now()): Promise<{ duplicate: boolean }> {
        context = { id: context.id, kind: context.kind, account: context.account, generation: context.generation };
        validateContext(context); revision(now);
        const payload = canonical(value); // Freeze before any await.
        const plaintext = encoder.encode(payload);
        if (plaintext.length > MAX_SEALED_PLAINTEXT_BYTES) fail();
        const bytes = await encodeSealedPayload(plaintext);
        const keyId = this.ring.currentId, material = this.ring.keys[keyId];
        const digest = await fingerprint(context, payload, material, keyId);
        const row: ObjectRow = { id: context.id, kind: context.kind, account: context.account, generation: context.generation, key_id: keyId, digest, bytes: bytes.length, chunks: Math.ceil(bytes.length / CHUNK_BYTES), created_at: now };
        const cipher = await key(material, keyId, 'cipher');
        const chunks: string[] = [];
        for (let ordinal = 0; ordinal < row.chunks; ordinal++) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(row, ordinal) }, cipher, bytes.slice(ordinal * CHUNK_BYTES, (ordinal + 1) * CHUNK_BYTES)));
            const all = new Uint8Array(12 + body.length); all.set(iv); all.set(body, 12); chunks.push(base64(all));
        }
        return this.db.transaction(() => {
            const existing = this.db.rows<ObjectRow>('SELECT * FROM sealed_objects WHERE id=?', context.id)[0];
            if (existing) {
                if (existing.digest !== digest || existing.key_id !== keyId || existing.kind !== context.kind || existing.account !== context.account || existing.generation !== context.generation) conflict();
                return { duplicate: true };
            }
            this.db.rows('INSERT INTO sealed_objects VALUES (?,?,?,?,?,?,?,?,?)', row.id, row.kind, row.account, row.generation, row.key_id, row.digest, row.bytes, row.chunks, row.created_at);
            chunks.forEach((chunk, ordinal) => this.db.rows('INSERT INTO sealed_chunks VALUES (?,?,?)', row.id, ordinal, chunk));
            return { duplicate: false };
        });
    }
    /** Safe metadata only. Internal callers still must authenticate account ownership. */
    info(context: SealedContext): { keyId: string; bytes: number; createdAt: number } {
        validateContext(context);
        const row = this.db.rows<ObjectRow>('SELECT * FROM sealed_objects WHERE id=?', context.id)[0];
        if (!row) throw new ReliabilityError('NOT_READY', 404);
        if (row.kind !== context.kind || row.account !== context.account || row.generation !== context.generation) conflict();
        return { keyId: row.key_id, bytes: row.bytes, createdAt: row.created_at };
    }
    async get(context: SealedContext): Promise<Json> {
        context = { id: context.id, kind: context.kind, account: context.account, generation: context.generation };
        validateContext(context);
        const stored = this.db.transaction(() => {
            this.info(context);
            return { row: this.db.rows<ObjectRow>('SELECT * FROM sealed_objects WHERE id=?', context.id)[0], chunks: this.db.rows<ChunkRow>('SELECT ordinal,ciphertext FROM sealed_chunks WHERE id=? ORDER BY ordinal', context.id) };
        });
        return this.decodeStored(context, stored);
    }
    private async decodeStored(context: SealedContext, stored: { row: ObjectRow; chunks: ChunkRow[] }): Promise<Json> {
        try {
            const { row, chunks } = stored;
            if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_SEALED_BYTES || row.chunks !== Math.ceil(row.bytes / CHUNK_BYTES) || chunks.length !== row.chunks || !Object.hasOwn(this.ring.keys, row.key_id)) fail();
            const material = this.ring.keys[row.key_id];
            const cipher = await key(material, row.key_id, 'cipher');
            const bytes = new Uint8Array(row.bytes);
            for (let ordinal = 0; ordinal < row.chunks; ordinal++) {
                if (chunks[ordinal].ordinal !== ordinal) fail();
                const encrypted = unbase64(chunks[ordinal].ciphertext);
                const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.slice(0, 12), additionalData: aad(row, ordinal) }, cipher, encrypted.slice(12)));
                if (plaintext.length !== Math.min(CHUNK_BYTES, row.bytes - ordinal * CHUNK_BYTES)) fail();
                bytes.set(plaintext, ordinal * CHUNK_BYTES);
            }
            const payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await decodeSealedPayload(bytes));
            if (await fingerprint(context, payload, material, row.key_id) !== row.digest) fail();
            return JSON.parse(payload) as Json;
        } catch { fail(); } // Never include payload, ciphertext or crypto error text.
    }
    private packetInput(context: SealedContext, raw: unknown): SealedPacket {
        validateContext(context);
        function exact(value: unknown, fields: string[]): asserts value is Record<string, any> {
            if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail();
        }
        try {
            exact(raw, ['format', 'version', 'object', 'chunks', 'proof']);
            const input = raw as SealedPacket;
            if (input.format !== 'cfauto.sealed-object' || input.version !== 1 || !/^[a-f0-9]{64}$/.test(input.proof) || !Array.isArray(input.chunks) || input.chunks.length < 1 || input.chunks.length > Math.ceil(MAX_SEALED_BYTES / CHUNK_BYTES)) fail();
            exact(input.object, ['id', 'kind', 'account', 'generation', 'key_id', 'digest', 'bytes', 'chunks', 'created_at']);
            const row = input.object;
            if (row.id !== context.id || row.kind !== context.kind || row.account !== context.account || row.generation !== context.generation) conflict();
            identifier(row.key_id); revision(row.created_at);
            if (!/^[a-f0-9]{64}$/.test(row.digest) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_SEALED_BYTES || row.chunks !== Math.ceil(row.bytes / CHUNK_BYTES) || input.chunks.length !== row.chunks) fail();
            input.chunks.forEach((chunk, ordinal) => { exact(chunk, ['ordinal', 'ciphertext']); if (chunk.ordinal !== ordinal || typeof chunk.ciphertext !== 'string' || chunk.ciphertext.length > 70000) fail(); });
            return JSON.parse(canonical(input)) as SealedPacket; // Freeze before crypto awaits.
        } catch (error) { if (error instanceof ReliabilityError) throw error; fail(); }
    }
    /** Internal archive reader only. The enclosing AuthorityArchive authenticates
     * metadata/chunks (including created_at); this authenticates the original AAD
     * and plaintext without importing/restoring any archived SQL or task state.
     * Not a replacement for openPacket at a transport/RPC boundary. */
    async openArchiveObject(context: SealedContext, object: unknown, chunks: unknown): Promise<Json> {
        context = { id: context.id, kind: context.kind, account: context.account, generation: context.generation };
        const packet = this.packetInput(context, { format: 'cfauto.sealed-object', version: 1, object, chunks, proof: '0'.repeat(64) });
        return this.decodeStored(context, { row: packet.object, chunks: packet.chunks });
    }
    private packetProof(context: SealedContext, packet: Omit<SealedPacket, 'proof'>): Promise<string> {
        const material = this.ring.keys[packet.object.key_id];
        // Transfer proof authenticates ALL metadata (including legacy created_at)
        // without changing the established ciphertext/AAD format.
        return fingerprint(context, canonical(['cfauto:sealed-packet:v1', packet]), material, packet.object.key_id);
    }
    async exportPacket(context: SealedContext): Promise<SealedPacket> {
        context = { id: context.id, kind: context.kind, account: context.account, generation: context.generation };
        validateContext(context);
        const packet = this.db.transaction(() => {
            this.info(context);
            return { format: 'cfauto.sealed-object' as const, version: 1 as const,
                object: { ...this.db.rows<ObjectRow>('SELECT * FROM sealed_objects WHERE id=?', context.id)[0] },
                chunks: this.db.rows<ChunkRow>('SELECT ordinal,ciphertext FROM sealed_chunks WHERE id=? ORDER BY ordinal', context.id).map(row => ({ ...row })) };
        });
        this.packetInput(context, { ...packet, proof: '0'.repeat(64) });
        await this.decodeStored(context, { row: packet.object, chunks: packet.chunks });
        return { ...packet, proof: await this.packetProof(context, packet) };
    }
    /** Decrypt and authenticate a portable packet without writing or activating it. */
    async openPacket(context: SealedContext, raw: unknown): Promise<Json> {
        context = { id: context.id, kind: context.kind, account: context.account, generation: context.generation };
        const packet = this.packetInput(context, raw);
        try {
            const { proof, ...unsigned } = packet;
            if (!Object.hasOwn(this.ring.keys, packet.object.key_id) || await this.packetProof(context, unsigned) !== proof) fail();
            return await this.decodeStored(context, { row: packet.object, chunks: packet.chunks });
        } catch { fail(); }
    }
    /** Restore immutable evidence only. Never enables a job, switches generation,
     * rewrites a credential or repeats an archived HTTP call. No overwrite/cleanup. */
    async importPacket(context: SealedContext, raw: unknown): Promise<{ duplicate: boolean }> {
        context = { id: context.id, kind: context.kind, account: context.account, generation: context.generation };
        const packet = this.packetInput(context, raw);
        await this.openPacket(context, packet);
        return this.db.transaction(() => {
            const row = packet.object;
            const existing = this.db.rows<ObjectRow>('SELECT * FROM sealed_objects WHERE id=?', row.id)[0];
            if (existing) {
                const chunks = this.db.rows<ChunkRow>('SELECT ordinal,ciphertext FROM sealed_chunks WHERE id=? ORDER BY ordinal', row.id).map(r => ({ ...r }));
                if (canonical({ ...existing }) !== canonical(row) || canonical(chunks) !== canonical(packet.chunks)) conflict();
                return { duplicate: true };
            }
            // Orphan chunks are evidence, not something to silently replace.
            if (this.db.rows('SELECT ordinal FROM sealed_chunks WHERE id=? LIMIT 1', row.id).length) conflict();
            this.db.rows('INSERT INTO sealed_objects VALUES (?,?,?,?,?,?,?,?,?)', row.id, row.kind, row.account, row.generation, row.key_id, row.digest, row.bytes, row.chunks, row.created_at);
            for (const chunk of packet.chunks) this.db.rows('INSERT INTO sealed_chunks VALUES (?,?,?)', row.id, chunk.ordinal, chunk.ciphertext);
            return { duplicate: false };
        });
    }

}
