import { redactDiagnostic } from './redaction';
/**
 * 结构化日志 — JSON 格式化输出，便于 Cloudflare 日志搜索
 */

export const logger = {
    info(msg: string, meta?: Record<string, unknown>) {
        console.log(JSON.stringify(redactDiagnostic({ level: "info", msg, ...(meta || {}), ts: new Date().toISOString() })));
    },

    warn(msg: string, meta?: Record<string, unknown>) {
        console.warn(JSON.stringify(redactDiagnostic({ level: "warn", msg, ...(meta || {}), ts: new Date().toISOString() })));
    },

    error(msg: string, err?: Error, meta?: Record<string, unknown>) {
        console.error(JSON.stringify(redactDiagnostic({ level: "error", msg, error: err?.message, stack: err?.stack, ...(meta || {}), ts: new Date().toISOString() })));
    },

    // 业务审计日志（操作记录类）
    audit(action: string, meta?: Record<string, unknown>) {
        console.log(JSON.stringify(redactDiagnostic({ level: "audit", action, ...(meta || {}), ts: new Date().toISOString() })));
    },
};
