import { AccountQueue } from './account-queue';
import { DurableObject } from 'cloudflare:workers';
import { ConfigStore, type SqlDatabase } from './config-store';

/** Local harness exports this class; production index does NOT export or bind it yet. */
export class ReliabilityCoordinator extends DurableObject<unknown> {
    readonly config: ConfigStore;
    readonly queue: AccountQueue;
    constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);
        const db: SqlDatabase = {
            rows: <T extends Record<string, unknown>>(query: string, ...params: (string | number | null)[]) => ctx.storage.sql.exec(query, ...params).toArray() as T[],
            transaction: callback => ctx.storage.transactionSync(callback)
        };
        this.config = new ConfigStore(db);
        this.queue = new AccountQueue(db);
    }
    // No fetch/RPC administration API. Local harness subclasses with test-only dispatch.
}
