/**
 * 请求体校验 — 轻量 field 检查，无需三方依赖
 */

import { jsonError } from './cloudflare-api';

/** 校验请求体必填字段，失败返回 400 错误响应 */
export function validateRequired(body: Record<string, unknown>, fields: string[]): Response | null {
    const missing = fields.filter(f => !(f in body) || body[f] === undefined || body[f] === null);
    if (missing.length > 0) {
        return jsonError("Missing required fields: " + missing.join(", "), 400, 'VALIDATION_ERROR');
    }
    return null;
}

/** 校验非空字符串字段 */
export function validateNonEmpty(body: Record<string, unknown>, fields: string[]): Response | null {
    for (const f of fields) {
        if (typeof body[f] !== 'string' || (body[f] as string).trim() === "") {
            return jsonError(f + " cannot be empty", 400, 'VALIDATION_ERROR');
        }
    }
    return null;
}
