/**
 * KV 回收 — 清理孤儿键与超期日志，防止 KV 无界增长。
 *
 * 背景：本项目写入 KV 的键分三类，此前只有第一类有回收机制：
 *  1. 带 TTL 的临时键（`SESSION_*`、`RATE_LIMIT_*`）—— Cloudflare 自动过期，无需处理。
 *  2. 长期配置键（`ACCOUNTS_UNIFIED_STORAGE`、`VARS_<type>`、`DEPLOY_CONFIG_<type>` …）
 *     —— 数量固定，随模板数量变化，不会增长。
 *  3. **无界或会变孤儿的键**：
 *     - `DEPLOY_JOURNAL` 只截断条数（100 条），但每条 summary 可达 500 字符、
 *       failed 数组无上限，长期使用后单个值可涨到数百 KB，且没有按时间过期。
 *     - `VARS_<type>_ACC_<accountId>` 由熔断轮换写入。账号被删除、模板被移除、
 *       或从备份恢复了别的实例的键之后，这些键**永远没有任何代码路径会删掉它**，
 *       只能靠人工到 Dashboard 清理。
 *
 * 本模块负责第 3 类：
 *  - `pruneJournal` 按条数 + 保留天数双重裁剪，并压缩单条体积。
 *  - `collectOrphanKeys` / `runKvGc` 用 list 翻页枚举 `VARS_` 前缀，删除
 *    「模板类型未知」或「accountId 已不在账号表里」的键。
 *
 * 安全约束：只删可推导为孤儿的键，**绝不按前缀批量删**。账号表读取失败时直接放弃
 * 本轮回收（宁可留垃圾，也不能因为一次 KV 读失败把所有账号级覆盖删光）。
 */

import { KV_KEYS, TEMPLATES, parseAccountVarsKey } from '../config/templates';
import { getJSON, putJSON, listAllKeys } from './kv-utils';
import { logger } from './logger';
import type { JournalEntry } from './types';
import type { AppEnv, KVNamespace } from '../config/env';

// ===== 部署日志裁剪参数 =====

/** journal 最多保留的条数（与 finalizeDeploy 的写入侧一致） */
export const JOURNAL_MAX_ENTRIES = 100;
/** journal 条目的保留天数：更早的记录对排障已无价值 */
export const JOURNAL_RETENTION_DAYS = 30;
/** 单条 summary 的长度上限 */
export const JOURNAL_SUMMARY_MAX = 500;
/** 单条 failed 数组的元素上限（超出记为 "+N more"） */
export const JOURNAL_FAILED_MAX = 20;

/** GC 的最小间隔：24 小时。cron 每 5 分钟触发一次，不能每轮都扫 KV */
export const GC_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * 裁剪部署日志：按时间过期 → 按条数截断 → 压缩单条体积。纯函数，供测试直接覆盖。
 *
 * 时间解析失败的条目**保留**（宁可多留一条，也不要因为脏数据把历史删掉），
 * 但仍受条数上限约束。
 */
export function pruneJournal(
    entries: JournalEntry[], now = Date.now(), retentionDays = JOURNAL_RETENTION_DAYS
): { kept: JournalEntry[]; removed: number; trimmed: number } {
    if (!Array.isArray(entries)) return { kept: [], removed: 0, trimmed: 0 };
    const cutoff = now - retentionDays * 24 * 3600 * 1000;

    const fresh = entries.filter(e => {
        if (!e || typeof e !== 'object') return false;
        const t = Date.parse(e.time);
        if (!Number.isFinite(t)) return true;   // 时间不可解析 → 保留
        return t >= cutoff;
    });

    const capped = fresh.slice(0, JOURNAL_MAX_ENTRIES);

    let trimmed = 0;
    const kept = capped.map(e => {
        let changed = false;
        const out: JournalEntry = { ...e };
        if (typeof out.summary === 'string' && out.summary.length > JOURNAL_SUMMARY_MAX) {
            out.summary = out.summary.substring(0, JOURNAL_SUMMARY_MAX);
            changed = true;
        }
        if (Array.isArray(out.failed) && out.failed.length > JOURNAL_FAILED_MAX) {
            const extra = out.failed.length - JOURNAL_FAILED_MAX;
            out.failed = [...out.failed.slice(0, JOURNAL_FAILED_MAX), '+' + extra + ' more'];
            changed = true;
        }
        if (changed) trimmed++;
        return out;
    });

    return { kept, removed: entries.length - kept.length, trimmed };
}

/**
 * 从 `VARS_` 前缀的键名清单里挑出孤儿键。纯函数，供测试直接覆盖。
 *
 * 判定为孤儿的两种情形：
 *  - 键名不是合法的 `VARS_<已知模板>_ACC_<accountId>`（模板被删、或从别处恢复的脏键）；
 *  - accountId 不在当前账号表中（账号已删除）。
 *
 * `VARS_<type>` 这种模板级全局变量键**不是**孤儿，必须排除。
 */
export function collectOrphanKeys(keyNames: string[], liveAccountIds: Set<string>): string[] {
    const templateVarsKeys = new Set(Object.keys(TEMPLATES).map(t => KV_KEYS.vars(t)));
    const orphans: string[] = [];
    for (const name of keyNames) {
        if (templateVarsKeys.has(name)) continue;         // 模板级全局变量，保留
        const parsed = parseAccountVarsKey(name);
        if (!parsed) { orphans.push(name); continue; }    // 模板未知 / 键名畸形
        if (!liveAccountIds.has(parsed.accountId)) orphans.push(name);
    }
    return orphans;
}

/**
 * 读取当前存活的 accountId 集合，用于孤儿判定。
 *
 * 返回 null 表示**结果不可信**，调用方必须放弃本轮回收。这一层刻意不复用
 * `readAccounts`：那里的 `getJSON` 在 JSON 损坏时会静默回落到 `[]`，而空集合会让
 * `collectOrphanKeys` 把所有账号级覆盖判成孤儿 —— 一次 KV 值损坏就会删光熔断状态。
 * 这里直接读原始值并严格校验：键不存在 = 确实没有账号（可信的空集合），
 * 键存在但不是数组 = 不可信。
 */
export async function readLiveAccountIds(kv: KVNamespace): Promise<Set<string> | null> {
    let raw: string | null;
    try {
        raw = await kv.get(KV_KEYS.ACCOUNTS);
    } catch (e) {
        logger.warn('kv-gc: 账号表读取失败', { module: 'kv-gc', error: (e as Error).message });
        return null;
    }
    if (raw === null) return new Set();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (e) {
        logger.warn('kv-gc: 账号表 JSON 损坏，放弃本轮回收', { module: 'kv-gc', error: (e as Error).message });
        return null;
    }
    if (!Array.isArray(parsed)) {
        logger.warn('kv-gc: 账号表不是数组，放弃本轮回收', { module: 'kv-gc' });
        return null;
    }
    const ids = new Set<string>();
    for (const a of parsed) {
        if (a && typeof a === 'object' && typeof (a as { accountId?: unknown }).accountId === 'string') {
            ids.add((a as { accountId: string }).accountId);
        }
    }
    return ids;
}

/** 回收结果 */
export interface KvGcResult {
    journalRemoved: number;
    journalTrimmed: number;
    orphansDeleted: number;
    orphanKeys: string[];
    /** list 未翻完（达到页数上限）时为 false，说明还有键未被检查 */
    listComplete: boolean;
    skipped?: string;
}

/**
 * 执行一次 KV 回收。
 *
 * @param accountIds 当前存活的 accountId 集合。**必须由调用方提供**：本模块不自己读
 *        账号表，避免「读失败 → 空集合 → 删光所有账号级覆盖」这条灾难路径。
 */
export async function runKvGc(env: AppEnv, accountIds: Set<string>): Promise<KvGcResult> {
    const result: KvGcResult = {
        journalRemoved: 0, journalTrimmed: 0,
        orphansDeleted: 0, orphanKeys: [], listComplete: true
    };

    // ===== 1. 裁剪部署日志 =====
    try {
        const journal = await getJSON<JournalEntry[]>(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, []);
        const { kept, removed, trimmed } = pruneJournal(journal);
        if (removed > 0 || trimmed > 0) {
            await putJSON(env.CONFIG_KV, KV_KEYS.DEPLOY_JOURNAL, kept);
            result.journalRemoved = removed;
            result.journalTrimmed = trimmed;
        }
    } catch (e) {
        logger.warn('kv-gc: journal 裁剪失败', { module: 'kv-gc', error: (e as Error).message });
    }

    // ===== 2. 删除孤儿的账号级变量覆盖 =====
    try {
        const { names, complete } = await listAllKeys(env.CONFIG_KV, 'VARS_');
        result.listComplete = complete;
        const orphans = collectOrphanKeys(names, accountIds);
        for (const key of orphans) {
            try {
                await env.CONFIG_KV.delete(key);
                result.orphansDeleted++;
                if (result.orphanKeys.length < 20) result.orphanKeys.push(key);
            } catch (e) {
                logger.warn('kv-gc: 孤儿键删除失败', { module: 'kv-gc', key, error: (e as Error).message });
            }
        }
    } catch (e) {
        logger.warn('kv-gc: 孤儿键枚举失败', { module: 'kv-gc', error: (e as Error).message });
    }

    if (result.journalRemoved > 0 || result.journalTrimmed > 0 || result.orphansDeleted > 0) {
        logger.audit('kv gc', {
            journalRemoved: result.journalRemoved,
            journalTrimmed: result.journalTrimmed,
            orphansDeleted: result.orphansDeleted,
            listComplete: result.listComplete
        });
    }
    return result;
}

/**
 * 删除某账号在所有模板下的账号级变量覆盖 —— 账号被删除时立即调用。
 *
 * 与 runKvGc 的分工：这里是**确定性的即时清理**（删一个账号最多 N 个键，N = 模板数），
 * runKvGc 是**兜底扫描**（覆盖恢复备份、模板下线等 immediate 路径管不到的情形）。
 */
export async function deleteAccountVarsFor(kv: KVNamespace, accountIds: string[]): Promise<number> {
    let deleted = 0;
    for (const accountId of accountIds) {
        for (const type of Object.keys(TEMPLATES)) {
            const key = KV_KEYS.accountVars(type, accountId);
            try {
                await kv.delete(key);
                deleted++;
            } catch (e) {
                logger.warn('deleteAccountVarsFor: 删除失败', { module: 'kv-gc', key, error: (e as Error).message });
            }
        }
    }
    return deleted;
}
