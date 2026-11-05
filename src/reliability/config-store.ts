import { ReliabilityError, canonical, encoded, domainName, revision, identifier, manifestDigest } from './protocol';
import type { Json, ConfigChange, ConfigRecord } from './protocol';

/** Small synchronous boundary shared by DO SQLite and real SQLite unit tests. */
export interface SqlDatabase {
    rows<T extends Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
    transaction<T>(callback: () => T): T;
}
interface Meta extends Record<string, unknown> { generation: string | null; maintenance: number; epoch: number }
interface Row extends Record<string, unknown> { domain: string; revision: number; payload: string }
interface Generation extends Record<string, unknown> { id: string; digest: string; count: number; state: string }

/** P1 kernel; callers must supply normalized business values and encrypted credentials.
 * Not a public API, not connected to the existing KV configuration adapter yet. */
export class ConfigStore {
    constructor(private readonly db: SqlDatabase) {
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS config_meta (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT, maintenance INTEGER NOT NULL, epoch INTEGER NOT NULL)');
            db.rows('INSERT OR IGNORE INTO config_meta VALUES (1, NULL, 1, 0)');
            db.rows('CREATE TABLE IF NOT EXISTS config_generations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, count INTEGER NOT NULL, state TEXT NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS config_records (generation TEXT NOT NULL, domain TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(generation,domain))');
            db.rows('CREATE TABLE IF NOT EXISTS runtime_records (domain TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS runtime_receipts (operation TEXT PRIMARY KEY, domain TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS authority_identity (id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL)');
            if(!db.rows('SELECT id FROM authority_identity WHERE id=1').length)db.rows('INSERT INTO authority_identity VALUES (1,?)',crypto.randomUUID());
            db.rows('CREATE TABLE IF NOT EXISTS authority_heads (id INTEGER PRIMARY KEY CHECK(id=1),config_generation TEXT NOT NULL,credential_generation TEXT NOT NULL,runtime_generation TEXT NOT NULL,epoch INTEGER NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS runtime_generations (generation TEXT NOT NULL,domain TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(generation,domain))');
            db.rows('CREATE TABLE IF NOT EXISTS runtime_receipt_owners (operation TEXT PRIMARY KEY,generation TEXT NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS config_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, generation TEXT NOT NULL, domain TEXT NOT NULL, revision INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)');
            // Poll only pending work, without scanning retained delivery history.
            db.rows('CREATE INDEX IF NOT EXISTS config_outbox_ack_id ON config_outbox(acknowledged,id)');
        });
    }
    status(): Meta {
        const meta=this.db.rows<Meta>('SELECT generation, maintenance, epoch FROM config_meta WHERE id=1')[0],head=this.db.rows<{config_generation:string;credential_generation:string;runtime_generation:string;epoch:number}>('SELECT * FROM authority_heads WHERE id=1')[0];
        if(head&&(head.config_generation!==meta.generation||head.credential_generation!==meta.generation||head.runtime_generation!==meta.generation||head.epoch!==meta.epoch))throw new ReliabilityError('CONFLICT',409);return meta;
    }
    private ready(writing = false): Meta {
        const meta = this.status();
        if (!meta.generation) throw new ReliabilityError('NOT_READY', 503);
        if (writing && meta.maintenance) throw new ReliabilityError('MAINTENANCE', 503);
        return meta;
    }
    /** Maintenance transitions are CAS. Task drain proof will be added at B1 integration. */
    setMaintenance(enabled: boolean, expectedEpoch: number): Meta {
        return this.db.transaction(() => this.setMaintenanceInTransaction(enabled, expectedEpoch));
    }
    /** Trusted same-database maintenance receipt transaction; never a public RPC. */
    setMaintenanceInTransaction(enabled: boolean, expectedEpoch: number): Meta {
        if (typeof enabled !== 'boolean') throw new ReliabilityError('INVALID', 400);
        revision(expectedEpoch);
            const meta = this.status();
            if (meta.epoch !== expectedEpoch) throw new ReliabilityError('CONFLICT', 409);
            if (!enabled && !meta.generation) throw new ReliabilityError('NOT_READY', 503);
            if (!enabled && this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='authority_drains'").length && this.db.rows("SELECT id FROM authority_drains WHERE generation=? AND state NOT IN ('consumed','released') LIMIT 1",meta.generation).length) throw new ReliabilityError('MAINTENANCE',503);
            if (meta.maintenance !== Number(enabled)) {this.db.rows('UPDATE config_meta SET maintenance=?, epoch=epoch+1 WHERE id=1', Number(enabled));this.db.rows('UPDATE authority_heads SET epoch=epoch+1 WHERE id=1');}
            return this.status();
    }
    read(domains: string[]): { generation: string; epoch: number; records: ConfigRecord[] } {
        if (!Array.isArray(domains) || domains.length > 100 || new Set(domains).size !== domains.length) throw new ReliabilityError('INVALID', 400);
        domains.forEach(domainName);
        return this.db.transaction(() => {
            const meta = this.ready();
            const records = domains.map(domain => {
                const row = this.db.rows<Row>('SELECT domain, revision, payload FROM config_records WHERE generation=? AND domain=?', meta.generation, domain)[0];
                return row ? { domain, revision: row.revision, value: JSON.parse(row.payload) as Json } : { domain, revision: 0, value: null };
            });
            return { generation: meta.generation!, epoch: meta.epoch, records };
        });
    }
    /** Complete authoritative view, including tombstones, for invocation-local adapters.
     * A missing domain in this view is revision zero, never a reason to fall back to KV. */
    readAll(): { generation: string; epoch: number; watermark: number; records: ConfigRecord[] } {
        return this.db.transaction(() => {
            const meta = this.ready();
            return { generation: meta.generation!, epoch: meta.epoch, watermark: this.watermark(), records: this.staged(meta.generation!) };
        });
    }
    private watermark(): number { return this.db.rows<{ n: number }>('SELECT COALESCE(MAX(id),0) AS n FROM config_outbox')[0].n; }
    /** Synchronous barrier for a task+outbox transaction on this same SQLite database.
     * No await and no nested transaction: the caller must insert the task immediately
     * after this check in its transaction. Epoch detects maintenance enter/exit ABA. */
    assertBarrier(generation: string, epoch: number, expected: { domain: string; revision: number }[]): void {
        identifier(generation); revision(epoch);
        if (!Array.isArray(expected) || !expected.length || expected.length > 100 || new Set(expected.map(r => r.domain)).size !== expected.length) throw new ReliabilityError('INVALID', 400);
        expected.forEach(r => { domainName(r.domain); revision(r.revision); });
        const meta = this.ready(true);
        if (meta.generation !== generation || meta.epoch !== epoch) throw new ReliabilityError('CONFLICT', 409);
        for (const r of expected) {
            const row = this.db.rows<Row>('SELECT revision FROM config_records WHERE generation=? AND domain=?', generation, r.domain)[0];
            if ((row?.revision || 0) !== r.revision) throw new ReliabilityError('CONFLICT', 409);
        }
    }
    /** All revisions are checked before any mutation, in one local transaction. */
    compareAndSet(generation: string, changes: ConfigChange[], dependencies?: { epoch: number; watermark?: number; expected: { domain: string; revision: number }[] }, beforeCommit?: () => void): ConfigRecord[] {
        return this.db.transaction(() => this.compareAndSetInTransaction(generation, changes, dependencies, beforeCommit));
    }
    /** Trusted synchronous participant in a caller-owned SAME-DB transaction (task +
     * config + projection outbox). Never call without that transaction or expose by RPC. */
    compareAndSetInTransaction(generation: string, changes: ConfigChange[], dependencies?: { epoch: number; watermark?: number; expected: { domain: string; revision: number }[] }, beforeCommit?: () => void): ConfigRecord[] {
        identifier(generation);
        if (!Array.isArray(changes) || !changes.length || changes.length > 100 || new Set(changes.map(c => c.domain)).size !== changes.length) throw new ReliabilityError('INVALID', 400);
        const prepared = changes.map(c => { domainName(c.domain); revision(c.expectedRevision); return { ...c, payload: encoded(c.value) }; });
        if (dependencies) {
            this.assertBarrier(generation, dependencies.epoch, dependencies.expected);
            if (dependencies.watermark !== undefined) {
                revision(dependencies.watermark);
                if (dependencies.watermark !== this.watermark()) throw new ReliabilityError('CONFLICT', 409);
            }
        }
        const meta = this.ready(true);
        if (meta.generation !== generation) throw new ReliabilityError('CONFLICT', 409);
        for (const c of prepared) {
            const row = this.db.rows<Row>('SELECT revision FROM config_records WHERE generation=? AND domain=?', generation, c.domain)[0];
            if ((row?.revision || 0) !== c.expectedRevision || c.expectedRevision === Number.MAX_SAFE_INTEGER) throw new ReliabilityError('CONFLICT', 409);
        }
        // Trusted synchronous global-store guard (same SQLite DB), after every
        // revision check and before any config/outbox write. Never perform RPC here.
        if (beforeCommit && beforeCommit() !== undefined) throw new ReliabilityError('INVALID', 400);
        for (const c of prepared) {
            this.db.rows('INSERT INTO config_records VALUES (?,?,?,?) ON CONFLICT(generation,domain) DO UPDATE SET revision=excluded.revision,payload=excluded.payload', generation, c.domain, c.expectedRevision + 1, c.payload);
            this.db.rows('INSERT INTO config_outbox (generation,domain,revision) VALUES (?,?,?)', generation, c.domain, c.expectedRevision + 1);
        }
        return prepared.map(c => ({ domain: c.domain, revision: c.expectedRevision + 1, value: JSON.parse(c.payload) as Json }));
    }
    /** Only monotonic timestamps, not arbitrary user config or whole-object replacement. */
    recordRuntime(operation: string, patch: { lastCheck?: number; lastGc?: number }): { revision: number } {
        identifier(operation);
        if (!patch || Object.keys(patch).length === 0 || Object.keys(patch).some(k => !['lastCheck', 'lastGc'].includes(k))) throw new ReliabilityError('INVALID', 400);
        Object.values(patch).forEach(revision);
        const payload = encoded(patch);
        return this.db.transaction(() => {
            const meta=this.ready(true);
            const receipt = this.db.rows<Row>('SELECT revision, payload FROM runtime_receipts WHERE operation=?', operation)[0];
            if (receipt) {
                const owner=this.db.rows<{generation:string}>('SELECT generation FROM runtime_receipt_owners WHERE operation=?',operation)[0];
                if (receipt.payload !== payload || (owner && owner.generation!==meta.generation) || (!owner && this.db.rows('SELECT id FROM authority_heads').length)) throw new ReliabilityError('CONFLICT',409);
                if(!owner)this.db.rows('INSERT INTO runtime_receipt_owners VALUES (?,?)',operation,meta.generation);return {revision:receipt.revision};
            }
            const prior = this.db.rows<Row>("SELECT revision,payload FROM runtime_records WHERE domain='automation'")[0];
            this.readRuntime(); // Also verifies the active runtime pointer/mirror if installed.
            const value = prior ? JSON.parse(prior.payload) as Record<string, number> : {};
            for (const [key, time] of Object.entries(patch)) value[key] = Math.max(value[key] || 0, time!);
            const next = (prior?.revision || 0) + 1;
            if (!Number.isSafeInteger(next)) throw new ReliabilityError('CONFLICT', 409);
            this.db.rows("INSERT INTO runtime_records VALUES ('automation',?,?) ON CONFLICT(domain) DO UPDATE SET revision=excluded.revision,payload=excluded.payload", next, canonical(value));
            this.db.rows("INSERT INTO runtime_receipts VALUES (?,'automation',?,?)", operation, payload, next);
            this.db.rows('INSERT INTO runtime_receipt_owners VALUES (?,?)',operation,meta.generation);
            this.db.rows("INSERT INTO runtime_generations VALUES (?,'automation',?,?) ON CONFLICT(generation,domain) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",meta.generation,next,canonical(value));
            return { revision: next };
        });
    }
    readRuntime(): { revision: number; value: Json } {
        const meta=this.ready();
        const row = this.db.rows<Row>("SELECT revision,payload FROM runtime_records WHERE domain='automation'")[0];
        if(this.db.rows('SELECT id FROM authority_heads').length){const stored=this.db.rows<Row>("SELECT revision,payload FROM runtime_generations WHERE generation=? AND domain='automation'",meta.generation)[0];if(!stored||!row||stored.revision!==row.revision||stored.payload!==row.payload)throw new ReliabilityError('CONFLICT',409);}
        return row ? { revision: row.revision, value: JSON.parse(row.payload) as Json } : { revision: 0, value: {} };
    }
    beginImport(id: string, digest: string, count: number, beforeCommit?: () => void): void {
        identifier(id);
        if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(count) || count < 1 || count > 10000) throw new ReliabilityError('INVALID', 400);
        this.db.transaction(() => {
            if (!this.status().maintenance) throw new ReliabilityError('MAINTENANCE', 503);
            if (beforeCommit && beforeCommit() !== undefined) throw new ReliabilityError('INVALID', 400);
            const old = this.db.rows<Generation>('SELECT * FROM config_generations WHERE id=?', id)[0];
            if (old) { if (old.digest !== digest || old.count !== count) throw new ReliabilityError('CONFLICT', 409); return; }
            this.db.rows("INSERT INTO config_generations VALUES (?,?,?,'staging')", id, digest, count);
        });
    }
    stage(id: string, record: ConfigRecord, beforeCommit?: () => void): void {
        identifier(id); domainName(record.domain); revision(record.revision);
        if (record.revision === 0) throw new ReliabilityError('INVALID', 400);
        const payload = encoded(record.value);
        this.db.transaction(() => {
            if (!this.status().maintenance) throw new ReliabilityError('MAINTENANCE', 503);
            if (beforeCommit && beforeCommit() !== undefined) throw new ReliabilityError('INVALID', 400);
            const gen = this.db.rows<Generation>('SELECT * FROM config_generations WHERE id=?', id)[0];
            if (!gen || gen.state !== 'staging') throw new ReliabilityError('CONFLICT', 409);
            const old = this.db.rows<Row>('SELECT revision,payload FROM config_records WHERE generation=? AND domain=?', id, record.domain)[0];
            if (old) { if (old.revision !== record.revision || old.payload !== payload) throw new ReliabilityError('CONFLICT', 409); return; }
            const total = this.db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM config_records WHERE generation=?', id)[0].n;
            if (total >= gen.count) throw new ReliabilityError('CONFLICT', 409);
            this.db.rows('INSERT INTO config_records VALUES (?,?,?,?)', id, record.domain, record.revision, payload);
        });
    }
    private staged(id: string): ConfigRecord[] {
        return this.db.rows<Row>('SELECT domain,revision,payload FROM config_records WHERE generation=? ORDER BY domain', id).map(r => ({ domain: r.domain, revision: r.revision, value: JSON.parse(r.payload) as Json }));
    }
    /** Bootstrap only. Replacing a live generation requires B1 drain/restore integration. */
    async activateInitial(id: string, expectedEpoch: number): Promise<Meta> {
        identifier(id); revision(expectedEpoch);
        const records = this.staged(id);
        const digest = await manifestDigest(records);
        return this.db.transaction(() => {
            const meta = this.status();
            const gen = this.db.rows<Generation>('SELECT * FROM config_generations WHERE id=?', id)[0];
            if (meta.epoch !== expectedEpoch) throw new ReliabilityError('CONFLICT', 409);
            if (!meta.maintenance || meta.generation || !gen || gen.state !== 'staging') throw new ReliabilityError('CONFLICT', 409);
            if (records.length !== gen.count || digest !== gen.digest || canonical(this.staged(id)) !== canonical(records)) throw new ReliabilityError('CONFLICT', 409);
            this.db.rows("UPDATE config_generations SET state='active' WHERE id=?", id);
            this.db.rows('UPDATE config_meta SET generation=?,epoch=epoch+1 WHERE id=1', id);
            for (const r of records) this.db.rows('INSERT INTO config_outbox (generation,domain,revision) VALUES (?,?,?)', id, r.domain, r.revision);
            return this.status();
        });
    }
    pendingProjection(limit = 100): Record<string, unknown>[] {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ReliabilityError('INVALID', 400);
        return this.db.rows('SELECT id,generation,domain,revision FROM config_outbox WHERE acknowledged=0 ORDER BY id LIMIT ?', limit);
    }
    acknowledgeProjection(id: number): void { revision(id); this.db.rows('UPDATE config_outbox SET acknowledged=1 WHERE id=?', id); }
}
