import {canonical,ReliabilityError,type Json} from './protocol';

const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const SHARE_THRESHOLD=64*1024;
const sourceEncoder=new TextEncoder();
// Persistent budgets are UTF-8 bytes, not UTF-16 string lengths.
const largeSource=(source:any):boolean=>typeof source?.code==='string'&&(source.code.length>=SHARE_THRESHOLD||sourceEncoder.encode(source.code).length>=SHARE_THRESHOLD);
/** Private stored-operation codec only. Public business intents never accept this
 * representation. Pool entries contain the COMPLETE artifact (not an unchecked
 * digest); indices are local to one authenticated account snapshot. */
export function packBusinessSources(input:unknown):Json {
    if(!object(input)||input.schema!==1||Object.keys(input).sort().join(',')!=='account,commands,credential,schema'||!Array.isArray(input.commands)||input.commands.length>50)return input as Json;
    const sources:Json[]=[],positions=new Map<string,number>();let savesLargeSource=false;
    const commands=input.commands.map((command:any)=>{
        if(!object(command)||!Object.hasOwn(command,'artifact'))return command;
        const key=canonical(command.artifact),previous=positions.get(key);
        const source=previous??sources.length;
        if(previous===undefined){positions.set(key,source);sources.push(command.artifact);}
        else if(largeSource(command.artifact))savesLargeSource=true;
        return {...command,artifact:{source}};
    });
    if(!savesLargeSource)return input as Json;
    // Do not discard unexpected fields; the executor still rejects them.
    return {...input,schema:2,commands,sources} as Json;
}
/** Expand references in memory, sharing objects/strings. Never serialize the
 * expanded result into a new snapshot; older schema-1 snapshots remain supported. */
export function expandBusinessSources(input:unknown):any {
    if(!object(input)||input.schema!==2)return input;
    if(Object.keys(input).sort().join(',')!=='account,commands,credential,schema,sources'||!Array.isArray(input.commands)||!input.commands.length||input.commands.length>50||!Array.isArray(input.sources)||!input.sources.length||input.sources.length>50)invalid();
    const used=new Set<number>(),identities=new Set<string>();
    for(const source of input.sources){if(!object(source)||typeof source.code!=='string')invalid();const identity=canonical(source);if(identities.has(identity))invalid();identities.add(identity);}
    const commands=input.commands.map((command:any)=>{
        if(!object(command))return invalid();
        if(!Object.hasOwn(command,'artifact'))return command;
        const ref=command.artifact;
        if(!object(ref)||Object.keys(ref).join(',')!=='source'||!Number.isSafeInteger(ref.source)||ref.source<0||ref.source>=input.sources.length)invalid();
        used.add(ref.source);return {...command,artifact:input.sources[ref.source]};
    });
    if(used.size!==input.sources.length)invalid();
    return {schema:1,account:input.account,credential:input.credential,commands};
}
/** Freeze before the first await without expanding a repeated multi-MiB source
 * into a multi-MiB-per-Worker intermediate JSON string. Full command/credential
 * validation remains parseBusinessOperation's responsibility. */
export function copyBusinessOperation(input:unknown):any {
    return expandBusinessSources(JSON.parse(canonical(packBusinessSources(input))));
}
/** Reuse exact immutable artifacts across independently decoded target parts.
 * Equality covers all bytes and provenance, not just a caller-claimed digest. */
export class SourceInterner {
    private readonly values=new Map<string,Json>();
    apply(target:any):void {
        const operation=target?.operation?.operation;
        if(!operation||![1,2].includes(operation.schema))return;
        const intern=(source:any)=>{if(!object(source)||!largeSource(source))return source;const key=canonical(source),old=this.values.get(key);if(old)return old;this.values.set(key,source);return source;};
        if(operation.schema===2&&Array.isArray(operation.sources))operation.sources=operation.sources.map(intern);
        else if(Array.isArray(operation.commands))for(const command of operation.commands)if(object(command)&&Object.hasOwn(command,'artifact'))command.artifact=intern(command.artifact);
    }
}
