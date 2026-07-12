/**
 * 统一账号存储层 — 透明加解密 globalKey
 * 
 * 所有对 ACCOUNTS KV 的读写都通过此模块，业务代码无需手动调用 decryptKey/encryptKey。
 * 读 = 自动解密(30s KV缓存)，写 = 自动加密，杜绝遗漏。
 *
 * ⚠️ 并发安全: Cloudflare KV 是最终一致性存储。当前读→改→写模式在并发场景下可能
 *    丢失写入（后写覆盖先写）。由于 Worker 中控是单用户管理面板，并发写入概率极低，
 *    暂不引入乐观锁（需额外 KV 键存储版本号）。多用户场景需升级方案。
 */
import { KV_KEYS } from '../config/templates';
import { decryptKey, encryptKey } from './crypto-utils';
import { getJSON, putJSON } from './kv-utils';
import { logger } from './logger';
import type { AccountEntry } from './types';
import type { AppEnv } from '../config/env';

/** 读取账号列表（自动解密 globalKey） */
export async function readAccounts(env: AppEnv): Promise<AccountEntry[]> {
    const accounts = await getJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);
    await Promise.all(accounts.map(async (a) => {
        if (a.globalKey) {
            const decrypted = await decryptKey(env, a.globalKey);
            // 解密失败（密钥变更）时返回空字符串，避免密文被当作 API Key 使用
            if (decrypted === a.globalKey && a.globalKey.startsWith('v')) {
                logger.warn('readAccounts: decryptKey returned raw ciphertext, clearing', { alias: a.alias });
                a.globalKey = '';
            } else {
                a.globalKey = decrypted;
            }
        }
    }));
    return accounts;
}

/** 读取账号列表（脱敏 globalKey，安全返回给前端） */
export async function readAccountsMasked(env: AppEnv): Promise<AccountEntry[]> {
    const accounts = await readAccounts(env);
    return accounts.map(a => ({
        ...a,
        globalKey: maskKey(a.globalKey)
    }));
}

/** 脱敏 API Key：保留前 6 后 4 字符 */
function maskKey(key: string): string {
    if (!key || key.length <= 10) return key ? '***' : '';
    return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}

/** 写入账号列表（自动加密 globalKey） */
export async function writeAccounts(env: AppEnv, accounts: AccountEntry[]): Promise<void> {
    // 克隆数组避免原地修改调用者持有的引用
    const cloned = accounts.map(a => ({ ...a }));
    await Promise.all(cloned.map(async (a) => {
        if (a.globalKey) a.globalKey = await encryptKey(env, a.globalKey);
    }));
    await putJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, cloned);
}

/** 类型安全地从 AccountEntry 获取对应模板的 Worker 列表 */
export function getWorkerNames(a: AccountEntry, type: string): string[] {
    switch (type) {
        case 'cmliu': return a.workers_cmliu || [];
        case 'joey': return a.workers_joey || [];
        case 'ech': return a.workers_ech || [];
        default: return [];
    }
}

/** 根据 accountId 查找单个账号（自动解密） */
export async function findAccount(env: AppEnv, accountId: string): Promise<AccountEntry | undefined> {
    const accounts = await readAccounts(env);
    return accounts.find((a) => a.accountId === accountId);
}
