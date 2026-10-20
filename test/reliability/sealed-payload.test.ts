import {describe,it,expect} from 'vitest';
import {encodeSealedPayload,decodeSealedPayload} from '../../src/reliability/sealed-payload';
import {MAX_SEALED_BYTES,MAX_SEALED_PLAINTEXT_BYTES} from '../../src/reliability/payload-limits';
const encoder=new TextEncoder(),magic=encoder.encode('cfauto.sealed-json.gzip.v1\0');
const combine=(a:Uint8Array,b:Uint8Array)=>{const r=new Uint8Array(a.length+b.length);r.set(a);r.set(b,a.length);return r;};
async function zipped(bytes:Uint8Array){return new Uint8Array(await new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());}
describe('authenticated sealed payload framing and bounded decompression',()=>{
 it('leaves legacy small canonical JSON bytes exactly unchanged',async()=>{for(const v of [null,true,false,123,-4.5,'日本語 🔐',{code:'original',private:'secret'},[1,2]]){const b=encoder.encode(JSON.stringify(v));expect(await encodeSealedPayload(b)).toEqual(b);expect(await decodeSealedPayload(b)).toEqual(b);}});
 it('round-trips logical bytes above the retained ciphertext cap with explicit version framing',async()=>{const b=encoder.encode(JSON.stringify({code:'"quoted"\n'.repeat(800000)}));expect(b.length).toBeGreaterThan(MAX_SEALED_BYTES);const encoded=await encodeSealedPayload(b);expect(encoded.subarray(0,magic.length)).toEqual(magic);expect(encoded.length).toBeLessThan(MAX_SEALED_BYTES);expect(Buffer.from(await decodeSealedPayload(encoded)).equals(Buffer.from(b))).toBe(true);},15000);
 it('freezes bytes before asynchronous compression',async()=>{const b=encoder.encode(JSON.stringify('a'.repeat(5*1024*1024))),original=new Uint8Array(b),pending=encodeSealedPayload(b);b.fill(0);expect(Buffer.from(await decodeSealedPayload(await pending)).equals(Buffer.from(original))).toBe(true);},15000);
 it('rejects decoded oversize input before compression',async()=>{await expect(encodeSealedPayload(new Uint8Array(MAX_SEALED_PLAINTEXT_BYTES+1))).rejects.toThrow(/^INVALID$/);});
 it('enforces the unchanged physical ciphertext cap even for high-entropy valid JSON',async()=>{const random=new Uint8Array(6*1024*1024);let x=0x12345678;for(let i=0;i<random.length;i++){x^=x<<13;x^=x>>>17;x^=x<<5;random[i]=x&255;}const text=Buffer.from(random).toString('base64');await expect(encodeSealedPayload(encoder.encode(JSON.stringify({data:text})))).rejects.toThrow(/^INVALID$/);},20000);
 it('bounds a gzip bomb by expanded bytes rather than trusting compressed length',async()=>{const bomb=await zipped(encoder.encode('"'+'x'.repeat(MAX_SEALED_PLAINTEXT_BYTES)+'"'));await expect(decodeSealedPayload(combine(magic,bomb))).rejects.toThrow(/^INVALID$/);},15000);
 it.each([new Uint8Array(),new Uint8Array([1,2,3])])('rejects missing or malformed gzip without leaking codec detail',async body=>{await expect(decodeSealedPayload(combine(magic,body))).rejects.toThrow(/^INVALID$/);});
 it('rejects unknown framing and oversize stored input',async()=>{await expect(decodeSealedPayload(encoder.encode('cfauto.sealed-json.gzip.v99\0data'))).rejects.toThrow(/^INVALID$/);await expect(decodeSealedPayload(new Uint8Array(MAX_SEALED_BYTES+1))).rejects.toThrow(/^INVALID$/);});
});
