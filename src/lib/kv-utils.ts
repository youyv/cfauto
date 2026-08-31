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

/**
 * 列举某前缀下的全部键（自动翻页）。
 *
 * `kv.list()` 单次最多返回 1000 个键，`list_complete: false` 时必须带 cursor 继续拉。
 * 备份与 KV 回收都依赖完整清单：只读第一页会让第 1001 个键之后既备份不到、也回收不掉。
 * `maxPages` 是失控保护（默认 20 页 ≈ 2 万个键），达到上限时返回 complete: false。
 */
export async function listAllKeys(
  kv: KVNamespace, prefix: string, maxPages = 20
): Promise<{ names: string[]; complete: boolean }> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await kv.list(cursor ? { prefix, cursor } : { prefix });
    for (const k of res.keys || []) names.push(k.name);
    // list_complete 缺省（如简化的 mock）视为已完成，避免无限循环
    if (res.list_complete !== false || !res.cursor) return { names, complete: true };
    cursor = res.cursor;
  }
  logger.warn('listAllKeys: 达到翻页上限，结果可能不完整', { module: 'kv-utils', prefix, maxPages, found: names.length });
  return { names, complete: false };
}