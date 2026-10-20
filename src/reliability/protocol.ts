/** Internal protocol only. No production route or KV cutover is enabled. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export class ReliabilityError extends Error {
    constructor(public readonly code: 'INVALID' | 'CONFLICT' | 'MAINTENANCE' | 'NOT_READY', public readonly status: number) { super(code); }
}
export function canonical(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) {
        // Holes are not JSON values; map() would silently erase them and create digest collisions.
        for (let i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(value, i)) throw new ReliabilityError('INVALID', 400);
        return '[' + value.map(canonical).join(',') + ']';
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
    }
    throw new ReliabilityError('INVALID', 400);
}
export function encoded(value: unknown): string {
    let result: string;
    try { result = canonical(value); } catch { throw new ReliabilityError('INVALID', 400); }
    if (new TextEncoder().encode(result).length > 131072) throw new ReliabilityError('INVALID', 400);
    return result;
}
export function domainName(value: string): void {
    if (typeof value !== 'string' || !/^(autoConfig|accounts|deployJournal|deploy:[a-z_]+|upstream:[a-z_]+|template:[a-z_]+|vars:[a-z_]+|override:[a-z_]+:[a-zA-Z0-9_-]+|account:[a-zA-Z0-9_-]+|favorites:[a-z_]+)$/.test(value)) throw new ReliabilityError('INVALID', 400);
}
export function revision(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new ReliabilityError('INVALID', 400);
}
export function identifier(value: string): void {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ReliabilityError('INVALID', 400);
}
export async function sha256(value: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export interface ConfigChange { domain: string; expectedRevision: number; value: Json }
export interface ConfigRecord { domain: string; revision: number; value: Json }
export async function manifestDigest(records: ConfigRecord[]): Promise<string> {
    return sha256(canonical([...records].sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0)));
}
