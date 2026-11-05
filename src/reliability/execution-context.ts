import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionJournal } from './execution-journal';
import { ReliabilityError, canonical, revision } from './protocol';

export interface FrozenExecutionInput {
    now: number;
    uuids: string[];
    subdomains: string[];
    /** Raw, untransformed source resolved and downloaded by the planner before submit. */
    sources: Record<string, { code: string; sha: string | null }>;
}
interface ExecutionContext { journal: ExecutionJournal; input: FrozenExecutionInput; uuidCursor: number; subdomainCursor: number }
const execution = new AsyncLocalStorage<ExecutionContext>();
/** Invocation-local, never a module-global mutable current job. Counters restart from
 * the immutable input on replay. No random value is generated after admission. */
export function withExecution<T>(journal: ExecutionJournal, input: FrozenExecutionInput, run: () => Promise<T>): Promise<T> {
    const frozen: FrozenExecutionInput = JSON.parse(canonical(input));
    revision(frozen.now);
    if (!Array.isArray(frozen.uuids) || !Array.isArray(frozen.subdomains) || !frozen.sources || Array.isArray(frozen.sources) || typeof frozen.sources !== 'object') throw new ReliabilityError('INVALID', 400);
    if (frozen.uuids.some(v => !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)) || frozen.subdomains.some(v => !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(v))) throw new ReliabilityError('INVALID', 400);
    return execution.run({ journal, input: frozen, uuidCursor: 0, subdomainCursor: 0 }, run);
}
export function executionJournal(): ExecutionJournal | undefined { return execution.getStore()?.journal; }
export function executionNow(): number { return execution.getStore()?.input.now ?? Date.now(); }
export function executionUUID(): string {
    const context = execution.getStore();
    if (!context) return crypto.randomUUID();
    const value = context.input.uuids[context.uuidCursor++];
    if (!value) throw new ReliabilityError('NOT_READY', 503);
    return value;
}
export function frozenSubdomain(): string | undefined {
    const context = execution.getStore();
    if (!context) return undefined;
    const value = context.input.subdomains[context.subdomainCursor++];
    if (!value) throw new ReliabilityError('NOT_READY', 503);
    return value;
}
export function frozenSource(type: string, requested: string | null): { code: string; sha: string | null } | undefined {
    const context = execution.getStore();
    if (!context) return undefined;
    const source = Object.hasOwn(context.input.sources, type) ? context.input.sources[type] : undefined;
    if (!source || typeof source.code !== 'string' || (source.sha !== null && !/^[a-f0-9]{7,40}$/i.test(source.sha)) || (requested && requested !== 'latest' && source.sha !== requested)) throw new ReliabilityError('NOT_READY', 503);
    return { ...source };
}
