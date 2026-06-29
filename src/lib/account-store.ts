/**
 * 统一账号存储层 — 透明加解密 globalKey
 * 
 * 所有对 ACCOUNTS KV 的读写都通过此模块，业务代码无需手动调用 decryptKey/encryptKey。
 * 读 = 自动解密(30s KV缓存)，写 = 自动加密，杜绝遗漏。
 */
import { KV_KEYS } from '../config/templates';
import { decryptKey, encryptKey } from './crypto-utils';
import { getJSON, putJSON } from './kv-utils';
import type { AppEnv } from '../config/env';

/** 读取账号列表（自动解密 globalKey） */
export async function readAccounts(env: AppEnv): Promise<any[]> {
    const accounts = await getJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);
    await Promise.all(accounts.map(async (a: any) => {
        if (a.globalKey) a.globalKey = await decryptKey(env, a.globalKey);
    }));
    return accounts;
}

/** 写入账号列表（自动加密 globalKey） */
export async function writeAccounts(env: AppEnv, accounts: any[]): Promise<void> {
    // 克隆数组避免原地修改调用者持有的引用
    const cloned = accounts.map(a => ({ ...a }));
    await Promise.all(cloned.map(async (a: any) => {
        if (a.globalKey) a.globalKey = await encryptKey(env, a.globalKey);
    }));
    await putJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, cloned);
}

/** 根据 accountId 查找单个账号（自动解密） */
export async function findAccount(env: AppEnv, accountId: string): Promise<any | undefined> {
    const accounts = await readAccounts(env);
    return accounts.find((a: any) => a.accountId === accountId);
}
