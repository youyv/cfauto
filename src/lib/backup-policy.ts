/** Versioned backup validation. No mutations here; never include field values in diagnostics. */
import { KV_KEYS, TEMPLATES, isAccountVarsKey, autoFlagKey } from '../config/templates';
import type { AppEnv } from '../config/env';
import { jsonError } from './cloudflare-api';
import { normalizeVariables, normalizeAutoConfig, validateAccountsPayload, WORKER_NAME_RE } from './validate';
import { normalizeUpstream } from './upstream';
import { decryptKey, encryptKey, secretFingerprint } from './crypto-utils';
import { SECRET_FIELDS } from './account-store';
import { FRONTEND_VERSION } from '../frontend-bundle';

export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
// 400 reads + 400 writes + snapshot/auth overhead stay below the 1000-subrequest budget.
export const MAX_RESTORE_KEYS = 400;
export const SNAPSHOT_PREFIX = 'RESTORE_SNAPSHOT_';
export const SNAPSHOT_TTL = 7 * 86400;
export const SNAPSHOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function backupKeys(): string[] {
    return [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG, KV_KEYS.DEPLOY_JOURNAL,
        ...Object.keys(TEMPLATES).flatMap(t => [KV_KEYS.vars(t), KV_KEYS.deployConfig(t), KV_KEYS.favorites(t), KV_KEYS.upstream(t)])];
}
export function isRestorableKey(k: string): boolean {
    return !!k && !k.startsWith('_') && (backupKeys().includes(k) || isAccountVarsKey(k));
}
export async function backupMetadata(env: AppEnv) {
    return { _schemaVersion: BACKUP_SCHEMA_VERSION, _sourceVersion: FRONTEND_VERSION.replace(/^V/, ''),
        _time: new Date().toISOString(), _encryptionFingerprint: await secretFingerprint(env) };
}
/** Limit bytes while streaming, not after an unbounded req.json()/text(). */
export async function readBackupBody(req: Request): Promise<unknown> {
    if (Number(req.headers.get('Content-Length')) > MAX_BACKUP_BYTES) throw jsonError('备份超过 5 MiB 上限，请按键拆分', 413, 'VALIDATION_ERROR');
    const reader = req.body?.getReader();
    if (!reader) throw jsonError('备份必须是 JSON 对象', 400, 'VALIDATION_ERROR');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BACKUP_BYTES) { await reader.cancel(); throw jsonError('备份超过 5 MiB 上限，请按键拆分', 413, 'VALIDATION_ERROR'); }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw jsonError('备份不是合法 UTF-8 JSON', 400, 'VALIDATION_ERROR'); }
}
type Obj = Record<string, any>;
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Obj, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max = 8192) => typeof v === 'string' && v.length <= max;
const timestamp = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const date = (v: unknown) => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const sha = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v);
const optional = (v: Obj, k: string, check: (x: any) => boolean) => v[k] === undefined || check(v[k]);
const nullable = (check: (x: any) => boolean) => (v: unknown) => v === null || check(v);
function invalid(): never { throw new Error('内容结构、字段类型或范围无效'); }
async function validateValue(key: string, value: unknown, env: AppEnv): Promise<unknown> {
    if (key === KV_KEYS.ACCOUNTS) {
        if (!validateAccountsPayload(value).ok) invalid();
        const accounts = value as Obj[];
        const output: Obj[] = [];
        for (const a of accounts) {
            const workers = Object.keys(a).filter(k => k.startsWith('workers_'));
            if (!fields(a, ['alias','accountId','email','globalKey','apiToken','authMode','dailyLimit','defaultZoneName','defaultZoneId','stats',...workers]) ||
                !['alias','accountId','email','globalKey','apiToken','defaultZoneName','defaultZoneId'].every(k => optional(a, k, x => text(x))) ||
                a.alias !== a.alias.trim() || a.accountId !== a.accountId.trim() ||
                !optional(a, 'dailyLimit', timestamp) ||
                !workers.every(k => Array.isArray(a[k]) && a[k].length <= 1000 && a[k].every((x: unknown) => typeof x === 'string' && WORKER_NAME_RE.test(x))) ||
                !optional(a, 'stats', s => obj(s) && fields(s, ['total','max','error']) && timestamp(s.total) && timestamp(s.max) && optional(s, 'error', x => text(x)))) invalid();
            const next = { ...a };
            for (const field of SECRET_FIELDS) {
                const cipher = a[field];
                if (!cipher) continue;
                if (/^v[0-9]+:/.test(cipher) && !cipher.startsWith('v1:')) throw new Error('不支持的凭据密文版本');
                const plain = await decryptKey(env, cipher);
                if (cipher.startsWith('v1:') && (plain === cipher || !plain)) throw new Error('账号凭据无法解密，请检查加密密钥或备份完整性');
                // Unprefixed historical ciphertext is ambiguous: long base64 must decrypt, not become a plaintext key.
                if (!cipher.startsWith('v1:') && plain === cipher && /^[A-Za-z0-9+/]{60,}={0,2}$/.test(cipher)) throw new Error('旧格式凭据无法确认解密，请使用原实例重新导出');
                if (plain === '***' || /\.\.\./.test(plain)) throw new Error('备份包含掩码凭据，不能恢复');
                next[field] = cipher.startsWith('v1:') ? cipher : await encryptKey(env, plain);
            }
            output.push(next);
        }
        return output;
    }
    if (key === KV_KEYS.GLOBAL_CONFIG) {
        const flags = ['enabled', ...Object.keys(TEMPLATES).map(autoFlagKey)];
        if (!obj(value) || !fields(value, [...flags,'interval','fuseThreshold','fuseWebhook','lastCheck','lastGc']) ||
            !flags.every(k => optional(value, k, x => typeof x === 'boolean')) ||
            !['interval','fuseThreshold'].every(k => optional(value, k, x => (typeof x === 'number' || typeof x === 'string') && x !== '' && Number.isFinite(Number(x)))) ||
            !['lastCheck','lastGc'].every(k => optional(value, k, timestamp)) ||
            !optional(value, 'fuseWebhook', x => text(x, 2048)) || !normalizeAutoConfig(value).ok) invalid();
        return value;
    }
    if (key.startsWith('VARS_')) {
        if (!Array.isArray(value) || value.some(v => !obj(v) || !fields(v, ['key','value','secret','type']) ||
            !text(v.key, 64) || !v.key.trim() || v.key !== v.key.trim() || !text(v.value) ||
            !optional(v, 'secret', x => typeof x === 'boolean') || !optional(v, 'type', x => ['plain_text','secret_text'].includes(x))) || !normalizeVariables(value).ok) invalid();
        return value;
    }
    if (key.startsWith('UPSTREAM_')) {
        if (!obj(value) || !fields(value, ['path','branch'])) invalid();
        try { return normalizeUpstream(value); } catch { invalid(); }
    }
    if (key.startsWith('DEPLOY_CONFIG_')) {
        if (!obj(value) || !fields(value, ['mode','currentSha','deployTime','commitDate','pendingTargets','pendingSha','lastAttempt','sourceIdentity']) ||
            !optional(value, 'mode', x => ['latest','fixed'].includes(x)) || !['currentSha','pendingSha'].every(k => optional(value, k, nullable(x => x === 'unknown' || sha(x)))) ||
            !['deployTime','commitDate','lastAttempt'].every(k => optional(value, k, nullable(date))) ||
            !optional(value, 'sourceIdentity', x => text(x, 2048)) ||
            !optional(value, 'pendingTargets', x => Array.isArray(x) && x.length <= 50000 && x.every(v => typeof v === 'string' && /^[0-9a-f]{32}::[a-z0-9][a-z0-9_-]{0,62}$/i.test(v)))) invalid();
        return value;
    }
    if (key.startsWith('FAVORITES_')) {
        if (!Array.isArray(value) || value.length > 200 || value.some(v => !obj(v) || !fields(v, ['sha','alias','type','name','date','message']) || !sha(v.sha) ||
            !['alias','type','name','date','message'].every(k => optional(v, k, x => text(x))))) invalid();
        return value;
    }
    if (key === KV_KEYS.DEPLOY_JOURNAL) {
        if (!Array.isArray(value) || value.length > 1000 || value.some(v => !obj(v) || !fields(v, ['time','type','sha','accounts','total','summary','customSha','failed']) ||
            !date(v.time) || !Object.hasOwn(TEMPLATES, v.type) || !nullable(sha)(v.sha) ||
            !Number.isInteger(v.accounts) || v.accounts < 0 || !Number.isInteger(v.total) || v.total < 0 || !text(v.summary, 65536) ||
            !optional(v, 'customSha', x => text(x, 100)) || !optional(v, 'failed', x => Array.isArray(x) && x.length <= 50000 && x.every(v => text(v, 200))))) invalid();
        return value;
    }
    invalid();
}
export interface PreviewItem { key: string; action: 'add' | 'overwrite' | 'skip' | 'unsupported' | 'invalid'; reason?: string; }
export interface RestoreEntry { key: string; raw: string; before: string | null; }
export async function preflightBackup(input: unknown, env: AppEnv) {
    if (!obj(input)) throw jsonError('备份必须是 JSON 对象', 400, 'VALIDATION_ERROR');
    if (input._schemaVersion !== undefined && input._schemaVersion !== BACKUP_SCHEMA_VERSION) throw jsonError('不支持的备份 schemaVersion，请使用匹配版本的面板', 400, 'VALIDATION_ERROR');
    if (input._schemaVersion !== undefined && (!text(input._sourceVersion, 80) || !date(input._time))) throw jsonError('备份版本或生成时间元数据无效', 400, 'VALIDATION_ERROR');
    if (input._format !== undefined) throw jsonError('这不是完整配置备份；账号导出和恢复快照请使用各自流程', 400, 'VALIDATION_ERROR');
    const pairs = Object.entries(input).filter(([k]) => !k.startsWith('_') || k === '__proto__');
    if (pairs.length > MAX_RESTORE_KEYS) throw jsonError('每次最多恢复 400 个键，请保留元数据并按键拆分备份', 413, 'VALIDATION_ERROR');
    const fingerprint = await secretFingerprint(env);
    const fp = input._encryptionFingerprint;
    if (fp != null && (typeof fp !== 'string' || !/^[0-9a-f]{8}$/.test(fp))) throw jsonError('加密密钥指纹格式无效', 400, 'VALIDATION_ERROR');
    const mismatch = !!fp && fp !== fingerprint;
    const items: PreviewItem[] = []; const entries: RestoreEntry[] = [];
    for (const [key, value] of pairs) {
        if (!isRestorableKey(key)) { items.push({ key: key.slice(0, 160), action: 'unsupported', reason: '非白名单键，整批恢复已阻止' }); continue; }
        if (value === null) { items.push({ key, action: 'skip', reason: 'null 保持现值，不删除' }); continue; }
        try {
            const validated = await validateValue(key, value, env);
            entries.push({ key, raw: JSON.stringify(validated), before: null });
        } catch (e) { items.push({ key, action: 'invalid', reason: e instanceof Error ? e.message : '内容校验失败' }); }
    }
    // Complete validation before reads; all entries must pass again at execution time.
    let beforeBytes = 0;
    // Serial reads bound retained snapshot memory, including unexpectedly large historical values.
    for (const entry of entries) {
        entry.before = await env.CONFIG_KV.get(entry.key);
        beforeBytes += entry.before === null ? 0 : new TextEncoder().encode(entry.before).byteLength;
        if (beforeBytes > 10 * 1024 * 1024) throw jsonError('恢复前快照超过 10 MiB，请按键拆分；尚未写入', 413, 'VALIDATION_ERROR');
    }
    for (const e of entries) items.push({ key: e.key, action: e.before === null ? 'add' : 'overwrite' });
    const counts = { add: 0, overwrite: 0, skip: 0, unsupported: 0, invalid: 0 };
    for (const item of items) counts[item.action]++;
    const errors: string[] = [];
    if (mismatch) errors.push('备份来自不同的加密密钥，整批恢复已阻止；请在原实例导出或先评审密钥迁移');
    if (counts.invalid || counts.unsupported) errors.push('包含无效或不支持的配置，整批未通过预检');
    return { entries, preview: { valid: !errors.length, schemaVersion: input._schemaVersion ?? 0,
        sourceVersion: input._sourceVersion ?? '旧备份未记录', counts, items, errors,
        encryption: mismatch ? 'mismatch' : fp ? 'matched' : 'legacy-checked',
        warning: input._warning ? '源备份标记为可能不完整，请先核对' : undefined,
        semantics: '按键合并；已有键整体覆盖，缺失键和 null 不变；账号级覆盖也是整键替换。' } };
}
