/**
 * CRUD 路由 — 数据备份 / 恢复 / 账号导入导出
 *
 * 从 crud.ts 拆分而来：备份恢复与账号迁移是一组独立的、以「文件」为中心的操作，
 * 与逐键读写的 CRUD 没有共享逻辑，混在一个 400 行的文件里难以维护。
 */

import { KV_KEYS, isAccountVarsKey } from '../config/templates';
import { json, jsonError, safeJson } from '../lib/cloudflare-api';
import { listAllKeys } from "../lib/kv-utils";
import { readAccounts, writeAccounts, SECRET_FIELDS } from "../lib/account-store";
import { decryptKey, secretFingerprint } from "../lib/crypto-utils";
import { validateAccountsPayload, MAX_ACCOUNTS } from '../lib/validate';
import { logger } from '../lib/logger';
import type { RouteRegistrar } from "./register";
import type { AccountEntry } from '../lib/types';
import { backupKeys, backupMetadata, readBackupBody, preflightBackup, SNAPSHOT_PREFIX, SNAPSHOT_TTL, SNAPSHOT_ID_RE } from '../lib/backup-policy';
export { backupKeys, isRestorableKey } from '../lib/backup-policy';

export function registerBackupRoutes(ROUTES: { set: RouteRegistrar }) {

// --- 账号导入导出 ---
/**
 * 导出账号：密文原样导出，并附带密钥指纹。
 * 指纹让「导入到另一个实例后解密全失败」在导入前就能被诊断出来，
 * 而不是等到每个账号 globalKey 被清空后才提示。
 */
ROUTES.set('GET /api/accounts/export', async (_req, env) => {
    const data = await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS) || '[]';
    let accounts: unknown;
    try { accounts = JSON.parse(data); } catch { accounts = []; }
    const payload = {
        _format: 'worker-pro-accounts@2',
        _time: new Date().toISOString(),
        _encryptionFingerprint: await secretFingerprint(env).catch(() => null),
        accounts
    };
    return new Response(JSON.stringify(payload, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="accounts-export.json"' }
    });
});

ROUTES.set('POST /api/accounts/import', async (req, env) => {
    try {
        const body = await safeJson<unknown>(req);
        // 兼容两种格式：v2 包裹对象 {accounts: [...]} 与旧版裸数组
        let imported: Array<Record<string, any>>;
        let importedFingerprint: string | null = null;
        if (Array.isArray(body)) {
            imported = body;
        } else if (body && typeof body === 'object' && Array.isArray((body as any).accounts)) {
            imported = (body as any).accounts;
            importedFingerprint = (body as any)._encryptionFingerprint || null;
        } else {
            return jsonError('格式错误：需要 JSON 数组或含 accounts 字段的导出文件', 400, 'VALIDATION_ERROR');
        }
        if (imported.length > MAX_ACCOUNTS) return jsonError('导入账号数量超限（最多 ' + MAX_ACCOUNTS + ' 个）', 400, 'VALIDATION_ERROR');

        // 指纹不匹配时提前告知：所有密文都将无法解密
        const localFingerprint = await secretFingerprint(env).catch(() => null);
        const fingerprintMismatch = !!(importedFingerprint && localFingerprint && importedFingerprint !== localFingerprint);

        const existing = await readAccounts(env);
        const merged: AccountEntry[] = [...existing];
        let added = 0, skipped = 0;
        const importedIdx: number[] = [];
        for (const item of imported) {
            if (!item || !item.alias || !item.accountId) { skipped++; continue; }
            const dupIdx = merged.findIndex((a) => a.alias === item.alias || a.accountId === item.accountId);
            if (dupIdx >= 0) { merged[dupIdx] = { ...merged[dupIdx], ...item }; importedIdx.push(dupIdx); skipped++; }
            else { merged.push(item as AccountEntry); importedIdx.push(merged.length - 1); added++; }
        }
        // 仅解密来自 import 的条目（export 数据已加密），避免对已解密的存量条目重复解密；
        // 只处理带 v1: 前缀的密文，跳过已解密的存量明文（避免无效 atob + warn）。
        // 字段清单来自 account-store 的 SECRET_FIELDS，避免两处各维护一份。
        const decryptFailed = new Set<string>();
        await Promise.all(importedIdx.map(async (i) => {
            // 所有秘密字段都是加密存储的密文，逐个字段处理
            for (const field of SECRET_FIELDS) {
                const raw = merged[i][field];
                if (!raw || !/^v\d+:/.test(raw)) continue;
                const dec = await decryptKey(env, raw);
                if (dec === raw) {
                    // 解密失败（密钥不匹配/数据损坏）→ 置空并提示，防止 writeAccounts 再次加密导致双重加密
                    merged[i][field] = '';
                    decryptFailed.add(merged[i].alias || merged[i].accountId);
                } else {
                    merged[i][field] = dec;
                }
            }
        }));
        const decryptFailedList = Array.from(decryptFailed);
        // 复用统一校验（唯一性 / accountId 格式 / workers_* 结构）
        const validated = validateAccountsPayload(merged);
        if (!validated.ok) return validated.response;
        await writeAccounts(env, merged);
        logger.audit('accounts imported', { added, skipped, total: merged.length, decryptFailed: decryptFailedList.length });
        const warnings: string[] = [];
        if (fingerprintMismatch) {
            warnings.push('导出文件来自不同的加密密钥（指纹 ' + importedFingerprint + ' ≠ 本实例 ' + localFingerprint + '），密文无法解密');
        }
        if (decryptFailedList.length > 0) {
            warnings.push('以下账号密钥解密失败，已清空需重新输入: ' + decryptFailedList.join(', '));
        }
        return json({
            success: true, added,
            skipped: skipped + decryptFailedList.length,
            total: merged.length,
            ...(warnings.length > 0 ? { warning: warnings.join('；') } : {})
        });
    } catch (e: any) {
        if (e instanceof Response) return e;
        logger.error('accounts/import failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud-backup' });
        return jsonError('导入失败：数据格式异常');
    }
});

// --- 数据备份恢复 ---
ROUTES.set('GET /api/backup', async (_req, env) => {
    const keys = backupKeys();
    const backup: Record<string, any> = await backupMetadata(env);
    for (const k of keys) {
        // 备份保留原始格式：JSON 解析失败时回退到原始字符串（不用 getJSON 是因为需要保留损坏数据）
        const raw = await env.CONFIG_KV.get(k);
        try { backup[k] = JSON.parse(raw || 'null'); }
        catch (e) {
            // 非 JSON 值（历史遗留明文）原样备份，并记录以便排查
            backup[k] = raw;
            logger.warn('backup: KV 值非 JSON，按原始字符串备份', { key: k });
        }
    }
    // 账号级变量覆盖（VARS_<type>_ACC_<id>）数量不定，用 list 枚举。
    // 必须翻页：kv.list 单次最多返回 1000 个键，只读第一页会让第 1001 个键之后
    // 悄悄漏出备份 —— 恢复时用户不会得到任何提示。
    try {
        const { names, complete } = await listAllKeys(env.CONFIG_KV, 'VARS_');
        for (const name of names) {
            if (!isAccountVarsKey(name)) continue;
            const raw = await env.CONFIG_KV.get(name);
            try { backup[name] = JSON.parse(raw || 'null'); } catch { backup[name] = raw; }
        }
        if (!complete) backup._warning = '账号级变量键过多，备份可能不完整（已达 list 翻页上限）';
    } catch { backup._warning = '账号级变量枚举失败，备份不完整，请重试'; logger.warn('backup: 账号级变量枚举失败'); }

    return new Response(JSON.stringify(backup, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="worker-backup.json"', 'Cache-Control': 'no-store' }
    });
});

/** Read-only preview. The execution route repeats the same validation; a preview is not a lock. */
ROUTES.set('POST /api/restore/preview', async (req, env) => {
    const { preview } = await preflightBackup(await readBackupBody(req), env);
    return json({ success: preview.valid, preview, msg: preview.errors.join('；') }, { status: preview.valid ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
});

ROUTES.set('GET /api/restore/snapshot', async (req, env) => {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!SNAPSHOT_ID_RE.test(id)) return jsonError('快照 ID 无效', 400, 'VALIDATION_ERROR');
    const raw = await env.CONFIG_KV.get(SNAPSHOT_PREFIX + id);
    if (!raw) return jsonError('快照尚未可见、未生成或已过期；KV 存在传播延迟，请稍后重试', 404, 'VALIDATION_ERROR');
    return new Response(raw, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="restore-snapshot-' + id + '.json"' } });
});

ROUTES.set('POST /api/restore', async (req, env) => {
    const { preview, entries } = await preflightBackup(await readBackupBody(req), env);
    if (!preview.valid) return json({ success: false, restored: 0, rejected: preview.counts.unsupported,
        preview, msg: preview.errors.join('；') }, 400);
    if (!entries.length) return json({ success: true, restored: 0, results: [], preview });
    // The UI generates a fresh UUID per attempt, so it can retrieve the snapshot even if the response is lost.
    const snapshotId = req.headers.get('X-Restore-Snapshot-ID') || crypto.randomUUID();
    if (!SNAPSHOT_ID_RE.test(snapshotId)) return jsonError('快照 ID 无效', 400, 'VALIDATION_ERROR');
    // Collision protection only, NOT a KV mutex or an idempotency guarantee.
    if (await env.CONFIG_KV.get(SNAPSHOT_PREFIX + snapshotId)) return jsonError('快照 ID 已使用，请重新预检后再试', 409, 'VALIDATION_ERROR');
    const snapshot = JSON.stringify({ _format: 'worker-pro-recovery@1', ...(await backupMetadata(env)), snapshotId,
        expiresAt: new Date(Date.now() + SNAPSHOT_TTL * 1000).toISOString(),
        instruction: '维护快照，不是普通备份。put 保存旧值原始字节文本；delete 为原先不存在的键。暂停自动任务/其他写入并核对逐项结果后，在受控维护中恢复，不要直接导入。',
        put: entries.filter(e => e.before !== null).map(e => ({ key: e.key, value: e.before })),
        delete: entries.filter(e => e.before === null).map(e => e.key) });
    if (new TextEncoder().encode(snapshot).byteLength > 10 * 1024 * 1024) return jsonError('恢复前快照超过 10 MiB，请按键拆分；尚未写入', 413, 'VALIDATION_ERROR');
    try { await env.CONFIG_KV.put(SNAPSHOT_PREFIX + snapshotId, snapshot, { expirationTtl: SNAPSHOT_TTL }); }
    catch { return jsonError('无法保存恢复前快照，未写入任何配置', 503); }
    const results: Array<{ key: string; status: 'written' | 'unknown' | 'notAttempted' }> = [];
    let stopped = false;
    for (const e of entries) {
        if (stopped) { results.push({ key: e.key, status: 'notAttempted' }); continue; }
        try { await env.CONFIG_KV.put(e.key, e.raw); results.push({ key: e.key, status: 'written' }); }
        catch { stopped = true; results.push({ key: e.key, status: 'unknown' }); }
    }
    const restored = results.filter(r => r.status === 'written').length;
    logger.audit('data restore attempted', { snapshotId, restored, stopped, total: entries.length });
    return json({ success: !stopped, restored, rejected: 0, snapshotId, results,
        msg: stopped ? '写入异常，已停止后续项；异常键可能已写入，请核对后恢复，勿直接重试整批' : '恢复完成',
        warning: 'KV 不是事务；并发写入未隔离。快照保留 7 天，建议立即下载；不会自动回滚。' },
        { status: stopped ? 207 : 200, headers: { 'Cache-Control': 'no-store' } });
});

}
