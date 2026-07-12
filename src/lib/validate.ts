/**
 * 请求体校验 — 轻量 field 检查，无需三方依赖
 */

import { jsonError } from './cloudflare-api';
import { TEMPLATES } from '../config/templates';

/** 校验请求体必填字段，失败返回 400 错误响应 */
export function validateRequired(body: Record<string, unknown>, fields: string[]): Response | null {
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
        return jsonError('Template type is required', 400);
    }
    if (!TEMPLATES[type]) {
        return jsonError('Invalid template type: ' + type, 400);
    }
    return null;
}
