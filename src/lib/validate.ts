/**
 * 请求体校验 — 轻量 field 检查，无需三方依赖
 */

import { jsonError } from './cloudflare-api';
import { TEMPLATES, autoFlagKey } from '../config/templates';
import type { VariableEntry } from './types';

/** Cloudflare Worker / KV 名称允许的字符集（小写字母、数字、连字符、下划线，长度 1-63） */
export const WORKER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** 非空字符串判定 */
export function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

/** 校验请求体必填字段，失败返回 400 错误响应 */
export function validateRequired<T extends Record<string, unknown>>(body: T, fields: string[]): Response | null {
    if (!body || typeof body !== 'object') {
        return jsonError('请求体必须是 JSON 对象', 400, 'VALIDATION_ERROR');
    }
    const missing = fields.filter(f => !(f in body) || body[f] === undefined || body[f] === null);
    if (missing.length > 0) {
        return jsonError("Missing required fields: " + missing.join(", "), 400, 'VALIDATION_ERROR');
    }
    return null;
}

/** 验证模板类型是否有效，失败返回 400 错误响应。required=false 时允许空值通过 */
export function requireTemplateType(type: string, required = true): Response | null {
    if (!type) {
        if (!required) return null;
        return jsonError('Template type is required', 400, 'VALIDATION_ERROR');
    }
    if (!TEMPLATES[type]) {
        return jsonError('Invalid template type: ' + type, 400, 'VALIDATION_ERROR');
    }
    return null;
}

/** 变量列表上限 — 防止把 KV 值撑爆（CF KV 单值 25MB，但绑定数本身有实际上限） */
export const MAX_VARIABLES = 128;
/** 单个变量值长度上限（CF plain_text 绑定实际可更大，此处按合理业务值收紧） */
export const MAX_VARIABLE_VALUE_LEN = 8192;

/**
 * 规范化变量列表：数组结构 + 逐项字段校验。
 * 返回 `{ ok: true, value }` 或 `{ ok: false, response }`。
 *
 * 此前 `POST /api/settings` 完全不校验，任意 JSON 直接落 KV；
 * 写入一个对象而非数组后，读取侧 `variables.map(...)` 会在部署时崩掉。
 */
export function normalizeVariables(input: unknown): { ok: true; value: VariableEntry[] } | { ok: false; response: Response } {
    if (!Array.isArray(input)) {
        return { ok: false, response: jsonError('变量必须是数组', 400, 'VALIDATION_ERROR') };
    }
    if (input.length > MAX_VARIABLES) {
        return { ok: false, response: jsonError('变量数量超限（最多 ' + MAX_VARIABLES + ' 个）', 400, 'VALIDATION_ERROR') };
    }
    const out: VariableEntry[] = [];
    const seen = new Set<string>();
    for (const raw of input) {
        if (!raw || typeof raw !== 'object') {
            return { ok: false, response: jsonError('变量条目必须是对象', 400, 'VALIDATION_ERROR') };
        }
        const item = raw as Record<string, unknown>;
        const key = typeof item.key === 'string' ? item.key.trim() : '';
        if (!key) continue;   // 前端空行，静默丢弃
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
            return { ok: false, response: jsonError('变量名非法: ' + key + '（仅允许字母数字下划线，且不以数字开头）', 400, 'VALIDATION_ERROR') };
        }
        if (seen.has(key)) {
            return { ok: false, response: jsonError('变量名重复: ' + key, 400, 'VALIDATION_ERROR') };
        }
        seen.add(key);
        const value = item.value === undefined || item.value === null ? '' : String(item.value);
        if (value.length > MAX_VARIABLE_VALUE_LEN) {
            return { ok: false, response: jsonError('变量 ' + key + ' 的值超长（上限 ' + MAX_VARIABLE_VALUE_LEN + ' 字符）', 400, 'VALIDATION_ERROR') };
        }
        const entry: VariableEntry = { key, value };
        if (item.secret === true) entry.secret = true;
        out.push(entry);
    }
    return { ok: true, value: out };
}

/** 账号列表上限 — 防止撑爆单个 KV 值 */
export const MAX_ACCOUNTS = 500;

/** Cloudflare Account ID 为 32 位小写十六进制 */
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * 校验账号数组：结构、必填、格式、以及 **alias / accountId 唯一性**。
 *
 * alias 是全项目事实上的主键（前端用它反查下标、部署日志用它标识目标、yxip 用它选账号），
 * 此前只校验非空，两个同 alias 的账号会让编辑/删除作用到错误的行。
 */
export function validateAccountsPayload(input: unknown): { ok: true; value: Array<Record<string, unknown>> } | { ok: false; response: Response } {
    if (!Array.isArray(input)) {
        return { ok: false, response: jsonError('格式错误：需要 JSON 数组', 400, 'VALIDATION_ERROR') };
    }
    if (input.length > MAX_ACCOUNTS) {
        return { ok: false, response: jsonError('账号数量超限（最多 ' + MAX_ACCOUNTS + ' 个）', 400, 'VALIDATION_ERROR') };
    }
    const aliases = new Set<string>();
    const accountIds = new Set<string>();
    for (const raw of input) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { ok: false, response: jsonError('格式错误：每条账号必须是对象', 400, 'VALIDATION_ERROR') };
        }
        const a = raw as Record<string, unknown>;
        const alias = typeof a.alias === 'string' ? a.alias.trim() : '';
        const accountId = typeof a.accountId === 'string' ? a.accountId.trim() : '';
        if (!alias || !accountId) {
            return { ok: false, response: jsonError('格式错误：每条账号必须包含非空 alias 和 accountId', 400, 'VALIDATION_ERROR') };
        }
        if (!ACCOUNT_ID_RE.test(accountId)) {
            return { ok: false, response: jsonError('Account ID 格式错误（应为 32 位十六进制字符）: ' + alias, 400, 'VALIDATION_ERROR') };
        }
        if (aliases.has(alias)) {
            return { ok: false, response: jsonError('备注(alias)重复: ' + alias + '。alias 用于唯一标识账号，请改为不同名称', 400, 'VALIDATION_ERROR') };
        }
        if (accountIds.has(accountId)) {
            return { ok: false, response: jsonError('Account ID 重复: ' + accountId + '（' + alias + '）', 400, 'VALIDATION_ERROR') };
        }
        aliases.add(alias);
        accountIds.add(accountId);
        // Worker 名列表必须是字符串数组
        for (const [k, v] of Object.entries(a)) {
            if (!k.startsWith('workers_')) continue;
            if (v === undefined || v === null) continue;
            if (!Array.isArray(v) || v.some(n => typeof n !== 'string')) {
                return { ok: false, response: jsonError('格式错误：' + alias + ' 的 ' + k + ' 必须是字符串数组', 400, 'VALIDATION_ERROR') };
            }
        }
    }
    return { ok: true, value: input as Array<Record<string, unknown>> };
}

/** 自动更新配置的校验结果 */
export interface NormalizedAutoConfig {
    enabled: boolean;
    interval: number;
    fuseThreshold: number;
    fuseWebhook: string;
    lastCheck?: number;
    [flag: string]: unknown;
}

/** cron 间隔与熔断阈值的允许范围 */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 1440;

/**
 * 规范化自动更新配置。数值字段强制转为数字并夹到合法区间，
 * webhook 必须是 https URL，模板开关只保留已知模板对应的键。
 */
export function normalizeAutoConfig(input: unknown): { ok: true; value: NormalizedAutoConfig } | { ok: false; response: Response } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, response: jsonError('配置必须是 JSON 对象', 400, 'VALIDATION_ERROR') };
    }
    const src = input as Record<string, unknown>;

    const interval = Number(src.interval);
    if (src.interval !== undefined && src.interval !== '' && (!Number.isFinite(interval) || interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES)) {
        return { ok: false, response: jsonError('检查间隔必须是 ' + MIN_INTERVAL_MINUTES + '-' + MAX_INTERVAL_MINUTES + ' 之间的分钟数', 400, 'VALIDATION_ERROR') };
    }
    const fuse = Number(src.fuseThreshold);
    if (src.fuseThreshold !== undefined && src.fuseThreshold !== '' && (!Number.isFinite(fuse) || fuse < 0 || fuse > 100)) {
        return { ok: false, response: jsonError('熔断阈值必须是 0-100 之间的百分比（0 = 关闭）', 400, 'VALIDATION_ERROR') };
    }
    const webhook = typeof src.fuseWebhook === 'string' ? src.fuseWebhook.trim() : '';
    if (webhook) {
        let parsed: URL;
        try { parsed = new URL(webhook); }
        catch { return { ok: false, response: jsonError('熔断 Webhook 不是合法 URL', 400, 'VALIDATION_ERROR') }; }
        if (parsed.protocol !== 'https:') {
            return { ok: false, response: jsonError('熔断 Webhook 必须使用 https', 400, 'VALIDATION_ERROR') };
        }
    }

    const value: NormalizedAutoConfig = {
        enabled: !!src.enabled,
        interval: Number.isFinite(interval) && interval >= MIN_INTERVAL_MINUTES ? Math.floor(interval) : 30,
        fuseThreshold: Number.isFinite(fuse) && fuse > 0 ? Math.floor(fuse) : 0,
        fuseWebhook: webhook
    };
    // 保留 cron 写入的 lastCheck，避免前端保存配置时把它清零导致立即重复触发
    if (typeof src.lastCheck === 'number' && Number.isFinite(src.lastCheck)) value.lastCheck = src.lastCheck;
    // 只接受已知模板对应的开关键（autoCmliu / autoJoey / autoEch ...）
    for (const t of Object.keys(TEMPLATES)) {
        const flag = autoFlagKey(t);
        if (flag in src) value[flag] = src[flag] !== false;
    }
    return { ok: true, value };
}
