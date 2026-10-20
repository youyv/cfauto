import type { SqlDatabase } from './config-store';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName, readRpcRequest, type CoordinatorRole, type RpcMessage } from './coordinator-rpc';
import { canonical, ReliabilityError, type Json } from './protocol';

export interface RoleRuntime { handle(message: RpcMessage): Promise<Json>; tick(): Promise<void> }
/** Internal DO facade. A production DO must keep this instance in a JS #private field
 * and expose ONLY fetch/alarm, not stores or helpers as remotely callable methods.
 * No global/account business stores are constructed before address + HMAC validation.
 * The factory is static server code, never a callable name or executor from the request. */
export class CoordinatorEndpoint {
    #runtime: RoleRuntime | undefined;
    #role: string | undefined;
    constructor(private readonly db: SqlDatabase, private readonly rpc: CoordinatorRpc, private readonly isObject: (name: string) => boolean, private readonly create: (role: CoordinatorRole) => RoleRuntime) {
        db.rows('CREATE TABLE IF NOT EXISTS coordinator_identity (id INTEGER PRIMARY KEY CHECK(id=1), role TEXT NOT NULL)');
    }
    /** Trusted local bootstrap/planner only; never put this method on the DO class. */
    bindTrusted(role: CoordinatorRole): RoleRuntime {
        const serialized = canonical(role);
        if (!this.isObject(role.role === 'global' ? GLOBAL_OBJECT_NAME : accountObjectName(role.account))) throw new ReliabilityError('INVALID', 403);
        this.db.transaction(() => {
            const existing = this.db.rows<{ role: string }>('SELECT role FROM coordinator_identity WHERE id=1')[0];
            if (existing && existing.role !== serialized) throw new ReliabilityError('CONFLICT', 409);
            if (!existing) this.db.rows('INSERT INTO coordinator_identity VALUES (1,?)', serialized);
        });
        if (this.#role && this.#role !== serialized) throw new ReliabilityError('CONFLICT', 409);
        if (!this.#runtime) { this.#runtime = this.create(role); this.#role = serialized; }
        return this.#runtime;
    }
    async fetch(request: Request): Promise<Response> {
        try {
            const { message, role } = await this.rpc.verify(await readRpcRequest(request), this.isObject);
            const value = await this.bindTrusted(role).handle(message);
            return Response.json({ value }, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
            const known = error instanceof ReliabilityError;
            return Response.json({ error: known ? error.code : 'NOT_READY' }, { status: known ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
        }
    }
    async alarm(): Promise<void> {
        const saved = this.db.rows<{ role: string }>('SELECT role FROM coordinator_identity WHERE id=1')[0];
        if (saved) await this.bindTrusted(JSON.parse(saved.role) as CoordinatorRole).tick();
    }
}
