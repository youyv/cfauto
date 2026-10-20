/** Task submission identities live in memory until a durable admission ACK.
 * Existing tasks reconnect from the server catalog; no draft/credential storage. */
export function createTaskProtocol({newKey,baseUrl,enabled}) {
 const pending=new Map();
 const error=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
 function prepare(url,init={}) {
  const u=new URL(url,baseUrl());
  if(!enabled()||(init.method||'GET').toUpperCase()!=='POST'||!['/api/deploy','/api/batch_deploy','/api/fix_1101','/api/delete_worker','/api/change_subdomain','/api/save_yxip'].includes(u.pathname))return {init,ticket:null};
  if(u.pathname==='/api/save_yxip'&&typeof init.body==='string'){try{if(JSON.parse(init.body).type==='joey_var')return {init,ticket:null};}catch{}}
  if(typeof init.body!=='string')error('INVALID','任务必须提交冻结的 JSON');
  const path=u.pathname+u.search;let ticket=pending.get(path);
  if(ticket&&ticket.body!==init.body)error('TASK_UNRESOLVED','原任务接纳结果未确认，请在任务面板重试原意图；不会生成新任务覆盖');
  if(!ticket){ticket={path,body:init.body,key:newKey()};pending.set(path,ticket);}
  const headers=new Headers(init.headers||{});headers.set('X-Reliability-Protocol','1');headers.set('Idempotency-Key',ticket.key);
  return {init:{...init,headers,body:ticket.body},ticket};
 }
 function finish(ticket,status,data){
  if(!ticket||pending.get(ticket.path)!==ticket)return;
  if([400,401,403,405,413,415,422].includes(status)){pending.delete(ticket.path);return;}
  if(status>=200&&status<300){
   if(status!==202||data?.status!=='accepted'||data?.protocol!==1||typeof data?.id!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(data.id)||data.statusUrl!=='/api/reliability/tasks/'+data.id||typeof data.duplicate!=='boolean')error('TASK_UNRESOLVED','任务接纳回执不完整，请重试原意图');
   pending.delete(ticket.path);
  }
 }
 function retry(path){const t=pending.get(path);if(!t)error('INVALID','没有待确认的接纳请求');return {url:t.path,init:{method:'POST',body:t.body}};}
 return {prepare,finish,retry,pending:()=>[...pending.keys()]};
}
