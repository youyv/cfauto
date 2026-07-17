import type { KVNamespace } from "../config/env";
import { logger } from './logger';
/**
 * KV utility - eliminate JSON.parse boilerplate
 */

export async function getJSON<T = any>(kv: KVNamespace, key: string, fallback: T, cacheTtl?: number): Promise<T> {
  const raw = await kv.get(key, cacheTtl ? {cacheTtl} : undefined);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch (e) { logger.error('JSON.parse failed', e instanceof Error ? e : new Error(String(e)), { module: 'kv-utils', key }); return fallback; }
}

export async function putJSON<T = any>(kv: KVNamespace, key: string, value: T): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}