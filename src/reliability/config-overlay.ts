import type { KVNamespace, KVGetOptions, KVPutOptions, KVListOptions } from '../config/env';
import { KV_KEYS, TEMPLATES, parseAccountVarsKey } from '../config/templates';
import { canonical, encoded, identifier, revision, ReliabilityError, type ConfigRecord, type ConfigChange } from './protocol';

export function configDomain(key: string): string | null {
    if (key === KV_KEYS.ACCOUNTS) return 'accounts';
    if (key === KV_KEYS.GLOBAL_CONFIG) return 'autoConfig';
    if (key === KV_KEYS.DEPLOY_JOURNAL) return 'deployJournal';
    const account = parseAccountVarsKey(key);
    if (account) return 'override:' + account.type + ':' + account.accountId;
    for (const type of Object.keys(TEMPLATES)) {
        if (key === KV_KEYS.vars(type)) return 'vars:' + type;
        if (key === KV_KEYS.deployConfig(type)) return 'deploy:' + type;
        if (key === KV_KEYS.favorites(type)) return 'favorites:' + type;
        if (key === KV_KEYS.upstream(type)) return 'upstream:' + type;
    }
    return null;
}
export function configKey(domain: string): string | null {
    if (domain === 'accounts') return KV_KEYS.ACCOUNTS;
    if (domain === 'autoConfig') return KV_KEYS.GLOBAL_CONFIG;
    if (domain === 'deployJournal') return KV_KEYS.DEPLOY_JOURNAL;
    const [kind, type, account, extra] = domain.split(':');
    if (!Object.hasOwn(TEMPLATES, type) || extra !== undefined) return null;
    if (kind === 'override' && account) { const key = KV_KEYS.accountVars(type, account); return configDomain(key) === domain ? key : null; }
    if (account !== undefined) return null;
    return ({ vars: KV_KEYS.vars, deploy: KV_KEYS.deployConfig, favorites: KV_KEYS.favorites, upstream: KV_KEYS.upstream } as Record<string, (type: string) => string>)[kind]?.(type) || null;
}
function ephemeral(key: string): boolean {
    return /^SESSION_[a-zA-Z0-9_-]+$/.test(key) || /^RATE_LIMIT_[a-zA-Z0-9_.:-]+$/.test(key) || Object.keys(TEMPLATES).some(t => key === KV_KEYS.ghInfoCache(t));
}
export interface ConfigView { generation: string; epoch: number; watermark: number; records: ConfigRecord[] }
/** Invocation-local JSON view, never a KV write-through for business data. Callers must
 * obtain a COMPLETE view from the authoritative DO; route registration decides which
 * operations may commit. Restores and unknown keys fail closed instead of old KV fallback. */
export class ConfigOverlay implements KVNamespace {
    readonly generation: string;
    readonly epoch: number;
    private readonly watermark: number;
    private enumerated = false;
    private readonly original = new Map<string, ConfigRecord>();
    private readonly pending = new Map<string, string | null>();
    private readonly reads = new Set<string>();
    private readonly cacheWrites = new Map<string, { value: string | null; options?: KVPutOptions }>();
    constructor(view: ConfigView, private readonly cache: KVNamespace) {
        identifier(view.generation); revision(view.epoch); revision(view.watermark);
        this.generation = view.generation; this.epoch = view.epoch; this.watermark = view.watermark;
        for (const record of view.records) {
            const key = configKey(record.domain);
            if (!key) continue; // Internal domains (e.g. credential records) aren't legacy KV keys.
            if (this.original.has(record.domain)) throw new ReliabilityError('INVALID', 400);
            revision(record.revision);
            this.original.set(record.domain, { ...record, value: JSON.parse(encoded(record.value)) });
        }
    }
    async get(key: string, options?: KVGetOptions): Promise<string | null> {
        const domain = configDomain(key);
        if (domain) {
            this.reads.add(domain);
            if (this.pending.has(domain)) return this.pending.get(domain)!;
            const record = this.original.get(domain);
            return !record || record.value === null ? null : canonical(record.value);
        }
        if (!ephemeral(key)) throw new ReliabilityError('INVALID', 400);
        if (this.cacheWrites.has(key)) return this.cacheWrites.get(key)!.value;
        return this.cache.get(key, options);
    }
    async put(key: string, value: string, options?: KVPutOptions): Promise<void> {
        const domain = configDomain(key);
        if (domain) {
            if (options && Object.keys(options).length) throw new ReliabilityError('INVALID', 400);
            let normalized: string;
            try { normalized = encoded(JSON.parse(value)); } catch { throw new ReliabilityError('INVALID', 400); }
            this.pending.set(domain, normalized); this.reads.add(domain); return;
        }
        if (!ephemeral(key)) throw new ReliabilityError('INVALID', 400);
        this.cacheWrites.set(key, { value, options: options ? { ...options } : undefined });
    }
    async delete(key: string): Promise<void> {
        const domain = configDomain(key);
        if (domain) { this.pending.set(domain, null); this.reads.add(domain); return; }
        if (!ephemeral(key)) throw new ReliabilityError('INVALID', 400);
        this.cacheWrites.set(key, { value: null });
    }
    async list(options: KVListOptions = {}): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
        // Only authoritative business keys. Never expose stale legacy KV copies to GC,
        // backup, or import. Diagnostics that count sessions need a separate cache API.
        this.enumerated = true;
        const limit = options.limit ?? 1000;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (options.cursor && !/^(0|[1-9][0-9]*)$/.test(options.cursor))) throw new ReliabilityError('INVALID', 400);
        const offset = Number(options.cursor || 0);
        if (!Number.isSafeInteger(offset)) throw new ReliabilityError('INVALID', 400);
        const domains = new Set([...this.original.keys(), ...this.pending.keys()]);
        const names: string[] = [];
        for (const domain of domains) {
            const key = configKey(domain)!;
            if (!key.startsWith(options.prefix || '')) continue;
            this.reads.add(domain);
            const present = this.pending.has(domain) ? this.pending.get(domain) !== null && this.pending.get(domain) !== 'null' : this.original.get(domain)?.value !== null;
            if (present) names.push(key);
        }
        names.sort(); const next = offset + limit;
        return { keys: names.slice(offset, next).map(name => ({ name })), list_complete: next >= names.length, ...(next < names.length ? { cursor: String(next) } : {}) };
    }
    changes(): ConfigChange[] {
        return [...this.pending].map(([domain, raw]) => ({ domain, expectedRevision: this.original.get(domain)?.revision || 0, value: raw === null ? null : JSON.parse(raw) }));
    }
    dependencies(): { epoch: number; watermark?: number; expected: { domain: string; revision: number }[] } {
        return { epoch: this.epoch, ...(this.enumerated ? { watermark: this.watermark } : {}), expected: [...this.reads].sort().map(domain => ({ domain, revision: this.original.get(domain)?.revision || 0 })) };
    }
    /** Only after authoritative commit. Failure here affects cache, not business commit.
     * A durable cache projection outbox is still required for guaranteed invalidation. */
    async flushCache(): Promise<void> {
        for (const [key, entry] of this.cacheWrites) {
            if (entry.value === null) await this.cache.delete(key); else await this.cache.put(key, entry.value, entry.options);
        }
        this.cacheWrites.clear();
    }
}
