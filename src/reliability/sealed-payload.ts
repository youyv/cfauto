import { ReliabilityError } from './protocol';
import { MAX_SEALED_BYTES, MAX_SEALED_PLAINTEXT_BYTES } from './payload-limits';

// Versioned framing INSIDE authenticated encryption. Legacy canonical JSON starts
// with a JSON token and can never collide with this prefix. No row/schema/key change.
const MAGIC = new TextEncoder().encode('cfauto.sealed-json.gzip.v1\0');
const COMPRESS_AFTER = 4 * 1024 * 1024;
const invalid = (): never => { throw new ReliabilityError('INVALID', 400); };
async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
 const reader=stream.getReader(), chunks:Uint8Array[]=[];let length=0;
 try { for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>limit)invalid();chunks.push(next.value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes; }
 finally { void reader.cancel().catch(()=>undefined);reader.releaseLock(); }
}
/** Bound decoded bytes before compression, and retained bytes after compression.
 * Public task-body/config/maintenance limits are deliberately not enlarged. */
export async function encodeSealedPayload(input: Uint8Array): Promise<Uint8Array> {
 if(!(input instanceof Uint8Array)||input.length<1||input.length>MAX_SEALED_PLAINTEXT_BYTES)invalid();
 const bytes=new Uint8Array(input);if(bytes.length<=COMPRESS_AFTER)return bytes;
 const compressed=await collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),MAX_SEALED_PLAINTEXT_BYTES);
 if(compressed.length+MAGIC.length<bytes.length){if(compressed.length+MAGIC.length>MAX_SEALED_BYTES)invalid();const framed=new Uint8Array(MAGIC.length+compressed.length);framed.set(MAGIC);framed.set(compressed,MAGIC.length);return framed;}
 if(bytes.length>MAX_SEALED_BYTES)invalid();return bytes;
}
/** Called only AFTER every ciphertext chunk passes AES-GCM authentication.
 * A decompression bomb, unknown frame or malformed gzip never reaches JSON/HMAC. */
export async function decodeSealedPayload(bytes: Uint8Array): Promise<Uint8Array> {
 if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX_SEALED_BYTES)invalid();
 const framed=bytes.length>=MAGIC.length&&MAGIC.every((n,i)=>bytes[i]===n);
 if(!framed){if(![0x7b,0x5b,0x22,0x2d,0x74,0x66,0x6e].includes(bytes[0])&&(bytes[0]<0x30||bytes[0]>0x39))invalid();return bytes;}
 try { return await collect(new Blob([new Uint8Array(bytes.subarray(MAGIC.length))]).stream().pipeThrough(new DecompressionStream('gzip')),MAX_SEALED_PLAINTEXT_BYTES); }
 catch { return invalid(); }
}
