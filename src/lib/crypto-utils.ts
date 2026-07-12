/**
 * 加密工具 — 密钥版本化 + 独立加解密密钥支持
 * 
 * 派生优先级: ENCRYPTION_SECRET > ACCESS_CODE
 * 格式: v1:base64(iv+ciphertext+tag)   (80 bytes raw → 108 chars base64)
 * 存量数据(无 v1: 前缀): 按明文或旧 ACCESS_CODE 密钥尝试解密
 *
 * 密钥轮换: 设置 ENCRYPTION_SECRET 后改 ACCESS_CODE 不影响已加密数据
 */
import type { AppEnv } from '../config/env';
import { logger } from './logger';

const ALGORITHM = { name: 'AES-GCM', length: 256 };
const IV_LENGTH = 12;
const VERSION_PREFIX = 'v1:';

/** 获取派生密钥的源材料: ENCRYPTION_SECRET 优先, 否则 ACCESS_CODE */
function getSecret(env: AppEnv): string {
    const s = env.ENCRYPTION_SECRET || env.ACCESS_CODE;
    if (!s) throw new Error('ENCRYPTION_SECRET or ACCESS_CODE not configured');
    return s;
}

/** WeakMap 缓存：同一 env 实例在同一请求内复用 CryptoKey */
const keyCache = new WeakMap<AppEnv, Promise<CryptoKey>>();

async function deriveKey(env: AppEnv): Promise<CryptoKey> {
    if (keyCache.has(env)) return keyCache.get(env)!;
    const secret = getSecret(env);
    const p = crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
        .then(keyMaterial => crypto.subtle.importKey('raw', keyMaterial, ALGORITHM, false, ['encrypt', 'decrypt']));
    keyCache.set(env, p);
    return p;
}

/** 加密并添加 v1: 版本前缀 */
export async function encryptKey(env: AppEnv, plaintext: string): Promise<string> {
    if (!plaintext) return '';
    const key = await deriveKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return VERSION_PREFIX + btoa(String.fromCharCode(...combined));
}

/** 解密：自动检测 v1: 前缀，兼容存量无前缀数据 */
export async function decryptKey(env: AppEnv, encrypted: string): Promise<string> {
    if (!encrypted) return '';
    // 检测版本前缀
    let payload = encrypted;
    if (encrypted.startsWith(VERSION_PREFIX)) {
        payload = encrypted.slice(VERSION_PREFIX.length);
    }
    try {
        const key = await deriveKey(env);
        const combined = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
        const iv = combined.slice(0, IV_LENGTH);
        const ciphertext = combined.slice(IV_LENGTH);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return new TextDecoder().decode(decrypted);
    } catch {
        // 解密失败（明文、格式不匹配、或密钥变更）→ 返回原值
        logger.warn('decryptKey failed, returning raw value', { len: encrypted.length, hasPrefix: encrypted.startsWith(VERSION_PREFIX) });
        return encrypted;
    }
}
