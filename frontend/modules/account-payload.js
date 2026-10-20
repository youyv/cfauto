/**
 * 账号配置保存载荷（纯逻辑，供 frontend/js/accounts.js 兼容层调用）。
 *
 * `stats` 是运行期展示数据：`/api/stats` 返回的对象带 `accountId`/`alias` 等字段，
 * 它不属于账号权威配置。权威侧对账号配置里的 `stats` 只接受少量历史展示字段
 * （total/max/error/alias），把读取到的统计对象原样回传会触发 400 INVALID。
 *
 * 因此保存/删除账号时：只保留账号配置允许的历史统计字段；统计对象不完整
 * （缺数字 total/max）时直接不带 stats，交给读取侧兜底。不修改入参。
 */
const STATS_FIELDS = ['total', 'max', 'error', 'alias'];
export function accountSavePayload(accounts) {
    if (!Array.isArray(accounts)) return accounts;
    return accounts.map(account => {
        if (!account || typeof account !== 'object' || Array.isArray(account)) return account;
        const { stats, ...rest } = account;
        if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return rest;
        if (typeof stats.total !== 'number' || typeof stats.max !== 'number') return rest;
        const value = {};
        for (const key of STATS_FIELDS) if (stats[key] !== undefined) value[key] = stats[key];
        return { ...rest, stats: value };
    });
}
