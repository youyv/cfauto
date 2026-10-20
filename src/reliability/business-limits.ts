import { canonical, ReliabilityError } from './protocol';

// Explicit byte budgets, not a platform capacity claim. Configuration CAS remains
// at 128 KiB; only authenticated business submission may carry custom script bytes.
export const MAX_BUSINESS_INTENT_BYTES = 2 * 1024 * 1024;
export const MAX_SUBMIT_RPC_BYTES = MAX_BUSINESS_INTENT_BYTES + 16384;
export function businessJson(value: unknown, limit = MAX_BUSINESS_INTENT_BYTES): string {
    let result: string;
    try { result = canonical(value); } catch { throw new ReliabilityError('INVALID',400); }
    if (new TextEncoder().encode(result).length > limit) throw new ReliabilityError('INVALID',400);
    return result;
}
