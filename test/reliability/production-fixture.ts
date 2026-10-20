import { canonical } from '../../src/reliability/protocol';
import type { ReliabilityEnv } from '../../src/reliability/production-config';
export const manager = 'f'.repeat(32), businessAccount = 'e'.repeat(32);
/** Test values only; never copied into a deployable config. */
export function productionEnv(): ReliabilityEnv {
    return {
        RELIABILITY_COORDINATOR: {} as DurableObjectNamespace,
        RELIABILITY_RPC_SECRET: '1'.repeat(64), RELIABILITY_IDEMPOTENCY_SECRET: '2'.repeat(64), RELIABILITY_EVIDENCE_SECRET: '3'.repeat(64),
        RELIABILITY_CREDENTIAL_KEYS: canonical({ currentId: 'credential_new', keys: { credential_old: '4'.repeat(64), credential_new: '5'.repeat(64) } }),
        RELIABILITY_SNAPSHOT_KEYS: canonical({ currentId: 'snapshot_new', keys: { snapshot_old: '6'.repeat(64), snapshot_new: '7'.repeat(64) } }),
        RELIABILITY_MANAGER_ACCOUNT: manager, RELIABILITY_MANAGER_WORKER: 'manager', RELIABILITY_CONFIG_NAMESPACE: 'a'.repeat(32)
    };
}
