// Diagnostic-only filtering. Never apply to active credentials or successful configuration payloads.
const SENSITIVE_FIELD = /(?:token|key|secret|password|authorization|cookie|code|webhook)$/i;
export function redactDiagnosticText(s: unknown): string {
    return String(s == null ? '' : s)
        // Quoted JSON/assignment values may contain spaces, escapes and short secrets.
        .replace(/((?:["'][\w-]*(?:token|key|secret|password|authorization|cookie|code|webhook)["']|\b[\w-]*(?:token|key|secret|password|authorization|cookie|code|webhook))\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1"***"')
        .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***')
        .replace(/(\b[\w-]*(?:token|key|secret|password|authorization|cookie|code|webhook)\s*[=:]\s*)[^\s,;"'&}]+/gi, '$1***')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
        .replace(/\b[0-9a-fA-F]{32}\b/g, '***')
        .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '***');
}
export function redactDiagnostic(value: unknown, ancestors = new Set<object>()): unknown {
    if (typeof value === 'string') return redactDiagnosticText(value);
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    const source = value as Record<string, unknown>;
    const secret = source.secret === true || source.type === 'secret_text';
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
    for (const key of Object.keys(source)) {
        (result as Record<string, unknown>)[key] = SENSITIVE_FIELD.test(key) || (secret && /^(value|text)$/i.test(key))
            ? '***' : redactDiagnostic(source[key], ancestors);
    }
    ancestors.delete(value);
    return result;
}
