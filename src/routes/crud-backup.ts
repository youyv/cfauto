/**
 * CRUD 路由 — 数据备份 / 恢复 / 账号导入导出
 *
 * 从 crud.ts 拆分而来：备份恢复与账号迁移是一组独立的、以「文件」为中心的操作，
 * 与逐键读写的 CRUD 没有共享逻辑，混在一个 400 行的文件里难以维护。
 */

import { KV_KEYS, TEMPLATES, isAccountVarsKey } from '../config/templates';
import { json, jsonError, safeJson } from '../lib/cloudflare-api';
import { listAllKeys } from "../lib/kv-utils";
import { readAccounts, writeAccounts } from "../lib/account-store";
import { decryptKey, secretFingerprint } from "../lib/crypto-utils";
import { validateAccountsPayload, MAX_ACCOUNTS } from '../lib/validate';
import { logger } from '../lib/logger';
import type { RouteRegistrar } from "./register";
import type { AccountEntry } from '../lib/types';

/** 备份/恢复覆盖的 KV 键（模板无关的固定键 + 每模板三键） */
export function backupKeys(): string[] {
    const templateTypes = Object.keys(TEMPLATES);
    return [
        KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG, KV_KEYS.DEPLOY_JOURNAL,
        ...templateTypes.flatMap(t => [KV_KEYS.vars(t), KV_KEYS.deployConfig(t), KV_KEYS.favorites(t)])
    ];
}

/**
 * 恢复白名单判定：精确匹配固定键 / 已知模板键 / 合法的账号级变量键。
 *
 * 必须精确匹配而非 startsWith —— 前缀匹配会放行 `VARS_cmliuX`、
 * `ACCOUNTS_UNIFIED_STORAGE_EVIL` 等注入键。导出供单元测试直接覆盖。
 */
export function isRestorableKey(k: string): boolean {
    if (!k || k.startsWith('_')) return false;
    if (backupKeys().includes(k)) return true;
    return isAccountVarsKey(k);
}

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
        // 仅解密来自 import 的条目（export 数据已加密），避免对已解密的存量条目重复解密
        // 仅解密带 v1: 前缀的已加密值，跳过已解密的存量明文（避免无效 atob + warn）
        const decryptFailed: string[] = [];
        await Promise.all(importedIdx.map(async (i) => {
            const raw = merged[i].globalKey;
            if (raw && /^v\d+:/.test(raw)) {
                const dec = await decryptKey(env, raw);
                if (dec === raw) {
                    // 解密失败（密钥不匹配/数据损坏）→ 置空并提示，防止 writeAccounts 再次加密导致双重加密
                    merged[i].globalKey = '';
                    decryptFailed.push(merged[i].alias || merged[i].accountId);
                } else {
                    merged[i].globalKey = dec;
                }
            }
        }));
        // 复用统一校验（唯一性 / accountId 格式 / workers_* 结构）
        const validated = validateAccountsPayload(merged);
        if (!validated.ok) return validated.response;
        await writeAccounts(env, merged);
        logger.audit('accounts imported', { added, skipped, total: merged.length, decryptFailed: decryptFailed.length });
        const warnings: string[] = [];
        if (fingerprintMismatch) {
            warnings.push('导出文件来自不同的加密密钥（指纹 ' + importedFingerprint + ' ≠ 本实例 ' + localFingerprint + '），密文无法解密');
        }
        if (decryptFailed.length > 0) {
            warnings.push('以下账号密钥解密失败，已清空需重新输入: ' + decryptFailed.join(', '));
        }
        return json({
            success: true, added,
            skipped: skipped + decryptFailed.length,
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
    const backup: Record<string, any> = {
        _time: new Date().toISOString(),
        _encryptionFingerprint: await secretFingerprint(env).catch(() => null)
    };
    for (const k of keys) {
        // 备份保留原始格式：JSON 解析失败时回退到原始字符串（不用 getJSON 是因为需要保留损坏数据）
        const raw = await env.CONFIG_KV.get(k);
        try { backup[k] = JSON.parse(raw || 'null'); }
        catch (e) {
            // 非 JSON 值（历史遗留明文）原样备份，并记录以便排查
            backup[k] = raw;
            logger.warn('backup: KV 值非 JSON，按原始字符串备份', { key: k, error: (e as Error).message });
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
    } catch (e) { logger.warn('backup: 账号级变量枚举失败', { error: (e as Error).message }); }

    return new Response(JSON.stringify(backup, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="worker-backup.json"' }
    });
});

/** 恢复白名单判定：精确匹配固定键 / 已知模板键 / 合法的账号级变量键 */
ROUTES.set('POST /api/restore', async (req, env) => {
    try {
        const backup = await safeJson<Record<string, unknown>>(req);
        if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
            return jsonError('恢复失败：备份文件必须是 JSON 对象', 400, 'VALIDATION_ERROR');
        }
        let restored = 0, rejected = 0;
        const rejectedKeys: string[] = [];
        for (const [k, v] of Object.entries(backup)) {
            if (k.startsWith('_')) continue;
            if (!isRestorableKey(k)) {
                rejected++;
                if (rejectedKeys.length < 10) rejectedKeys.push(k);
                continue;
            }
            if (v === null || v === undefined) continue;
            await env.CONFIG_KV.put(k, typeof v === 'string' ? v : JSON.stringify(v));
            restored++;
        }
        logger.audit('data restored', { restored, rejected });
        const fp = (backup as any)._encryptionFingerprint;
        const localFp = await secretFingerprint(env).catch(() => null);
        const warning = fp && localFp && fp !== localFp
            ? '备份来自不同的加密密钥，恢复后账号 API Key 需重新填写'
            : undefined;
        return json({ success: true, restored, rejected, ...(rejectedKeys.length ? { rejectedKeys } : {}), ...(warning ? { warning } : {}) });
    } catch (e: any) {
        if (e instanceof Response) return e;
        logger.error('restore failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud-backup' });
        return jsonError('恢复失败：备份数据异常');
    }
});

}
