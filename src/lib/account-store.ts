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
import { decryptKey, encryptKey, VERSION_PREFIX } from './crypto-utils';
import { getJSON, putJSON } from './kv-utils';
import { logger } from './logger';
import type { AccountEntry } from './types';
import type { AppEnv } from '../config/env';

/** 读取账号列表（自动解密 globalKey） */
export async function readAccounts(env: AppEnv): Promise<AccountEntry[]> {
    const accounts = await getJSON<AccountEntry[]>(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);
    await Promise.all(accounts.map(async (a) => {
        if (a.globalKey) {
            const decrypted = await decryptKey(env, a.globalKey);
            // 解密失败（密钥变更）时返回空字符串，避免密文被当作 API Key 使用
            if (decrypted === a.globalKey && a.globalKey.startsWith(VERSION_PREFIX)) {
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

/** 写入账号列表（自动加密 globalKey；空值/掩码值保留旧密文，防止覆盖真实凭证） */
export async function writeAccounts(env: AppEnv, accounts: AccountEntry[]): Promise<void> {
    // 读取现有密文列表，用于保留未修改（空/掩码）的 key
    const existing = await getJSON<AccountEntry[]>(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);
    // 克隆数组避免原地修改调用者持有的引用
    const cloned = accounts.map(a => ({ ...a }));
    await Promise.all(cloned.map(async (a) => {
        // 空 key 或掩码值（前端未修改 key）→ 保留 KV 中该账号的旧密文，绝不覆盖真实凭证
        if (a.globalKey && !isMaskedKey(a.globalKey)) {
            a.globalKey = await encryptKey(env, a.globalKey);
        } else {
            // 匹配旧密文：优先 accountId；编辑时若 accountId 被修改，用 alias+email 兜底，防止 key 丢失
            const old = existing.find(e => e.accountId === a.accountId)
                     || existing.find(e => e.alias === a.alias && e.email === a.email);
            a.globalKey = (old && old.globalKey) || '';
        }
    }));
    await putJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, cloned);
}

/** 判断是否为前端脱敏格式（前6...后4 或 ***），此类值不得作为新 key 加密入库 */
function isMaskedKey(key: string): boolean {
    return key.includes('...') || key === '***';
}

/** 从 AccountEntry 动态获取对应模板的 Worker 列表 — 模板驱动，无需硬编码 switch */
export function getWorkerNames(a: AccountEntry, type: string): string[] {
    return a[`workers_${type}`] || [];
}

/** 覆盖某模板的 Worker 列表（就地修改，供调用方随后整体 writeAccounts） */
export function setWorkerNames(a: AccountEntry, type: string, names: string[]): void {
    a[`workers_${type}`] = names;
}

/** 追加一个 Worker 名，已存在则不动。返回是否发生了修改 */
export function addWorkerName(a: AccountEntry, type: string, name: string): boolean {
    const list = getWorkerNames(a, type);
    if (list.includes(name)) return false;
    setWorkerNames(a, type, [...list, name]);
    return true;
}

/** 移除一个 Worker 名。返回是否发生了修改 */
export function removeWorkerName(a: AccountEntry, type: string, name: string): boolean {
    const list = getWorkerNames(a, type);
    if (!list.includes(name)) return false;
    setWorkerNames(a, type, list.filter(n => n !== name));
    return true;
}

/** 某模板在任一账号下是否还有已部署的 Worker */
export function hasAnyWorker(accounts: AccountEntry[], type: string): boolean {
    return accounts.some(a => getWorkerNames(a, type).length > 0);
}

/** 根据 accountId 查找单个账号（自动解密） */
export async function findAccount(env: AppEnv, accountId: string): Promise<AccountEntry | undefined> {
    const accounts = await readAccounts(env);
    return accounts.find((a) => a.accountId === accountId);
}
