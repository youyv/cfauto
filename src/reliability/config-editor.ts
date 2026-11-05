import { TEMPLATES, autoFlagKey, normalizeTemplateSettings, readTemplateSettings } from '../config/templates';
import { normalizeAutoConfig, normalizeVariables, validateAccountsPayload } from '../lib/validate';
import { normalizeUpstream } from '../lib/upstream';
import type { AccountEntry } from '../lib/types';
import { ConfigStore, type SqlDatabase } from './config-store';
import { CredentialAuthority } from './credential-authority';
import { prepareAccountImport } from './account-transfer';
import { readCredentialAccounts } from './credential-accounts';
import type { KeyRing } from './credential-envelope';
import { canonical, encoded, identifier, revision, ReliabilityError, type Json } from './protocol';

export type ConfigSelector = { kind: 'accounts' | 'auto' | 'joey_nodes' } | { kind: 'template' | 'variables' | 'favorites' | 'upstream' | 'deploy'; template: string };
type ConfigEditSelector = ConfigSelector | { kind: 'accounts_import' };
export interface ConfigEdit { key: string; generation: string; epoch: number; revision: number; selector: ConfigEditSelector; value: Json }
interface Receipt extends Record<string, unknown> { digest: string; result: string }
function invalid(): never { throw new ReliabilityError('INVALID', 400); }
function conflict(): never { throw new ReliabilityError('CONFLICT', 409); }
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) invalid();
}
export function parseConfigSelector(input: unknown): ConfigSelector {
    shape(input, ['kind'], ['template']);
    if (['accounts', 'auto', 'joey_nodes'].includes(input.kind)) { shape(input, ['kind']); return { kind: input.kind }; }
    if (!['template', 'variables', 'favorites', 'upstream', 'deploy'].includes(input.kind) || typeof input.template !== 'string' || !Object.hasOwn(TEMPLATES, input.template)) invalid();
    if (input.kind === 'upstream' && !['cmliu', 'joey'].includes(input.template)) invalid();
    return { kind: input.kind, template: input.template };
}
export function parseConfigEdit(input: unknown): ConfigEdit {
    // Copy before the first cryptographic await. JSON input is bounded separately
    // from the larger business/source submission budget.
    const value: unknown = JSON.parse(encoded(input));
    shape(value, ['key', 'generation', 'epoch', 'revision', 'selector', 'value']);
    identifier(value.key); identifier(value.generation); revision(value.epoch); revision(value.revision);
    let selector: ConfigEditSelector;
    if (value.selector?.kind === 'accounts_import') { shape(value.selector, ['kind']); selector = { kind: 'accounts_import' }; }
    else selector = parseConfigSelector(value.selector);
    if (selector.kind === 'deploy') invalid(); // Ledger is task-owned, never a browser patch.
    return { ...value, selector } as ConfigEdit;
}
export const LEGACY_CONFIG_PATHS = ['/api/accounts', '/api/accounts/import', '/api/settings', '/api/favorites', '/api/auto_config', '/api/upstream'] as const;
/** Old URLs with an explicit NEW revision/idempotency protocol. This never infers a
 * revision by reading current state on behalf of a stale browser. */
export function legacyConfigEdit(request: Request, value: unknown): ConfigEdit {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.hash) invalid();
    let selector: ConfigEditSelector;
    if (url.pathname === '/api/save_yxip') {
        if (url.search) invalid();
        shape(value, ['type', 'rawContent']);
        if (value.type !== 'joey_var') invalid();
        selector = { kind: 'joey_nodes' }; value = value.rawContent;
    } else if (url.pathname === '/api/accounts/import') {
        if (url.search) invalid();
        selector = { kind: 'accounts_import' };
    } else if (url.pathname === '/api/accounts' || url.pathname === '/api/auto_config') {
        if (url.search) invalid();
        selector = { kind: url.pathname === '/api/accounts' ? 'accounts' : 'auto' };
    } else {
        const kinds: Record<string, string> = { '/api/settings': 'variables', '/api/favorites': 'favorites', '/api/upstream': 'upstream' };
        const kind = kinds[url.pathname];
        if (!kind || [...url.searchParams.keys()].some(k => k !== 'type') || url.searchParams.getAll('type').length !== 1) invalid();
        selector = parseConfigSelector({ kind, template: url.searchParams.get('type') });
    }
    const numberHeader = (name: string) => {
        const raw = request.headers.get(name); if (raw === null || !/^(0|[1-9][0-9]{0,15})$/.test(raw)) invalid(); return Number(raw);
    };
    return parseConfigEdit({ key: request.headers.get('idempotency-key'), generation: request.headers.get('x-config-generation'), epoch: numberHeader('x-config-epoch'), revision: numberHeader('x-config-revision'), selector, value });
}
function domain(selector: ConfigEditSelector): string {
    switch (selector.kind) {
        case 'accounts': case 'accounts_import': return 'accounts';
        case 'auto': return 'autoConfig';
        case 'joey_nodes': return 'vars:joey';
        case 'template': return 'template:' + selector.template;
        case 'variables': return 'vars:' + selector.template;
        case 'favorites': return 'favorites:' + selector.template;
        case 'upstream': return 'upstream:' + selector.template;
        case 'deploy': return 'deploy:' + selector.template;
    }
}
function templateSettingsValue(template: string, value: unknown): Json {
    const settings = readTemplateSettings(template, value);
    if (!settings) throw new ReliabilityError('NOT_READY', 503);
    return settings as unknown as Json;
}
function variables(value: unknown): Json[] {
    if (!Array.isArray(value)) invalid();
    for (const row of value) {
        shape(row, ['key', 'value'], ['secret']);
        if (typeof row.key !== 'string' || typeof row.value !== 'string' || (row.secret !== undefined && typeof row.secret !== 'boolean')) invalid();
    }
    const result = normalizeVariables(value); if (!result.ok) invalid();
    return result.value as unknown as Json[];
}
const autoFields = ['enabled', 'interval', 'fuseThreshold', 'fuseWebhook', ...Object.keys(TEMPLATES).map(autoFlagKey)];
function automation(value: unknown): Json {
    shape(value, [], autoFields);
    for (const key of ['enabled', ...Object.keys(TEMPLATES).map(autoFlagKey)]) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') invalid();
    for (const key of ['interval', 'fuseThreshold']) if (Object.hasOwn(value, key) && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) invalid();
    if (Object.hasOwn(value, 'fuseWebhook') && typeof value.fuseWebhook !== 'string') invalid();
    const normalized = normalizeAutoConfig(value); if (!normalized.ok) invalid();
    return normalized.value as unknown as Json;
}
/** Pure migration preparation only; does not activate data or reset runtime. The
 * eventual generation importer must commit both halves under its drain protocol. */
export function splitAutomationConfig(input: unknown): { config: Json; runtime: { lastCheck?: number; lastGc?: number } } {
    const value: unknown = JSON.parse(encoded(input));
    shape(value, [], [...autoFields, 'lastCheck', 'lastGc']);
    const runtime: { lastCheck?: number; lastGc?: number } = {};
    for (const key of ['lastCheck', 'lastGc'] as const) if (Object.hasOwn(value, key)) { revision(value[key]); runtime[key] = value[key]; delete value[key]; }
    return { config: automation(value), runtime };
}
function favoriteItem(value: unknown): Record<string, Json> {
    shape(value, ['sha'], ['alias', 'type', 'name', 'date', 'message']);
    if (typeof value.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value.sha)) invalid();
    for (const [key, field] of Object.entries(value)) if (typeof field !== 'string' || field.length > (key === 'message' ? 8192 : 1024)) invalid();
    return value as Record<string, Json>;
}
function favoriteAction(value: unknown, prior: Json): Json {
    shape(value, ['action', 'item']);
    if (!['add', 'remove'].includes(value.action)) invalid();
    const item = favoriteItem(value.item);
    if (prior !== null && !Array.isArray(prior)) throw new ReliabilityError('NOT_READY', 503);
    const list = (prior || []) as Json[];
    try { list.forEach(favoriteItem); } catch { throw new ReliabilityError('NOT_READY', 503); }
    if (value.action === 'remove') return list.filter(f => (f as Record<string, Json>).sha !== item.sha);
    if (list.some(f => (f as Record<string, Json>).sha === item.sha)) return list;
    if (list.length >= 200) invalid();
    return [item, ...list];
}
/** Global-only configuration application boundary. No handler/client-supplied patch,
 * no KV fallback, no network writes. The receipt and CAS share ONE SQLite transaction.
 * Deployment/override facts remain executor-owned. Strict account transfer uses this
 * same CAS/receipt; full backup restoration requires the maintenance protocol. */
export class ConfigEditor {
    private readonly ring: KeyRing;
    private readonly digestSecret: Uint8Array;
    constructor(private readonly db: SqlDatabase, private readonly config: ConfigStore, private readonly authority: CredentialAuthority, ring: KeyRing, digestSecret: Uint8Array) {
        if (!(digestSecret instanceof Uint8Array) || digestSecret.length < 32) invalid();
        this.ring = { ...ring, keys: { ...ring.keys } }; this.digestSecret = digestSecret.slice();
        db.rows('CREATE TABLE IF NOT EXISTS config_edit_receipts (key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL)');
    }
    async read(input: unknown): Promise<Json> {
        const selector = parseConfigSelector(input), name = domain(selector), view = this.config.read([name]), record = view.records[0];
        // Read runtime synchronously with the config view, before decryption awaits.
        const runtime = selector.kind === 'auto' ? this.config.readRuntime() : undefined;
        let value = record.value;
        if (selector.kind === 'accounts') {
            const accounts = await readCredentialAccounts((value || []) as unknown as AccountEntry[], this.ring);
            value = accounts.map(a => ({ ...a, globalKey: a.globalKey ? '***' : '', apiToken: a.apiToken ? '***' : '' })) as unknown as Json;
        } else if (selector.kind === 'template') {
            value = templateSettingsValue(selector.template, value);
        } else if (selector.kind === 'auto' && value !== null) {
            try { value = automation(value); } catch { throw new ReliabilityError('NOT_READY', 503); }
        }
        return { generation: view.generation, epoch: view.epoch, revision: record.revision, value, ...(runtime ? { runtime: runtime as unknown as Json } : {}) };
    }
    private async digest(input: ConfigEdit): Promise<string> {
        const key = await crypto.subtle.importKey('raw', this.digestSecret as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical(['cfauto:config-edit:v1', 'manager', input])));
        return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
    }
    private replay(key: string, digest: string): Json | undefined {
        const row = this.db.rows<Receipt>('SELECT digest,result FROM config_edit_receipts WHERE key=?', key)[0];
        if (!row) return undefined;
        if (row.digest !== digest) conflict();
        return { ...JSON.parse(row.result), duplicate: true };
    }
    async edit(raw: unknown): Promise<Json> {
        const input = parseConfigEdit(raw), digest = await this.digest(input);
        const replay = this.replay(input.key, digest); if (replay) return replay;
        const name = domain(input.selector), view = this.config.read([name]);
        if (view.generation !== input.generation || view.epoch !== input.epoch || view.records[0].revision !== input.revision) conflict();
        const result: Record<string, Json> = { generation: input.generation, epoch: input.epoch, domain: name, revision: input.revision + 1, duplicate: false };
        const receipt = () => {
            if (this.replay(input.key, digest)) conflict();
            this.db.rows('INSERT INTO config_edit_receipts VALUES (?,?,?)', input.key, digest, canonical(result));
        };
        try {
            if (input.selector.kind === 'accounts_import') {
                this.authority.assertImportAllowed(input.generation, input.epoch);
                const prepared = await prepareAccountImport(input.value, view.records[0].value as unknown as AccountEntry[], this.ring);
                Object.assign(result, { success: true, added: prepared.added, merged: prepared.merged, total: prepared.total });
                await this.authority.write({ generation: input.generation, epoch: input.epoch, expectedRevision: input.revision, accounts: prepared.accounts }, () => {
                    this.authority.assertImportAllowed(input.generation, input.epoch); receipt();
                });
            } else if (input.selector.kind === 'accounts') {
                const parsed = validateAccountsPayload(input.value); if (!parsed.ok) invalid();
                await this.authority.write({ generation: input.generation, epoch: input.epoch, expectedRevision: input.revision, accounts: input.value as unknown as AccountEntry[] }, receipt);
            } else {
                let value: Json;
                switch (input.selector.kind) {
                    case 'template': {
                        const settings = normalizeTemplateSettings(input.value);
                        if (!settings) invalid();
                        value = settings as unknown as Json;
                        break;
                    }
                    case 'variables': value = variables(input.value); break;
                    case 'auto':
                        // Do not erase unmigrated lastCheck/lastGc by accepting a user save.
                        if (view.records[0].value !== null) { try { automation(view.records[0].value); } catch { throw new ReliabilityError('NOT_READY', 503); } }
                        value = automation(input.value); break;
                    case 'upstream':
                        shape(input.value, ['path', 'branch']);
                        try { value = normalizeUpstream(input.value) as unknown as Json; } catch { invalid(); }
                        break;
                    case 'favorites': value = favoriteAction(input.value, view.records[0].value); break;
                    case 'joey_nodes': {
                        if (typeof input.value !== 'string' || !input.value.trim() || input.value.length > 8192) invalid();
                        let list: Json[];
                        try { list = variables(view.records[0].value ?? []); } catch { throw new ReliabilityError('NOT_READY', 503); }
                        const index = list.findIndex(row => (row as Record<string, Json>).key === 'yx');
                        const entry = { key: 'yx', value: input.value };
                        if (index < 0) list.push(entry); else list[index] = entry;
                        value = variables(list); break;
                    }
                    default: invalid();
                }
                this.config.compareAndSet(input.generation, [{ domain: name, expectedRevision: input.revision, value }], { epoch: input.epoch, expected: [{ domain: name, revision: input.revision }] }, receipt);
            }
            return result;
        } catch (error) {
            // A matching concurrent account edit can commit while crypto is awaited.
            // Its atomic receipt is sufficient to answer a lost ACK, not to retry a write.
            const saved = this.replay(input.key, digest); if (saved) return saved;
            throw error;
        }
    }
}
