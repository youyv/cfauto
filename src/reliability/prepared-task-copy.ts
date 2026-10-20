import {canonical,ReliabilityError} from './protocol';
import {SourceInterner} from './shared-source';
import type {PreparedTaskInput} from './task-preparation';

/** Freeze each bounded target separately. A task can cover many accounts without
 * building one giant transient JSON string. Preserve the original wire schema:
 * replaying an old schema-1 task must retain its exact sealed-object identity. */
export function copyPreparedTarget(input:unknown,interner=new SourceInterner()):PreparedTaskInput['targets'][number] {
    const value=JSON.parse(canonical(input));interner.apply(value);return value;
}
export function copyPreparedTask(input:PreparedTaskInput,interner=new SourceInterner()):PreparedTaskInput {
    if(!input||typeof input!=='object'||Object.getPrototypeOf(input)!==Object.prototype||!Array.isArray(input.targets)||input.targets.length>100)throw new ReliabilityError('INVALID',400);
    const value=JSON.parse(canonical({...input,targets:[]}));
    value.targets=input.targets.map(target=>copyPreparedTarget(target,interner));return value;
}
