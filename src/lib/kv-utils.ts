import type { KVNamespace } from "../config/env";
/**
 * KV utility - eliminate JSON.parse boilerplate
 */

export async function getJSON(kv: KVNamespace, key: string, fallback: any = null, cacheTtl?: number): Promise<any> {
  const raw = await kv.get(key, cacheTtl ? {cacheTtl} : undefined);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch (e) { console.error('[kv-utils] JSON.parse failed for key ' + key + ':', e); return fallback; }
}

export async function putJSON(kv: KVNamespace, key: string, value: any): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}