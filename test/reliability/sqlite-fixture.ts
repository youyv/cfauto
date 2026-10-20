import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase } from '../../src/reliability/config-store';
export function sqliteFixture() {
    const sql = new DatabaseSync(':memory:');
    const db: SqlDatabase = {
        rows: (query, ...params) => sql.prepare(query).all(...params) as any,
        transaction(fn) { sql.exec('BEGIN IMMEDIATE'); try { const result = fn(); sql.exec('COMMIT'); return result; } catch (e) { sql.exec('ROLLBACK'); throw e; } }
    };
    return { sql, db };
}
