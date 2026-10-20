import { executionJournal } from '../reliability/execution-context';
/**
 * 并发工具 — 统一全项目的批量请求并发策略
 *
 * 控制单次批量操作的在飞任务数，兼顾吞吐与连接/内存占用。
 * 不减少总请求数，不是跨请求限流器，也不绕过当前计划的 subrequest/CPU 配额。
 * 同一请求中的独立池、不同请求与 Cron 的并发仍会叠加；协调与任务拆分另行处理。
 */

/** 默认并发度 — 兼顾吞吐与 CF 限流余量 */
export const DEFAULT_CONCURRENCY = 5;

/**
 * 有界并发 map — 保持输入顺序，任一任务抛错都会向外传播（调用方需自行包裹 try/catch）。
 * @param items 待处理项
 * @param worker 处理函数，接收 (item, index)
 * @param concurrency 同时在飞的任务数（有限值 <=0 视为 1，非有限值回退默认值）
 */
export async function pooledMap<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    concurrency = DEFAULT_CONCURRENCY
): Promise<R[]> {
    const limit = executionJournal() ? 1 : (Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : DEFAULT_CONCURRENCY);
    const results = new Array<R>(items.length);
    let cursor = 0;

    async function runner(): Promise<void> {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }

    const runners: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runner());
    await Promise.all(runners);
    return results;
}

/**
 * 有界并发 map（不抛错版）— 单项失败落为 { ok: false, error }，其余继续。
 * 语义等价于 `Promise.allSettled` 但带并发上限。
 */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: Error };

export async function pooledMapSettled<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    concurrency = DEFAULT_CONCURRENCY
): Promise<Array<Settled<R>>> {
    return pooledMap(items, async (item, index) => {
        try {
            return { ok: true as const, value: await worker(item, index) };
        } catch (e) {
            return { ok: false as const, error: e instanceof Error ? e : new Error(String(e)) };
        }
    }, concurrency);
}
