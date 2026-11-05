// Durable task UI: GET reconnects; accepted is never rendered as completed.
const taskLabels = {queued:'排队中',running:'执行中',succeeded:'已验证完成',failed:'失败',partial_failed:'部分失败',cancelled:'已取消',partial_cancelled:'部分取消',needs_review:'结果未知，需安全对账'};
let taskPageCursor = null, taskSelectedId = null, taskPollTimer = null, taskReadSerial = 0, taskCatalogSerial = 0, taskHasUnread = false;
function taskText(tag,text,parent) { const el=document.createElement(tag); el.textContent=text; if(parent)parent.appendChild(el); return el; }
function taskButton(text,action,parent) { const b=taskText('button',text,parent); b.type='button'; b.className='task-action'; b.addEventListener('click',()=>Promise.resolve(action()).catch(e=>Swal.fire('任务请求失败',e.message,'warning'))); return b; }
function updateTaskIndicator() {
 const pending=typeof taskProtocol!=='undefined'&&taskProtocol&&taskProtocol.pending().length>0;
 const badge=$('task_badge'),toggle=$('task_toggle'),panel=$('task_panel');
 if(badge)badge.hidden=!(taskHasUnread||pending);
 if(toggle){const open=!!panel&&!panel.hidden,label=(open?'收起':'展开')+'任务列表'+(taskHasUnread||pending?'（有新任务或待确认请求）':'');toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',label);toggle.title=label;}
}
function setTaskPanelOpen(open,returnFocus=false) {
 const panel=$('task_panel');if(!panel)return;panel.hidden=!open;
 if(!open){stopTaskPolling();taskCatalogSerial++;panel.setAttribute('aria-busy','false');}
 updateTaskIndicator();if(returnFocus){const toggle=$('task_toggle');if(toggle)toggle.focus();}
}
function closeTaskPanel(){setTaskPanelOpen(false,true);}
async function toggleTaskPanel() {
 const panel=$('task_panel');if(!panel)return;
 if(!panel.hidden){closeTaskPanel();return;}
 setTaskPanelOpen(true);await loadTaskPage(false);
 if(!panel.hidden&&taskSelectedId)await showTask(taskSelectedId);
}
function isAcceptedTask(value) { return !!value && value.protocol===1 && value.status==='accepted' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id||''); }
function trackAcceptedTask(value) {
 if(!isAcceptedTask(value))return false;
 stopTaskPolling();taskSelectedId=value.id;taskHasUnread=true;updateTaskIndicator();
 wbLog('任务 '+value.id+' 已接纳；尚未完成。点击顶部任务图标查看进度，刷新页面不会丢失服务器任务。','text-yellow-400');
 const panel=$('task_panel');
 if(panel&&!panel.hidden)showTask(value.id).catch(e=>{if(!panel.hidden){const detail=$('task_detail');if(detail)detail.textContent='已接纳，暂时无法读取状态；请重新连接。'+e.message;}});
 return true;
}
async function loadTaskPage(append=false) {
 const panel=$('task_panel'),list=$('task_list');if(!panel||!list||append&&!taskPageCursor)return;
 setTaskPanelOpen(true);const serial=++taskCatalogSerial;panel.setAttribute('aria-busy','true');
 try{
  const result=await apiFetch('/api/reliability/tasks?limit=20'+(append&&taskPageCursor?'&cursor='+encodeURIComponent(taskPageCursor):''));
  if(serial!==taskCatalogSerial||panel.hidden)return;
  if(!result||!Array.isArray(result.items))throw new Error('任务列表格式不完整');
  if(!append)list.replaceChildren();
  for(const task of result.items){
   const row=taskText('div','',list);row.className='task-list-item';row.setAttribute('role','listitem');
   const button=taskButton('',()=>showTask(task.id),row);button.className='task-row';button.title=task.id;
   taskText('span',task.trigger==='automation'?'定时任务 · Cron':'手动任务',button).className='task-row-trigger';
   const status=taskText('span',taskLabels[task.state]||'未知状态',button);status.className='task-state';status.setAttribute('data-state',Object.hasOwn(taskLabels,task.state)?task.state:'needs_review');
   taskText('span',task.id,button).className='task-row-id';
  }
  if(!result.items.length&&!append)taskText('p','暂无已接纳的任务。',list).className='task-empty';
  taskPageCursor=result.cursor;const more=$('task_more');if(more)more.disabled=!taskPageCursor;
  taskHasUnread=false;updateTaskIndicator();
 }finally{if(serial===taskCatalogSerial)panel.setAttribute('aria-busy','false');}
}
function stopTaskPolling(){if(taskPollTimer)clearTimeout(taskPollTimer);taskPollTimer=null;taskReadSerial++;}
async function showTask(id,remaining=100) {
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('任务标识无效');
 stopTaskPolling();taskSelectedId=id;const serial=taskReadSerial;
 const result=await apiFetch('/api/reliability/tasks/'+id);
 if(serial!==taskReadSerial||taskSelectedId!==id)return;
 const detail=$('task_detail');if(!detail)return;detail.replaceChildren();taskHasUnread=false;updateTaskIndicator();
 taskText('h3',id+'：'+(taskLabels[result.state]||'未知状态'),detail);
 if(Number.isSafeInteger(result.humanSettlements)&&result.humanSettlements>0)taskText('p','包含 '+result.humanSettlements+' 项人工结案：供应商终态由操作者确认，不是程序验证；不代表原操作成功或已回滚。',detail);
 taskText('p',result.terminal?'已收到所有账号终态回执；具体成功、失败及取消以下方事实为准。':'仍未收到全部终态；不要重复发起外部写来“重试”。',detail);
 if(result.trigger==='automation')taskText('p','Cron '+(result.template||'')+'；通知：'+({unknown:'结果未知，不自动重发',rejected:'发送被拒绝',unsupported:'通知地址不受支持，未发送；请检查自动设置，旧通知不会自动补发',delivered:'已确认送达',not_requested:'未配置',not_sent:'部署未全部成功，未发送通知',pending:'待完成后确认'}[result.notification]||'待核对'),detail);
 for(const target of result.targets||[]){
  taskText('h4',target.account+' · '+target.state+(target.outcome?' / '+target.outcome:'')+(target.cancellationRequested?' / 已请求取消':''),detail);
  for(const step of target.steps||[]){const safe=step.result||{},manual=step.state==='failed'&&safe.code==='OPERATOR_CLOSED_UNCONFIRMED';taskText('p','步骤 '+(step.ordinal+1)+' '+step.kind+'：'+(manual?'人工结案（未验证成功）':step.state)+(safe.worker?' / '+safe.worker:'')+(!manual&&safe.code?' / '+safe.code:'')+(safe.disposition?' / '+safe.disposition:''),detail);if(manual)taskText('p','受审计裁决记录：'+(safe.adjudication||'请联系维护人员')+'；原 HTTP 不会自动重放。',detail);}
 }
 // Deployment ledger is already a safe server projection; show no raw JSON.
 for(const run of result.deployments||[])taskText('p','部署账本：'+(run.template||'')+' / '+(run.status||'')+' / '+(run.scope||''),detail);
 taskButton('重新连接',()=>showTask(id),detail);
 taskButton('停止本页轮询（不取消任务）',()=>{stopTaskPolling();},detail);
 if(!result.terminal){
  taskButton('请求取消',async()=>{const confirm=await Swal.fire({title:'请求取消后续步骤？',text:'已开始的外部请求不会回滚；未知结果仍保留屏障。',icon:'warning',showCancelButton:true,confirmButtonText:'请求取消',cancelButtonText:'保留任务'});if(confirm.isConfirmed){await apiFetch('/api/reliability/tasks/'+id+'/cancel',{method:'POST',body:'{}'});await showTask(id);}},detail);
  taskButton('唤醒持久投递',async()=>{await apiFetch('/api/reliability/tasks/'+id+'/wake',{method:'POST',body:'{}'});await showTask(id);},detail);
  taskText('p','唤醒只处理已保存的投递/回执，不解除 unknown，也不重发不确定的外部写。',detail);
 }
 if(result.state==='needs_review'||result.notification==='unknown')taskText('p','需维护人员通过独立维护 CLI 的 review_candidates 获取原调用序号，再只读观察并按证据裁决；普通页面不能解锁，也不要提交新任务绕过。',detail);
 if((!result.terminal&&result.state!=='needs_review'||result.notification==='pending')&&remaining>0&&!$('task_panel')?.hidden){taskPollTimer=setTimeout(()=>showTask(id,remaining-1).catch(()=>{if(taskSelectedId===id)taskText('p','连接中断，已停止轮询；任务仍保留在服务器，请重新连接。',detail);}),3000);}
}
function renderPendingTaskSubmissions() {
 const panel=$('task_pending');if(!panel||!taskProtocol)return;panel.replaceChildren();
 for(const path of taskProtocol.pending()){
  taskText('p','接纳回执尚未确认：'+path+'；原请求保留在本页内存中。',panel);
  taskButton('重试原接纳请求',async()=>{const r=taskProtocol.retry(path);trackAcceptedTask(await apiFetch(r.url,r.init));},panel);
 }
 updateTaskIndicator();
}
registerActions({
    toggleTaskPanel:toggleTaskPanel,
    closeTaskPanel:closeTaskPanel,
    showTaskCatalog:()=>loadTaskPage(false),
    moreTasks:()=>loadTaskPage(true)
});
