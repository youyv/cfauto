/**
 * 并发工具 — 统一全项目的批量请求并发策略
 *
 * 背景：Cloudflare API 限流 1200 次/5 分钟，单次 Worker 调用还有 1000 subrequest 上限。
 * 此前项目里存在两个极端：账号遍历全串行（账号多必然超时），批量部署 Promise.all 全并发
 * （容易触发限流）。此模块提供有界并发，三处调用点统一使用。
 */

/** 默认并发度 — 兼顾吞吐与 CF 限流余量 */
export const DEFAULT_CONCURRENCY = 5;

/**
 * 有界并发 map — 保持输入顺序，任一任务抛错都会向外传播（调用方需自行包裹 try/catch）。
 * @param items 待处理项
 * @param worker 处理函数，接收 (item, index)
 * @param concurrency 同时在飞的任务数（<=0 视为 1）
 */
export async function pooledMap<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
    concurrency = DEFAULT_CONCURRENCY
): Promise<R[]> {
    const limit = Math.max(1, Math.floor(concurrency));
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
