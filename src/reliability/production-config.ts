import {initialCutoverPin,type InitialCutoverPin} from './initial-cutover-pin';
import {maintenanceConfig,type MaintenanceConfig} from './maintenance-protocol';
import type { KeyRing } from './credential-envelope';
import type { SealedKeyRing } from './sealed-store';
import { accountId, resourcePolicy, shape, workerName, type ProtectedResources } from './business-command';
import { canonical, identifier, ReliabilityError } from './protocol';

/** Independent Worker Secret slots. No fallback to ACCESS_CODE/ENCRYPTION_SECRET,
 * process globals, test keys or KV. Do not log/serialize the resolved configuration. */
export interface ReliabilityEnv {
    /** Retained legacy bindings; no ordinary credential/RPC/key fallback. */
    ACCESS_CODE?: string;
    ENCRYPTION_SECRET?: string;
    GITHUB_TOKEN?: string;
    RELIABILITY_MAINTENANCE_KEYS?: string;
    RELIABILITY_INITIAL_CUTOVER_PIN?: string;
    RELIABILITY_COORDINATOR: DurableObjectNamespace;
    RELIABILITY_RPC_SECRET: string;
    RELIABILITY_IDEMPOTENCY_SECRET: string;
    RELIABILITY_EVIDENCE_SECRET: string;
    RELIABILITY_CREDENTIAL_KEYS: string;
    RELIABILITY_SNAPSHOT_KEYS: string;
    RELIABILITY_LEGACY_SECRET?: string;
    RELIABILITY_MANAGER_ACCOUNT: string;
    RELIABILITY_MANAGER_WORKER: string;
    RELIABILITY_CONFIG_NAMESPACE: string;
    RELIABILITY_PROTECTED_RESOURCES?: string;
}
export interface ProductionConfig {
    initialCutover?: InitialCutoverPin;
    maintenance?: MaintenanceConfig;
    rpcSecret: string;
    idempotencySecret: string;
    evidenceSecret: string;
    credentials: KeyRing;
    snapshots: SealedKeyRing;
    protected: ProtectedResources;
}
function unavailable(): never { throw new ReliabilityError('NOT_READY', 503); }
function secret(value: unknown): string {
    // 32 independently generated random bytes, hex-encoded by the provisioning tool.
    // Format validation is not an entropy test and never generates/replaces a key.
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) unavailable();
    return value;
}
function ring(raw: unknown): SealedKeyRing {
    if (typeof raw !== 'string' || raw.length > 8192) unavailable();
    let value: any; try { value = JSON.parse(raw); } catch { return unavailable(); }
    shape(value, 'currentId,keys');
    // Require canonical JSON to reject duplicate/ambiguous member names rather than
    // silently dropping an old decryption key via JSON.parse's last-member-wins rule.
    if (canonical(value) !== raw || !value.keys || Object.getPrototypeOf(value.keys) !== Object.prototype) unavailable();
    identifier(value.currentId);
    const ids = Object.keys(value.keys);
    if (!ids.length || ids.length > 32 || !Object.hasOwn(value.keys, value.currentId)) unavailable();
    for (const id of ids) { identifier(id); if (['__proto__','constructor','prototype'].includes(id)) unavailable(); secret(value.keys[id]); }
    return { currentId: value.currentId, keys: { ...value.keys } };
}
export function productionConfig(env: ReliabilityEnv): ProductionConfig {
    try {
        const rpcSecret = secret(env.RELIABILITY_RPC_SECRET), idempotencySecret = secret(env.RELIABILITY_IDEMPOTENCY_SECRET), evidenceSecret = secret(env.RELIABILITY_EVIDENCE_SECRET);
        const credentials: KeyRing = ring(env.RELIABILITY_CREDENTIAL_KEYS), snapshots = ring(env.RELIABILITY_SNAPSHOT_KEYS);
        const keys = [rpcSecret, idempotencySecret, evidenceSecret, ...Object.values(credentials.keys), ...Object.values(snapshots.keys)];
        if (new Set(keys).size !== keys.length) unavailable();
        if (env.RELIABILITY_LEGACY_SECRET !== undefined) {
            if (typeof env.RELIABILITY_LEGACY_SECRET !== 'string' || !env.RELIABILITY_LEGACY_SECRET || new TextEncoder().encode(env.RELIABILITY_LEGACY_SECRET).length > 8192 || keys.includes(env.RELIABILITY_LEGACY_SECRET)) unavailable();
            credentials.legacySecret = env.RELIABILITY_LEGACY_SECRET;
        }
        const maintenance=maintenanceConfig(env.RELIABILITY_MAINTENANCE_KEYS,[...keys,...(credentials.legacySecret?[credentials.legacySecret]:[])]);
        accountId(env.RELIABILITY_MANAGER_ACCOUNT); workerName(env.RELIABILITY_MANAGER_WORKER); accountId(env.RELIABILITY_CONFIG_NAMESPACE);
        const initialCutover=initialCutoverPin(env.RELIABILITY_INITIAL_CUTOVER_PIN,{account:env.RELIABILITY_MANAGER_ACCOUNT,worker:env.RELIABILITY_MANAGER_WORKER,namespace:env.RELIABILITY_CONFIG_NAMESPACE});
        let extra: ProtectedResources = { workers: [], namespaces: [] };
        if (env.RELIABILITY_PROTECTED_RESOURCES !== undefined) {
            if (typeof env.RELIABILITY_PROTECTED_RESOURCES !== 'string' || env.RELIABILITY_PROTECTED_RESOURCES.length > 16384) unavailable();
            extra = resourcePolicy(JSON.parse(env.RELIABILITY_PROTECTED_RESOURCES));
        }
        const protectedResources = resourcePolicy({ workers: [{ account: env.RELIABILITY_MANAGER_ACCOUNT, worker: env.RELIABILITY_MANAGER_WORKER }, ...extra.workers], namespaces: [{ account: env.RELIABILITY_MANAGER_ACCOUNT, namespace: env.RELIABILITY_CONFIG_NAMESPACE }, ...extra.namespaces] });
        Object.freeze(credentials.keys); Object.freeze(credentials); Object.freeze(snapshots.keys); Object.freeze(snapshots);
        for (const entry of [...protectedResources.workers, ...protectedResources.namespaces]) Object.freeze(entry);
        Object.freeze(protectedResources.workers); Object.freeze(protectedResources.namespaces); Object.freeze(protectedResources);
        return Object.freeze({ initialCutover, maintenance, rpcSecret, idempotencySecret, evidenceSecret, credentials, snapshots, protected: protectedResources });
    } catch { return unavailable(); } // Never echo a key, JSON parser context or raw binding error.
}
