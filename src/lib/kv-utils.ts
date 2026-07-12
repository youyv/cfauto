import type { KVNamespace } from "../config/env";
/**
 * KV utility - eliminate JSON.parse boilerplate
 */

export async function getJSON<T = any>(kv: KVNamespace, key: string, fallback: T, cacheTtl?: number): Promise<T> {
  const raw = await kv.get(key, cacheTtl ? {cacheTtl} : undefined);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch (e) { console.error('[kv-utils] JSON.parse failed for key ' + key + ':', e); return fallback; }
}

export async function putJSON<T = any>(kv: KVNamespace, key: string, value: T): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}