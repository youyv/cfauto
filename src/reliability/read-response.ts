import {ReliabilityError} from './protocol';
/** Fixed read deadline includes headers AND body. Buffered bytes are bounded and
 * never printed on failure; a late response/body is cancelled rather than leaked. */
export async function boundedReadResponse(response:Response,deadline:number,limit=2*1024*1024):Promise<Response> {
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const failure=()=>new ReliabilityError('NOT_READY',503);
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(failure());void reader?.cancel().catch(()=>{});},Math.max(0,deadline-Date.now()));});
 try{
  if(Date.now()>=deadline)throw failure();
  if(!response.body)return response;
  reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  for(;;){const next=await Promise.race([reader.read(),timeout]);if(next.done)break;size+=next.value.length;if(size>limit)throw failure();chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
  return new Response(bytes,{status:response.status,statusText:response.statusText,headers});
 }finally{if(timer!==undefined)clearTimeout(timer);if(reader)void reader.cancel().catch(()=>{});else void response.body?.cancel().catch(()=>{});}
}
