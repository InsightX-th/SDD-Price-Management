/* WordPress-provided React; no remote fonts or runtime dependencies. */
(function () {
'use strict';
const {createElement:h, useState, useEffect, useRef} = wp.element;
const cfg = window.SDD_CONFIG;
const drafts = new Map();
const pendingPricePrefix='sdd-price-command:'+cfg.api+':'+cfg.userId+':';
function pendingPriceCommands(){
 const rows=[];
 try{
  for(let i=0;i<localStorage.length;i++){
   const stored=localStorage.key(i);
   if(!stored?.startsWith(pendingPricePrefix))continue;
   const match=/^(\d+:(?:regular_price|sale_price|sale_dates|stock_status))(?::([a-f0-9-]{36}))?$/.exec(stored.slice(pendingPricePrefix.length));
   const operation_id=match&&(match[2]||localStorage.getItem(stored));
   if(operation_id&&/^[a-f0-9-]{36}$/.test(operation_id))rows.push({key:match[1],operation_id});
  }
 }catch{}
 return rows;
}
for(const {key,operation_id} of pendingPriceCommands()){
 if(!drafts.has(key))drafts.set(key,{state:'unknown',recovering:true,operation:{operation_id},message:'มีคำสั่งที่ส่งไว้ กรุณาตรวจผลเดิมก่อนแก้ราคา'});
}
function rememberPriceCommand(key,id,remove=false){
 if(!id)return;
 try{
  if(remove){
   localStorage.removeItem(pendingPricePrefix+key+':'+id);
   if(localStorage.getItem(pendingPricePrefix+key)===id)localStorage.removeItem(pendingPricePrefix+key);
  }else localStorage.setItem(pendingPricePrefix+key+':'+id,'1');
 }catch{}
}
const workspacePresence = new Map();
const cacheUpdates = new Map();
function cacheUpdateText(update){
 const state=update?.state;
 if(!state||['idle','disabled'].includes(state))return '';
 return ({pending:'บันทึกแล้ว · กำลังอัปเดตราคาบนหน้าร้าน',enumerating:'บันทึกแล้ว · กำลังอัปเดตราคาบนหน้าร้าน',processing:'บันทึกแล้ว · กำลังอัปเดตราคาบนหน้าร้าน',retry_wait:'อัปเดตราคาบนหน้าร้านล่าช้า · ระบบจะลองใหม่',paused:'บันทึกราคาแล้ว · พักการส่งคำขอ',accepted:'Cloudflare รับคำขอให้อัปเดตราคาบนหน้าร้านแล้ว',simulated:'ทดลองขั้นตอนแล้ว · ยังไม่ได้อัปเดตบนเว็บไซต์จริง',needs_attention:'บันทึกราคาแล้ว · ต้องตรวจการอัปเดตหน้าร้าน',closed:'ปิดงานโดยผู้ดูแลแล้ว',unavailable:'ยังตรวจสถานะการอัปเดตราคาบนหน้าร้านไม่ได้'})[state]||'ยังตรวจสถานะการอัปเดตราคาบนหน้าร้านไม่ได้';
}
function markCachePending(id,noop=false){
 if(noop||!cfg.cacheCapture)return;
 cacheUpdates.set(String(id),{state:'pending'});
 window.dispatchEvent(new CustomEvent('sdd:cache-update'));
}
function CacheUpdateStatus({id,detail=false,compact=false,onJob}){
 const [,refresh]=useState(0);
 useEffect(()=>{const update=()=>refresh(n=>n+1);window.addEventListener('sdd:cache-update',update);return()=>window.removeEventListener('sdd:cache-update',update);},[id]);
 const update=cacheUpdates.get(String(id)),message=cacheUpdateText(update);
 if(!message||(compact&&['accepted','simulated','closed'].includes(update.state)))return null;
 const tone=['needs_attention','retry_wait','unavailable'].includes(update.state)?'attention':'pending';
 return h('small',{className:'sdd-cache-status '+tone,role:'status','data-cache-state':update.state},message,detail&&update.updated_at&&h('span',null,' · '+displayDate(update.updated_at)),onJob&&update.job_id&&h('button',{type:'button',onClick:()=>onJob(update.job_id)},'ดูงานนี้ในคิว'));
}
function CacheQueueSummary({data}){
 if(!data||data.state==='disabled')return null;
 const attention=Number(data.attention)||0;
 const waiting=Math.max(0,(Number(data.pending)||0)-attention);
 const status=data.operational_state;
 return h('div',{className:'sdd-cache-summary'},
  data.state==='unavailable'?h('p',null,'ยังตรวจสถานะการอัปเดตราคาบนหน้าร้านไม่ได้'):h('div',{className:'sdd-cache-counts'},
   h('p',null,h('strong',null,waiting),' รายการกำลังรอส่งหรือกำลังส่ง'),
   h('p',{className:attention?'sdd-cache-count-alert':undefined},h('strong',null,attention),' รายการต้องตรวจสอบ')),
  data.dry_run&&h('p',null,'ทดลองอยู่ · ยังไม่ได้ส่งคำขอไป Cloudflare'),
  status==='paused_error'&&h('p',{className:'sdd-cache-count-alert'},'พักส่งคำขอ · ตรวจการเชื่อมต่อ Cloudflare'),
  status==='stalled'&&h('p',{className:'sdd-cache-count-alert'},'งานส่งคำขอเบื้องหลังล่าช้า'),
  status==='unavailable'&&data.state!=='unavailable'&&h('p',{className:'sdd-cache-count-alert'},'ระบบส่งคำขอเบื้องหลังไม่พร้อม'),
  status!=='paused_error'&&!data.dispatch_enabled&&data.pending>0&&h('p',null,'พักส่งคำขอ · รายการที่รอยังอยู่'));
}
function cacheRemedy(code){
 return ({
  network:'เชื่อมต่อ Cloudflare ไม่ได้ ให้ผู้ดูแลตรวจการเชื่อมต่อจากเซิร์ฟเวอร์',
  cloudflare_400:'Cloudflare ไม่รับรูปแบบคำขอ ให้ผู้ดูแลตรวจรายการหน้าและการตั้งค่าแคช',
  cloudflare_401:'Cloudflare ไม่รับ Token กรุณาตรวจหรือเปลี่ยน Token',
  cloudflare_403:'ตรวจสิทธิ์ Cache Purge ของ Token และขอบเขตเว็บไซต์',
  cloudflare_404:'ตรวจ Zone ID ในหน้า Overview ของโดเมน',
  cloudflare_422:'Cloudflare ไม่รับรายการหน้า ให้ผู้ดูแลตรวจ URL และการตั้งค่าแคช',
  cloudflare_429:'Cloudflare จำกัดความถี่ ระบบจะรอก่อนส่งอีกครั้ง',
  live_not_verified:'ตรวจการเชื่อมต่อ Cloudflare ก่อนส่งงาน',
  configuration_changed:'การตั้งค่าของงานนี้เปลี่ยนไป ให้ผู้ดูแลตรวจคิวและการตั้งค่าปัจจุบัน',
  enumeration_failed:'ยังจัดรายการหน้าที่ต้องอัปเดตไม่ได้ ให้ผู้ดูแลตรวจการตั้งค่าเว็บไซต์',
  replay_limit:'งานนี้ลองส่งครบจำนวนแล้ว ให้ผู้ดูแลตรวจสาเหตุ',
 })[code]||'ให้ผู้ดูแลตรวจสถานะระบบก่อนลองส่งอีกครั้ง';
}
function CacheSettings({jobId}={}){
 const [data,setData]=useState(null);
 const [draft,setDraft]=useState({});
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [message,setMessage]=useState('');
 const [extraDraft,setExtraDraft]=useState(null);
 const [zoneDraft,setZoneDraft]=useState(null);
 const [token,setToken]=useState('');
 const [page,setPage]=useState(1);
 const [filter,setFilter]=useState('all');
 const [job,setJob]=useState(jobId||'');
 const connectionPanel=useRef(null);
 const openedJob=useRef(false),jobHeading=useRef(null);
 const live=useRef(true);
 useEffect(()=>{
  live.current=true;
  run('refresh',()=>read());
  return()=>{live.current=false;};
 },[]);
 useEffect(()=>{
  if(!data||!job||openedJob.current)return;
  openedJob.current=true;
  jobHeading.current?.focus();
  jobHeading.current?.scrollIntoView?.({block:'nearest'});
 },[data,job]);
 const settings=data?.settings;
 const form=settings?{...settings,...draft}:null;
 const queue=data?.queue;
 const verification=data?.connection?.verification_state;
 const needsConnection=!!settings&&!settings.dry_run&&(verification==='recheck_required'||
  (!data.live_verified&&(settings.capture_enabled||settings.dispatch_enabled||queue?.pending>0)));
 const extraText=extraDraft??settings?.extra_urls?.join('\n')??'';
 const zone=zoneDraft??data?.connection?.zone_id??'';
 const hasChanges=!!settings&&(Object.keys(draft).some(key=>draft[key]!==settings[key])||extraDraft!==null&&extraDraft!==settings.extra_urls.join('\n'));

 async function read(nextPage=page,nextFilter=filter,nextJob=job){
  const params=new URLSearchParams({page:nextPage,filter:nextFilter});
  if(nextJob)params.set('job_id',String(nextJob));
  const result=await api('cache-health?'+params);
  if(!live.current)return;
  cfg.cacheCapture=result.settings.capture_enabled;
  setData(result);
  setPage(result.jobs_pagination?.page??nextPage);
  setFilter(nextFilter);setJob(nextJob);
 }
 async function run(action,perform,success=''){
  setBusy(action);
  setError('');
  setMessage('');
  try{
   await perform();
   if(live.current&&success)setMessage(success);
  }catch(e){
   if(live.current)setError(e.message+(e.data?.request_id?' · '+e.data.request_id:''));
  }finally{
   if(live.current)setBusy('');
  }
 }
 function change(key,value){
  setDraft(current=>({...current,[key]:value}));
  setMessage('');
 }
 function setAutomatic(enabled){
  setDraft(current=>({...current,capture_enabled:enabled,dispatch_enabled:enabled&&(!settings.capture_enabled||settings.dispatch_enabled)}));
  setMessage('');
 }
 async function persist(next,resetDraft=false){
  const result=await api('cache-settings',{
   capture_enabled:next.capture_enabled,
   dispatch_enabled:next.dispatch_enabled,
   dry_run:next.dry_run,
   extra_urls:next.extra_urls,
  });
  if(!live.current)return;
  cfg.cacheCapture=result.settings.capture_enabled;
  setData(current=>({...current,...result}));
  if(resetDraft){
   setDraft({});
   setExtraDraft(null);
  }
  await read();
 }
 function save(){
  return run('save',()=>persist({...form,extra_urls:extraText.split('\n').map(value=>value.trim()).filter(Boolean)},true),'บันทึกการตั้งค่าแล้ว');
 }
 function toggleDispatch(enabled){
  const success=enabled?'เปิดส่งคำขอแล้ว ดูผลการส่งได้จากคิวงาน':
   settings.capture_enabled?'พักส่งคำขอแล้ว ระบบยังเก็บงานจากการเปลี่ยนราคาใหม่':'พักส่งคำขอแล้ว รายการที่ค้างยังอยู่ในคิว';
  return run(enabled?'resume':'pause',()=>persist({...settings,dispatch_enabled:enabled}),success);
 }
 function connect(){
  return run('connect',async()=>{
   try{
    let result;
    try{
     result=await api('cache-connection',{zone_id:zone.trim(),api_token:token});
    }catch(connectionError){
     if(live.current){
      try{await read();}catch{ /* Keep the original connection error. */ }
     }
     throw connectionError;
    }
    if(!live.current)return;
    setZoneDraft(null);
    setData(current=>({...current,connection:result.connection,credentials_ready:true,live_verified:true}));
    await read();
   }finally{
    if(live.current)setToken('');
   }
  },'ตรวจการเชื่อมต่อและบันทึกแล้ว');
 }
 function retry(id){
  return run('retry-'+id,async()=>{
   await api('cache-updates/'+id+'/retry',{});
   await read();
  },'ส่งงานเข้าคิวให้ลองอีกครั้งแล้ว');
 }
 async function closeJob(job,name){
  const confirmed=await confirmChange('ปิดงานอัปเดตหน้าร้านของ '+name+' หรือไม่? งานนี้จะหยุดส่ง กรุณาตรวจราคาหน้าร้านด้วยตนเอง ราคาสินค้าคงเดิม',
   {title:'ปิดงานอัปเดตหน้าร้าน',confirmLabel:'ยืนยันปิดงาน'});
  if(!confirmed||!live.current)return;
  return run('close-'+job.id,async()=>{
   await api('cache-updates/'+job.id+'/close',{confirmed:true});
   await read();
  },'ปิดงานอัปเดตหน้าร้านแล้ว');
 }
 function showConnection(){
  const panel=connectionPanel.current;
  if(!panel)return;
  panel.open=true;
  panel.querySelector('input')?.focus();
 }
 const refresh=(nextPage=page,nextFilter=filter)=>run('refresh',()=>read(nextPage,nextFilter));
 const stale=!!queue?.worker_stale||!!settings?.dispatch_enabled&&!data?.scheduler_ready;
 let statusTitle='ปิดการอัปเดตอัตโนมัติ';
 let statusDetail='เปิดการอัปเดตเพื่อเก็บงานจากการเปลี่ยนราคาผ่าน SoundDD';
 let statusAction=null;
 if(!data){
  statusTitle=busy?'กำลังอ่านสถานะ…':'ยังไม่ทราบสถานะ';
  statusDetail='';
 }else if(!data.schema_ready||queue?.state==='unavailable'){
  statusTitle='ยังตรวจสถานะคิวไม่ได้';
  statusDetail='ให้ผู้ดูแลเว็บไซต์ตรวจความพร้อมของระบบคิว';
 }else if(needsConnection){
  statusTitle='ต้องตรวจการเชื่อมต่อ Cloudflare';
  statusDetail=cacheRemedy(data.connection?.last_failure||queue?.pause_reason||'live_not_verified');
  statusAction=h('button',{type:'button',className:'sdd-primary',onClick:showConnection,disabled:!!busy},'ตรวจและแก้การเชื่อมต่อ');
 }else if(!settings.dispatch_enabled&&(settings.capture_enabled||queue?.pending>0)){
  statusTitle=settings.capture_enabled?'พักการส่งคำขอ':'ปิดรับงานใหม่ · มีงานค้าง';
  statusDetail=queue?.pause_reason&&queue.pause_reason!=='manual'?cacheRemedy(queue.pause_reason):
   settings.capture_enabled?'ระบบยังเก็บงานจากการเปลี่ยนราคาใหม่ไว้':'เปิดส่งงานที่ค้างต่อได้จากหน้านี้';
  statusAction=h('button',{type:'button',className:'sdd-primary',disabled:!!busy||!data.scheduler_ready,onClick:()=>toggleDispatch(true)},'ส่งงานที่ค้างต่อ');
 }else if(settings.dispatch_enabled&&stale){
  statusTitle='งานเบื้องหลังล่าช้า';
  statusDetail='ระบบยังเก็บงานไว้ ให้ผู้ดูแลตรวจการเรียกงานเบื้องหลัง';
  statusAction=h('button',{type:'button',disabled:!!busy,onClick:()=>toggleDispatch(false)},'พักการส่ง');
 }else if(settings.dispatch_enabled){
  statusTitle=!settings.capture_enabled?'กำลังส่งงานที่ค้าง':settings.dry_run?'เปิดโหมดทดลอง':'เปิดใช้งานจริง';
  statusDetail=settings.dry_run?'ระบบทดลองเตรียมงานโดยไม่ส่งคำขอไป Cloudflare':
   queue?.last_accepted_at?'Cloudflare รับคำขอล่าสุด '+displayDate(queue.last_accepted_at):'ระบบส่งคำขอเมื่อมีงานอัปเดตราคา';
  statusAction=h('button',{type:'button',disabled:!!busy,onClick:()=>toggleDispatch(false)},'พักการส่ง');
 }
 const pagination=data?.jobs_pagination;
 const jobs=data?.jobs||[];
 return h('section',{className:'sdd-setup-card sdd-cache-settings','aria-label':'การอัปเดตราคาหน้าร้าน'},
  h('div',{className:'sdd-card-heading'},h('h3',null,'การอัปเดตราคาหน้าร้าน'),
   h('button',{type:'button',onClick:()=>refresh(),disabled:!!busy},busy==='refresh'?'กำลังอ่านสถานะ…':'รีเฟรชสถานะ')),
  error&&h('p',{role:'alert',className:'sdd-error'},error),
  message&&h('p',{role:'status'},message),
  h('div',{className:'sdd-cache-overview'},
   h('div',{role:'status'},h('strong',null,statusTitle),statusDetail&&h('p',null,statusDetail)),statusAction),
  h(CacheQueueSummary,{data:queue}),
  job&&h('div',{className:'sdd-import-actions'},h('strong',{tabIndex:-1,ref:jobHeading},'งานอัปเดตหน้าร้าน #'+job),h('button',{disabled:!!busy,onClick:()=>run('refresh',()=>read(1,'all',''))},'ดูคิวทั้งหมด')),
  data&&h('section',{className:'sdd-cache-jobs','aria-label':'คิวอัปเดตหน้าร้าน'},
   h('div',{className:'sdd-card-heading'},h('h4',null,'คิวอัปเดตหน้าร้าน'),
    h('label',null,'แสดงงาน ',h('select',{value:filter,disabled:!!busy,onChange:e=>refresh(1,e.target.value)},
     h('option',{value:'all'},'ทั้งหมด'),h('option',{value:'attention'},'ต้องตรวจสอบ'),h('option',{value:'pending'},'กำลังรอส่ง')))),
   queue?.oldest_at&&h('p',{className:'sdd-plan-help'},'งานที่ค้างนานที่สุดตั้งแต่ '+displayDate(queue.oldest_at)),
   queue?.next_retry_at&&queue.dispatch_enabled&&h('p',{className:'sdd-plan-help'},'รอบถัดไป '+displayDate(queue.next_retry_at)),
   data.jobs_error?h('p',{role:'alert',className:'sdd-error'},'อ่านรายการงานไม่ได้ กรุณารีเฟรชสถานะ'):
   jobs.length?h('ul',{className:'sdd-cache-job-list',tabIndex:jobs.length>3?0:undefined,'aria-label':'รายการงานอัปเดตราคาหน้าร้าน'},jobs.map(job=>{
    const name=job.product_name||'สินค้า #'+job.product_id;
    const sku=job.sku;
    const permalink=job.permalink;
    const canRetry=['needs_attention','retry_wait'].includes(job.status)&&queue?.dispatch_enabled&&!job.retry_blocked;
    const pausedJob=queue?.dispatch_enabled===false&&['pending','processing','enumerating','retry_wait'].includes(job.status);
    const canClose=job.can_close??(job.status==='needs_attention'||pausedJob);
    const issue=job.retry_blocked||job.error_code;
    const state=pausedJob?'paused':job.status;
    return h('li',{key:job.id},
     h('div',{className:'sdd-cache-job-info'},
      h('strong',null,name),sku&&h('small',null,'SKU '+sku),
      job.current_price!=null&&job.current_price!==''&&h('p',null,'ราคาปัจจุบันในระบบ ',h('strong',null,showValue(job.current_price,'sale_price')+' '+(cfg.currency==='THB'||!cfg.currency?'บาท':cfg.currency))),
      h('p',null,'บันทึกการเปลี่ยนแปลงแล้ว',job.created_at&&' · '+displayDate(job.created_at)),
      h('p',null,cacheUpdateText({state}).replace(/^บันทึก(?:ราคา)?แล้ว · /u,''),state==='accepted'&&(job.last_accepted_at||job.updated_at)&&' · '+displayDate(job.last_accepted_at||job.updated_at)),
      job.status==='retry_wait'&&job.next_retry_at&&h('p',null,'ลองอีกครั้ง '+displayDate(job.next_retry_at)),
      issue&&h('p',{className:'sdd-cache-count-alert'},cacheRemedy(issue)),
      h('details',{className:'sdd-cache-job-support'},h('summary',null,'ข้อมูลสำหรับผู้ดูแล'),h('code',null,'งาน #'+job.id,job.error_code&&' · '+job.error_code))),
     (permalink||canRetry||canClose)&&h('div',{className:'sdd-cache-job-actions'},
      permalink&&h('a',{href:permalink,target:'_blank',rel:'noopener noreferrer'},'เปิดดูหน้าสินค้า'),
      canRetry&&h('button',{type:'button',disabled:!!busy,onClick:()=>retry(job.id)},busy==='retry-'+job.id?'กำลังส่งเข้าคิว…':'ลองส่งอีกครั้ง'),
      canClose&&h('button',{type:'button',disabled:!!busy,onClick:()=>closeJob(job,name)},busy==='close-'+job.id?'กำลังปิดงาน…':'ปิดงานนี้')));
   })):h('p',null,'ไม่มีงานในมุมมองนี้'),
   pagination?.total_pages>1&&h('nav',{className:'sdd-cache-pages','aria-label':'หน้าคิวอัปเดตราคา'},
    h('button',{type:'button',disabled:!!busy||page<=1,onClick:()=>refresh(page-1)},'ก่อนหน้า'),
    h('span',null,'หน้า '+page+' / '+pagination.total_pages),
    h('button',{type:'button',disabled:!!busy||page>=pagination.total_pages,onClick:()=>refresh(page+1)},'ถัดไป'))),
  form&&h('fieldset',{disabled:!!busy,className:'sdd-cache-controls'},
   h('label',{className:'sdd-cache-master-toggle'},h('input',{type:'checkbox',checked:form.capture_enabled,onChange:e=>setAutomatic(e.target.checked)}),' เปิดอัปเดตราคาหน้าร้านอัตโนมัติ'),
   h('p',{className:'sdd-plan-help'},'ปิดสวิตช์เพื่อหยุดรับงานใหม่ หรือใช้ปุ่มพักการส่งด้านบนเพื่อเก็บงานไว้ส่งภายหลัง'),
   h('label',null,h('input',{type:'checkbox',checked:form.dry_run,onChange:e=>change('dry_run',e.target.checked)}),' ทดลองระบบโดยยังไม่อัปเดตเว็บไซต์จริง'),
   h('details',{className:'sdd-cache-advanced',ref:connectionPanel,open:!data.credentials_ready||undefined},
    h('summary',null,'การเชื่อมต่อ Cloudflare'),
    h('p',{role:'status'},data.live_verified?'ตรวจการเชื่อมต่อแล้ว'+(data.connection?.verified_at?' · '+displayDate(data.connection.verified_at):''):verification==='recheck_required'?'ต้องตรวจการเชื่อมต่ออีกครั้ง':'ยังไม่ได้ตรวจการเชื่อมต่อ'),
    h('label',null,'Zone ID',h('input',{type:'text',value:zone,autoComplete:'off',spellCheck:false,'aria-describedby':'sdd-cache-zone-help',onChange:e=>setZoneDraft(e.target.value)})),
    h('p',{id:'sdd-cache-zone-help',className:'sdd-plan-help'},'คัดลอก Zone ID จากหน้า Overview ของโดเมนใน Cloudflare ช่องนี้ใช้ Zone ID ของเว็บไซต์'),
    h('label',null,'API Token',h('input',{type:'password',value:token,autoComplete:'new-password','aria-describedby':'sdd-cache-token-help',placeholder:data.connection?.has_token?'บันทึก Token ไว้แล้ว':'วาง API Token',onChange:e=>setToken(e.target.value)})),
    h('p',{id:'sdd-cache-token-help',className:'sdd-plan-help'},'ให้สิทธิ์ Cache Purge เฉพาะเว็บไซต์นี้ เว้นว่างเพื่อตรวจ Token ที่บันทึกไว้'),
    h('button',{type:'button',onClick:connect},busy==='connect'?'กำลังตรวจการเชื่อมต่อ…':'ตรวจการเชื่อมต่อและบันทึก')),
   h('details',{className:'sdd-cache-advanced'},
    h('summary',null,'หน้าที่อัปเดต'),
    h('p',{className:'sdd-plan-help'},'ครอบคลุมการแก้ราคาผ่าน SoundDD รวมถึงตอนโปรเริ่มและหมดเวลา ระบบรวมหน้าสินค้า หน้าร้าน หมวดหมู่ และหน้าแรก'),
    data.discovered_pages?.length>0&&h('details',null,h('summary',null,'หน้าที่ตรวจพบอัตโนมัติ '+data.discovered_pages.length+' หน้า'),
     h('ul',null,data.discovered_pages.map(item=>h('li',{key:item.url},h('a',{href:item.url,target:'_blank',rel:'noopener noreferrer'},item.title||item.url))))),
    h('label',null,'URL หน้าพิเศษเพิ่มเติม (ใส่ URL ละ 1 บรรทัด)',
     h('textarea',{rows:4,value:extraText,onChange:e=>{setExtraDraft(e.target.value);setMessage('');}})),
    h('p',{className:'sdd-plan-help'},'เพิ่มเฉพาะหน้าที่ระบบตรวจไม่พบ ราคาที่พิมพ์ในข้อความหรือรูปภาพต้องแก้ที่หน้านั้น')),
   h('button',{type:'button',className:'sdd-primary',disabled:!hasChanges,onClick:save},busy==='save'?'กำลังบันทึก…':'บันทึกการอัปเดตหน้าร้าน')));
}
function mergeLiveRows(rows,update){
 const changed=new Map(update.items.map(r=>[r.id,r])),missing=new Set(update.unavailable);
 return rows.filter(r=>!missing.has(r.id)).map(row=>{
  const next=changed.get(row.id);if(!next)return row;
  if(Object.keys(row.revisions||{}).some(field=>BigInt(next.revisions?.[field]||'0')<BigInt(row.revisions[field]||'0')))return row;
  return {...row,...next,latest_change:next.latest_change??row.latest_change};
 });
}
function applyPriceRow(row,id,field,value,revision,result){
 if(row.id!==id||BigInt(row.revisions[field]||'0')>BigInt(revision||'0'))return row;
 const coherent=result?.revisions&&['regular_price','sale_price','sale_dates'].every(key=>BigInt(result.revisions[key]||'0')>=BigInt(row.revisions[key]||'0'));
 return {...row,[field]:value,revisions:{...row.revisions,[field]:revision},
  ...(coherent&&typeof result.current_price==='string'?{current_price:result.current_price}:{}),
  ...(result?.event_id&&result.changed_at?{latest_change:result.changed_at}:{}),
  ...(result?.temporary_sale?{temporary_sale:result.temporary_sale}:{})};
}
const signalDraft=id=>window.dispatchEvent(new CustomEvent('sdd:draft-update',{detail:String(id)}));
const stock = {instock:'มีสินค้า', outofstock:'สินค้าหมด', onbackorder:'สั่งจองได้'};
const labels = {regular_price:'ราคาปกติ',sale_price:'ราคาโปร',stock_status:'สถานะ',sale_dates:'วันราคาโปร'};
const uuid = () => crypto.randomUUID();
let nonce = cfg.nonce;
let showConfirmation,confirmationPending=false;
const confirmChange=(text,options={})=>{if(confirmationPending||!showConfirmation)return Promise.resolve(false);confirmationPending=true;return new Promise(resolve=>showConfirmation({text,...options,resolve:answer=>{confirmationPending=false;resolve(answer);}}));};
let importLeaveGuard=null;
async function allowImportLeave(){return importLeaveGuard?importLeaveGuard():true;}
async function navigateFromImport(action){if(await allowImportLeave()){action();return true;}return false;}
const canonicalPrice=value=>/^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(value)?value.replace(/,/g,''):value;
const displayPrice=value=>/^(0|[1-9][0-9]{0,14})$/.test(value)?BigInt(value).toLocaleString('en-US'):value;
function editPrice(event,change){
 const input=event.target,text=input.value,caret=input.selectionStart??text.length,digits=(text.slice(0,caret).match(/[0-9]/g)||[]).length;
 const type=event.nativeEvent?.inputType||'',data=event.nativeEvent?.data;
 const generated=(type==='insertText'&&typeof data==='string'&&/^[0-9]$/.test(data))||type.startsWith('delete');
 const value=canonicalPrice(generated?text.replace(/,/g,''):text);change(value);
 if(/^(0|[1-9][0-9]{0,14})$/.test(value))requestAnimationFrame(()=>{if(document.activeElement!==input)return;const shown=displayPrice(value);let count=0,pos=0;while(pos<shown.length&&count<digits){if(/[0-9]/.test(shown[pos]))count++;pos++;}input.setSelectionRange(pos,pos);});
}
function scheduleLabel(value){return (value||'|').split('|').map(token=>!token?'ไม่กำหนด':/^-?[0-9]+$/.test(token)?promoTime(token):displayDate(token)).join(' → ');}
class ApiError extends Error { constructor(data,status) { super(data.message || 'เกิดข้อผิดพลาด'); this.code=data.code; this.data=data.data || {}; this.status=status; } }
let connectionError=null,nonceRefreshPromise=null;
function pauseConnection(error){
 if(connectionError)return;
 connectionError=new ApiError({code:'session_unavailable',message:error.message},error.status||403);
 window.dispatchEvent(new CustomEvent('sdd:connection-error',{detail:error}));
}
async function responseJSON(response,write=false){
 let data;
 try{data=JSON.parse(await response.text());}catch(e){/* HTML error/login pages must never reach the JSON parser message in the UI. */}
 if(!data||typeof data!=='object'||Array.isArray(data)){
  const denied=[401,403].includes(response.status);
  throw new ApiError({code:write?'operation_unknown':denied?'request_blocked':'invalid_response',message:denied?'เซิร์ฟเวอร์ปฏิเสธการเชื่อมต่อ (HTTP '+response.status+') กรุณาเชื่อมต่อใหม่ หากยังพบปัญหา ให้ผู้ดูแลตรวจระบบป้องกันของเว็บไซต์':write?'เซิร์ฟเวอร์ตอบกลับไม่ครบถ้วน ยังยืนยันผลบันทึกไม่ได้ กรุณาตรวจผลคำสั่งเดิมก่อนทำต่อ':'เซิร์ฟเวอร์ตอบกลับในรูปแบบที่ไม่รองรับ กรุณาลองใหม่'},response.status);
 }
 return data;
}
async function renewNonce(){
 if(nonceRefreshPromise)return nonceRefreshPromise;
 nonceRefreshPromise=(async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await fetch(cfg.ajax+'?action=sdd_session',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
   const data=await responseJSON(response);
   if(!response.ok||!data.success||typeof data.data?.nonce!=='string'||!data.data.nonce)throw new ApiError({code:'session_unavailable',message:data.data?.message||'ไม่สามารถต่ออายุการเชื่อมต่อได้ กรุณาเข้าสู่ระบบอีกครั้งแล้วกดเชื่อมต่อใหม่'},response.status);
   if(String(data.data.user_id)!==String(cfg.userId))throw new ApiError({code:'session_changed',message:'บัญชีที่เข้าสู่ระบบเปลี่ยนไป กรุณาเปิดหน้าปลั๊กอินใหม่ก่อนแก้ไขสินค้า'},403);
   nonce=data.data.nonce;
  }catch(e){if(e instanceof ApiError)throw e;throw new ApiError({code:'session_unavailable',message:'ไม่สามารถต่ออายุการเชื่อมต่อได้ กรุณาตรวจอินเทอร์เน็ตแล้วกดเชื่อมต่อใหม่'},0);}
  finally{clearTimeout(timer);}
 })();
 try{return await nonceRefreshPromise;}finally{nonceRefreshPromise=null;}
}
async function api(path, body, retry=true) {
 if(connectionError)throw connectionError;
 const multipart=typeof FormData!=='undefined'&&body instanceof FormData;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000),sentNonce=nonce;
 let response,data;
 try{
  response=await fetch(cfg.api+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'X-WP-Nonce':sentNonce,...(multipart?{}:{'Content-Type':'application/json'})},body:multipart?body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
  data=await responseJSON(response,body!==undefined&&!(multipart&&path==='promotion-import'));
 }catch(e){if([401,403].includes(e.status))pauseConnection(e);if(e instanceof ApiError)throw e;const write=body!==undefined&&!(multipart&&path==='promotion-import');throw new ApiError({code:write?'operation_unknown':'network_unavailable',message:write?'ยังไม่ได้รับผลบันทึก กรุณาตรวจสถานะคำสั่งเดิมก่อนทำต่อ':'เชื่อมต่อไม่สำเร็จหรือใช้เวลานานเกินไป กรุณากดรีเฟรชเพื่อลองอีกครั้ง'},0);}
 finally{clearTimeout(timer);}
 if(!response.ok){
  // Only WordPress's explicit nonce rejection proves a write was not executed.
  if(response.status===403&&data.code==='rest_cookie_invalid_nonce'&&retry){
   try{if(nonce===sentNonce)await renewNonce();}catch(e){pauseConnection(e);throw e;}
   return api(path,body,false);
  }
  const error=new ApiError(data,response.status);
  if(response.status===401||data.code==='rest_cookie_invalid_nonce'||(response.status===403&&typeof data.code!=='string'))pauseConnection(error);
  throw error;
 }
 const freshNonce=response.headers.get('X-WP-Nonce');
 if(freshNonce&&nonce===sentNonce)nonce=freshNonce;
 return data;
}
const datePart=token=>{
 if(!token || /^\d{4}-\d{2}-\d{2}(T|$)/.test(token))return token.slice(0,10);
 const tz=cfg.timezone||'UTC';
 const offset=/^([+-])(\d{2}):(\d{2})$/.exec(tz);
 const date=new Date(Number(token)*1000+(offset?(offset[1]==='-'?-1:1)*(Number(offset[2])*60+Number(offset[3]))*60000:0));
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:offset?'UTC':tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
 const part=t=>parts.find(p=>p.type===t).value;
 return part('year')+'-'+part('month')+'-'+part('day');
};
const datePair=value=>(value||'|').split('|').map(datePart);
const showValue=(v,f)=>f==='sale_dates'?scheduleLabel(v):f==='stock_status'?(stock[v]||v):v===''?'—':/^\d+$/.test(v)?BigInt(v).toLocaleString('en-US'):v;
function Cell({row,field,onSaved,canWrite}) {
 const key=row.id+':'+field;
 const [,render]=useState(0); const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;const changed=e=>{if(e.detail===row.id)render(x=>x+1);};window.addEventListener('sdd:draft-update',changed);return()=>{mounted.current=false;window.removeEventListener('sdd:draft-update',changed);};},[row.id]);
 let d=drafts.get(key);
 if (!d) { d={value:row[field],base:row[field],revision:row.revisions[field],generation:0,state:'clean',message:'',operation:null,conflict:null}; drafts.set(key,d); }
 if(d.recovering){Object.assign(d,{base:row[field],value:row[field],revision:row.revisions[field],generation:0,sentGeneration:0,recovering:false});}
 if (d.state==='clean' && !d.busy) { d.value=row[field];d.base=row[field];d.revision=row.revisions[field]; }
 if(['dirty','error'].includes(d.state)&&!d.busy&&(d.base!==row[field]||d.revision!==row.revisions[field])){d.state='conflict';d.conflict={current_value:row[field],current_revision:row.revisions[field],changed_by:null,changed_at:null};d.message='มีข้อมูลใหม่ ตรวจราคาปัจจุบันก่อนบันทึก';}
 const refresh=()=>{if(mounted.current)render(x=>x+1);};
 function clearCommand(){
  rememberPriceCommand(key,d.operation?.operation_id,true);
  d.operation=null;d.canAbandon=false;
 }
 function surfaceOtherCommand(){
  const next=pendingPriceCommands().find(command=>command.key===key);
  if(next){d.operation={operation_id:next.operation_id};d.sentGeneration=d.generation;d.state='unknown';d.canAbandon=false;d.message='ยังมีอีกคำสั่งในช่องนี้ กรุณาตรวจผลเดิม';}
 }
 const applyResult=(result,generation)=>{
  d.base=result.new_value;d.revision=result.revision;clearCommand();d.conflict=null;
  if(d.generation===generation){d.value=result.new_value;d.state='clean';d.message='บันทึกแล้ว';}else{d.state='dirty';d.message='ค่าที่พิมพ์ใหม่ยังไม่ได้บันทึก';}
  surfaceOtherCommand();
  markCachePending(row.id,result.noop);
  onSaved(row.id,field,result.new_value,result.revision,result);refresh();
 };
 async function inspect() {
  if(!d.operation || d.busy)return;d.busy=true;
  try {const response=await api('operations/'+d.operation.operation_id);
   if(response.result?.ok){applyResult(response.result,d.sentGeneration);}
   else if(response.result?.code){fail(new ApiError(response.result,response.result.data?.status||400));clearCommand();surfaceOtherCommand();}
   else{d.canAbandon=false;d.state='unknown';d.message='ยังยืนยันผลบันทึกไม่ได้ ให้ผู้ดูแลตรวจสอบรายการเดิมก่อนบันทึกอีกครั้ง';}
  }catch(e){d.state='unknown';d.canAbandon=e.status===404&&e.code==='not_found';d.message=d.canAbandon?'ยังไม่พบคำสั่งนี้ในระบบ ตรวจอีกครั้ง หรือยกเลิกคำสั่งที่ยังไม่เริ่ม':'ตรวจผลไม่ได้: '+e.message;}
  finally{d.busy=false;refresh();signalDraft(row.id);}
 }
 async function abandon(){
  if(!d.canAbandon||d.busy||!d.operation)return;
  if(!await confirmChange('ระบบจะยกเลิกได้เมื่อคำสั่งนี้ยังไม่มีผลบันทึก ราคาที่ใช้อยู่จะคงเดิม',{title:'ยกเลิกคำสั่งที่ยังไม่เริ่ม?',confirmLabel:'ยืนยันยกเลิกคำสั่ง'}))return;
  d.busy=true;
  try{
   const result=await api('products/'+row.id+'/commands/'+d.operation.operation_id+'/abandon',{confirmed:true});
   if(result.cancelled){clearCommand();d.state='clean';d.message='ยกเลิกคำสั่งเดิมแล้ว';surfaceOtherCommand();}
  }catch(e){d.canAbandon=false;d.message=e.message;}
  finally{d.busy=false;refresh();signalDraft(row.id);}
 }
 function fail(e) {
  if(!(e instanceof ApiError)){d.state='unknown';d.message='การเชื่อมต่อขาดหาย ผลบันทึกยังไม่แน่ชัด';return;}
  if(e.code==='field_conflict'){d.state='conflict';d.conflict=e.data;d.message='ข้อมูลเปลี่ยนแล้ว';}
  else if(e.code==='operation_unknown'){d.state='unknown';d.message=e.message;}
  else{d.state='error';d.message=e.message+(e.data.request_id?' · '+e.data.request_id:'');}
 }
 async function commit() {
  if((canWrite&&!canWrite()) || d.busy || d.state==='unknown' || d.state==='conflict' || d.value===d.base)return;
  if(field!=='stock_status' && field!=='sale_dates' && !((field==='sale_price'&&d.value==='') || /^(0|[1-9][0-9]{0,14})$/.test(d.value))){d.state='error';d.message='กรอกราคาเป็นจำนวนเต็มไม่เกิน 15 หลัก เช่น 14,900 โดยไม่ใส่ทศนิยม';refresh();return;}
  if(!d.operation){
   const acks=[];
   if(field==='sale_dates'){
    if(!await confirmChange('วันราคาโปร ของ '+row.name+'\n'+showValue(d.base,field)+' → '+showValue(d.value,field)+'\nเขตเวลา '+(cfg.timezone||'UTC')+' · วันใหม่เริ่ม 00:00 / สิ้นสุด 23:59:59\nเปลี่ยนหรือล้างวันอาจทำให้โปรเริ่มหรือหยุดทันที ยืนยันบันทึก?')){d.state='dirty';refresh();return;}
    acks.push('schedule_change');
   } else if(field!=='stock_status'){
    if(!await confirmChange(labels[field]+' ของ '+row.name+'\n'+showValue(d.base,field)+' → '+showValue(d.value,field)+(row.type==='bundle'?'\nรายการนี้เปลี่ยนราคาฐานของชุด':'')+(row.bundle_item_pricing?'\nราคาสินค้าในชุดยังบวกเพิ่มตามการตั้งค่า':'')+(d.value==='0'?'\nคำเตือน: ราคาจะเป็นศูนย์':'')+(['active','future'].includes(row.sale_schedule?.state)?'\nคงวันโปรเดิม: '+showValue(row.sale_dates,'sale_dates')+' ('+(cfg.timezone||'UTC')+')'+(row.sale_schedule.state==='active'?'\nโปรกำลังทำงาน: การเปลี่ยนราคาอาจมีผลทันที':'\nโปรอนาคต: ราคาโปรจะใช้ตามวันเริ่มเดิม'):'')+(row.sale_schedule?.state==='expired'?'\nเวลาโปรเดิมหมดอายุแล้ว ('+displayDate(row.sale_schedule.to)+')\nระบบคงเวลาเดิม: แก้ราคาโปรแล้วโปรจะยังไม่เริ่มใหม่ หากต้องการเริ่มโปรเดิมอีกครั้ง ให้แก้วันโปรใน WooCommerce':'')+(['pending','active'].includes(row.temporary_sale?.status)?'\nมีโปรชั่วคราวอยู่: การแก้ราคาจะหยุดการคืนอัตโนมัติให้ตรวจสอบ':'')+'\nยืนยันบันทึกราคานี้?')){d.state='dirty';refresh();return;}
    acks.push('price_change');if(row.sale_schedule?.state==='expired')acks.push('expired_schedule');if(d.value==='0')acks.push('zero_price');
   }
   if(!mounted.current||(canWrite&&!canWrite()))return;
   d.operation={operation_id:uuid(),field,value:d.value,base_value:d.base,base_revision:d.revision,acknowledgements:acks};d.sentGeneration=d.generation;
  }
  rememberPriceCommand(key,d.operation.operation_id);
  d.busy=true;d.state='saving';d.message='กำลังบันทึก';refresh();
  try{const result=await api('products/'+row.id+'/field',d.operation);applyResult(result,d.sentGeneration);}
  catch(e){fail(e);if(d.state!=='unknown')rememberPriceCommand(key,d.operation?.operation_id,true);if(e instanceof ApiError && ![401,403,429,503].includes(e.status) && e.code!=='operation_unknown'){d.operation=null;}}
  finally{d.busy=false;refresh();signalDraft(row.id);}
 }
 function change(value){d.value=value;d.generation++;if(d.state!=='saving'&&d.state!=='unknown'&&d.state!=='conflict'){d.state=value===d.base?'clean':'dirty';d.operation=null;d.message='';}refresh();signalDraft(row.id);}
 function reset(){if(d.busy||d.state==='unknown')return;d.value=d.base;d.operation=null;d.state='clean';d.message='ยกเลิกการแก้ไขแล้ว';refresh();signalDraft(row.id);}
 function useCurrent(){if(!d.conflict)return;d.base=d.conflict.current_value;d.revision=d.conflict.current_revision;d.value=d.base;d.state='clean';d.conflict=null;d.operation=null;d.message='ใช้ค่าปัจจุบันแล้ว';onSaved(row.id,field,d.base,d.revision);refresh();}
 function rebase(){d.base=d.conflict.current_value;d.revision=d.conflict.current_revision;d.conflict=null;d.operation=null;d.state='dirty';d.message='ตรวจค่าแล้ว กดบันทึกเพื่อยืนยันจากข้อมูลล่าสุด';onSaved(row.id,field,d.base,d.revision);refresh();}
 const readonly=!row.editable[field];
 if(readonly)return h('div',{className:'sdd-cell'},h('span',{className:'sdd-static'},showValue(row[field],field)),h('div',{className:'sdd-cell-message'},(row.field_readonly_reasons?.[field]||[]).join(' · ')));
 const inputProps={'data-sdd-field':field,value:field==='stock_status'?d.value:displayPrice(d.value),'aria-label':labels[field]+' '+row.name,'aria-invalid':d.state==='error',disabled:d.state==='unknown',onChange:e=>field==='stock_status'?change(e.target.value):editPrice(e,change),onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();commit();}if(e.key==='Escape'){e.preventDefault();reset();}},className:'sdd-input '+d.state,style:field==='stock_status'?undefined:{'--sdd-price-width':Math.max(120,displayPrice(d.value).length*9+20)+'px'}};
 return h('div',{className:'sdd-cell'},field==='sale_dates'?h('div',{className:'sdd-date-pair'},['เริ่ม','สิ้นสุด'].map((label,i)=>h('label',{key:label},label,h('input',{type:'date',value:datePair(d.value)[i],min:'1000-01-01',max:'9999-12-31','aria-label':label+'ราคาโปร '+row.name,disabled:d.busy||d.state==='unknown'||d.state==='conflict',onChange:e=>{const parts=d.value.split('|');parts[i]=e.target.value;change(parts.join('|'));}}))),h('small',null,'เวลา '+(cfg.timezone||'UTC')),h('button',{type:'button',disabled:d.busy||d.state==='unknown'||d.state==='conflict',onClick:()=>change('|')},'ล้างวันโปร')):field==='stock_status'?h('select',{...inputProps,onChange:e=>change(e.target.value)},Object.entries(stock).map(([v,label])=>h('option',{key:v,value:v},label))):h('input',{...inputProps,type:'text',inputMode:'numeric',placeholder:'—',maxLength:19}),
  d.message&&h('div',{className:'sdd-cell-message','aria-live':'polite'},d.message),
  ['dirty','error'].includes(d.state)&&h('button',{type:'button',className:'sdd-small',onMouseDown:e=>e.preventDefault(),onClick:commit},'บันทึก'),
  ['dirty','error'].includes(d.state)&&h('button',{className:'sdd-small',onMouseDown:e=>e.preventDefault(),onClick:reset},'ยกเลิก'),
  d.state==='unknown'&&h('button',{className:'sdd-small',onClick:inspect},'ตรวจผลคำสั่ง'),d.state==='unknown'&&d.canAbandon&&h('button',{className:'sdd-small',onClick:abandon},'ยกเลิกคำสั่งที่ยังไม่เริ่ม'),
  d.state==='error'&&d.operation&&h('button',{className:'sdd-small',onClick:inspect},'ตรวจผลก่อนลองใหม่'),
  d.state==='conflict'&&h('div',{className:'sdd-conflict'},'ปัจจุบัน '+showValue(d.conflict.current_value,field)+' / ที่พิมพ์ '+showValue(d.value,field),h('button',{onClick:useCurrent},'ใช้ค่าปัจจุบัน'),h('button',{onClick:rebase},'เก็บค่าที่พิมพ์ไว้และตรวจใหม่')));
}
function Setup({onClose,onSaved,jobId}){
 const [settings,setSettings]=useState(null),[terms,setTerms]=useState([]),[selected,setSelected]=useState(new Set()),[enableAck,setEnableAck]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState(''),[busy,setBusy]=useState(false),[search,setSearch]=useState(''),[health,setHealth]=useState(null),[healthError,setHealthError]=useState(''),[healthBusy,setHealthBusy]=useState(true);
 const [settingsLoading,setSettingsLoading]=useState(true),[settingsError,setSettingsError]=useState(''),[termsLoading,setTermsLoading]=useState(true),[termsError,setTermsError]=useState('');
 const settingsGeneration=useRef(0);
 const loadSettings=async()=>{const generation=++settingsGeneration.current;setSettingsLoading(true);setSettingsError('');try{const result=await api('settings');if(generation===settingsGeneration.current){setSettings(result);setSelected(new Set((result.settings.brand_ids||[]).map(String)));}}catch(e){if(generation===settingsGeneration.current)setSettingsError(e.message);}finally{if(generation===settingsGeneration.current)setSettingsLoading(false);}};
 const healthGeneration=useRef(0);
 const loadHealth=async()=>{const generation=++healthGeneration.current;setHealthBusy(true);try{const result=await api('health');if(generation===healthGeneration.current){setHealth(result);setHealthError('');}}catch(e){if(generation===healthGeneration.current){setHealthError(e.message);}}finally{if(generation===healthGeneration.current)setHealthBusy(false);}};
 useEffect(()=>{let live=true;loadSettings();(async()=>{let result=[],page=1,pages=1;do{const r=await api('brand-terms?page='+page);result.push(...r.items);pages=r.pages;page++;}while(page<=pages&&page<=20);return result;})().then(t=>{if(live)setTerms(t);}).catch(e=>{if(live)setTermsError(e.message);}).finally(()=>{if(live)setTermsLoading(false);});loadHealth();return()=>{live=false;settingsGeneration.current++;healthGeneration.current++;};},[]);
 const stopped=settings?settings.settings.write_stop!==false:null;
 const blockers=[...new Set([...(settings&&!settings.schema_ready?['โครงสร้างฐานข้อมูลยังไม่พร้อม']:[]),...(health?.enable_reasons||[])])];
 const checking=settingsLoading||healthBusy,unavailable=!!settingsError||!!healthError;
 const canEnable=!!settings&&!!health&&!checking&&!unavailable&&!blockers.length&&enableAck;
 async function persist(values,message){setBusy(true);setError('');setSuccess('');try{const updated=await api('settings',values);setSettings(updated);if('brand_ids' in values)setSelected(new Set((updated.settings.brand_ids||[]).map(String)));setSuccess(message);onSaved();await loadHealth();return true;}catch(e){const reasons=e.data?.blockers||[];setError(e.message+(reasons.length?' · '+reasons.join(' · '):''));await loadHealth();return false;}finally{setBusy(false);}}
 async function save(){return persist({brand_ids:[...selected]},'บันทึกการตั้งค่าแบรนด์แล้ว โดยคงสถานะการแก้ไขเดิม');}
 async function enableEditing(){if(!enableAck){setError('ทำเครื่องหมายยืนยันก่อนเปิดให้แก้ไขสินค้า');return;}if(blockers.length){setError('ยังเปิดให้แก้ไขไม่ได้: '+blockers.join(' · '));return;}if(!await confirmChange('กำลังเปิดสิทธิ์แก้ไขสินค้าและราคาให้ผู้ใช้ที่มีสิทธิ์\nก่อนยืนยัน โปรดตรวจว่า backup และขั้นตอนกู้คืนพร้อมแล้ว\nยืนยันเปิดให้แก้ไขสินค้า?'))return;const ok=await persist({write_stop:false,local_ack:true},'เปิดให้แก้ไขสินค้าแล้ว');if(ok)setEnableAck(false);}
 async function pauseEditing(){if(!await confirmChange('หยุดการแก้ไขสินค้าและราคาไว้ชั่วคราวหรือไม่? ผู้ใช้ยังดูข้อมูลได้ แต่จะบันทึกไม่ได้ และโปรจะหยุดเริ่มหรือคืนราคาอัตโนมัติจนกว่าจะเปิดอีกครั้ง',{title:'หยุดการแก้ไขและงานราคา',confirmLabel:'ยืนยันหยุดชั่วคราว'}))return;await persist({write_stop:true},'หยุดการแก้ไขสินค้าแล้ว');setEnableAck(false);}
 const visibleTerms=terms.filter(t=>t.name.toLowerCase().includes(search.toLowerCase()));
 const allVisibleSelected=visibleTerms.length>0&&visibleTerms.every(t=>selected.has(t.id));
 return h('section',{className:'sdd-setup','aria-label':'ตั้งค่า'},h('header',{className:'sdd-setup-heading'},h('div',null,h('h2',null,'ตั้งค่าการใช้งาน'),h('p',null,'ตั้งค่าแบรนด์ ตรวจความพร้อม และควบคุมการแก้ไขสินค้า'))),
 error&&h('p',{role:'alert',className:'sdd-error'},error),success&&h('p',{role:'status',className:'sdd-success'},success),
 h('section',{className:'sdd-setup-card sdd-write-control','aria-labelledby':'sdd-write-heading'},h('div',{className:'sdd-write-header'},h('div',null,h('h3',{id:'sdd-write-heading'},'สถานะการแก้ไข'),h('p',null,'เมื่อปิดอยู่ ยังดูข้อมูลได้ แต่บันทึกราคาและสต็อกไม่ได้ รวมถึงหยุดการเริ่มและคืนราคาโปรอัตโนมัติจนกว่าจะเปิดอีกครั้ง')),h('span',{className:'sdd-write-pill '+(!settings?'neutral':stopped?'paused':'enabled'),role:'status'},!settings?(settingsLoading?'กำลังอ่านสถานะ…':'ยังอ่านสถานะไม่ได้'):stopped?'ปิดการแก้ไข':'เปิดให้แก้ไขแล้ว')),
 settingsError&&h('div',{role:'alert',className:'sdd-readiness blocked'},h('p',null,'อ่านการตั้งค่าไม่สำเร็จ · '+settingsError),h('button',{disabled:settingsLoading,onClick:loadSettings},'ลองอ่านการตั้งค่าอีกครั้ง')),
 !settings&&!settingsError&&h('p',{className:'sdd-readiness neutral',role:'status'},'กำลังอ่านการตั้งค่า ยังไม่มีการเปลี่ยนสถานะการแก้ไข'),
 settings&&(!cfg.canManageCache?h('p',null,'ติดต่อผู้ดูแลเว็บไซต์เพื่อเปิดหรือหยุดการแก้ไข'):stopped?h(wp.element.Fragment,null,
 h('div',{className:'sdd-readiness '+(checking?'neutral':unavailable||blockers.length?'blocked':'ready'),role:'status'},h('strong',null,checking?'กำลังตรวจความพร้อม…':unavailable?'ยังตรวจความพร้อมไม่ได้':blockers.length?'ยังเปิดไม่ได้':'ผ่านเงื่อนไขระบบ'),
 checking?h('p',null,'รอผลตรวจสักครู่ ยังไม่มีการเปลี่ยนการตั้งค่า'):unavailable?h('div',null,h('p',null,healthError||settingsError),h('button',{onClick:()=>{loadSettings();loadHealth();}},'ลองตรวจความพร้อมอีกครั้ง')):blockers.length?h('ul',null,blockers.map((reason,i)=>h('li',{key:reason+i},reason))):h('p',null,'ระบบพร้อมในส่วนที่ปลั๊กอินตรวจได้ โปรดตรวจ backup และวิธีกู้คืนของร้านด้วย')),
 h('label',{className:'sdd-enable-ack'},h('input',{type:'checkbox',checked:enableAck,disabled:busy||checking||unavailable||!!blockers.length,onChange:e=>setEnableAck(e.target.checked)}),' ฉันตรวจสอบ backup และเข้าใจว่าการเปิดนี้อนุญาตให้ผู้มีสิทธิ์แก้ไขข้อมูลสินค้า'),h('button',{type:'button',className:'sdd-primary',disabled:busy||!canEnable,onClick:enableEditing},busy?'กำลังตรวจและบันทึก…':'เปิดให้แก้ไขสินค้า')):h('div',{className:'sdd-write-actions'},h('p',null,'ผู้ใช้ที่มีสิทธิ์สามารถแก้ไขสินค้าได้'),h('button',{type:'button',className:'sdd-danger-button',disabled:busy||settingsLoading||!!settingsError,onClick:pauseEditing},busy?'กำลังบันทึก…':'หยุดการแก้ไขชั่วคราว')))),
 h('section',{className:'sdd-setup-card','aria-labelledby':'sdd-environment-heading'},h('div',{className:'sdd-card-heading'},h('h3',{id:'sdd-environment-heading'},'สภาพแวดล้อม'),h('span',{className:'sdd-setup-version'},'ปลั๊กอิน '+(health?.version||settings?.version||'—'))),h('div',{className:'sdd-environment-grid'},[['PHP',health?.runtime?.php||settings?.php],['WordPress',health?.runtime?.wordpress],['WooCommerce',health?.runtime?.woocommerce],['สกุลเงิน',settings?.currency],['ภาษี',settings?(settings.prices_include_tax?'รวมภาษี':'ไม่รวมภาษี'):null],['เขตเวลา',health?.runtime?.timezone]].map(([label,value])=>h('div',{key:label},h('span',null,label),h('strong',null,value||'กำลังอ่าน…')))),h('div',{className:'sdd-schema-state'},h('span',{className:'sdd-status '+(!settings?'neutral':settings.schema_ready?'active':'needs_review')},'ฐานข้อมูล '+(settings?(settings.schema_ready?'พร้อม':'ไม่พร้อม'):'กำลังตรวจ')))),
 h('section',{className:'sdd-setup-card sdd-brand-settings','aria-labelledby':'sdd-brands-heading'},h('div',{className:'sdd-card-heading'},h('h3',{id:'sdd-brands-heading',tabIndex:-1},'แท็กแบรนด์'),h('span',{className:'sdd-term-count'},'เลือก '+selected.size+' / '+terms.length)),h('p',null,'เลือกแท็กที่ใช้เป็นแบรนด์สำหรับค้นหาและกรองสินค้า การเปลี่ยนแปลงนี้ไม่ย้ายหรือลบแท็ก'),!cfg.canManageCache&&h('p',null,'อ่านอย่างเดียว · ติดต่อผู้ดูแลเว็บไซต์เพื่อเปลี่ยนแท็กแบรนด์'),h('div',{className:'sdd-term-controls'},h('input',{'aria-label':'ค้นหาแท็กแบรนด์',value:search,onChange:e=>setSearch(e.target.value),placeholder:'พิมพ์ชื่อแบรนด์เพื่อค้นหา…'}),h('button',{type:'button',disabled:busy||!cfg.canManageCache||!terms.length,'aria-pressed':allVisibleSelected,onClick:()=>{setSelected(prev=>{const next=new Set(prev);visibleTerms.forEach(t=>allVisibleSelected?next.delete(t.id):next.add(t.id));return next;});}},allVisibleSelected?(search?'ยกเลิกผลที่แสดง':'ยกเลิกทั้งหมด'):(search?'เลือกผลที่แสดง':'เลือกทั้งหมด'))),h('div',{className:'sdd-terms'},visibleTerms.map(t=>h('label',{key:t.id},h('input',{type:'checkbox',checked:selected.has(t.id),disabled:busy||!cfg.canManageCache,onChange:e=>{const next=new Set(selected);e.target.checked?next.add(t.id):next.delete(t.id);setSelected(next);}}),' '+t.name)),!visibleTerms.length&&h('p',{className:'sdd-empty'},termsLoading?'กำลังโหลดแท็กแบรนด์…':termsError?'ยังอ่านแท็กแบรนด์ไม่ได้ · '+termsError:terms.length?'ไม่พบแบรนด์ที่ตรงกับคำค้น':'ยังไม่มีแท็กแบรนด์ในระบบ'))),
 cfg.canManageCache&&h(CacheSettings,{jobId}),h(HealthPanel,{data:health,error:healthError,busy:healthBusy,onRefresh:loadHealth,stopped}),cfg.canLogs&&h(LogViewer),h('div',{className:'sdd-actions'},h('button',{className:'sdd-primary',disabled:busy||settingsLoading||!!settingsError||!settings||!cfg.canManageCache,onClick:save},busy?'กำลังบันทึก…':'บันทึกการตั้งค่าแบรนด์'),h('button',{onClick:onClose,disabled:busy},'กลับตาราง')));
}
function downloadLogCsv(data){
 const columns=['เวลา (UTC)','ระดับ','เหตุการณ์','Request ID'];
 const quote=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
 const rows=[columns,...data.items.map(item=>[item.occurred_at,item.level,item.event,item.request_id||''])];
 const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
 const url=URL.createObjectURL(blob),anchor=document.createElement('a');
 anchor.href=url;anchor.download=(String(data.id||'sdd-log').replace(/[^a-z0-9_.-]/gi,'_')||'sdd-log')+'.csv';
 document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function LogViewer(){
 const [files,setFiles]=useState([]),[selected,setSelected]=useState(''),[data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[tick,setTick]=useState(0);
 useEffect(()=>{let live=true;setBusy(true);api('logs').then(r=>{if(live){setFiles(r.items||[]);setError('');}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[tick]);
 useEffect(()=>{let live=true;if(!selected){setData(null);return()=>{live=false;};}setBusy(true);api('logs/'+encodeURIComponent(selected)).then(r=>{if(live){setData(r);setError('');}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[selected]);
 const options=files.map(f=>h('option',{key:f.id,value:f.id},displayDate(f.created_at)+' · '+(f.size_bytes<1024?'น้อยกว่า 1 KB':Math.round(f.size_bytes/1024)+' KB')));
 const current=data?.id===selected?data:null;
 const entries=current&&h('div',{className:'sdd-log-entries'},data.items.map((item,i)=>h('article',{key:item.occurred_at+'-'+i,className:'sdd-log-entry'},h('span',{className:'sdd-status needs_review'},item.level),h('strong',null,item.event),h('time',null,displayDate(item.occurred_at)),item.request_id&&h('code',null,item.request_id))),!data.items.length&&h('p',null,'ไม่มีเหตุการณ์ที่แสดงได้ในไฟล์นี้'),data.truncated&&h('small',null,'ไฟล์มีเหตุการณ์มากกว่าที่หน้าแสดง รายการที่ดาวน์โหลดอาจไม่ครบทั้งไฟล์'));
 return h('section',{className:'sdd-health sdd-log-viewer','aria-label':'บันทึกเหตุการณ์ทางเทคนิค'},
  h('div',{className:'sdd-inspection-heading'},h('h3',null,'บันทึกเหตุการณ์ทางเทคนิค'),h('button',{disabled:busy,onClick:()=>{setSelected('');setData(null);setTick(t=>t+1);}},busy?'กำลังอ่าน…':'โหลดรายการใหม่')),
  h('p',null,'สำหรับผู้ดูแลตรวจปัญหาของ SoundDD · เก็บไฟล์ 30 วัน · แสดงเฉพาะข้อมูลที่จำเป็น ไม่เกิน 200 เหตุการณ์ต่อไฟล์'),
  error&&h('p',{role:'alert',className:'sdd-error'},error),
  h('label',null,'ไฟล์ log ',h('select',{value:selected,onChange:e=>setSelected(e.target.value)},h('option',{value:''},files.length?'เลือกไฟล์':'ไม่พบไฟล์ log'),options)),
  current&&h('div',{className:'sdd-log-download-row'},h('button',{type:'button',className:'sdd-secondary',disabled:busy||!data.items.length,onClick:()=>downloadLogCsv(data)},'ดาวน์โหลด CSV'),h('span',null,data.truncated?'ดาวน์โหลดเฉพาะรายการที่แสดง':'ดาวน์โหลดเหตุการณ์ที่ผ่านการกรองทั้งหมดในไฟล์นี้')),
  entries);
}
const promoLabels={pending:'รอเริ่ม',active:'กำลังใช้',needs_review:'ต้องตรวจสอบ',restored:'คืนราคาแล้ว',cancelled:'ปิดรายการแล้ว',missed:'เลยเวลาเริ่ม'};
function HealthPanel({data,error,busy,onRefresh,stopped}){
 const queueNames={unresolved_operations:'รายการที่ยังไม่ทราบผล',external_pending:'การเปลี่ยนข้อมูลที่รอประมวลผล',promotions_review:'โปรที่ต้องตรวจสอบ',live_promotions:'โปรที่รอเริ่มหรือกำลังใช้'};
 const cronNames={sdd_feed_publish:'เผยแพร่การเปลี่ยนแปลง',sdd_external_drain:'ประมวลผลการแก้จากภายนอก',sdd_temporary_sale_scan:'ตรวจเวลาโปรชั่วคราว',sdd_log_retention:'ลบไฟล์ log ที่เกิน 30 วัน',sdd_business_retention:'ลบประวัติและรายการดำเนินการที่จบแล้วเกิน 90 วัน'};
 return h('section',{className:'sdd-health','aria-label':'สถานะระบบ'},h('div',{className:'sdd-inspection-heading'},h('div',null,h('h3',null,'รายละเอียดการตรวจระบบ'),data?.server_time&&h('small',{className:'sdd-health-checked'},'ตรวจล่าสุด '+displayDate(data.server_time))),h('button',{disabled:busy,onClick:onRefresh},busy?'กำลังตรวจ…':'ตรวจอีกครั้ง')),busy&&!data&&h('p',{role:'status'},'กำลังอ่านสถานะระบบ…'),error&&h('p',{role:'alert',className:'sdd-error'},error),data&&h(wp.element.Fragment,null,h('div',{className:'sdd-health-grid'},(data.checks||[]).map(c=>{const statusLabel=c.key==='writer'&&stopped&&!(data.enable_reasons||[]).length?'ปิดตามการตั้งค่า':({ok:'พร้อม',blocked:'ต้องแก้ก่อนเปิด',warning:'ควรตรวจสอบ'})[c.state];return h('div',{key:c.key,className:'sdd-health-check '+c.state},h('div',{className:'sdd-health-check-heading'},h('strong',null,c.label),h('span',{className:'sdd-status '+(c.state==='ok'?'active':c.state==='blocked'?'needs_review':'expired')},statusLabel)),h('p',null,c.detail));})),h('h4',null,'งานที่รอดำเนินการ'),h('div',{className:'sdd-health-queues'},Object.entries(data.queues||{}).map(([key,q])=>h('p',{key},queueNames[key]||key,': ',h('strong',null,q.count===null?'อ่านไม่ได้':q.count+(q.at_least?'+':''))))),h('small',null,'แสดงไม่เกิน 100 รายการต่อคิว; 100+ คืออย่างน้อย 101 รายการ'),h('h4',null,'งานอัตโนมัติ'),h('ul',null,(data.cron||[]).map(c=>h('li',{key:c.job},cronNames[c.job]||c.job,': ',c.next_at?displayDate(c.next_at):'ยังไม่มีนัดหมาย',c.state==='warning'?' · ยังไม่พร้อม':c.state==='idle'?' · ยังไม่จำเป็นตอนนี้':' · มีนัดหมาย'))),h('p',{className:'sdd-plan-help'},data.cron_note,data.wp_cron_disabled?' · ปิด WP-Cron อยู่ ให้ผู้ดูแลตรวจระบบเรียกงานของเซิร์ฟเวอร์':''),h('p',{className:'sdd-warning'},'ข้อมูลนี้แสดงความพร้อมที่ปลั๊กอินตรวจได้ ตารางงานที่มีนัดหมายยังไม่ยืนยันว่ารันสำเร็จ และไม่ได้ตรวจการกู้คืน backup')));
}
function AuditPanel({productId,onClose,onRollback,initialField='',eventId}){
 const [input,setInput]=useState(productId||''),[id,setId]=useState(productId||''),[field,setField]=useState(initialField),[cursors,setCursors]=useState(()=>[eventId?String(BigInt(eventId)+1n):'']),[tick,setTick]=useState(0),[data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const before=cursors[cursors.length-1];
 useEffect(()=>{let live=true;if(!id)return;setBusy(true);setData(null);setError('');api('audit?'+new URLSearchParams({product_id:id,field,before,per_page:'20'})).then(r=>{if(live)setData(r);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[id,field,before,tick]);
 function search(){if(!/^[1-9][0-9]{0,17}$/.test(input.trim())){setData(null);setError('กรอกรหัสสินค้า หรือรหัสตัวเลือกสินค้า เป็นตัวเลขเท่านั้น');return;}setId(input.trim());setCursors(['']);setTick(t=>t+1);setError('');}
 const sources={inline:'แก้รายสินค้า',temporary_sale_created:'ตั้งโปรล่วงหน้า',inline_edit:'แก้รายสินค้า',bulk_action:'แก้หลายรายการ',rollback:'ย้อนคืน',external_hook:'ช่องทางภายนอก',external_detected:'ตรวจพบค่าภายนอก',woo_schedule:'ตารางโปร WooCommerce',temporary_sale:'โปรชั่วคราว',temporary_start:'เริ่มโปรชั่วคราว',temporary_restore:'คืนโปรชั่วคราว',temporary_reprice:'แก้ราคาโปรชั่วคราว',sale_plan:'ตั้งโปร'};
 const rows=data&&data.items.map(e=>{const login=e.actor_login||(e.user_id?'บัญชี #'+e.user_id:'ระบบ / ช่องทางภายนอก');return h('tr',{key:e.id,'aria-current':String(e.id)===eventId?'true':undefined},h('td',null,String(e.id)===eventId&&h('strong',null,'เหตุการณ์ที่เลือก'),displayDate(e.created_at),h('small',null,'Event #'+e.id)),h('td',null,labels[e.field]||(e.field==='temporary_sale'?'แผนโปรชั่วคราว':e.field),h('small',null,sources[e.source]||e.source)),h('td',null,h('strong',null,e.source==='temporary_sale_created'?'บันทึกแผนแล้ว · รอเวลาเริ่ม':showValue(e.old_value,e.field)+' → '+showValue(e.new_value,e.field)),h('small',null,'Revision '+e.revision_before+' → '+e.revision_after)),h('td',{className:'sdd-audit-actor'},h('strong',null,login),e.actor_email&&h('small',null,e.actor_email),e.user_id&&!e.actor_login&&h('small',null,'ไม่พบข้อมูลบัญชีผู้ใช้'),h('details',null,h('summary',null,'รหัสสำหรับตรวจสอบ'),h('small',null,'Request: '+e.request_id),e.operation_id&&h('small',null,'Operation: '+e.operation_id),e.reverts_event_id&&h('small',null,'ย้อน Event #'+e.reverts_event_id)),cfg.canRollback&&onRollback&&['regular_price','sale_price'].includes(e.field)&&h('button',{type:'button',onClick:()=>onRollback(String(e.id))},'ตรวจสอบก่อนย้อนราคา')));});
 return h('section',{className:'sdd-audit','aria-label':'ประวัติการแก้ไข'},
  h('div',{className:'sdd-inspection-heading'},h('h2',null,'ประวัติการแก้ไข'),h('button',{onClick:onClose},'กลับตาราง')),
  h('p',null,'กรอกรหัสสินค้าเพื่อดูการแก้ไขที่ผ่านมา รวมการแก้จากช่องทางอื่นที่ระบบตรวจพบ แสดงเฉพาะสินค้าที่คุณมีสิทธิ์ดู'),
  h('div',{className:'sdd-audit-tools'},h('label',null,'ID สินค้า / ตัวเลือกสินค้า',h('input',{'aria-label':'ID สินค้าสำหรับดูประวัติ',value:input,inputMode:'numeric',maxLength:18,onChange:e=>setInput(e.target.value),onKeyDown:e=>{if(e.key==='Enter')search();}})),h('button',{className:'sdd-primary',disabled:busy,onClick:search},'ดูประวัติ'),h('label',null,'ช่องที่แก้',h('select',{'aria-label':'กรองช่องในประวัติ',value:field,onChange:e=>{setField(e.target.value);setCursors(['']);}},h('option',{value:''},'ทุกช่อง'),Object.entries(labels).filter(([key])=>['regular_price','sale_price','sale_dates','stock_status'].includes(key)).map(([key,label])=>h('option',{key,value:key},label))))),
  busy&&h('p',{role:'status'},'กำลังอ่านประวัติ…'),error&&h('p',{role:'alert',className:'sdd-error'},error),
  data&&h(wp.element.Fragment,null,h('h3',null,data.product.name+' · #'+data.product.id),h('div',{className:'sdd-tablewrap'},h('table',null,h('thead',null,h('tr',null,['เวลา','ช่อง / ช่องทาง','ก่อน → หลัง','ชื่อบัญชี / อีเมล'].map(t=>h('th',{key:t},t)))),h('tbody',null,rows,!data.items.length&&h('tr',null,h('td',{colSpan:4,className:'sdd-empty'},'ยังไม่มีประวัติที่เก็บไว้สำหรับสินค้านี้'))))),h('div',{className:'sdd-pagination'},h('button',{disabled:busy||cursors.length<=1,onClick:()=>setCursors(c=>c.slice(0,-1))},'ประวัติก่อนหน้า'),h('span',null,'หน้า '+cursors.length),h('button',{disabled:busy||!data.next_before,onClick:()=>setCursors(c=>[...c,data.next_before])},'ดูรายการเก่ากว่า'))));
}
const promoDrafts=new Map();
function displayDate(value,kind='datetime'){
 if(value===null||value===undefined||value==='')return '—';
 const wall=/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(String(value));
 const tz=cfg.timezone||'UTC',offset=/^([+-])(\d{2}):(\d{2})$/.exec(tz);
 const numeric=/^-?\d+(?:\.\d+)?$/.test(String(value));
 const date=wall?new Date(Date.UTC(+wall[1],+wall[2]-1,+wall[3],+(wall[4]||0),+(wall[5]||0))):new Date(numeric?Number(value)*(Math.abs(Number(value))<1e12?1000:1):value);
 if(!Number.isFinite(date.getTime()))return '—';
 if(!wall&&offset)date.setTime(date.getTime()+(offset[1]==='-'?-1:1)*(Number(offset[2])*60+Number(offset[3]))*60000);
 const options={timeZone:wall||offset?'UTC':tz,calendar:'buddhist',numberingSystem:'latn'};
 const day=new Intl.DateTimeFormat('th-TH',{...options,day:'numeric',month:'short',year:'numeric'}).format(date);
 const time=new Intl.DateTimeFormat('th-TH',{...options,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
 return kind==='date'?day:kind==='time'?time:day+' · '+time;
}
const promoTime=value=>displayDate(value);
function originalScheduleState(dates,now){
 const [from,to]=(dates||'|').split('|'),start=Number(from),end=Number(to);
 if(!from&&!to)return {label:'ไม่ตั้งวัน',className:'none'};
 if(from&&to&&start>end)return {label:'ตรวจวันโปร',className:'needs_review'};
 if(to&&end<now)return {label:'หมดอายุแล้ว',className:'expired'};
 if(from&&start>now)return {label:'รอเริ่ม',className:'pending'};
 return {label:'อยู่ในช่วงโปรเดิม',className:'active'};
}
function isoDateParts(value){const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(value||'');return m?{year:Number(m[1]),month:Number(m[2]),day:Number(m[3])}:null;}
function isoDate(year,month,day){return year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');}
function DateTimePicker({value,onChange,label,disabled,id,invalid,describedBy,defaultTime='00:00'}){
 const todayISO=localMinute(Date.now()/1000).slice(0,10),today=isoDateParts(todayISO);
 const selected=isoDateParts(value),time=value?.slice(11,16)||defaultTime;
 const monthOf=({year,month})=>({year,month});
 const [open,setOpen]=useState(false),[month,setMonth]=useState(()=>monthOf(selected||today)),[position,setPosition]=useState(null);
 const [focusDay,setFocusDay]=useState('');
 const root=useRef(null),trigger=useRef(null),grid=useRef(null),popover=useRef(null);
 useEffect(()=>{if(open)grid.current?.querySelector('button[tabindex="0"]')?.focus();},[open]);
 useEffect(()=>{if(!open)return;const outside=e=>{if(!root.current?.contains(e.target))setOpen(false);},escape=e=>{if(e.key==='Escape'){e.preventDefault();setOpen(false);trigger.current?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[open]);
 useEffect(()=>{if(!open)return;const place=()=>{const a=trigger.current?.getBoundingClientRect(),p=popover.current?.getBoundingClientRect();if(!a||!p)return;setPosition({left:Math.max(12,Math.min(a.left,window.innerWidth-p.width-12)),top:a.bottom+p.height+12>window.innerHeight?Math.max(12,a.top-p.height-8):a.bottom+8});};const raf=requestAnimationFrame(place);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);return()=>{cancelAnimationFrame(raf);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};},[open,month]);
 const dateLabel=selected?new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(selected.year,selected.month-1,selected.day))):'เลือกวันที่';
 const monthLabel=new Intl.DateTimeFormat('th-TH',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(month.year,month.month-1,1)));
 const firstWeekday=new Date(Date.UTC(month.year,month.month-1,1)).getUTCDay(),daysInMonth=new Date(Date.UTC(month.year,month.month,0)).getUTCDate();
 const moveMonth=delta=>{const d=new Date(Date.UTC(month.year,month.month-1+delta,1));setFocusDay(isoDate(d.getUTCFullYear(),d.getUTCMonth()+1,1));setMonth({year:d.getUTCFullYear(),month:d.getUTCMonth()+1});};
 const chooseDate=date=>onChange(date+'T'+time);
 const setTime=next=>{const date=selected?isoDate(selected.year,selected.month,selected.day):todayISO;onChange(date+'T'+next);};
 const cells=Array.from({length:42},(_,i)=>{const day=i-firstWeekday+1,date=new Date(Date.UTC(month.year,month.month-1,day)),dateISO=isoDate(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate()),inMonth=day>0&&day<=daysInMonth;return {date,dateISO,inMonth,day:date.getUTCDate()};});
 const keyMove=(event,index)=>{const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];if(delta===undefined)return;event.preventDefault();grid.current?.querySelectorAll('button[data-day]')[Math.max(0,Math.min(41,index+delta))]?.focus();};
 return h('div',{className:'sdd-datetime-picker',ref:root},h('button',{type:'button',ref:trigger,id, className:'sdd-datetime-trigger','aria-label':label+': '+(selected?dateLabel+' เวลา '+time:'ยังไม่ได้เลือกวันและเวลา'),'aria-haspopup':'dialog','aria-expanded':open,'aria-invalid':invalid||undefined,'aria-describedby':describedBy,disabled,onClick:()=>{if(!open){setMonth(monthOf(selected||today));setFocusDay(selected?value.slice(0,10):todayISO);}setOpen(v=>!v);}},h('span',{className:'sdd-datetime-trigger-value'},selected?h( wp.element.Fragment,null,h('strong',null,dateLabel),h('span',null,time)):h('span',{className:'sdd-datetime-placeholder'},'เลือกวันและเวลา')),h('span',{className:'sdd-calendar-icon','aria-hidden':'true'},h('svg',{viewBox:'0 0 24 24',focusable:'false'},h('rect',{x:'3.5',y:'5',width:'17',height:'15',rx:'2',fill:'none',stroke:'currentColor',strokeWidth:'1.8'}),h('path',{d:'M7.5 3.5v3M16.5 3.5v3M4 9h16',fill:'none',stroke:'currentColor',strokeWidth:'1.8',strokeLinecap:'round'}),h('path',{d:'M8 12.5h2v2H8zM12 12.5h2v2h-2zM16 12.5h1v2h-1z',fill:'currentColor'})))),
 open&&h('div',{className:'sdd-calendar-popover',ref:popover,style:position?{left:position.left,top:position.top}:undefined,role:'dialog','aria-label':label+' เลือกวันและเวลา'},h('div',{className:'sdd-calendar-head'},h('button',{type:'button','aria-label':'เดือนก่อนหน้า',onClick:()=>moveMonth(-1)},'‹'),h('strong',null,monthLabel),h('button',{type:'button','aria-label':'เดือนถัดไป',onClick:()=>moveMonth(1)},'›')),
 h('div',{className:'sdd-calendar-grid'},['อา','จ','อ','พ','พฤ','ศ','ส'].map((day,i)=>h('span',{key:day+i,className:'sdd-calendar-weekday','aria-hidden':'true'},day))),
 h('div',{className:'sdd-calendar-grid sdd-calendar-days',ref:grid},cells.map((cell,i)=>h('button',{key:cell.dateISO,type:'button','data-day':cell.dateISO,tabIndex:cell.dateISO===focusDay?0:-1,onFocus:()=>setFocusDay(cell.dateISO),className:[cell.inMonth?'':'outside',cell.dateISO===todayISO?'today':'',selected&&cell.dateISO===isoDate(selected.year,selected.month,selected.day)?'selected':''].filter(Boolean).join(' '),'aria-label':new Intl.DateTimeFormat('th-TH',{dateStyle:'full',timeZone:'UTC'}).format(cell.date),'aria-pressed':!!selected&&cell.dateISO===isoDate(selected.year,selected.month,selected.day),onKeyDown:e=>keyMove(e,i),onClick:()=>chooseDate(cell.dateISO)},cell.day))),
 h('div',{className:'sdd-calendar-footer'},h('button',{type:'button',className:'sdd-calendar-today',onClick:()=>{chooseDate(todayISO);setMonth(monthOf(today));setFocusDay(todayISO);}},'วันนี้'),h('label',null,'เวลา',h('input',{type:'time',step:60,value:time,'aria-label':label+' เวลา',onChange:e=>setTime(e.target.value)}))),
 h('div',{className:'sdd-calendar-actions'},h('button',{type:'button',onClick:()=>{onChange('');setOpen(false);trigger.current?.focus();}},'ล้างวันที่'),h('button',{type:'button',className:'sdd-calendar-done',onClick:()=>{setOpen(false);trigger.current?.focus();}},'เสร็จสิ้น'))));
}
function restorationSummary(plan,now=Date.now()/1000){
 const after=plan.revive_expired?plan.original.sale_price:restoredPrice(plan.original,localMinute(plan.ends_at));
 if(plan.status==='restored')return {tone:'success',title:'คืนราคาและตารางเดิมแล้ว',detail:'ระบบบันทึกการคืนราคาสำเร็จแล้ว',after};
 if(plan.status==='needs_review')return {tone:'attention',title:'โปรหยุดรอตรวจสอบ',detail:'ตรวจผลคำสั่งเพื่อดูว่าโปรเริ่มใช้หรือคืนราคาแล้วหรือยัง',after};
 if(plan.status==='cancelled')return {tone:'neutral',title:'ปิดรายการแล้ว',detail:'ดูผลการปิดรายการและราคาปัจจุบันด้านล่าง',after};
 if(plan.status==='missed')return {tone:'attention',title:'โปรนี้ไม่ได้เริ่มตามกำหนด',detail:'ตรวจราคาปัจจุบันและประวัติก่อนทำรายการต่อ',after};
 if(plan.status==='pending'&&Number(plan.starts_at)<now-300)return {tone:'attention',title:'เลยเวลาเริ่มแล้ว ยังไม่ยืนยันการเริ่มโปร',detail:'ตรวจงานอัตโนมัติหรือแจ้งผู้ดูแลก่อนทำรายการซ้ำ',after};
 if(plan.status==='active'&&Number(plan.ends_at)<now-300)return {tone:'attention',title:'เลยเวลาคืนราคาแล้ว กำลังรอตรวจสอบ',detail:'ยังไม่ยืนยันการคืนราคา ตรวจงานอัตโนมัติหรือแจ้งผู้ดูแล',after};
 return {tone:'scheduled',title:'ตั้งให้กลับเป็น '+showValue(after,'sale_price')+' บาทหลังจบ',detail:'กำหนดคืนราคา '+promoTime(plan.ends_at)+' · ดูผลการคืนราคาได้ที่นี่',after};
}
function RestorationCard({plan,currentPrice,automation,onAudit,onCloseReview,onCheck,check,onRestart}){
 const result=restorationSummary(plan);
 const paused=automation?.blocked&&['pending','active'].includes(plan.status);
 const review=plan.status==='needs_review';
 const matchesPlan=review&&typeof currentPrice==='string'&&currentPrice!==''&&currentPrice===result.after;
 const operationLabels={succeeded:'พบผลบันทึกว่าสำเร็จ',failed:'พบผลบันทึกว่าไม่สำเร็จ',unknown:'พบคำสั่ง แต่ยังยืนยันผลไม่ได้',no_record:'ไม่พบผลคำสั่งที่บันทึกไว้'};
 const after=h('span',null,review?'ราคาหลังจบตามแผนเดิม ':'หลังจบตามแผน ',h('b',null,showValue(result.after,'sale_price')+' บาท'));
 const current=(review||typeof currentPrice==='string')&&h('span',null,review?'ราคาในระบบล่าสุด ':'ราคาข้อมูลล่าสุด ',h('b',null,currentPrice?showValue(currentPrice,'sale_price')+' บาท':review?'ยังไม่มีข้อมูลราคา':'— บาท'));
 return h('section',{className:'sdd-restoration-card '+(paused?'attention':result.tone),'aria-label':'การคืนราคาหลังจบโปร'},
  h('span',{className:'sdd-restoration-icon','aria-hidden':'true'},result.tone==='success'?'✓':paused||result.tone==='attention'?'!':'↩'),
  h('div',null,h('strong',null,paused?'งานราคาอัตโนมัติหยุดอยู่':result.title),
   h('p',null,paused?(automation.reason||'ต้องให้ผู้ดูแลเปิดการทำงานอีกครั้ง เพื่อให้ระบบเริ่มและคืนราคาโปรได้'):result.detail),
   plan.status==='restored'&&plan.updated_at&&h('p',null,'บันทึกผลเมื่อ '+promoTime(String(Date.parse(plan.updated_at)/1000))),
   review&&plan.message&&h('p',null,'เหตุผลที่หยุด · '+plan.message),
   h('div',{className:'sdd-restoration-prices'},review?current:after,review?after:current),
   review?h(wp.element.Fragment,null,
    matchesPlan&&h('p',null,'ราคาในระบบตรงกับแผนเดิม แต่ยังต้องตรวจผลคำสั่ง'),
    onCheck&&h('button',{type:'button',className:'sdd-primary',disabled:!!check?.busy,onClick:onCheck},check?.busy?'กำลังตรวจผล…':check?.result?'ตรวจผลอีกครั้ง':'ตรวจผลคำสั่งโปร'),
    check?.error&&h('p',{role:'alert'},check.error),
    check?.result&&h('div',{role:'status'},
     h('ul',{className:'sdd-restoration-steps'},[['start','เริ่มโปร'],['end','คืนราคาหลังจบ']].map(([phase,label])=>h('li',{key:phase},h('b',null,label+' · '),operationLabels[check.result[phase]?.status]||operationLabels.unknown))),
     h('p',null,check.result.end?.status==='succeeded'?'พบหลักฐานว่าการคืนราคาบันทึกสำเร็จแล้ว หากราคาและวันโปรปัจจุบันถูกต้อง ให้ปิดงานได้':'ถ้ายังยืนยันผลไม่ได้ ให้เปิดประวัติราคาแล้วตรวจราคาและวันโปรก่อนตัดสินใจ'),
     h('details',null,h('summary',null,'รหัสคำสั่งสำหรับส่งให้ผู้ดูแล'),[['start','เริ่มโปร'],['end','คืนราคาหลังจบ']].map(([phase,label])=>check.result[phase]?.operation_id&&h('p',{key:phase},label+' ',h('code',null,check.result[phase].operation_id))))),
    !onAudit&&h('p',null,'ให้ผู้ดูแลที่มีสิทธิ์เปิดประวัติราคาตรวจสอบก่อนเลือกว่าจะใช้ราคาไหนต่อ'),
    h('details',null,h('summary',null,'เลือกว่าจะทำอะไรต่อ'),h('ul',{className:'sdd-restoration-steps'},
     h('li',null,h('b',null,'ราคาปัจจุบันถูกต้องแล้ว '),'กดปิดงานเพื่อเก็บราคานี้ไว้'),
     h('li',null,h('b',null,'ราคาปัจจุบันต้องแก้ '),'ตรวจราคาและวันโปรที่ถูกต้องก่อน แล้วปิดงานและแก้สินค้าเอง'),
     h('li',null,h('b',null,'ยังไม่แน่ใจหรือผลคำสั่งไม่ชัด '),'เปิดงานนี้ไว้แล้วส่งให้ผู้ดูแลตรวจผลเดิมก่อนแก้ราคา'))),
    h('p',null,'การปิดงานจะคงราคากับวันโปรที่ใช้อยู่'),
    h('div',{className:'sdd-plan-actions'},
     onRestart&&h('button',{type:'button',className:'sdd-primary',onClick:onRestart},'เตรียมโปรใหม่ '+showValue(plan.price,'sale_price')+' บาท'),
     onAudit&&h('button',{type:'button',onClick:onAudit},'เปิดประวัติราคา'),
     onCloseReview&&h('button',{type:'button',onClick:onCloseReview},'ปิดงานและคงราคาปัจจุบัน')))
   :h('details',null,h('summary',null,'ระบบคืนราคาอย่างไร'),h('p',null,'ระบบเก็บราคาและตารางเดิมไว้ และจะพยายามคืนให้เมื่อครบเวลา โดยไม่ต้องตั้งโปรเดิมใหม่ หากมีการแก้ราคาแทรก ระบบจะหยุดไว้ให้ตรวจสอบเพื่อไม่ทับค่าที่แก้ใหม่ งานอัตโนมัติของเว็บอาจทำให้คืนราคาช้ากว่ากำหนด'))));
}
function promotionDraftError(draft,regular,now){
 if(!/^(0|[1-9][0-9]{0,14})$/.test(draft.price))return ['price','กรอกราคาโปรเป็นจำนวนเต็ม'];
 if(/^[0-9]+$/.test(regular)&&BigInt(draft.price)>=BigInt(regular))return ['price','ราคาโปรต้องต่ำกว่าราคาปกติ '+showValue(regular,'regular_price')+' บาท'];
 if(!draft.start)return ['start','เลือกวันและเวลาเริ่มโปร'];
 if(!draft.end)return ['end','เลือกวันและเวลาสิ้นสุดโปร'];
 if(draft.end<=draft.start)return ['end','เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม'];
 if(draft.end<=now)return ['end','เวลาโปรสิ้นสุดแล้ว เลือกเวลาสิ้นสุดใหม่'];
 return null;
}
function TemporarySale({row,onSaved,canWrite,onAudit}){
 const [data,setData]=useState(null),[working,setBusy]=useState(false),[error,setError]=useState(''),[readError,setReadError]=useState(false),[,render]=useState(0);
 const readGeneration=useRef(0),activeReads=useRef(0);
 const [operationCheck,setOperationCheck]=useState(null);
 const [fieldError,setFieldError]=useState(null);
 const newStart=useRef(null);
 const key=row.id,priceReadonly=row.type==='bundle'?data?.can_edit_price!==true:!row.editable.sale_price; let d=promoDrafts.get(key);
 if(!d){d={price:'',start:'',end:'',revive:false,operation:null,state:'clean'};promoDrafts.set(key,d);}
 const busy=working||d.state==='saving';
 const livePlan=data?.items?.find(p=>['pending','active','needs_review'].includes(p.status));
 useEffect(()=>{if(!livePlan&&!busy&&d.prepared){newStart.current?.querySelector('button:not(:disabled)')?.focus();}},[!!livePlan,busy,d.prepared]);
 const originalDates=livePlan?.original?.sale_dates??data?.baseline?.sale_dates??row.sale_dates??'|';
 const originalState=originalScheduleState(originalDates,Number(data?.server_time||Date.now()/1000));
 const change=(field,value)=>{d[field]=value;d.state='dirty';setFieldError(null);render(x=>x+1);signalDraft(row.id);};
 useEffect(()=>{load();const refresh=()=>{if(!document.hidden&&d.state!=='saving')load(true);};const timer=setInterval(refresh,30000);document.addEventListener('visibilitychange',refresh);return()=>{readGeneration.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[row.id,row.temporary_sale?.status,row.regular_price,row.sale_price,row.sale_dates]);
 useEffect(()=>{const changed=e=>{if(e.detail===row.id)render(x=>x+1);};window.addEventListener('sdd:draft-update',changed);return()=>window.removeEventListener('sdd:draft-update',changed);},[row.id]);
 const load=async(background=false)=>{if(background&&activeReads.current)return false;activeReads.current++;const generation=++readGeneration.current;if(!background)setBusy(true);setReadError(false);try{const latest=await api('products/'+row.id+'/temporary-sales');if(generation!==readGeneration.current)return false;setData(latest);setError('');return true;}catch(e){if(generation===readGeneration.current){setReadError(true);setError('ตรวจข้อมูลล่าสุดไม่สำเร็จ · '+e.message);}return false;}finally{activeReads.current--;if(!background&&generation===readGeneration.current)setBusy(false);}};
 const done=async()=>{d.state='clean';d.operation=null;d.price='';d.start='';d.end='';d.revive=false;d.prepared=false;signalDraft(row.id);await load();onSaved(row.id,'sale_price',row.sale_price,row.revisions.sale_price);};
 async function save(){
  if((canWrite&&!canWrite())||!data?.baseline||data.automation?.reason||busy||readError||d.state==='unknown')return;
  const now=localMinute(Date.now()/1000),validation=promotionDraftError(d,data.baseline.regular_price,now);
  setFieldError(validation);
  if(validation){requestAnimationFrame(()=>document.getElementById('sdd-promo-'+row.id+'-'+validation[0])?.focus());return;}
  if([...drafts.entries()].some(([k,v])=>k.startsWith(row.id+':')&&v.state!=='clean')){setError('บันทึกหรือยกเลิกราคาที่แก้ค้างไว้ของสินค้านี้ ก่อนตั้งโปรชั่วคราว');return;}
  const after=d.revive&&canRevive(data.baseline,d.end)?data.baseline.sale_price:restoredPrice(data.baseline,d.end);
  const summary=row.name+(row.type==='bundle'?'\nราคาโปรฐานของชุด ':'\nราคาโปร ')+showValue(d.price,'sale_price')+' บาท\nเริ่ม '+displayDate(d.start)+' · จบ '+displayDate(d.end)+' ('+(cfg.timezone||'UTC')+')\nหลังจบตามแผน '+showValue(after,'sale_price')+' บาท'+(row.bundle_item_pricing?'\nราคาสินค้าในชุดยังบวกเพิ่มตามการตั้งค่า':'')+'\nระบบเก็บราคาและตารางเดิมไว้เพื่อคืนอัตโนมัติ ดูผลการคืนได้ในรายการโปรนี้'+(d.revive&&canRevive(data.baseline,d.end)?'\nคุณเลือกใช้ราคาโปรเดิมต่อแม้หมดอายุ โดยล้างวันเริ่ม–จบเดิม':'');
  if(!await confirmChange(summary,{title:'ตั้งโปรพร้อมแผนคืนราคา',confirmLabel:'ยืนยันตั้งโปรชั่วคราว'}))return;
  if(d.price==='0'&&!await confirmChange('ราคาโปรเป็นศูนย์ ยืนยันให้สินค้านี้ราคา 0?'))return;
  if(canWrite&&!canWrite())return;
  d.operation={operation_id:uuid(),price:d.price,start:d.start,end:d.end,baseline:data.baseline,confirmed:true,zero_ack:d.price==='0',revive_expired:!!d.revive&&canRevive(data.baseline,d.end)};d.state='saving';setBusy(true);setError('');
  try{await api('products/'+row.id+'/temporary-sales',d.operation);await done();}
  catch(e){if(!(e instanceof ApiError)||e.code==='operation_unknown'){d.state='unknown';setError('ยังยืนยันผลไม่ได้ กดตรวจผลคำสั่งเดิมก่อนตั้งโปรอีกครั้ง');}else{d.state='dirty';d.operation=null;setError(e.message);if(e.code==='field_conflict'){const loaded=await load();setError(e.message+(loaded?' · แสดงราคาเดิมล่าสุดแล้ว กรุณาตรวจและยืนยันใหม่':' · อ่านราคาเดิมล่าสุดไม่สำเร็จ กรุณาลองอีกครั้ง'));}}}
  finally{setBusy(false);render(x=>x+1);signalDraft(row.id);}
 }
 async function inspect(){setBusy(true);try{const r=await api('operations/'+d.operation.operation_id);if(r.status==='succeeded'&&r.result?.ok){await done();}else{setError('ยังยืนยันผลไม่ได้ เก็บรหัส '+d.operation.operation_id+' ให้ผู้ดูแลตรวจสอบ');}}catch(e){setError(e.message+' · เก็บรหัส '+d.operation.operation_id+' ห้ามส่งใหม่');}finally{setBusy(false);}}
 async function checkOperations(p){
  setOperationCheck({id:p.id,busy:true});
  try{
   const result=await api('products/'+row.id+'/temporary-sales/'+p.id+'/review');
   setOperationCheck({id:p.id,result});
  }catch(e){setOperationCheck({id:p.id,error:e.message});}
 }
 async function closePromo(p,prepareNew=false){
  const review=p.status==='needs_review',pending=p.status==='pending',after=p.revive_expired?p.original.sale_price:restoredPrice(p.original,localMinute(Date.now()/1000));
  const title=prepareNew?'ปิดงานเดิมและเตรียมโปรใหม่':review?'ปิดรายการตรวจสอบ':pending?'ยกเลิกโปรที่รอเริ่ม':'จบโปรก่อนกำหนด';
  const message=prepareNew?'โปรเดิมจะไม่ทำงานต่อหลังปิดงาน ระบบจะคงราคาและวันโปรปัจจุบัน จากนั้นจะเปิดร่างโปร '+showValue(p.price,'sale_price')+' บาท ให้เลือกเวลาใหม่ ราคาจะเปลี่ยนเมื่อยืนยันโปรใหม่และถึงเวลาเริ่ม':review?'ปิดงานตรวจสอบแล้วระบบจะคงราคากับวันโปรที่ใช้อยู่ หากต้องแก้ ให้ไปบันทึกในหน้าสินค้าหลังปิดงาน':pending?'ยกเลิกก่อนเริ่ม โดยไม่เปลี่ยนราคาสินค้า':'ระบบจะพยายามคืนราคาเป็น '+showValue(after,'sale_price')+' บาท พร้อมตารางเดิม หากข้อมูลยังตรงกัน';
  if(!await confirmChange(message,{title,confirmLabel:prepareNew?'ปิดงานเดิมและเปิดร่าง':review?'ปิดรายการและคงราคา':pending?'ยืนยันยกเลิกโปร':'ยืนยันจบโปรและคืนราคา'}))return;
  if(canWrite&&!canWrite())return;
  if(prepareNew&&d.state!=='clean')return;
  setBusy(true);try{
   const closed=await api('products/'+row.id+'/temporary-sales/'+p.id+'/cancel',review?{confirmed:true,expected_status:'needs_review'}:{confirmed:true});
   if(prepareNew&&closed.promotion?.status==='cancelled'){
    Object.assign(d,{price:p.price,start:'',end:'',revive:false,prepared:true,state:'dirty'});
    signalDraft(row.id);
   }
   await load();
   if(!prepareNew)onSaved(row.id,'sale_price',row.sale_price,row.revisions.sale_price);
  }catch(e){await load();setError(e.message+' · ตรวจสถานะล่าสุดก่อนทำต่อ');}finally{setBusy(false);}
 }

 const openPlans=(data?.items||[]).filter(p=>['pending','active','needs_review'].includes(p.status));
 const history=(data?.items||[]).filter(p=>!['pending','active','needs_review'].includes(p.status));
 const planDetails=p=>[h('small',{key:'restore'},'คืนเดิม '+showValue(p.original.sale_price,'sale_price')+' · '+showValue(p.original.sale_dates,'sale_dates')+(p.revive_expired?' · เลือกคืนโปรเดิมแม้หมดอายุ: ล้างวันหากหมดอายุเมื่อคืน':' · คืนตารางเดิมตามจริง')),h('small',{key:'message'},p.message)];
 const planTitle=p=>[h('span',{key:'status',className:'sdd-status '+p.status},promoLabels[p.status]||p.status),h('strong',{key:'price'},(row.type==='bundle'?'ราคาโปรฐาน ':'ราคาโปร ')+showValue(p.price,'sale_price')+' บาท'),h('small',{key:'dates',className:'sdd-history-dates'},promoTime(p.starts_at)+' → '+promoTime(p.ends_at))];
 return h('div',{className:'sdd-temporary'},h('div',{className:'sdd-temporary-layout'},
 h('section',{className:'sdd-promo-history','aria-label':'ประวัติโปรชั่วคราว'},h('h3',null,'โปรที่สิ้นสุดในรายการล่าสุด',data&&h('span',{className:'sdd-history-count'},history.length.toLocaleString('th-TH')+' รายการ')),
 h('div',{className:'sdd-history-scroll',tabIndex:0,role:'region','aria-label':'รายการประวัติโปรชั่วคราว'},!data&&h('p',{className:'sdd-plan-help'},readError?'ยังโหลดประวัติไม่ได้':'กำลังโหลดประวัติ…'),data&&!history.length&&h('p',{className:'sdd-plan-help'},'ยังไม่มีประวัติโปรชั่วคราว'),history.map(p=>h('details',{key:p.id,className:'sdd-promotion sdd-history-item'},h('summary',null,planTitle(p),h('span',{className:'sdd-history-more'},'ดูรายละเอียด')),h(RestorationCard,{plan:p,currentPrice:data?.current_price}),planDetails(p))))),
 h('section',{className:'sdd-promo-editor','aria-label':'จัดการโปรชั่วคราว'},h('h3',null,livePlan?'โปรชั่วคราวปัจจุบัน':'ตั้งโปรชั่วคราว'),
 row.bundle_item_pricing&&h('p',{className:'sdd-plan-help'},'ราคาสินค้าในชุดยังบวกเพิ่มตามการตั้งค่า'),
 data?.server_time&&h('p',{className:'sdd-last-loaded'},(readError?'ข้อมูลก่อนหน้า · ตรวจล่าสุด ':'ตรวจสถานะล่าสุด ')+promoTime(data.server_time)+' · ตรวจซ้ำเมื่อเปิดหน้านี้ทุก 30 วินาที'),openPlans.map(p=>h('div',{key:p.id,className:'sdd-promotion sdd-current-promotion'},planTitle(p),p.status==='pending'&&h('p',{role:'status',className:'sdd-plan-help'},p.starts_at>Number(data.server_time)?'บันทึกแผนแล้ว · เริ่ม '+promoTime(p.starts_at):'ถึงเวลาเริ่มตามแผนแล้ว · รอระบบเริ่มใช้ราคาโปร'),h(RestorationCard,{plan:p,currentPrice:data?.current_price,automation:data?.automation,onAudit,onCloseReview:busy||readError||operationCheck?.busy?undefined:()=>closePromo(p),onCheck:()=>checkOperations(p),check:operationCheck?.id===p.id?operationCheck:null,onRestart:p.status==='needs_review'&&!data.automation?.blocked&&!priceReadonly&&!busy&&!readError&&!operationCheck?.busy&&d.state==='clean'?()=>closePromo(p,true):undefined}),p.status!=='needs_review'&&h('button',{disabled:busy||readError,onClick:()=>closePromo(p)},p.status==='pending'?'ยกเลิกโปรที่รอเริ่ม':'จบโปรก่อนกำหนด'))),
 h(livePlan?'details':'div',{className:'sdd-promo-reference'},livePlan&&h('summary',null,'ดูราคาและตารางเดิมที่เก็บไว้'),data?.baseline&&h('strong',null,'ราคาเดิมที่เก็บไว้ · ปกติ '+showValue((livePlan?.original||data.baseline).regular_price,'regular_price')+' · ราคาโปร '+showValue((livePlan?.original||data.baseline).sale_price,'sale_price')),h('div',{className:'sdd-original-schedule',role:'note'},h('div',{className:'sdd-original-schedule-head'},h('span',{className:'sdd-status '+originalState.className},originalState.label)),h('div',{className:'sdd-original-schedule-dates'},h('span',null,'เริ่ม '+(originalDates.split('|')[0]?promoTime(originalDates.split('|')[0]):'ไม่กำหนด')),h('span',null,'สิ้นสุด '+(originalDates.split('|')[1]?promoTime(originalDates.split('|')[1]):'ไม่กำหนด'))),h('small',null,'เลือกวันเริ่ม–สิ้นสุดของโปรชั่วคราวได้เอง โดยไม่เปลี่ยนวันโปรเดิม · ช่องกรอกใช้ปี ค.ศ. เช่น 2026'))),
 busy&&!data&&h('p',{role:'status'},'กำลังอ่านราคาเดิมและประวัติโปร…'),
 data?.automation?.reason&&h('p',{role:'alert',className:'sdd-error'},data.automation.reason),
 data&&!livePlan&&row.type==='bundle'&&priceReadonly&&data.price_reasons?.length>0&&h('p',{role:'status',className:'sdd-plan-help'},data.price_reasons.join(' · ')),
 data&&!livePlan&&d.prepared&&h('p',{role:'status',className:'sdd-plan-help'},'ร่างโปรใหม่พร้อมแล้ว · เลือกวันเริ่มและสิ้นสุด แล้วตรวจสรุปก่อนยืนยัน'),
 data&&!livePlan&&h('div',{className:'sdd-plan-grid'},h('div',null,h('label',{className:'sdd-plan-field'},row.type==='bundle'?'ราคาโปรฐาน (บาท)':'ราคาโปรชั่วคราว (บาท)',h('input',{'aria-label':(row.type==='bundle'?'ราคาโปรฐาน #':'ราคาโปรชั่วคราว #')+row.id,id:'sdd-promo-'+row.id+'-price','aria-invalid':fieldError?.[0]==='price'||undefined,'aria-describedby':fieldError?.[0]==='price'?'sdd-promo-'+row.id+'-price-error':undefined,inputMode:'numeric',maxLength:19,value:displayPrice(d.price),disabled:busy||readError||d.state==='unknown'||priceReadonly,onChange:e=>editPrice(e,v=>change('price',v))}),fieldError?.[0]==='price'&&h('small',{id:'sdd-promo-'+row.id+'-price-error',role:'alert',className:'sdd-error'},fieldError[1])),h('div',{className:'sdd-plan-dates'},['start','end'].map((field,i)=>h('label',{className:'sdd-plan-field sdd-plan-date-field',key:field,ref:i?null:newStart},i?'สิ้นสุดโปรชั่วคราว':'เริ่มโปรชั่วคราว',h(DateTimePicker,{id:'sdd-promo-'+row.id+'-'+field,label:(i?'สิ้นสุด':'เริ่ม')+'โปรชั่วคราว #'+row.id,value:d[field],defaultTime:i?'23:59':'00:00',invalid:fieldError?.[0]===field,describedBy:fieldError?.[0]===field?'sdd-promo-'+row.id+'-'+field+'-error':undefined,disabled:busy||readError||d.state==='unknown'||priceReadonly,onChange:value=>change(field,value)}),fieldError?.[0]===field&&h('small',{id:'sdd-promo-'+row.id+'-'+field+'-error',role:'alert',className:'sdd-error'},fieldError[1])))),h('p',{className:'sdd-plan-help'},'หากเวลาเริ่มผ่านไปแล้ว ระบบจะพยายามเริ่มทันทีหลังยืนยัน · เขตเวลา '+(cfg.timezone||'UTC'))),
 h('div',null,canRevive(data.baseline,d.end)&&h('label',{className:'sdd-revive-choice'},h('input',{type:'checkbox',checked:!!d.revive,disabled:busy||readError||d.state==='unknown'||priceReadonly,onChange:e=>change('revive',e.target.checked)}),' หลังจบโปรชั่วคราว ให้กลับมาใช้ราคาโปรเดิมแม้หมดอายุแล้ว'),h(PlanSummary,{row:{...row,...data.baseline},price:d.price,dates:d.start+'|'+d.end,temporary:true,revive:!!d.revive&&canRevive(data.baseline,d.end)}),h('p',{className:'sdd-plan-help'},'ระบบเก็บราคาและตารางเดิมไว้เพื่อคืนหลังจบ ดูแผนและผลการคืนได้ในรายการโปรนี้'),h('div',{className:'sdd-plan-actions'},h('button',{className:'sdd-primary',disabled:busy||readError||d.state==='unknown'||priceReadonly||!!data.automation?.reason,onClick:save},'ตรวจสรุปโปรชั่วคราว'),d.state!=='unknown'&&h('button',{disabled:busy,onClick:()=>{d.price='';d.start='';d.end='';d.revive=false;d.prepared=false;d.state='clean';setFieldError(null);render(x=>x+1);signalDraft(row.id);}},'ล้างข้อมูลที่กรอก')))),
 d.state==='unknown'&&h('button',{disabled:busy,onClick:inspect},'ตรวจผลคำสั่งโปร'),d.state==='unknown'&&!error&&h('p',{role:'alert',className:'sdd-error'},'ยังไม่ยืนยันผล กดตรวจผลคำสั่งก่อนทำต่อ'),error&&h('p',{role:'alert',className:'sdd-error'},error),readError&&h('button',{disabled:busy,onClick:load},'ลองโหลดข้อมูลอีกครั้ง'))));

}

function localMinute(epoch){
 const tz=cfg.timezone||'UTC',offset=/^([+-])(\d{2}):(\d{2})$/.exec(tz);
 const date=new Date(Number(epoch)*1000+(offset?(offset[1]==='-'?-1:1)*(Number(offset[2])*60+Number(offset[3]))*60000:0));
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:offset?'UTC':tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date),part=k=>parts.find(p=>p.type===k).value;
 return part('year')+'-'+part('month')+'-'+part('day')+'T'+part('hour')+':'+part('minute');
}
function hasOriginalSale(row){return row.sale_price!==''&&row.sale_price!=='0';}
function canRevive(row,end){const to=(row.sale_dates||'|').split('|')[1];return hasOriginalSale(row)&&!!to&&localMinute(to)<=(end||localMinute(Date.now()/1000));}
function referenceAt(row,at){
 return {price:row.regular_price,reason:'ใช้ราคาปกติเป็นราคาอ้างอิง'};
}
function restoredPrice(row,at){const [from,to]=(row.sale_dates||'|').split('|');return hasOriginalSale(row)&&(!from||localMinute(from)<=at)&&(!to||localMinute(to)>=at)?row.sale_price:row.regular_price;}
function PlanSummary({row,price,dates,revive}){
 const [start,end]=(dates||'|').split('|'),now=localMinute(Date.now()/1000),reference=referenceAt(row,start&&start>now?start:now),after=revive?row.sale_price:restoredPrice(row,end||now);
 return h('section',{className:'sdd-plan-summary','aria-label':'สรุปผลโปร'},h('strong',null,row.type==='bundle'?'ราคาฐานและแผนคืนราคา':'ราคาโปรและแผนคืนราคา'),price!==''&&Number(price)>Number(restoredPrice(row,start||now))&&h('p',{className:'sdd-summary-warning'},'ราคาใหม่สูงกว่าราคาก่อนเริ่มตามตารางเดิม '+displayPrice(String(Number(price)-Number(restoredPrice(row,start||now))))) ,
 [['ก่อนเริ่มตามตารางเดิม',restoredPrice(row,start||now)],['ระหว่างโปร',price===''?'':price],['หลังจบตามตารางเดิม',after]].flatMap(([label,value],index)=>[h('div',{className:'sdd-plan-stage',key:label},h('span',null,label),h('strong',null,showValue(value,label==='ราคาปกติ'?'regular_price':'sale_price'))),index<2&&h('span',{className:'sdd-plan-arrow','aria-hidden':true,key:'arrow-'+index},'→')].filter(Boolean)),
 h('div',{className:'sdd-plan-context',role:'group','aria-label':'รายละเอียดราคาอ้างอิง วันโปรเดิม และการคืนราคา'},h('span',null,'ราคาปกติอ้างอิง '+showValue(reference.price,'regular_price')+' บาท · ราคานี้ยังไม่รวมคูปองหรือส่วนลดในตะกร้า'),h('span',null,showValue(dates,'sale_dates')+' · '+(cfg.timezone||'UTC')),h('strong',{className:'sdd-return-plan'},'↩ ตั้งให้กลับเป็น '+showValue(after,'sale_price')+' บาทหลังจบ'),h('details',null,h('summary',null,'ดูเงื่อนไขการคืนราคา'),h('span',null,revive?'คืนโปรเดิมและล้างวันเริ่ม–จบ เพื่อใช้โปรเดิมต่อ':'ระบบเก็บตารางเดิมไว้ หากโปรเดิมหมดอายุแล้วจะใช้ราคาปกติ'),h('span',null,'หากมีการแก้ราคาแทรก ระบบจะหยุดให้ตรวจสอบ และงานอัตโนมัติอาจทำให้คืนราคาช้ากว่ากำหนด'))));
}

function PromotionPanel({row,onSaved,onClose,canWrite,onAudit}){
 return h('section',{id:'sdd-promotion-panel-'+row.id,tabIndex:-1,className:'sdd-promotion-panel','data-sdd-focus-field':'temporary_sale','aria-label':'จัดการโปร #'+row.id},h('div',{className:'sdd-panel-head'},h('div',null,h('h2',null,row.type==='bundle'?'โปรชั่วคราวของชุด · ':'จัดการโปร · ',row.name),h('small',null,'#'+row.id+' · '+(row.sku||'ไม่มี SKU')+' · ราคาปกติ '+showValue(row.regular_price,'regular_price')+' / ราคาโปรที่บันทึก '+showValue(row.sale_price,'sale_price'))),h('button',{onClick:onClose,'aria-label':'ปิดแผงจัดการโปร '+row.name},'ปิดแผง ×')),
 h('aside',{className:'sdd-promo-product-card'},row.thumbnail_url&&h('img',{src:row.thumbnail_url,alt:row.name}),h('span',{className:'sdd-dashboard-eyebrow'},'สินค้าที่กำลังจัดการ'),h('h3',null,row.name),h(CacheUpdateStatus,{id:row.id,detail:true}),h('p',null,'SKU: '+(row.sku||'ไม่ระบุ')+' · #'+row.id),h('span',{className:'sdd-status active'},'เผยแพร่แล้ว'),h('div',{className:'sdd-promo-product-price'},h('span',null,'ราคาปกติอ้างอิง'),h('strong',null,showValue(row.regular_price,'regular_price')+' บาท')),!row.bundle_item_pricing&&h('p',{className:'sdd-plan-help'},'ราคาโปรยังอาจได้รับส่วนลดเพิ่มเติมจากกฎในตะกร้าหรือคูปอง')),cfg.canSettings?h(TemporarySale,{row,onSaved,canWrite,onAudit:cfg.canAudit&&onAudit?()=>onAudit(row.id):undefined}):h('p',{className:'sdd-plan-help'},'เฉพาะผู้ดูแลระบบสามารถตั้งโปรชั่วคราวได้'));
}
function Confirmation({request,onDone}){
 const dialog=useRef(null),cancel=useRef(null);
 useEffect(()=>{dialog.current.showModal();cancel.current.focus();return()=>{if(dialog.current?.open)dialog.current.close();};},[]);
 return h('dialog',{ref:dialog,className:'sdd-confirmation','aria-label':'ยืนยันการเปลี่ยนแปลง',onCancel:e=>{e.preventDefault();onDone(false);}},h('h2',null,request.title||'ยืนยันการเปลี่ยนแปลง'),h('p',null,request.text),h('div',{className:'sdd-plan-actions'},h('button',{ref:cancel,onClick:()=>onDone(false)},request.cancelLabel||'ยกเลิก'),h('button',{className:'sdd-primary',onClick:()=>onDone(true)},request.confirmLabel||'ยืนยันบันทึก')));
}

function priceRange(minimum,maximum){
 return minimum==null||minimum===''?'—':showValue(minimum,'regular_price')+(maximum!=null&&maximum!==''&&maximum!==minimum?' – '+showValue(maximum,'regular_price'):'');
}
function VariablePriceSummary({summary}){
 return h('div',{className:'sdd-variable-price-summary'},h('strong',null,priceRange(summary?.regular_min,summary?.regular_max)),h('small',null,summary?.count?'ช่วงราคาจาก '+summary.count+' ตัวเลือก':'ยังไม่มีข้อมูลราคา'));
}
function StockPill({row}){
 const hasQuantity=Number.isFinite(row.stock_quantity);
 const showStatus=!hasQuantity||row.stock_status!=='instock';
 return h('span',{className:'sdd-stock-pill'+(hasQuantity?' sdd-stock-pill-with-quantity':''),'data-stock-status':row.stock_status},
  showStatus&&showValue(row.stock_status,'stock_status'),
  hasQuantity&&h('span',{className:'sdd-stock-quantity'},row.stock_quantity_shared?'สต๊อกร่วม ':'คงเหลือ ',
   row.stock_quantity.toLocaleString('th-TH',{maximumFractionDigits:20}),row.type==='bundle'?' ชุด':' ชิ้น'));
}
function MobileProductPrices({row}){
 const parent=row.type==='variable',summary=row.variation_summary;
 const current=parent?priceRange(summary?.current_min,summary?.current_max):showValue(row.current_price??'','sale_price');
 return h('div',{className:'sdd-mobile-product-summary'},
  h('span',{className:'sdd-mobile-current-price'},'ราคาในระบบตอนนี้',h('b',null,current,current!=='—'?' บาท':'')),
  h('span',null,parent?'ช่วงราคาปกติ':'ราคาปกติ',h('b',null,parent?priceRange(summary?.regular_min,summary?.regular_max):showValue(row.regular_price,'regular_price'))),
  h('span',null,'ราคาโปรที่บันทึก',h('b',null,parent?'มีโปร '+(summary?.sale_count||0)+' / '+(summary?.count||0)+' ตัวเลือก':showValue(row.sale_price,'sale_price'))),
  row.type==='bundle'||row.stock_by_quantity||Number.isFinite(row.stock_quantity)?h(StockPill,{row}):h('span',null,showValue(row.stock_status,'stock_status')));
}
function VariableSaleSummary({summary}){
 const count=summary?.sale_count||0,total=summary?.count||0;
 return count?h('span',{className:'sdd-variation-sale-summary'},'มีราคาโปร '+count+' / '+total+' ตัวเลือก'):h('span',{className:'sdd-variation-empty','aria-label':'ไม่มีราคาโปร'},'—');
}
function VariableStockSummary({summary}){
 const counts=summary?.stock_counts||{},parts=[['instock','มีสินค้า','instock'],['outofstock','สินค้าหมด','outofstock'],['onbackorder','สั่งจองได้','onbackorder']].filter(([key])=>(counts[key]||0)>0);
 return parts.length?h('div',{className:'sdd-variation-stocks','aria-label':'สรุปสถานะสต็อกตัวเลือก'},parts.map(([key,label,className])=>h('span',{key,className:'sdd-variation-stock '+className},label+' '+counts[key]))):h('span',{className:'sdd-variation-stock-empty'},summary?.count?'ไม่มีข้อมูลสต็อก':'ไม่มีตัวเลือก');
}

function CatalogPromotionTiming({row}){
 const plan=row.temporary_sale;
 if(plan&&['pending','active'].includes(plan.status))return h('small',{className:'sdd-promo-timing'},plan.status==='pending'&&plan.price?'เมื่อโปรเริ่ม '+showValue(plan.price,'sale_price')+' บาท · ':'',(plan.status==='pending'?'เริ่ม ':'สิ้นสุด ')+promoTime(plan.status==='pending'?plan.starts_at:plan.ends_at));
 const schedule=row.sale_schedule;
 if(schedule?.state==='future'&&schedule.from)return h('small',{className:'sdd-promo-timing'},'เริ่ม '+promoTime(Date.parse(schedule.from)/1000));
 if(schedule?.state==='active'&&schedule.to)return h('small',{className:'sdd-promo-timing'},'สิ้นสุด '+promoTime(Date.parse(schedule.to)/1000));
 return null;
}
function ProductRow({row,onSaved,open,onExpand,promoId,onPromo,scope,onAudit,onOpen,canWrite,bulkSelection,onSelectBulk}){
 const parent=row.type==='variable',summary=row.variation_summary,promoOpen=promoId===row.id;
 const bundle=row.type==='bundle';
 const canManageBundlePromo=bundle&&cfg.canSettings&&row.bundle_temp_promo&&row.edit_url;
 const bulkSelected=!!onSelectBulk&&bulkSelection.has(row.id);
 const showBulkCheckbox=!!onSelectBulk&&['simple','variation'].includes(row.type);
 const presence=workspacePresence.get(row.id)||[];
 const promoStatus=row.temporary_sale?h('span',{className:'sdd-status '+row.temporary_sale.status},promoLabels[row.temporary_sale.status]):row.sale_schedule&&row.sale_schedule.state!=='none'?h('span',{className:'sdd-status '+({active:'active',future:'pending',expired:'expired',invalid:'needs_review'}[row.sale_schedule.state]||'')},({active:'โปรกำลังใช้',future:'โปรรอเริ่ม',expired:'โปรเดิมหมดอายุ',invalid:'ตรวจวันโปร'})[row.sale_schedule.state]):!parent&&Number(row.sale_price)>0&&Number(row.sale_price)<Number(row.regular_price)?h('span',{className:'sdd-status active'},'ราคาโปรถาวร'):null;
 return h(wp.element.Fragment,null,h('tr',{'data-product-id':row.id,className:(row.stock_status==='outofstock'?'sdd-out ':row.stock_status==='onbackorder'?'sdd-backorder ':'')+(row.parent_id?'sdd-child ':'')+(promoOpen?'sdd-row-active ':'')+(bulkSelected?'sdd-bulk-selected ':'')+(parent&&open?'sdd-variable-open':'')},
 h('td',{className:'sdd-thumbnail-cell'+(onSelectBulk?' sdd-thumbnail-with-selection':'')},
  h('div',{className:'sdd-catalog-row-media'},
   showBulkCheckbox&&h('label',{className:'sdd-catalog-checkbox'},h('input',{type:'checkbox',checked:bulkSelected,disabled:!bulkSelected&&!row.editable.regular_price&&!row.editable.sale_price,'aria-label':'เลือก '+row.name+' สำหรับแก้หลายรายการ',onChange:e=>onSelectBulk(row,e.target.checked)})),
   row.thumbnail_url?h('img',{src:row.thumbnail_url,alt:'',width:40,height:40,loading:'lazy'}):h('span',{className:'sdd-thumb'},'—'))),
 h('td',{className:'sdd-product'},parent&&h('button',{className:'sdd-expand','aria-expanded':open,'aria-label':(open?'ยุบ':'ขยาย')+'ตัวเลือก #'+row.id,onClick:onExpand},open?'− ยุบตัวเลือก':'+ ดูตัวเลือก ('+(summary?.count||0)+')'),' ',row.edit_url?h('a',{id:'sdd-product-name-'+row.id,href:row.edit_url,target:'_blank',rel:'noopener noreferrer'},row.name):h('span',{id:'sdd-product-name-'+row.id},row.name),
 h('small',null,h('code',null,row.sku||'ไม่มี SKU'),(row.brands.length?' · '+row.brands.join(', '):'')+(summary?' · '+summary.count+' ตัวเลือก':'')),row.attributes&&h('small',{className:'sdd-variation-attributes'},row.attributes),bundle&&h('span',{className:'sdd-catalog-bundle'},row.bundle_item_pricing?'สินค้าชุด · คิดราคาสินค้าในชุดเพิ่ม':'สินค้าชุด'),h(MobileProductPrices,{row}),h(CacheUpdateStatus,{id:row.id,compact:true}),row.latest_change&&h('small',{className:'sdd-latest-change'},'แก้ราคาล่าสุด '+promoTime(Date.parse(row.latest_change)/1000)),h('details',{className:'sdd-product-meta'},h('summary',null,'รายละเอียดสินค้า'),h('small',null,'สินค้า #'+row.id),bundle&&row.edit_url&&h('a',{className:'sdd-wc-link',href:row.edit_url,target:'_blank',rel:'noopener noreferrer'},'แก้ราคาปกติและส่วนประกอบใน WooCommerce'),cfg.canAudit&&h('button',{className:'sdd-audit-row-link',onClick:()=>onAudit(row.id)},'ประวัติราคา')),
 presence.length>0&&h('small',{className:'sdd-presence',role:'status'},presence.map(p=>(p.own_user?'อีกแท็บของคุณ':p.actor)+' กำลังแก้'+(labels[p.field]||'โปรชั่วคราว')).join(' · ')),row.readonly_reasons.length>0&&h('details',null,h('summary',null,'ข้อจำกัดการแก้ไข'),h('small',{className:'sdd-reason'},row.readonly_reasons.join(' · ')),row.edit_url&&!bundle&&!row.stock_by_quantity&&h('a',{className:'sdd-wc-link',href:row.edit_url,target:'_blank',rel:'noopener noreferrer'},'แก้ไขใน WooCommerce ↗'))),
 ['regular_price','sale_price','stock_status'].map(field=>h('td',{key:field,'data-label':labels[field],className:(field==='stock_status'?'sdd-stock-cell':'sdd-price-cell')+(parent?' sdd-aggregate-cell':'')},
  field==='stock_status'?(
   parent?h(wp.element.Fragment,null,h(VariableStockSummary,{summary}),Number.isFinite(row.stock_quantity)&&h(StockPill,{row})):
   bundle||row.stock_by_quantity||Number.isFinite(row.stock_quantity)?h(StockPill,{row}):h(Cell,{row,field,onSaved,canWrite})):
  parent?field==='regular_price'?h(VariablePriceSummary,{summary}):h(VariableSaleSummary,{summary}):
  h(wp.element.Fragment,null,h(Cell,{row,field,onSaved,canWrite}),field==='sale_price'&&row.current_price!=null&&row.current_price!==row.sale_price&&h('small',{className:'sdd-current-system-price'},'ใช้ในระบบตอนนี้ '+showValue(row.current_price,'sale_price')+' บาท')))),
 h('td',{className:'sdd-promo-status'},promoStatus||h('span',{className:'sdd-empty-status','aria-label':'ไม่มีโปรโมชัน'},'—'),h(CatalogPromotionTiming,{row}),row.temporary_sale?.status==='needs_review'&&h('small',{className:'sdd-error'},row.temporary_sale.message)),
 h('td',{className:'sdd-action-cell'},h('div',{className:'sdd-catalog-row-actions'},
  !parent&&(!bundle||row.editable.regular_price||row.editable.sale_price)&&h('button',{className:'sdd-mobile-edit',onClick:()=>onOpen(row.id,bundle&&!row.editable.regular_price?'sale_price':'regular_price')},'เปิดแก้ไขสินค้า →'),
  !parent&&(['simple','variation'].includes(row.type)||canManageBundlePromo)&&h('button',{className:bundle?'sdd-bundle-promo-action':undefined,id:'sdd-promo-toggle-'+row.id,'aria-expanded':promoOpen,'aria-controls':promoOpen?'sdd-promotion-panel-'+row.id:undefined,'aria-label':'จัดการโปร #'+row.id,'aria-describedby':'sdd-product-name-'+row.id,onClick:()=>onPromo(promoOpen?null:row.id)},'จัดการโปร'),
  ((bundle&&!canManageBundlePromo)||parent)&&h('span',{className:'sdd-empty-status','aria-hidden':true},'—')))),
 promoOpen&&h('tr',{className:'sdd-promotion-row','data-promotion-for':row.id},h('td',{colSpan:7},h(PromotionPanel,{row,onSaved,canWrite,onAudit,onClose:()=>{onPromo(null);requestAnimationFrame(()=>document.getElementById('sdd-promo-toggle-'+row.id)?.focus());}}))));
}
function ProductGroup({row,context,onSaved,promoId,onPromo,onAudit,onOpen,canWrite,bulkSelection,onSelectBulk}){
 const [open,setOpen]=useState(false),[page,setPage]=useState(1),[size,setSize]=useState(20),[all,setAll]=useState(false),[data,setData]=useState({items:[],total:0,pages:0}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const filterKey=JSON.stringify({...context,tick:0});
 const params=new URLSearchParams({...context,page,per_page:size,all:all?'1':'0'});
 params.delete('tick');
 const requestKey=row.id+':'+params+':'+context.tick+':'+retry;
 const matches=data.requestKey===requestKey;
 const allowedRequest=useRef(null);
 allowedRequest.current=open&&matches&&!busy&&!error?requestKey:null;
 const canWriteChild=()=>allowedRequest.current===requestKey&&(!canWrite||canWrite());
 useEffect(()=>{const receive=e=>setData(d=>({...d,items:mergeLiveRows(d.items,e.detail)}));window.addEventListener('sdd:workspace-sync',receive);return()=>window.removeEventListener('sdd:workspace-sync',receive);},[]);
 useEffect(()=>{setPage(1);setAll(false);},[filterKey]);
 useEffect(()=>{let live=true;if(!open||row.type!=='variable')return;setBusy(true);setError('');setData({items:[],total:0,pages:0});
  api('products/'+row.id+'/variations?'+params).then(r=>{if(live)setData({...r,requestKey});}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;allowedRequest.current=null;};
 },[open,requestKey]);
 function saved(id,field,value,revision,result){setData(d=>({...d,items:d.items.map(r=>applyPriceRow(r,id,field,value,revision,result))}));onSaved(id,field,value,revision,result);}
 return h(wp.element.Fragment,null,h(ProductRow,{row,onSaved,promoId,onPromo,canWrite,scope:context.scope,onAudit,onOpen,bulkSelection,onSelectBulk,open,onExpand:()=>setOpen(v=>!v)}),open&&row.type==='variable'&&h(wp.element.Fragment,null,
 h('tr',{className:'sdd-child-tools'},h('td',{colSpan:7},h('div',{className:'sdd-child-toolbar'},h('strong',null,'ตัวเลือกสินค้า · '+row.name),h('span',null,all?'แสดงทั้งหมด — อาจอยู่นอกคำค้น/สถานะที่กรอง':'แสดงเฉพาะตัวเลือกที่ตรงคำค้น/ตัวกรอง'),h('button',{onClick:()=>{setAll(v=>!v);setPage(1);}},all?'แสดงเฉพาะที่ตรงตัวกรอง':'แสดงตัวเลือกทั้งหมด'),h('span',null,(busy||(!matches&&!error))?'กำลังโหลด…':matches?data.total+' ตัวเลือก':'ยังโหลดตัวเลือกไม่ได้'),h('button',{disabled:busy||page<=1,onClick:()=>setPage(v=>v-1),'aria-label':'ตัวเลือกก่อนหน้า #'+row.id},'←'),h('span',null,'หน้า '+page+' / '+Math.max(1,data.pages)),h('button',{disabled:busy||page>=data.pages,onClick:()=>setPage(v=>v+1),'aria-label':'ตัวเลือกถัดไป #'+row.id},'→'),h('select',{'aria-label':'จำนวนตัวเลือกต่อหน้า #'+row.id,value:size,onChange:e=>{setSize(Number(e.target.value));setPage(1);}},[20,50,100].map(n=>h('option',{key:n,value:n},n+' / หน้า')))),error&&h('div',null,h('p',{role:'alert',className:'sdd-error'},error),h('button',{type:'button',onClick:()=>setRetry(n=>n+1)},'โหลดตัวเลือกอีกครั้ง')))),
 matches&&data.items.map(child=>h(ProductRow,{key:child.id,row:child,onSaved:saved,promoId,onPromo,canWrite:canWriteChild,scope:context.scope,onAudit,onOpen,bulkSelection,onSelectBulk})),matches&&!busy&&!error&&!data.items.length&&h('tr',null,h('td',{colSpan:7,className:'sdd-empty'},'ไม่พบตัวเลือกที่ตรงเงื่อนไข')),h('tr',{className:'sdd-child-footer'},h('td',{colSpan:7},h('span',null,'สิ้นสุดตัวเลือก · '+row.name),h('button',{'aria-label':'ปิดกลุ่มตัวเลือก #'+row.id,onClick:()=>setOpen(false)},'ยุบตัวเลือก')))));
}
function calendarWeeks(month,items){
 const [year,m]=month.split('-').map(Number),days=new Date(Date.UTC(year,m,0)).getUTCDate(),offset=new Date(Date.UTC(year,m-1,1)).getUTCDay();
 const day=n=>month+'-'+String(n).padStart(2,'0');
 return Array.from({length:Math.ceil((offset+days)/7)},(_,week)=>{
  const first=Math.max(1,week*7-offset+1),last=Math.min(days,week*7-offset+7),lanes=[];
  const segments=items.filter(item=>datePart(String(item.starts_at))<=day(last)&&datePart(String(item.ends_at))>=day(first)).map(item=>{
   const startDate=datePart(String(item.starts_at));
   const start=startDate.slice(0,7)===month?Math.max(first,Number(startDate.slice(-2))):first;
   const end=datePart(String(item.ends_at)).slice(0,7)===month?Math.min(last,Number(datePart(String(item.ends_at)).slice(-2))):last;
   return {item,start,end};
  }).sort((a,b)=>a.start-b.start||b.end-a.end||String(a.item.promotion_id).localeCompare(String(b.item.promotion_id)));
  segments.forEach(segment=>{let lane=lanes.findIndex(end=>end<segment.start);if(lane<0)lane=lanes.length;lanes[lane]=segment.end;segment.lane=lane;segment.column=(segment.start+offset-1)%7+1;});
  return {first,last,dates:Array.from({length:7},(_,col)=>{const n=week*7+col-offset+1;return n>0&&n<=days?day(n):null;}),segments:segments.filter(x=>x.lane<4),hidden:segments.filter(x=>x.lane>=4).length,lanes:Math.min(4,lanes.length)};
 });
}
function CalendarMonth({month,items,selected,today,busy,error,onSelect,onList}){
 return h('div',{className:'sdd-timeline-month'},h('div',{className:'sdd-timeline-weekdays'},['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'].map(day=>h('span',{key:day},day))),calendarWeeks(month,items).map((week,index)=>h('div',{key:index,className:'sdd-timeline-week',style:{minHeight:Math.max(144,52+week.lanes*46)+(week.hidden?30:0)+'px'}},
  week.dates.map((day,col)=>day?h('button',{key:day,className:'sdd-timeline-date'+(day===selected?' is-selected':'')+(day===today?' is-today':''),style:{gridColumn:col+1,gridRow:'1 / span '+(week.lanes+2)},'aria-pressed':day===selected,'aria-label':displayDate(day,'date')+(busy?' กำลังโหลด':error?' อ่านข้อมูลไม่ได้':' เลือกดูโปรในวันนี้'),onClick:()=>onSelect(day)},h('span',null,Number(day.slice(-2)))):h('div',{key:'empty'+col,className:'sdd-timeline-outside',style:{gridColumn:col+1,gridRow:'1 / span '+(week.lanes+2)}})),
  week.segments.map(({item,start,end,lane,column})=>h('button',{key:item.promotion_id,className:'sdd-timeline-bar sdd-calendar-state-'+item.status,style:{gridColumn:column+' / span '+(end-start+1),gridRow:lane+2},title:item.name+' · '+promoLabels[item.status]+' · '+promoTime(item.starts_at)+' → '+promoTime(item.ends_at),onClick:()=>onSelect(month+'-'+String(start).padStart(2,'0'))},h('span',{className:'sdd-timeline-bar-name'},item.name),h('span',{className:'sdd-timeline-bar-meta'},showValue(item.price,'sale_price')+' บาท · '+(promoLabels[item.status]||item.status)))),
  week.hidden>0&&h('button',{className:'sdd-timeline-overflow',style:{gridColumn:'1 / -1',gridRow:week.lanes+2},onClick:onList},'อีก '+week.hidden+' รายการในสัปดาห์นี้ · เปิดรายการทั้งหมด')
 )));
}
function PromotionDuplicateChoice({row,other,busy,onKeep,onChooseAnother}){
 const card=(entry)=>h('div',{key:entry.row},
  h('strong',null,'แถว '+entry.row+' · '+(entry.input||entry.name)),
  h('small',null,'ราคาโปร '+showValue(entry.price,'sale_price')+' บาท'),
  h('small',null,entry.from?entry.from+' ถึง '+entry.until:'โปรถาวร · ไม่มีวันสิ้นสุด'),
  h('button',{type:'button',disabled:busy,onClick:()=>onKeep(entry.row)},'เก็บแถว '+entry.row));
 return h('div',{className:'sdd-import-duplicate'},
  h('strong',null,'แถว '+row.row+' กับแถว '+other.row+' เป็นสินค้าเดียวกัน'),
  h('p',null,other.name),
  h('div',{className:'sdd-import-duplicate-grid'},card(other),card(row)),
  onChooseAnother&&h('button',{type:'button',disabled:busy,onClick:onChooseAnother},'เลือกสินค้าอื่น'));
}
function PromotionImportPicker({batch,row,rows,onSelect,onClose}){
 const [query,setQuery]=useState(row.input||row.name||''),[matches,setMatches]=useState(null),
  [error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [duplicate,setDuplicate]=useState(null);
 const searchInput=useRef(null);
 useEffect(()=>{searchInput.current?.focus();search();},[]);
 async function search(event){
  event?.preventDefault();
  if(busy||query.trim().length<2||query.trim().length>200)return;
  setBusy(true);setError('');setMatches(null);setDuplicate(null);
  try{setMatches(await api('promotion-import/'+batch+'/search?'+new URLSearchParams({q:query.trim(),row:row.row})));}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function select(id,replaceRow){
  setBusy(true);setError('');
  try{await onSelect({row:row.row,product_id:id,...(replaceRow?{replace_row:replaceRow}:{})},replaceRow||null);}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function keep(number){
  if(number===row.row){await select(duplicate.id,duplicate.used_row);return;}
  setBusy(true);setError('');
  try{await onSelect({row:row.row,action:'remove'},row.row);}
  catch(e){setError(e.message);}finally{setBusy(false);}
 }
 const other=duplicate&&rows.find(entry=>entry.row===duplicate.used_row);
 return h('section',{className:'sdd-import-picker','aria-label':'เลือกสินค้าสำหรับแถว '+row.row,'aria-busy':busy},
  h('h3',null,'เลือกสินค้า · แถว '+row.row),
  h('form',{onSubmit:search,className:'sdd-import-actions'},h('label',null,'ชื่อ รุ่น หรือแบรนด์',
   h('input',{type:'search',value:query,ref:searchInput,maxLength:200,disabled:busy,onChange:e=>{setQuery(e.target.value);setMatches(null);setDuplicate(null);}})),
   h('button',{type:'submit',disabled:busy||query.trim().length<2},'ค้นหา'),
   h('button',{type:'button',disabled:busy,onClick:onClose},'ปิดตัวเลือก')),
  error&&h('p',{role:'alert',className:'sdd-error'},error),
  busy&&h('p',{role:'status'},'กำลังดำเนินการ…'),
  other&&h(PromotionDuplicateChoice,{row,other,busy,onKeep:keep,onChooseAnother:()=>{setDuplicate(null);searchInput.current?.focus();}}),
  !other&&matches&&(matches.items.length?h('ul',null,matches.items.map(product=>h('li',{key:product.id},
   h('div',null,h('strong',null,product.name),product.variation&&h('small',null,product.variation),
    h('small',null,'ราคาปัจจุบัน '+showValue(product.price,'sale_price')+' บาท · #'+product.id)),
   product.used_row?h('button',{type:'button',disabled:busy||!rows.some(entry=>entry.row===product.used_row),onClick:()=>setDuplicate(product)},'เทียบกับแถว '+product.used_row):h('button',{disabled:busy,onClick:()=>select(product.id),'aria-label':'เลือก '+product.name},'เลือกสินค้านี้')))):
   h('p',{role:'status'},'ยังไม่พบสินค้า ลองใช้ชื่อรุ่นหรือแบรนด์')),
  matches?.limited&&h('p',null,'ลองระบุชื่อหรือรุ่นให้ละเอียดขึ้นหากไม่พบในรายการ'));
}
const csvFields=['price','from','until'];
function csvRowValues(row){return Object.fromEntries(csvFields.map(key=>[key,String((row.values||row)[key]??'')]));}
function csvRowIdentity(row){return JSON.stringify([row.id??null,row.name,row.current_price??row.price_context??null,row.regular_price??null,csvRowValues(row)]);}
function csvDraftDirty(draft){return !!draft&&(draft.conflict||csvFields.some(key=>draft.values[key]!==draft.base[key]));}
function csvEntries(review){return [...(review?.rows||[]),...(review?.errors||[]).filter(row=>row.values)];}
function mergeCsvDrafts(drafts,review,checked){
 const entries=new Map(csvEntries(review).map(row=>[String(row.row),row]));const next={};
 for(const [number,draft] of Object.entries(drafts)){
  if(!csvDraftDirty(draft))continue;
  const row=entries.get(number);
  if(!row){next[number]={...draft,conflict:true,missing:true};continue;}
  const base=csvRowValues(row),identity=csvRowIdentity(row);
  if(checked&&String(checked.row)===number){
   const values={...draft.values};for(const field of Object.keys(checked.values||{}))values[field]=base[field];
   const merged={...draft,base,identity,values,conflict:false,missing:false};
   if(csvDraftDirty(merged))next[number]=merged;
  }else next[number]={...draft,conflict:draft.conflict||identity!==draft.identity,missing:false};
 }
 return next;
}
function ImportDraftNotice({draft,busy,onResolve,onDiscard}){
 if(!draft?.conflict)return null;
 return h('div',{className:'sdd-import-draft-conflict',role:'status'},h('strong',null,'ข้อมูลแถวนี้เปลี่ยนไป · ยังเก็บค่าที่พิมพ์ไว้'),
  h('p',null,draft.missing?'แถวนี้ไม่อยู่ในผลตรวจล่าสุด': 'ตรวจสินค้าและค่าล่าสุดก่อนนำค่าที่พิมพ์ไปใช้'),
  !draft.missing&&h('button',{type:'button',disabled:busy,onClick:onResolve},'ตรวจข้อมูลล่าสุดและใช้ค่าที่พิมพ์'),
  h('button',{type:'button',disabled:busy,onClick:onDiscard},'ใช้ข้อมูลล่าสุดแทน'));
}
function importPriceLimit(regular){
 if(typeof regular==='string'&&/^[1-9][0-9]{0,14}$/.test(regular)){
  return BigInt(regular)>1n?'ใส่ราคาเต็มบาท 1–'+showValue(String(BigInt(regular)-1n),'sale_price')+' บาท (ต่ำกว่าราคาปกติ)':'ราคาปกติยังไม่รองรับการตั้งราคาโปรเต็มบาทที่มากกว่า 0';
 }
 return regular?'ราคาโปรต้องต่ำกว่าราคาปกติ '+showValue(regular,'regular_price')+' บาท':'ตรวจข้อมูลสินค้าอีกครั้งเพื่อดูราคาปกติ';
}
function PromotionImportCorrection({issue,busy,onCheck,draft,onDraft,onResolve,onDiscard,permanent=false}){
 const [price,setPrice]=useState(issue.values.price);
 const toInput=value=>/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)?value.replace(' ','T'):'';
 const [from,setFrom]=useState(()=>toInput(issue.values.from)),[until,setUntil]=useState(()=>toInput(issue.values.until));
 const priceIssue=issue.edit==='price',issueId='sdd-import-edit-'+issue.row+'-issue';
 const values=draft?.values;
 const shownPrice=values?.price??price,shownFrom=values?toInput(values.from):from,shownUntil=values?toInput(values.until):until;
 const change=(key,value,setter)=>{setter(value);onDraft?.({[key]:key==='price'?value:value.replace('T',' ')});};
 const submit=event=>{
  event.preventDefault();
  if(!busy&&!draft?.conflict)onCheck(priceIssue?{price:shownPrice}:{from:shownFrom.replace('T',' '),until:shownUntil.replace('T',' ')});
 };
 const dateField=(key,label,value,setter)=>h('label',{className:issue.edit===key?'sdd-import-date-error':undefined},label,
  h('input',{type:'datetime-local','aria-label':label+' แถว '+issue.row,
   'aria-describedby':issueId,'aria-invalid':issue.edit===key||undefined,value,required:true,disabled:busy,onChange:e=>change(key,e.target.value,setter)}),
  !value&&issue.values[key]&&h('small',null,'ในไฟล์ (ค.ศ.) '+issue.values[key]));
 return h('tr',{'data-import-row':issue.row},
  h('th',{scope:'row'},issue.row),
  h('td',{className:'sdd-import-correction-product'},h('strong',null,issue.name),h('small',{id:issueId},issue.message),h(ImportDraftNotice,{draft,busy,onResolve,onDiscard})),
  h('td',{className:'sdd-import-current-price'},
   issue.price_context?h(wp.element.Fragment,null,
    h('strong',null,issue.price_context.current!==''?showValue(issue.price_context.current,'sale_price')+' บาท':'ยังไม่กำหนดราคา'),
    h('small',null,'ราคาปกติ '+(issue.price_context.regular!==''?showValue(issue.price_context.regular,'regular_price')+' บาท':'ยังไม่กำหนด'))):
    h('small',null,'ต้องระบุสินค้าให้แน่ชัดก่อนดูราคา')),
  h('td',{className:priceIssue?'sdd-import-cell-error':undefined},
   priceIssue?h('form',{className:'sdd-import-inline-edit',onSubmit:submit},
    h('input',{type:'text',inputMode:'numeric',pattern:'[1-9][0-9]{0,14}',maxLength:15,
     'aria-label':'ราคาโปร แถว '+issue.row,'aria-describedby':issueId,'aria-invalid':true,
     required:true,disabled:busy,value:shownPrice,onChange:e=>change('price',e.target.value,setPrice)}),
    h('button',{type:'submit',disabled:busy||!!draft?.conflict},'ตรวจแถวนี้'),
    h('small',null,importPriceLimit(issue.price_context?.regular)),h('small',null,'ค่าที่ตรวจล่าสุด '+(issue.values.price||'—'))):issue.values.price),
  !permanent&&h('td',null,priceIssue?h('div',{className:'sdd-import-date-summary'},
   h('span',null,'เริ่ม '+displayDate(issue.values.from)),h('span',null,'จบ '+displayDate(issue.values.until))):
   h('form',{className:'sdd-import-inline-edit',onSubmit:submit},
    dateField('from','วันเริ่มโปร (ค.ศ.)',shownFrom,setFrom),dateField('until','วันจบโปร (ค.ศ.)',shownUntil,setUntil),
    h('button',{type:'submit',disabled:busy||!!draft?.conflict},'ตรวจแถวนี้'))));
}
function priceChange(current,target){
 const valid=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,14})$/.test(value);
 if(!valid(current)||!valid(target))return {kind:'unknown',label:'ยังเทียบราคาไม่ได้'};
 const before=BigInt(current),after=BigInt(target),delta=after-before;
 if(delta===0n)return {kind:'same',label:'ราคาเท่าเดิม'};
 const amount=delta<0n?-delta:delta,kind=delta<0n?'decreased':'increased';
 const hundredths=before>0n?(amount*10000n+before/2n)/before:null;
 const percent=hundredths===null?'':' ('+String(hundredths/100n)+(hundredths%100n?'.'+String(hundredths%100n).padStart(2,'0').replace(/0$/,''):'')+'%)';
 return {kind,label:(kind==='decreased'?'ลดลง ':'เพิ่มขึ้น ')+showValue(String(amount),'sale_price')+' บาท'+percent};
}
function ImportPriceSummary({rows,permanent}){
 const counts={decreased:0,increased:0,same:0,unknown:0};for(const row of rows)counts[priceChange(row.current_price,row.price).kind]++;
 const schedules=permanent?rows.filter(row=>row.clears_schedule===true).length:0;
 return h('div',{className:'sdd-import-change-summary'},h('strong',null,'เทียบราคาจากผลตรวจล่าสุด'),h('div',null,
  [['decreased','ลดลง'],['increased','เพิ่มขึ้น'],['same','เท่าเดิม'],['unknown','ยังเทียบไม่ได้']].filter(([key])=>counts[key]>0).map(([key,label])=>h('span',{key,className:'sdd-price-change '+key},label+' '+counts[key]+' รายการ'))),
  schedules>0&&h('p',null,'ล้างวันโปรเดิม '+schedules+' รายการ แม้ราคาเท่าเดิมก็ยังมีการเปลี่ยนตารางโปร'));
}
function PromotionImportReadyRow({row,editing,busy,onEdit,onCancel,onCheck,onChangeProduct,draft,onDraft,onResolve,onDiscard,invalid=false}){
 const [price,setPrice]=useState(row.price),[from,setFrom]=useState(row.from),[until,setUntil]=useState(row.until);
 const formId='sdd-import-ready-edit-'+row.row,limitId=formId+'-limit';
 const values=draft?.values;
 const shownPrice=values?.price??price,shownFrom=values?.from??from,shownUntil=values?.until??until;
 const change=(key,value,setter)=>{setter(value);onDraft?.({[key]:value});};
 const dateInput=(label,key,value,setter)=>h('label',null,label,h('input',{type:'datetime-local',form:formId,
  'aria-label':label+' แถว '+row.row,value:value.replace(' ','T'),required:true,disabled:busy,
  onChange:event=>change(key,event.target.value.replace('T',' '),setter)}));
 const dateLabel=value=>displayDate(value);
 const changeInfo=priceChange(row.current_price,editing?shownPrice:row.price);
 function cancel(){setPrice(row.price);setFrom(row.from);setUntil(row.until);onCancel();}
 return h('tr',{'data-import-row':row.row,className:editing?'sdd-import-row-editing':undefined},
  h('th',{scope:'row'},h('span',{className:'sdd-import-row-number'},row.row),
   editing&&h('small',{className:'sdd-import-editing-label'},'กำลังแก้')),
  h('td',{className:'sdd-import-correction-product'},h('strong',null,row.name),
   row.input&&row.input!==row.name&&h('small',{className:'sdd-import-file-name'},'ในไฟล์ '+row.input),h(ImportDraftNotice,{draft,busy,onResolve,onDiscard}),
   editing&&onChangeProduct&&h('button',{type:'button',className:'sdd-import-text-action',disabled:busy,onClick:onChangeProduct},'เปลี่ยนสินค้า')),
  h('td',{className:'sdd-import-prices-cell'},
   h('div',{className:'sdd-import-price-before'},'ราคาในระบบตอนนี้ ',row.current_price!=null&&row.current_price!==''?showValue(row.current_price,'sale_price')+' บาท':'—'),
   h('div',{className:'sdd-import-regular-price'},'ราคาปกติ ',row.regular_price!=null&&row.regular_price!==''?showValue(row.regular_price,'regular_price')+' บาท':'ยังอ่านไม่ได้'),

   editing?h('form',{id:formId,className:'sdd-import-inline-edit',onSubmit:event=>{
    event.preventDefault();
    if(!busy&&!draft?.conflict)onCheck(row.permanent?{price:shownPrice}:{price:shownPrice,from:shownFrom,until:shownUntil});
   }},
    h('input',{type:'text',inputMode:'numeric',pattern:'[1-9][0-9]{0,14}',maxLength:15,
     'aria-label':'ราคาโปรใหม่ แถว '+row.row,'aria-describedby':limitId,'aria-invalid':invalid||undefined,required:true,value:shownPrice,disabled:busy,onChange:event=>change('price',event.target.value,setPrice)}),
    h('small',{id:limitId,className:'sdd-import-price-limit'},importPriceLimit(row.regular_price)),
    h('button',{type:'submit',disabled:busy||!!draft?.conflict},'ตรวจแถวนี้'),
    h('button',{type:'button',disabled:busy,onClick:cancel},'ยกเลิก')):
   h('div',{className:'sdd-import-new-price-line'+(changeInfo.kind==='same'?' is-unchanged':'')},h('strong',null,h('span',{'aria-hidden':true,className:'sdd-import-price-arrow'},'→ '),(changeInfo.kind==='same'?'ราคาเท่าเดิม ':row.permanent?'ราคาใหม่ ':'ราคาโปรใหม่ ')+showValue(row.price,'sale_price')),
    h('button',{type:'button',className:'sdd-import-text-action',disabled:busy,onClick:onEdit,'data-import-edit':row.row,'aria-label':(row.permanent?'แก้ไขราคา แถว ':'แก้ไขราคาและวันเวลา แถว ')+row.row},'แก้ไข')),
   changeInfo.kind!=='same'&&h('small',{className:'sdd-price-change '+changeInfo.kind},changeInfo.label),
   row.permanent&&row.clears_schedule&&h('small',{className:'sdd-import-schedule-change'},'ล้างวันเริ่ม–จบโปรเดิมเมื่อยืนยัน'),
   !row.permanent&&h('small',{className:'sdd-import-restore-price'},editing?'หลังจบโปร · ตรวจใหม่เมื่อใช้ค่าใหม่':'หลังจบโปรคาดว่า '+showValue(row.after,'sale_price'))),
  !row.permanent&&h('td',null,editing?h('div',{className:'sdd-import-inline-edit'},
   dateInput('วันเริ่มโปร (ค.ศ.)','from',shownFrom,setFrom),dateInput('วันจบโปร (ค.ศ.)','until',shownUntil,setUntil)):
   h('div',{className:'sdd-import-period'},h('span',null,dateLabel(row.from)),h('span',null,'ถึง '+dateLabel(row.until)))));
}
function importElapsedTime(){return typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():Date.now();}
function PromotionImport({onClose,onComplete,closeLabel='กลับปฏิทิน'}){
 const key='sdd-promotion-import-'+cfg.userId;
 const [batch,setBatch]=useState(()=>{try{return sessionStorage.getItem(key)||'';}catch{return '';}}),
  [preview,setPreview]=useState(null),[filename,setFilename]=useState(''),[busy,setBusy]=useState(false),
  [error,setError]=useState(''),[result,setResult]=useState(null),[needsCheck,setNeedsCheck]=useState(!!batch);
 const [editing,setEditing]=useState(null);
 const [mode,setMode]=useState('temporary'),[progress,setProgress]=useState(null);
 const permanent=(preview?.mode||mode)==='permanent';
 const [selecting,setSelecting]=useState(null),[selectionNotice,setSelectionNotice]=useState('');
 const [rowDrafts,setRowDrafts]=useState({}),[expired,setExpired]=useState(false),[recovering,setRecovering]=useState(!!batch),[expiryWarning,setExpiryWarning]=useState(false),[errorRow,setErrorRow]=useState(null);
 const [history,setHistory]=useState(null);
 const input=useRef(null),heading=useRef(null),matchedHeading=useRef(null),root=useRef(null);
 const engine=useRef({live:true,generation:0,busy:false,batch,preview:null,drafts:{},clock:null,expiryChecked:false});
 const state=engine.current;state.preview=preview;state.drafts=rowDrafts;
 const dirtyRows=Object.keys(rowDrafts).filter(number=>csvDraftDirty(rowDrafts[number]));
 const step=result?3:preview||batch?2:1;
 function focusHeading(){requestAnimationFrame(()=>heading.current?.focus());}
 function focusReview(){requestAnimationFrame(()=>{const target=state.preview?.errors.length?heading.current:matchedHeading.current||heading.current;target?.focus();});}
 function focusRow(number,mode='input'){requestAnimationFrame(()=>{if(!state.live)return;const row=root.current?.querySelector('[data-import-row="'+number+'"]');const target=mode==='edit'?row?.querySelector('[data-import-edit]'):row?.querySelector('[aria-invalid="true"]')||row?.querySelector('input:not(:disabled)');target?.focus({preventScroll:true});target?.scrollIntoView?.({block:'nearest'});});}
 function commitDrafts(next){state.drafts=next;setRowDrafts(next);}
 function updateDraft(row,patch){
  const number=String(row.row),existing=state.drafts[number]||{base:csvRowValues(row),values:csvRowValues(row),identity:csvRowIdentity(row),name:row.name,conflict:false};
  const next={...state.drafts,[number]:{...existing,values:{...existing.values,...patch}}};
  if(!csvDraftDirty(next[number]))delete next[number];commitDrafts(next);
 }
 function discardRow(number){const next={...state.drafts};delete next[number];commitDrafts(next);}
 function draftFor(row){return state.drafts[row.row]||{base:csvRowValues(row),values:csvRowValues(row)};}
 async function resolveRow(row){
  const originalBatch=state.batch;
  if(await confirmChange('ตรวจว่าสินค้าและราคาล่าสุดของ '+row.name+' ถูกต้อง ก่อนใช้ค่าที่พิมพ์ไว้กับรายการนี้ ค่านี้ยังไม่บันทึกลงสินค้า',
    {title:'ใช้ค่าที่พิมพ์กับข้อมูลล่าสุด?',confirmLabel:'ใช้ค่าที่พิมพ์กับรายการนี้',cancelLabel:'กลับไปตรวจรายการ'})){
   if(!state.live||state.batch!==originalBatch)return;
   const draft=state.drafts[row.row];if(!draft)return;
   commitDrafts({...state.drafts,[row.row]:{...draft,base:csvRowValues(row),identity:csvRowIdentity(row),conflict:false,missing:false}});
  }
 }
 function acceptReview(response,checked,replacing=false){
  if(!response||typeof response.batch!=='string'||!Number.isInteger(response.revision)||!Array.isArray(response.rows)||!Array.isArray(response.errors)||!Number.isInteger(response.expires_at)||!Number.isInteger(response.server_time)||(!replacing&&state.batch&&response.batch!==state.batch))throw new ApiError({code:'invalid_response',message:'ยังอ่านชุดตรวจได้ไม่ครบ กรุณาลองตรวจสถานะอีกครั้ง'},502);
  commitDrafts(mergeCsvDrafts(state.drafts,response,checked));state.preview=response;setPreview(response);
  if(response.expires_at&&response.server_time){state.clock={expiresAt:response.expires_at,deadline:importElapsedTime()+Math.max(0,response.expires_at-response.server_time)*1000};state.expiryChecked=false;}
  setExpired(false);setNeedsCheck(false);setProgress(null);setMode(response.mode||'temporary');
 }
 function remember(value){state.batch=value;setBatch(value);try{if(value)sessionStorage.setItem(key,value);else sessionStorage.removeItem(key);}catch{}}
 function begin(kind='read'){if(state.busy||!state.live)return null;state.requestKind=kind;state.busy=true;setBusy(true);setError('');return {generation:++state.generation,batch:state.batch};}
 function current(token){return state.live&&token.generation===state.generation&&token.batch===state.batch;}
 function finish(token){if(state.live&&token.generation===state.generation){state.busy=false;setBusy(false);setRecovering(false);}}
 function complete(response){setProgress(null);setResult(response);setNeedsCheck(false);setExpired(false);state.clock=null;remember('');focusHeading();}
 async function askLeave(){
  if(state.busy&&state.requestKind!=='read')return false;
  if(!Object.values(state.drafts).some(csvDraftDirty))return true;
  const leave=await confirmChange('ค่าที่กำลังพิมพ์และยังไม่ได้ตรวจจะไม่ถูกเก็บ ข้อมูลที่ตรวจแล้วจะอยู่ในชุดเดิมจนหมดอายุ',
   {title:'มีค่าที่ยังไม่ได้ตรวจ',confirmLabel:'ออกโดยไม่ใช้ค่าที่ยังไม่ตรวจ',cancelLabel:'กลับไปแก้ต่อ'});
  if(leave&&state.live)commitDrafts({});return leave;
 }
 async function close(){if(await askLeave())onClose();}
 useEffect(()=>{state.live=true;const guard=()=>askLeave();importLeaveGuard=guard;
  const unload=event=>{if(Object.values(state.drafts).some(csvDraftDirty)){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',unload);
  if(state.batch)inspect(true);
  else focusHeading();
  return()=>{state.live=false;state.generation++;state.busy=false;if(importLeaveGuard===guard)importLeaveGuard=null;window.removeEventListener('beforeunload',unload);};
 },[]);
 useEffect(()=>{const tick=()=>{
  if(!state.clock||!state.batch||result)return;
  const remaining=state.clock.deadline-importElapsedTime();
  if(remaining<=300000)setExpiryWarning(true);
  if(remaining<=0&&!state.expiryChecked&&!state.busy){state.expiryChecked=true;setExpired(true);inspect(false);}
 };tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);},[preview?.expires_at,result]);
 async function upload(file){
  if(!file||state.busy)return;
  if(file.size>262144){setError('เลือกไฟล์ CSV ขนาดไม่เกิน 256 KB');return;}
  if(state.batch&&(state.preview?.revision>1||Object.values(state.drafts).some(csvDraftDirty))){
   if(!await confirmChange('การเลือกสินค้าและข้อมูลที่แก้ในชุดนี้จะถูกแทนที่ด้วยไฟล์ใหม่',{title:'เปลี่ยนไฟล์นำเข้า?',confirmLabel:'เลือกใช้ไฟล์ใหม่',cancelLabel:'กลับไปตรวจรายการ'}))return;
  }
  if(!state.live)return;
  const token=begin('upload');if(!token)return;
  try{const payload=new FormData();payload.append('file',file);payload.append('mode',mode);
   const response=await api('promotion-import',payload);if(!current(token))return;
   acceptReview(response,undefined,true);
   setSelectionNotice('');setSelecting(null);setEditing(null);setResult(null);setFilename(file.name);setErrorRow(null);
   commitDrafts({});setExpiryWarning(false);remember(response.batch);focusReview();
  }catch(error){if(current(token))setError(error.message);}finally{finish(token);}
 }
 function download(){
  const start=localMinute(Date.now()/1000+86400).replace('T',' '),end=localMinute(Date.now()/1000+172800).replace('T',' '),link=document.createElement('a');
  const csv=mode==='permanent'?'product_name,sale_price\r\nชื่อสินค้าเต็ม,3490\r\n':'product_name,sale_price,starts_at,ends_at\r\nชื่อสินค้าเต็ม,3490,'+start+','+end+'\r\n';
  link.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));link.download='sounddd-promotion-template.csv';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
 }
 function downloadIssues(){
  const quote=value=>{
   const text=String(value??'');
   return '"'+(/^[\s]*[=+@-]|^[\t\r]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';
  };
  const rows=[['แถว','สินค้า','สิ่งที่ต้องแก้'],...(state.preview?.errors||[]).map(issue=>[issue.row,issue.name,issue.message])];
  const link=document.createElement('a');
  link.href=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  link.download='sounddd-csv-issues.csv';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
 }
 function failed(error){
  setError(error.message);
  if(error.code==='preview_expired'){
   setExpired(true);setNeedsCheck(false);state.clock=null;
   if(!state.preview){remember('');focusHeading();}
  }else if(['review_required','preview_changed','operation_unknown','lock_timeout','invalid_response','import_started'].includes(error.code)||!error.status||error.status>=500)setNeedsCheck(true);
 }
 async function inspect(restoring=false){
  const token=begin();if(!token)return null;if(restoring)setRecovering(true);
  try{const response=await api('promotion-import/'+token.batch);if(!current(token))return null;
   if(response.status==='completed')complete(response);
   else if(['running','paused','needs_reconciliation'].includes(response.status)){setProgress(response);setMode(response.mode||'permanent');setEditing(null);setSelecting(null);setNeedsCheck(false);setExpired(false);state.clock=null;}
   else if(response.status==='ready'){acceptReview(response);focusReview();}
   else throw new ApiError({message:'ยังอ่านสถานะชุดนี้ไม่ได้ กรุณาลองตรวจอีกครั้ง',code:'invalid_response'},502);
   return response;
  }catch(error){if(current(token))failed(error);return null;}finally{finish(token);}
 }
 async function confirm(){
  if(!state.batch||state.busy||selecting||editing!==null||expired||Object.values(state.drafts).some(csvDraftDirty)||(!progress&&(!state.preview?.rows.length||state.preview.errors.length)))return;
  const token=begin('save');if(!token)return;
  try{const revision=progress?.revision??state.preview.revision;let response;
   do{response=await api('promotion-import/'+token.batch,{revision});if(!current(token))return;if(response.status==='running')setProgress(response);}while(response.status==='running');
   if(['paused','needs_reconciliation'].includes(response.status)){setProgress(response);setNeedsCheck(false);return;}
   if(response.status!=='completed')throw new ApiError({message:'ยังยืนยันผลไม่ได้ กรุณาตรวจสถานะชุดเดิม',code:'invalid_response'},502);
   complete(response);
  }catch(error){if(current(token))failed(error);}finally{finish(token);}
 }
 async function loadHistory(){
  const token=begin();if(!token)return;
  try{const response=await api('promotion-import');if(current(token))setHistory(response.items||[]);}
  catch(error){if(current(token))setError(error.message);}finally{finish(token);}
 }
 async function stopImport(){
  const id=state.batch;
  if(!await confirmChange('รายการที่บันทึกแล้วและแถวที่ต้องตรวจผลจะถูกเก็บไว้ ส่วนงานที่ยังไม่เริ่มจะหยุด', {title:'หยุดงานที่เหลือ?',confirmLabel:'ยืนยันหยุดงานที่เหลือ'}))return;
  if(id!==state.batch)return;
  const token=begin('save');if(!token)return;
  try{const response=await api('promotion-import/'+id+'/stop',{confirmed:true});if(current(token))complete(response);}
  catch(error){if(current(token))failed(error);}finally{finish(token);}
 }
 async function cancelImport(){
  if(state.busy||progress)return;
  const originalBatch=state.batch;
  if(needsCheck&&!state.preview){const latest=await inspect();if(!latest||latest.status!=='ready')return;}
  if(state.preview?.revision>1||Object.values(state.drafts).some(csvDraftDirty)){
   if(!await confirmChange('การแก้ราคา วันเวลา การเลือกสินค้า และแถวที่เอาออกในชุดนี้จะถูกล้าง ราคาสินค้ายังไม่เปลี่ยนจากการยกเลิกชุดตรวจ',
    {title:'ยกเลิกชุดนำเข้านี้?',confirmLabel:'ยกเลิกชุดนี้',cancelLabel:'กลับไปตรวจรายการ'}))return;
  }
  if(!state.live||originalBatch!==state.batch)return;
  const token=begin('cancel');if(!token)return;
  try{if(token.batch)await api('promotion-import/'+token.batch+'/cancel',{});if(current(token))resetImport();}
  catch(error){if(current(token)){if(error.code==='preview_expired')resetImport();else failed(error);}}finally{finish(token);}
 }
 function resetImport(){
  remember('');state.preview=null;state.clock=null;setPreview(null);commitDrafts({});setFilename('');setResult(null);setProgress(null);setNeedsCheck(false);
  setExpired(false);setExpiryWarning(false);setEditing(null);setSelecting(null);setSelectionNotice('');setError('');setErrorRow(null);focusHeading();
 }
 async function changeRow(input,message){
  if(state.busy||expired||state.drafts[input.row]?.conflict)return;
  const token=begin('edit');if(!token)return;setErrorRow(null);
  try{const response=await api('promotion-import/'+token.batch+'/selection',{...input,revision:state.preview.revision});if(!current(token))return;
   acceptReview(response,input.values?input:undefined);setErrorRow(null);setSelecting(null);
   if(input.action==='update'){if(!csvDraftDirty(state.drafts[input.row])){setEditing(null);focusRow(input.row,'edit');}setSelectionNotice('แถว '+input.row+' ตรวจแล้ว · '+(permanent?'ราคาจะเปลี่ยนหลังยืนยันทั้งชุด':'ราคาจะเปลี่ยนเมื่อโปรเริ่ม'));}
   else if(input.action==='edit'){const issue=response.errors.find(entry=>entry.row===input.row);setSelectionNotice(issue?'แถว '+input.row+' · '+issue.message:'แถว '+input.row+' ผ่านแล้ว');if(issue)focusRow(input.row);else focusRow(input.row,'edit');}
   else setSelectionNotice(message);
  }catch(error){if(current(token)){setErrorRow(input.row);failed(error);focusRow(input.row);}}finally{finish(token);}
 }
 const issues=preview?.errors||[], rows=preview?.rows||[];
 const removed=preview?.removed||[];
 const needsSelection=issues.filter(issue=>issue.selectable), corrections=issues.filter(issue=>issue.edit), fileIssues=issues.filter(issue=>!issue.selectable&&!issue.edit);

 const pickerFor=row=>selecting?.row===row.row&&h(PromotionImportPicker,{key:row.row,batch,row,rows,
  onClose:()=>setSelecting(null),onSelect:(input,removedRow)=>changeRow(input,
   removedRow?'เอาแถว '+removedRow+' ออกจากชุดแล้ว':'แถว '+row.row+' เลือกสินค้าแล้ว')});
 const keepDuplicate=(issue,other,keep)=>{
  const remove=keep===issue.row?other.row:issue.row;
  const input=keep===issue.row?{row:keep,product_id:issue.id,replace_row:remove}:{row:remove,action:'remove'};
  return changeRow(input,'เก็บแถว '+keep+' และเอาแถว '+remove+' ออกจากชุดแล้ว');
 };
 const readyRows=rows.map(row=>h(wp.element.Fragment,{key:row.row},
  h(PromotionImportReadyRow,{
   key:row.row,row,editing:editing===row.row,invalid:errorRow===row.row,draft:draftFor(row),onDraft:patch=>updateDraft(row,patch),onResolve:()=>resolveRow(row),onDiscard:()=>discardRow(row.row),
   busy:busy||expired||needsCheck||!!selecting||(editing!==null&&editing!==row.row),
   onEdit:()=>{setEditing(row.row);focusRow(row.row);},onCancel:()=>{discardRow(row.row);setEditing(null);focusRow(row.row,'edit');},
   onChangeProduct:()=>setSelecting(row),
   onCheck:values=>changeRow({row:row.row,action:'update',values})
  }),
  selecting?.row===row.row&&h('tr',null,h('td',{colSpan:permanent?3:4},pickerFor(row)))
 ));
 const review=rows.length>0&&h('details',{className:'sdd-import-reviewed',open:true},
  h('summary',{id:'sdd-import-ready-title',tabIndex:-1,ref:matchedHeading},'รายการสินค้า ('+rows.length+' รายการ)'),
  h('p',null,permanent?'กดแก้ไขในแถวเพื่อเปลี่ยนราคาหรือสินค้า':'กดแก้ไขในแถวเพื่อเปลี่ยนราคา วันเวลา หรือสินค้า'),
  h('div',{className:'sdd-import-correction-scroll sdd-import-ready-scroll',tabIndex:0,role:'region','aria-label':'ตารางรายการสินค้า เลื่อนแนวนอนได้'},
   h('table',{className:'sdd-import-correction-table sdd-import-ready-table','aria-labelledby':'sdd-import-ready-title'},
    h('thead',null,h('tr',null,['แถว','สินค้า','ราคา (บาท)',...(permanent?[]:['ช่วงโปร'])].map(label=>h('th',{key:label,scope:'col'},label)))),
    h('tbody',null,readyRows))));
 return h('section',{ref:root,className:'sdd-promo-import'+(step===1?' sdd-import-upload-page':''),'aria-labelledby':'sdd-import-heading','aria-busy':busy},
  h('div',{className:'sdd-import-page-heading'},h('h1',{id:'sdd-import-heading',tabIndex:-1,ref:heading},'นำเข้าโปรจาก CSV'),step===1&&h('p',null,'เลือกประเภทโปร อัปโหลดไฟล์ แล้วตรวจรายการก่อนยืนยัน')),
  h('ol',{className:'sdd-import-steps'},['อัปโหลดไฟล์','ตรวจรายการ','ผลการนำเข้า'].map((label,i)=>h('li',{key:label,'aria-current':step===i+1?'step':undefined,'data-state':step>i+1?'complete':step===i+1?'current':'upcoming'},h('span',{className:'sdd-import-step-number','aria-hidden':true},step>i+1?'✓':i+1),h('span',null,label)))),
  h('input',{type:'file',accept:'.csv,text/csv',hidden:true,ref:input,onChange:e=>{const file=e.target.files[0];e.target.value='';upload(file);}}),
  error&&h('p',{className:'sdd-error',role:'alert'},error),
  recovering&&h('p',{role:'status',className:'sdd-import-loading'},'กำลังเปิดชุดนำเข้าเดิม…'),
  busy&&!recovering&&h('p',{role:'status'},'กำลังตรวจข้อมูล…'),
  !batch&&!result&&h('div',{className:'sdd-import-card'},
   h('button',{type:'button',disabled:busy,onClick:loadHistory},'ดูชุดนำเข้าเดิม'),
   history&&(history.length?h('ul',null,history.map(item=>h('li',{key:item.operation_id},
    h('button',{type:'button',disabled:busy,onClick:()=>{remember(item.operation_id);inspect(true);}},
     (item.status==='running'?'เปิดชุดที่ยังไม่จบ':item.status==='stopped'?'ดูชุดที่หยุดแล้ว':'ดูผลชุดเดิม')+' · '+(item.mode==='temporary'?'โปรชั่วคราว':'โปรถาวร')+(item.total?' · '+item.count+' / '+item.total:'')+(item.blocked_row?' · ตรวจแถว '+item.blocked_row:'')+' · '+displayDate(item.updated_at)+' · '+item.operation_id.slice(0,8))))):h('p',null,'ยังไม่มีชุดนำเข้าราคาโปรถาวร'))),
  result?h('div',{className:'sdd-import-card',role:'status'},
   h('h2',null,result.stopped?'หยุดงานที่เหลือแล้ว · บันทึกสำเร็จ '+result.count+' / '+result.total:result.mode==='permanent'?'บันทึกราคาโปรถาวรแล้ว '+result.count+' / '+result.total+' รายการ':'บันทึกแผนโปรแล้ว '+result.count+' รายการ'),
   result.mode==='permanent'?h(wp.element.Fragment,null,
    result.stopped&&result.blocked&&h('p',null,'แถว '+result.blocked.row+' ยังต้องตรวจราคาปัจจุบัน',result.blocked.operation_id&&h('code',null,' · '+result.blocked.operation_id)),
    result.errors?.length>0&&h('ul',null,result.errors.map(issue=>h('li',{key:issue.row},'แถว '+issue.row+' · '+issue.name+' · '+issue.message))),
    h('button',{className:'sdd-primary',onClick:close},closeLabel)):
   h(wp.element.Fragment,null,h('p',null,'ราคาจะเปลี่ยนตามเวลาเริ่มของแต่ละรายการ'),
    h('button',{className:'sdd-primary',onClick:()=>onComplete(result.first_start)},'ดูในปฏิทินโปร'))):
  h(wp.element.Fragment,null,
   !preview&&!batch&&h('div',{className:'sdd-import-card sdd-import-upload-card'},
    h('h2',null,'เลือกประเภทโปร'),
    h('fieldset',{className:'sdd-import-mode'},h('legend',{className:'sdd-import-visually-hidden'},'ประเภทโปร'),
     [['temporary','โปรชั่วคราว','กำหนดวันเริ่มและวันสิ้นสุด'],['permanent','ราคาโปรถาวร','ใช้ราคาใหม่ต่อเนื่อง ไม่มีวันสิ้นสุด']].map(([value,label,description])=>h('label',{key:value,className:'sdd-import-mode-option'+(mode===value?' is-selected':'')},
      h('input',{type:'radio',name:'sdd-import-mode',value,checked:mode===value,disabled:busy,onChange:()=>setMode(value)}),h('span',null,h('strong',null,label),h('small',null,description))))),
    h('p',{className:'sdd-import-mode-note'},mode==='permanent'?'ใช้ราคาโปรทันทีหลังยืนยัน และล้างวันเริ่ม–จบโปรเดิมของสินค้า':
     'เลือกวันเริ่มและวันจบในไฟล์ ระบบจะคืนราคาและตารางโปรเดิมหลังจบ'),
    h('div',{className:'sdd-import-file-panel'},
     h('div',{className:'sdd-import-file-heading'},h('h3',null,'เตรียมไฟล์ CSV'),h('span',{className:'sdd-import-file-limit'},'สูงสุด 100 รายการ / ไฟล์')),
     h('ul',{className:'sdd-import-file-guide'},
      h('li',null,h('strong',null,'สินค้าและราคา'),h('span',null,'หนึ่งแถวต่อสินค้า ใช้ชื่อเต็ม SKU ตรงตัว หรือรหัสรุ่น และราคาเต็มบาท')),
      mode==='temporary'&&h('li',null,h('strong',null,'วันเริ่มและวันสิ้นสุด'),h('span',null,h('code',null,'YYYY-MM-DD HH:mm'),' · ใช้ปี ค.ศ. เช่น 2026 · เวลาเว็บไซต์ '+(cfg.timezone||'UTC')))),
     h('div',{className:'sdd-import-file-footer'},h('div',null,h('strong',null,'เริ่มจากไฟล์ตัวอย่างได้'),h('p',null,'เลือกไฟล์แล้วจะเข้าสู่หน้าตรวจรายการ ยังไม่เปลี่ยนราคาสินค้า')),
      h('div',{className:'sdd-import-actions'},h('button',{type:'button',className:'sdd-secondary',onClick:download},'ดาวน์โหลดไฟล์ตัวอย่าง'),h('button',{type:'button',className:'sdd-primary',disabled:busy,onClick:()=>input.current.click()},'เลือกไฟล์ CSV'))))),
   needsCheck&&!recovering&&h('div',{className:'sdd-import-recovery',role:'status'},
    h('span',{className:'sdd-import-recovery-icon','aria-hidden':true},'↻'),
    h('div',null,h('h2',null,'ตรวจสถานะชุดเดิม'),h('p',null,'พบชุดนำเข้าที่เปิดไว้ก่อนหน้า หรือยังไม่ได้รับผลตอบกลับครบถ้วน'),
     h('ul',null,h('li',null,'ลองตรวจสถานะอีกครั้งเพื่อเปิดรายการล่าสุดหรือดูผลบันทึก'),h('li',null,'ยกเลิกได้เฉพาะชุดที่ยังไม่เริ่มบันทึก ระบบจะตรวจให้อีกครั้งก่อนยกเลิก')))),
   progress&&h('div',{className:'sdd-import-progress-card',role:'status'},h('h2',null,'ชุดนี้เริ่มบันทึกแล้ว'),h('p',null,'บันทึกราคาโปรถาวรแล้ว '+progress.count+' รายการ · ตรวจผล '+progress.processed+' / '+progress.total),progress.status==='needs_reconciliation'?h('p',null,'แถว '+progress.blocked?.row+' ยังยืนยันผลไม่ได้',progress.blocked?.operation_id&&h('code',null,' · '+progress.blocked.operation_id)):
    h('p',null,progress.status==='paused'?'ระบบพักการบันทึก งานที่ยังไม่เริ่มจะรอจนเปิดให้บันทึก':'กดทำรายการที่เหลือต่อ โดยใช้คำสั่งชุดเดิม')),
   preview&&!progress&&h('div',{className:'sdd-import-card'},
    h('h2',null,permanent?'ตรวจราคาโปรถาวร':'ตรวจรายการ'),h('p',null,(filename||'ผลตรวจที่บันทึกไว้')+' · '+preview.total+' รายการ · '+(cfg.timezone||'UTC')),
    h('div',{className:'sdd-import-summary'},h('strong',null,'ผ่าน '+rows.length),h('strong',null,'ต้องจัดการ '+issues.length),removed.length>0&&h('span',null,'เอาออก '+removed.length+' แถว'),issues.length>0&&h('button',{type:'button',onClick:downloadIssues},'ดาวน์โหลดรายการที่ต้องแก้')),
    h('p',{className:'sdd-import-save-help'},permanent?'ราคาสินค้าจะเปลี่ยนหลังยืนยันทั้งชุด · ราคาใหม่ใช้ทันทีและล้างวันโปรเดิม':'หลังยืนยันจะบันทึกแผนโปร ราคาเปลี่ยนเมื่อโปรเริ่ม · ช่องวันเวลาใช้ปี ค.ศ. เช่น 2026'),
    rows.length>0&&h(ImportPriceSummary,{rows,permanent}),
    dirtyRows.length>0&&h('p',{role:'status'},'มีค่าที่ยังไม่ได้ตรวจ '+dirtyRows.length+' แถว · ตรวจแถวนี้ก่อนยืนยันทั้งชุด'),
    editing!==null&&h('p',null,'กำลังแก้แถว '+editing+' · กดตรวจแถวนี้ หรือยกเลิกการแก้แถว'),
    selectionNotice&&h('p',{role:'status'},selectionNotice),
    dirtyRows.filter(number=>rowDrafts[number].missing).map(number=>h('div',{key:number,className:'sdd-import-draft-conflict'},h('strong',null,'แถว '+number+' · '+rowDrafts[number].name),h('pre',null,JSON.stringify(rowDrafts[number].values,null,2)),h('button',{type:'button',onClick:()=>discardRow(number)},'ไม่ใช้ค่าที่พิมพ์ในแถวนี้'))),
    removed.length>0&&h('details',{className:'sdd-import-reviewed',open:true},
     h('summary',null,'แถวที่เอาออกจากชุด ('+removed.length+')'),
     h('ul',null,removed.map(number=>{
      const item=preview.removed_items?.find(entry=>entry.row===number);
      return h('li',{key:number},
       h('strong',null,'แถว '+number+(item?' · '+item.name:'')),
       item?.input&&item.input!==item.name&&h('small',null,'ชื่อในไฟล์ '+item.input),
      h('button',{type:'button',disabled:busy||expired||needsCheck||!!selecting||editing!==null||dirtyRows.length>0,onClick:()=>changeRow({row:number,action:'restore'},'คืนแถว '+number+' เข้าชุดแล้ว')},'เลิกทำ'));}))),

    needsSelection.length>0&&h('div',{className:'sdd-import-issues'},
     h('h3',null,'เหลือ '+needsSelection.length+' แถวที่ต้องจัดการ'),
     h('ul',null,needsSelection.map(issue=>{
      const other=rows.find(row=>row.row===issue.duplicate_row);
      return h('li',{key:issue.row},
       h('strong',null,'แถว '+issue.row+' · '+issue.name),
       other?h(PromotionDuplicateChoice,{row:issue,other,busy:busy||!!selecting||editing!==null,
        onKeep:keep=>keepDuplicate(issue,other,keep),onChooseAnother:()=>setSelecting(issue)}):
       h(wp.element.Fragment,null,h('p',null,issue.message),
        h('div',{className:'sdd-import-actions'},
         h('button',{disabled:busy||expired||needsCheck||!!selecting||editing!==null||dirtyRows.length>0,onClick:()=>setSelecting(issue)},'ค้นหาและเลือกสินค้า'),
         h('button',{disabled:busy||expired||needsCheck||!!selecting||editing!==null||dirtyRows.length>0,onClick:()=>changeRow({row:issue.row,action:'remove'},'เอาแถว '+issue.row+' ออกจากชุดแล้ว')},'เอาแถวนี้ออกจากชุด'))),
       pickerFor(issue));
     }))),
    corrections.length>0&&h('section',{className:'sdd-import-issues','aria-labelledby':'sdd-import-corrections-title'},
     h('h3',{id:'sdd-import-corrections-title'},'ตรวจราคาและวันเวลา '+corrections.length+' แถว'),
     h('p',null,'แก้ช่องที่ไฮไลต์แล้วกดตรวจในแถวนั้น · เวลา '+(cfg.timezone||'UTC')),
     h('div',{className:'sdd-import-correction-scroll',tabIndex:0,role:'region','aria-label':'ตารางแก้ราคาและวันเวลา เลื่อนแนวนอนได้'},
      h('table',{className:'sdd-import-correction-table','aria-labelledby':'sdd-import-corrections-title'},
       h('thead',null,h('tr',null,['แถว','สินค้าและปัญหา','ราคาปัจจุบัน','ราคาโปรใหม่ (บาท)',...(permanent?[]:['ช่วงโปร'])].map(label=>h('th',{key:label,scope:'col'},label)))),
       h('tbody',null,corrections.map(issue=>h(PromotionImportCorrection,{
        key:issue.row,issue,permanent,busy:busy||expired||needsCheck||!!selecting||editing!==null,draft:draftFor(issue),onDraft:patch=>updateDraft(issue,patch),onResolve:()=>resolveRow(issue),onDiscard:()=>discardRow(issue.row),
        onCheck:values=>changeRow({row:issue.row,action:'edit',values})
       })))))),
    fileIssues.length>0&&h('div',{className:'sdd-import-issues',role:'status'},
     h('h3',null,'แก้ '+fileIssues.length+' แถวในไฟล์'),
     h('ul',null,fileIssues.map(issue=>h('li',{key:issue.row},h('strong',null,'แถว '+issue.row+(issue.name?' · '+issue.name:'')),h('p',null,issue.message)))),
     h('button',{className:'sdd-primary',disabled:busy||expired||needsCheck||!!selecting||editing!==null||dirtyRows.length>0,onClick:()=>input.current.click()},'อัปโหลดไฟล์ที่แก้แล้ว')),
    !issues.length&&!rows.length&&h('p',null,'ไม่มีรายการในชุดนี้ คืนแถวที่เอาออกหรือเลือกไฟล์ใหม่'),
    !issues.length&&rows.length>0&&!dirtyRows.length&&editing===null&&!expired&&!needsCheck&&h('p',null,permanent?
     'ตรวจครบแล้ว '+rows.length+' รายการ พร้อมยืนยันเปลี่ยนราคา':
     'พร้อมตั้งโปร '+rows.length+' รายการ · เริ่มรายการแรก '+promoTime(Math.min(...rows.map(row=>row.start)))+' · จบรายการสุดท้าย '+promoTime(Math.max(...rows.map(row=>row.end)))),
    review),
   expired&&h('div',{className:'sdd-import-expired',role:'status'},h('strong',null,'ชุดตรวจหมดอายุแล้ว'),h('p',null,preview?'ยังเก็บข้อมูลที่เห็นไว้ให้อ่านหรือคัดลอก กรุณาเลือกไฟล์ใหม่ก่อนยืนยัน':'กรุณาอัปโหลดไฟล์ใหม่เพื่อเริ่มตรวจอีกครั้ง'),h('button',{type:'button',disabled:busy,onClick:()=>input.current.click()},'เลือกไฟล์ใหม่')),
   (expired||result||progress)&&dirtyRows.length>0&&h('details',{className:'sdd-import-local-values',open:true},h('summary',null,'ค่าที่ยังไม่ตรวจ (ยังไม่ได้บันทึก)'),dirtyRows.map(number=>h('div',{key:number},h('strong',null,'แถว '+number+' · '+rowDrafts[number].name),h('pre',null,JSON.stringify(rowDrafts[number].values,null,2)))),progress&&h('p',null,'ค่าที่ยังไม่ตรวจไม่ได้รวมในชุดที่เริ่มบันทึกแล้ว'),progress&&h('button',{type:'button',onClick:()=>commitDrafts({})},'รับทราบและไม่ใช้ค่าที่ยังไม่ตรวจ')),
   h('div',{className:'sdd-import-actions sdd-import-footer'},
    h('div',{className:'sdd-import-footer-secondary'},h('button',{type:'button',disabled:busy,onClick:close},closeLabel),progress&&h('button',{type:'button',disabled:busy,onClick:async()=>{if(await askLeave())resetImport();}},'เก็บชุดนี้ไว้และกลับไปหน้านำเข้า'),
    preview&&!progress&&!result&&preview.expires_at&&h('div',{className:'sdd-import-expiry'},h('span',null,expired?'ชุดตรวจหมดอายุแล้ว':'เก็บชุดนี้ไว้ถึง ',!expired&&h('time',{dateTime:new Date(preview.expires_at*1000).toISOString()},displayDate(preview.expires_at,'time')),!expired&&' น.'),expiryWarning&&!expired&&h('p',{role:'status'},'เหลือเวลาไม่เกิน 5 นาที'))),
    h('div',{className:'sdd-import-footer-main'},
     (preview||batch)&&h('button',{type:'button',className:'sdd-import-cancel',disabled:busy||recovering||!!progress,onClick:cancelImport,title:progress?'ชุดนี้เริ่มบันทึกแล้ว กรุณาตรวจผลคำสั่งเดิม':'ยกเลิกชุดตรวจนี้และกลับไปเลือกไฟล์ใหม่'},'ยกเลิกชุดนี้'),
    preview&&!progress&&!needsCheck&&!fileIssues.length&&h('button',{disabled:busy||expired||needsCheck||!!selecting||editing!==null||dirtyRows.length>0,onClick:()=>input.current.click()},'เปลี่ยนไฟล์'),
    !progress&&rows.length>0&&h('button',{type:'button',onClick:()=>matchedHeading.current?.focus()},'ดูรายการสินค้า ('+rows.length+')'),
    needsCheck?h('button',{className:'sdd-primary',disabled:busy||recovering,onClick:()=>inspect(false)},'ตรวจสถานะชุดเดิม'):
    progress?h(wp.element.Fragment,null,
     h('button',{className:'sdd-primary',disabled:busy||dirtyRows.length>0,onClick:confirm},progress.status==='needs_reconciliation'?'ตรวจผลเดิมและทำต่อ':'ทำรายการที่เหลือต่อ'),
     progress.status==='needs_reconciliation'&&h('button',{type:'button',disabled:busy,onClick:stopImport},'หยุดงานที่เหลือ')):
    (preview||batch)&&h('button',{className:'sdd-primary',disabled:busy||expired||dirtyRows.length>0||!batch||!preview||!rows.length||!!issues.length||!!selecting||editing!==null,onClick:confirm},preview?(permanent?'ยืนยันเปลี่ยนราคา ':'ยืนยันตั้งโปร ')+(removed.length?rows.length:preview.total)+' รายการ':'ลองยืนยันชุดเดิมอีกครั้ง')))));
}
function PromotionCalendar({onClose,onProduct,tick,month:controlledMonth,onMonthChange,options={},onOptions}){
 const [importing,setImporting]=useState(false),[importTick,setImportTick]=useState(0);
 const today=datePart(String(Math.floor(Date.now()/1000)));
 const [fallbackMonth,setFallbackMonth]=useState(today.slice(0,7));
 const month=controlledMonth||fallbackMonth,setMonth=onMonthChange||setFallbackMonth;
 const [localSelected,setLocalSelected]=useState(month===today.slice(0,7)?today:month+'-01'),[data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const selected=options.calendarSelected||localSelected,setSelected=value=>onOptions?onOptions({calendarSelected:value}):setLocalSelected(value);

 useEffect(()=>{if(selected.slice(0,7)!==month)setSelected(month+'-01');},[month]);
 const [year,m]=month.split('-').map(Number),first=new Date(Date.UTC(year,m-1,1)),days=new Date(Date.UTC(year,m,0)).getUTCDate(),offset=first.getUTCDay();
 const monthName=new Intl.DateTimeFormat('th-TH',{timeZone:'UTC',month:'long',year:'numeric'}).format(first);
 const shift=delta=>{setCalendarPage(1);setDayOnly(false);const next=new Date(Date.UTC(year,m-1+delta,1));const value=next.getUTCFullYear()+'-'+String(next.getUTCMonth()+1).padStart(2,'0');setMonth(value);setSelected(value+'-01');};
 const applies=(item,day)=>datePart(String(item.starts_at))<=day&&datePart(String(item.ends_at))>=day;
 const [localSearch,setLocalSearch]=useState(''),[localStatus,setLocalStatus]=useState(''),[localView,setLocalView]=useState('month');
 const [calendarPage,setCalendarPage]=useState(1),[dayOnly,setDayOnly]=useState(false);
 const calendarSearch=options.calendarSearch??localSearch,calendarStatus=options.calendarStatus??localStatus,calendarView=options.calendarView||localView;
 const setCalendarSearch=value=>onOptions?onOptions({calendarSearch:value}):setLocalSearch(value),setCalendarStatus=value=>onOptions?onOptions({calendarStatus:value}):setLocalStatus(value),setCalendarView=value=>onOptions?onOptions({calendarView:value}):setLocalView(value);
 useEffect(()=>{let current=true;setBusy(true);setError('');setData(null);
  const timer=setTimeout(()=>api('promotion-calendar?'+new URLSearchParams({month,search:calendarSearch.trim(),status:calendarStatus,page:String(calendarPage),...(dayOnly&&selected.slice(0,7)===month?{day:selected}:{})})).then(r=>{if(current)setData(r);}).catch(e=>{if(current)setError(e.message);}).finally(()=>{if(current)setBusy(false);}),250);
  return()=>{current=false;clearTimeout(timer);};
 },[month,tick,importTick,calendarSearch,calendarStatus,calendarPage,dayOnly,dayOnly?selected:'']);
 const items=data?.items||[],selectedItems=items.filter(item=>applies(item,selected));
 const eventLabel=(item,day)=>{const start=datePart(String(item.starts_at))===day,end=datePart(String(item.ends_at))===day;return start&&end?'กำหนดเริ่มและจบ':start?'กำหนดเริ่ม':end?'กำหนดจบ':'อยู่ในช่วงที่ตั้งไว้';};
 if(importing)return h(PromotionImport,{onClose:()=>{setImporting(false);requestAnimationFrame(()=>document.getElementById('sdd-import-trigger')?.focus());},onComplete:start=>{
  const day=datePart(String(start));setMonth(day.slice(0,7));
  if(onOptions)onOptions({calendarSearch:'',calendarStatus:'',calendarSelected:day});
  else{setLocalSearch('');setLocalStatus('');setLocalSelected(day);}
  setImportTick(t=>t+1);setImporting(false);
 }});
 return h('section',{className:'sdd-promo-calendar'},h('div',{className:'sdd-calendar-page-head'},h('div',null,h('span',{className:'sdd-dashboard-eyebrow'},'วางแผนโปรโมชัน'),h('h1',{id:'sdd-calendar-title',tabIndex:-1},'ปฏิทินโปรชั่วคราว'),h('p',null,'เฉพาะโปรชั่วคราวในปลั๊กอินนี้ · 1 รายการคือสินค้า หรือตัวเลือกสินค้า 1 ตัว')),h('div',{className:'sdd-import-actions'},cfg.canImportPromotions&&h('button',{id:'sdd-import-trigger',className:'sdd-primary',onClick:()=>setImporting(true)},'นำเข้าโปรจาก CSV'),h('button',{onClick:onClose},'← กลับไปจัดการสินค้า'))),
 h('div',{className:'sdd-calendar-filters'},h('label',null,'ค้นหาโปร',h('input',{value:calendarSearch,onChange:e=>{setCalendarPage(1);setCalendarSearch(e.target.value);},maxLength:200,placeholder:'ชื่อสินค้า, SKU หรือ ID'})),h('label',null,'สถานะปัจจุบัน',h('select',{value:calendarStatus,onChange:e=>{setCalendarPage(1);setCalendarStatus(e.target.value);}},h('option',{value:''},'ทุกสถานะ'),Object.entries(promoLabels).map(([id,label])=>h('option',{key:id,value:id},label)))),h('div',{className:'sdd-view-switch'},[['month','เดือน'],['list','รายการ']].map(([id,label])=>h('button',{key:id,'aria-pressed':calendarView===id,onClick:()=>{if(id==='month'){setDayOnly(false);setCalendarPage(1);}setCalendarView(id);}},label)))),
 h('div',{className:'sdd-calendar-layout'},h('section',{className:'sdd-calendar-card'},h('div',{className:'sdd-calendar-toolbar'},h('button',{onClick:()=>shift(-1),disabled:month==='2000-01','aria-label':'เดือนก่อนหน้า'},'←'),h('h2',{'aria-live':'polite'},monthName),h('button',{onClick:()=>shift(1),disabled:month==='2099-12','aria-label':'เดือนถัดไป'},'→'),h('button',{onClick:()=>{setCalendarPage(1);setDayOnly(false);setMonth(today.slice(0,7));setSelected(today);}},'วันนี้')),
 h('p',{className:'sdd-calendar-note'},'เวลาตามเว็บไซต์ '+(cfg.timezone||'UTC')+' · วันในปฏิทินเป็นช่วงที่ตั้งไว้ สถานะบอกผลล่าสุด'),h('div',{className:'sdd-calendar-legend'},[['pending','รอเริ่ม'],['active','กำลังใช้'],['needs_review','ต้องตรวจสอบ / เลยเวลาเริ่ม'],['restored','สิ้นสุด / ปิดแล้ว']].map(([key,label])=>h('span',{key},h('i',{className:'sdd-calendar-dot '+key,'aria-hidden':true}),label))),
 busy&&h('p',{role:'status'},'กำลังโหลดปฏิทิน…'),error&&h('p',{className:'sdd-error',role:'alert'},error),(calendarPage>1||data?.limited)&&h('div',{className:'sdd-calendar-toolbar'},
  h('button',{type:'button',disabled:busy||calendarPage===1,onClick:()=>setCalendarPage(n=>n-1)},'โปรหน้าก่อน'),
  h('span',null,'หน้าที่ '+calendarPage),
  h('button',{type:'button',disabled:busy||!data?.limited,onClick:()=>setCalendarPage(n=>n+1)},'โปรหน้าถัดไป')),
 h('div',{className:'sdd-month-view'+(calendarView==='list'?' is-hidden':'')},h(CalendarMonth,{month,items,selected,today,busy,error,onSelect:day=>{setSelected(day);setCalendarPage(1);setDayOnly(true);setCalendarView('list');},onList:()=>setCalendarView('list')}))),
 h('section',{className:'sdd-month-agenda'+(calendarView==='list'?' is-visible':''),'aria-label':'รายการโปรในเดือน'},h('h2',null,'รายการโปร · '+monthName),
 h('div',{className:'sdd-calendar-filters'},h('label',null,'เลือกวัน',h('input',{type:'date',value:selected,onChange:e=>{const day=e.target.value;if(!day)return;setCalendarPage(1);setMonth(day.slice(0,7));setSelected(day);setDayOnly(true);}})),dayOnly&&h('button',{type:'button',onClick:()=>{setCalendarPage(1);setDayOnly(false);}},'ดูทุกวันในเดือน')),
 dayOnly&&!selectedItems.length&&items.length>0&&h('p',null,data?.limited?'ขณะนี้แสดงผลเพียงบางหน้า':'ไม่มีโปรในวันที่เลือก'),busy?h('p',{role:'status'},'กำลังโหลด…'):error?h('p',null,'อ่านรายการไม่ได้ กรุณารีเฟรช'):!items.length?h('p',null,data?.limited?'ยังตรวจไม่ครบทุกโปรในเดือนนี้':'ไม่พบโปรที่ตรงเงื่อนไขในเดือนนี้'):h('ul',null,(dayOnly?selectedItems:items).map(item=>h('li',{key:item.promotion_id},h('span',{className:'sdd-status '+item.status},promoLabels[item.status]||item.status),h('button',{className:'sdd-calendar-product','data-calendar-product':item.id,onClick:()=>onProduct(item.id)},item.name),h('small',null,item.sku||'#'+item.id),h('p',null,'ราคาโปร '+showValue(item.price,'sale_price')+' บาท'),h('small',null,promoTime(item.starts_at)+' → '+promoTime(item.ends_at)),['needs_review','missed'].includes(item.status)&&item.message&&h('p',null,item.message))))),
 h('section',{className:'sdd-calendar-details'},h('h2',null,'โปรวันที่ '+displayDate(selected,'date')),h('p',{className:'sdd-calendar-note'},'กดชื่อสินค้าเพื่อเปิดในตารางจัดการ'),busy?h('p',null,'กำลังโหลด…'):error?h('p',null,'ไม่สามารถแสดงรายการได้'):selectedItems.length?h('ul',null,selectedItems.map(item=>h('li',{key:item.promotion_id},h('span',{className:'sdd-calendar-detail-event'},eventLabel(item,selected)),h('span',{className:'sdd-status '+item.status},promoLabels[item.status]||item.status),h('button',{className:'sdd-calendar-product',onClick:()=>onProduct(item.id)},item.name),h('small',null,'#'+item.id+(item.sku?' · '+item.sku:'')),h('p',null,'ราคาโปร '+showValue(item.price,'sale_price')+' บาท'),h('small',null,'กำหนด '+promoTime(item.starts_at)+' → '+promoTime(item.ends_at)),item.message&&h('p',{className:'sdd-calendar-message'+(['needs_review','missed'].includes(item.status)?' is-attention':'')},item.message)))):h('p',{className:'sdd-dashboard-empty'},data?.limited?'ยังตรวจไม่ครบทุกโปรในวันที่เลือก':'ไม่มีโปรในวันที่เลือก'),h('p',{className:'sdd-calendar-note'},'วันเริ่มและสิ้นสุดเป็นเวลาที่ตั้งไว้ สถานะบอกผลล่าสุด'))));
}
function DashboardGroup({title,subtitle,group,render,empty,tone='blue',wide=false}){
 const [visible,setVisible]=useState(5);
 const total=group.items.length;
 return h('section',{className:'sdd-dashboard-card sdd-dashboard-card--'+tone+(wide?' sdd-dashboard-card--wide':'')},
  h('div',{className:'sdd-dashboard-card-header'},h('div',null,h('h2',null,title),h('p',{className:'sdd-dashboard-card-subtitle'},subtitle)),h('span',{className:'sdd-dashboard-count','aria-label':'แสดง '+total+' รายการ'},total)),
  group.limited&&h('p',{className:'sdd-dashboard-limit'},'แสดงสูงสุด 100 รายการแรก ยังมีรายการอื่นที่ไม่ได้แสดง'),
  total?h(wp.element.Fragment,null,h('ul',{className:'sdd-dashboard-list'},group.items.slice(0,visible).map(render)),visible<total&&h('button',{className:'sdd-dashboard-more',onClick:()=>setVisible(n=>Math.min(n+10,total))},'แสดงเพิ่มอีก '+Math.min(10,total-visible)+' รายการ'),visible>5&&h('button',{className:'sdd-dashboard-more',onClick:()=>setVisible(5)},'ย่อรายการ')):h('p',{className:'sdd-dashboard-empty'},h('span',{'aria-hidden':true},'✓'),group.limited?'ไม่พบรายการที่มีสิทธิ์ดูใน 100 รายการแรก':empty));
}
function DashboardTasks({data,onProduct,onAudit,date,selectedTab,onTabChange}){
 const [localTab,setLocalTab]=useState('problems'),[visible,setVisible]=useState(10);
 const tab=selectedTab||localTab,setTab=value=>{setLocalTab(value);onTabChange?.(value);};
 const groups={problems:data.problems.items.map(item=>({...item,kind:'problems',label:'ต้องตรวจสอบ',detail:item.message})),upcoming:data.upcoming.items.map(item=>({...item,kind:'upcoming',label:item.event_type==='start'?'ใกล้เริ่ม':'ใกล้จบ',detail:(item.event_type==='start'?'กำหนดเริ่ม ':'กำหนดจบ ')+date(item.at)})),changes:data.changes.items.map(item=>({...item,kind:'changes',label:'ราคาลดลง',detail:(labels[item.field]||item.field)+' '+displayPrice(item.old_value)+' → '+displayPrice(item.new_value)+' บาท · '+date(item.at)}))};
 const rows=tab==='all'?Object.values(groups).flat():groups[tab];
 const open=item=>item.kind==='changes'&&onAudit&&item.event_id?onAudit(item.id,item.field,item.event_id):onProduct(item.id);
 return h('section',{className:'sdd-task-board',id:'sdd-task-board',tabIndex:-1},h('div',{className:'sdd-task-board-heading'},h('div',null,h('span',{className:'sdd-dashboard-eyebrow'},'ติดตามและดำเนินการ'),h('h2',null,'รายการงานของร้าน')),h('span',{className:'sdd-task-total'},rows.length+' รายการที่โหลดได้')),
 h('div',{className:'sdd-task-tabs','aria-label':'ประเภทงาน'},[['problems','ต้องตรวจสอบ'],['upcoming','ใกล้เริ่ม / จบ'],['changes','ราคาลดลง'],['all','ทั้งหมด']].map(([id,label])=>h('button',{key:id,'aria-pressed':tab===id,onClick:()=>{setTab(id);setVisible(10);}},label,h('span',null,id==='all'?Object.values(groups).flat().length:groups[id].length)))),
 Object.entries({problems:data.problems,upcoming:data.upcoming,changes:data.changes}).some(([key,group])=>group.limited&&(tab==='all'||tab===key))&&h('p',{className:'sdd-dashboard-limit'},'ข้อมูลแต่ละประเภทแสดงไม่เกิน 100 รายการแรก ตัวเลขนี้ไม่ใช่ยอดทั้งหมด'),
 !rows.length?h('div',{className:'sdd-task-empty'},h('span',{'aria-hidden':true},'✓'),h('strong',null,'ไม่มีรายการในหมวดนี้'),h('p',null,'เลือกหมวดอื่นหรือปรับช่วงเวลาที่ต้องการดู')):h('div',{className:'sdd-task-table-wrap'},h('table',{className:'sdd-task-table'},h('thead',null,h('tr',null,['สินค้า','สถานะงาน','รายละเอียด','ดำเนินการ'].map(label=>h('th',{key:label,scope:'col'},label)))),h('tbody',null,rows.slice(0,visible).map((item,index)=>h('tr',{key:item.kind+':'+item.id+':'+index,'data-task-product':item.id},h('td',{'data-label':'สินค้า'},h('button',{className:'sdd-dashboard-product',onClick:()=>onProduct(item.id)},item.name),h('small',null,'#'+item.id+(item.sku?' · '+item.sku:''))),h('td',{'data-label':'สถานะงาน'},h('span',{className:'sdd-task-badge '+item.kind},item.label)),h('td',{'data-label':'รายละเอียด'},item.detail),h('td',{'data-label':'ดำเนินการ'},h('button',{className:'sdd-task-action',onClick:()=>open(item)},item.kind==='problems'?'ตรวจสอบโปร →':item.kind==='changes'&&onAudit&&item.event_id?'ดูเหตุการณ์ราคา →':'เปิดสินค้า →'))))))),visible<rows.length&&h('button',{className:'sdd-dashboard-more',onClick:()=>setVisible(n=>n+10)},'แสดงเพิ่มอีก '+Math.min(10,rows.length-visible)+' รายการ'));
}
function Dashboard({onClose,onProduct,onSettings,onAudit,tick,options={},onOptions}){
 const [localHours,setLocalHours]=useState('24'),[localThreshold,setLocalThreshold]=useState('30'),[data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const hours=options.dashboardHours||localHours,threshold=options.dashboardThreshold||localThreshold;
 const setHours=value=>onOptions?onOptions({dashboardHours:value}):setLocalHours(value),setThreshold=value=>onOptions?onOptions({dashboardThreshold:value}):setLocalThreshold(value);
 useEffect(()=>{let active=true;setBusy(true);setError('');api('dashboard?'+new URLSearchParams({hours,threshold})).then(result=>{if(active)setData(result);}).catch(e=>{if(active){setError(e.message);}}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[hours,threshold,tick]);
 const date=value=>promoTime(typeof value==='number'?String(value):String(Date.parse(value)/1000));
 const row=(item,description)=>h('li',{key:item.id+':'+description,className:'sdd-dashboard-row'},h('div',{className:'sdd-dashboard-row-main'},h('button',{className:'sdd-dashboard-product',onClick:()=>onProduct(item.id)},item.name||('สินค้า #'+item.id)),h('div',{className:'sdd-dashboard-meta'},'#'+item.id+(item.sku?' · SKU: '+item.sku:'')),description&&h('div',{className:'sdd-dashboard-detail'},description)),h('span',{className:'sdd-dashboard-arrow','aria-hidden':true},'→'));
 const jobs={sdd_feed_publish:'เผยแพร่การเปลี่ยนแปลง',sdd_external_drain:'ตรวจการเปลี่ยนแปลงภายนอก',sdd_temporary_sale_scan:'ตรวจโปรชั่วคราว',sdd_log_retention:'จัดการบันทึกระบบ',sdd_business_retention:'จัดการประวัติ'};
 return h('section',{className:'sdd-dashboard'},h('div',{className:'sdd-dashboard-heading'},h('div',null,h('span',{className:'sdd-dashboard-eyebrow'},'ภาพรวมร้าน'),h('h1',null,'งานที่ต้องจัดการ'),h('p',null,'ดูรายการที่ควรติดตาม แล้วกดชื่อสินค้าเพื่อจัดการต่อ')),h('button',{className:'sdd-dashboard-back',onClick:onClose},'← กลับไปจัดการสินค้า')),
 h('div',{className:'sdd-dashboard-controls'},h('div',{className:'sdd-dashboard-controls-title'},h('strong',null,'เลือกสิ่งที่ต้องการดู'),h('span',null,'เลือกช่วงเวลาและระดับการลดราคา')),h('label',null,h('span',null,'โปรชั่วคราว'),h('select',{value:hours,onChange:e=>setHours(e.target.value)},h('option',{value:'24'},'ภายใน 24 ชั่วโมง'),h('option',{value:'168'},'ภายใน 7 วัน'))),h('label',null,h('span',null,'ราคาเปลี่ยนลดลงตั้งแต่'),h('select',{value:threshold,onChange:e=>setThreshold(e.target.value)},[10,20,30,50].map(n=>h('option',{key:n,value:String(n)},n+'%')))),h('div',{className:'sdd-dashboard-controls-note'},'ดูการเปลี่ยนราคาย้อนหลัง 7 วัน')),
 busy&&h('p',{className:'sdd-dashboard-loading',role:'status'},'กำลังตรวจรายการ…'),error&&h('p',{className:'sdd-error',role:'alert'},error),data&&h(wp.element.Fragment,null,h('div',{className:'sdd-dashboard-updated'},h('span',{'aria-hidden':true},'●'), (busy?' กำลังอัปเดต · แสดงข้อมูลที่โหลดได้เมื่อ ':error?' โหลดใหม่ไม่สำเร็จ · แสดงข้อมูลก่อนหน้าเมื่อ ':' ตรวจล่าสุด ')+date(data.server_time)+' · เวลาตามเว็บไซต์ '+(cfg.timezone||'UTC')),
 data.problems.items.length>0&&h('div',{className:'sdd-attention-banner',role:'status'},h('span',{className:'sdd-attention-icon','aria-hidden':true},'!'),h('div',null,h('strong',null,'มีโปรที่ควรตรวจสอบ '+data.problems.items.length+' รายการ'+(data.problems.limited?'ขึ้นไป':'')),h('p',null,'บางรายการหยุดทำงานหรือเลยกำหนด เริ่มตรวจจากรายการงานด้านล่าง')),h('a',{href:'#sdd-task-board',onClick:()=>onOptions?.({dashboardTab:'problems'})},'ดูรายการที่ต้องตรวจ →')),
 h('div',{className:'sdd-overview-stats'},[['ต้องตรวจสอบ',data.problems.items.length,'red',data.problems.limited?'แสดง 100 รายการแรก':'โปรที่ควรจัดการก่อน'],['ใกล้เริ่มหรือจบ',data.upcoming.items.length,'blue','ตามช่วงเวลาที่เลือก'],['ราคาลดถึงเกณฑ์',data.changes.items.length,'amber','เหตุการณ์ใน 7 วันล่าสุด'],['งานระบบที่ควรตรวจ',data.jobs.length,'violet','ตรวจรายละเอียดด้านล่าง']].map(([label,count,tone,note])=>h('div',{key:label,className:'sdd-overview-stat '+tone},h('span',null,label),h('strong',null,count),h('small',null,note)))),
 h('div',{className:'sdd-dashboard-grid sdd-dashboard-workspace'},h(DashboardTasks,{data,onProduct,onAudit,date,selectedTab:options.dashboardTab,onTabChange:tab=>onOptions?.({dashboardTab:tab})}),
 h('section',{className:'sdd-dashboard-card sdd-dashboard-card--blue sdd-dashboard-jobs'},h('div',{className:'sdd-dashboard-card-header'},h('div',null,h('h2',null,'สถานะงานอัตโนมัติ'),h('p',{className:'sdd-dashboard-card-subtitle'},'ตรวจงานเบื้องหลัง เช่น การเริ่มและจบโปร')),h('span',{className:'sdd-dashboard-count'},data.jobs.length)),data.jobs.length?h('ul',{className:'sdd-dashboard-list'},data.jobs.map(j=>h('li',{key:j.job,className:'sdd-dashboard-job'},h('strong',null,jobs[j.job]||j.job),h('div',{className:'sdd-dashboard-detail'},j.next_at?'ถึงเวลาทำงานแล้วเมื่อ '+date(j.next_at)+' แต่ยังพบงานค้างอยู่':'ไม่พบกำหนดเวลาทำงาน')))):h('p',{className:'sdd-dashboard-empty'},h('span',{'aria-hidden':true},'✓'),'ไม่พบงานที่เลยกำหนดหรือไม่มีกำหนดเวลา'),h(CacheQueueSummary,{data:data.cache_updates}),h('div',{className:'sdd-dashboard-job-note'},h('strong',null,'รายการที่ยังไม่ทราบผล'),h('p',null,data.operations.state==='unavailable'?'ตรวจรายการไม่สำเร็จ กรุณาลองรีเฟรช':data.operations.count?(data.operations.at_least?'อย่างน้อย ':'')+data.operations.count+' รายการ · ตรวจผลก่อนทำรายการเดิมซ้ำ':'ไม่มีรายการที่รอตรวจ')),h('p',{className:'sdd-dashboard-caption'},'การมีกำหนดเวลาไม่ได้ยืนยันว่างานสำเร็จ หากพบปัญหาให้ตรวจรายละเอียดในหน้าตั้งค่า'),h('button',{className:'sdd-dashboard-more',onClick:onSettings},'ดูสถานะระบบในการตั้งค่า')))));
}
function collectPendingDrafts(fields,promotions){
 return [...[...fields.entries()].filter(([,d])=>d.state!=='clean').map(([key,d])=>({id:key.split(':')[0],field:key.split(':')[1],state:d.state})),...[...promotions.entries()].filter(([,d])=>d.state!=='clean').map(([id,d])=>({id,field:'temporary_sale',state:d.state}))];
}
const catalogTabs=[['all','สินค้าทั้งหมด'],['recent','แก้ไขล่าสุด'],['current','โปรชั่วคราวกำลังใช้'],['expiring','โปรชั่วคราวใกล้หมด'],['upcoming','โปรชั่วคราวรอเริ่ม']];
function CatalogBrandFilter({configured,loading,error,brands,search,value,onSearch,onChange,onSetup,onRetry}){
 if(loading)return h('div',{className:'sdd-brand-filter-note',role:'status'},'กำลังอ่านตัวกรองแบรนด์…');
 if(error)return h('div',{className:'sdd-brand-filter-note',role:'status'},h('strong',null,'ยังอ่านแบรนด์ไม่ได้'),h('p',null,error),h('button',{type:'button',onClick:onRetry},'ลองโหลดแบรนด์อีกครั้ง'));
 if(!configured)return h('div',{className:'sdd-brand-filter-note'},h('strong',null,'ยังไม่เปิดตัวกรองแบรนด์'),h('p',null,'ค้นหาด้วยชื่อสินค้า SKU หรือ ID ได้ตามปกติ'),onSetup?h('button',{type:'button',onClick:onSetup},'ตั้งค่าตัวกรองแบรนด์'):h('small',null,'ติดต่อผู้ดูแลเว็บไซต์หากต้องการใช้ตัวกรองแบรนด์'));
 const shown=brands.filter(brand=>brand.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())||brand.id===value);
 return h(wp.element.Fragment,null,h('label',{className:'sdd-filter sdd-brand-search'},h('span',null,'ค้นหาแบรนด์'),h('input',{type:'search',value:search,onChange:e=>onSearch(e.target.value),placeholder:'พิมพ์ชื่อแบรนด์…','aria-label':'ค้นหาแบรนด์'})),h('label',{className:'sdd-filter sdd-brand-picker'},h('span',null,'แบรนด์'),h('select',{'aria-label':'เลือกแบรนด์',value,onChange:e=>onChange(e.target.value)},h('option',{value:''},'ทุกแบรนด์'),shown.map(brand=>h('option',{key:brand.id,value:brand.id},brand.name)),value&&!shown.some(brand=>brand.id===value)&&h('option',{value},'แบรนด์ที่เลือก')),!shown.length&&h('small',null,search?'ไม่พบแบรนด์ตามคำค้น':'ยังไม่มีแบรนด์ที่พร้อมใช้งาน')));
}
function CatalogTabs({scope,counts,loading,onChange}){
 function move(e,index){
  const keys=['ArrowLeft','ArrowRight','Home','End'];if(!keys.includes(e.key))return;
  e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?catalogTabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+catalogTabs.length)%catalogTabs.length;
  onChange(catalogTabs[next][0]);e.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
 }
 return h('div',{className:'sdd-catalog-tabs',role:'tablist','aria-label':'รายการสินค้า','aria-description':'เลื่อนแนวนอนเพื่อดูทุกแท็บ ใช้ปุ่มลูกศรเพื่อเปลี่ยนแท็บ'},catalogTabs.map(([id,label],index)=>h('button',{key:id,id:'sdd-catalog-tab-'+id,role:'tab','aria-controls':'sdd-catalog-results','aria-selected':scope===id,tabIndex:scope===id?0:-1,onClick:()=>onChange(id),onKeyDown:e=>move(e,index)},label,h('span',{className:'sdd-tab-count','aria-label':loading?'กำลังโหลดจำนวนรายการ':(counts?.[id]??'')+' รายการ'},loading?'…':counts?.[id]?.toLocaleString('th-TH')??'—'))));
}
function readWorkspaceLocation(search){
 const q=new URLSearchParams(search),get=key=>q.get('sdd_'+key)||'',id=v=>/^[1-9][0-9]{0,17}$/.test(v)?v:'';
 const one=(key,values,fallback)=>values.includes(get(key))?get(key):fallback;
 return {view:one('view',['products','dashboard','calendar','setup'],'products'),search:get('search').slice(0,200),brand:id(get('brand')),status:one('stock',['instock','outofstock','onbackorder'],''),source:one('source',['new_promotion'],''),promotionPost:id(get('article')),promotion:['current','expiring','upcoming'].includes(get('scope'))?'':one('promotion',['none','current','expiring','future','expired','review'],''),page:/^[1-9][0-9]{0,5}$/.test(get('page'))?Number(get('page')):1,size:[20,50,100].includes(Number(get('size')))?Number(get('size')):50,scope:one('scope',['all','recent','current','expiring','upcoming'],'all'),orderby:one('sort',['name','sku','regular_price'],'name'),order:one('order',['asc','desc'],'asc'),month:/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(get('month'))?get('month'):datePart(String(Math.floor(Date.now()/1000))).slice(0,7),product:id(get('product')),field:one('field',['regular_price','sale_price','stock_status','temporary_sale'],'temporary_sale'),dashboardHours:one('hours',['24','168'],'24'),dashboardThreshold:one('threshold',['10','20','30','50'],'30'),dashboardTab:one('task',['problems','upcoming','changes','all'],'problems'),calendarSearch:get('calendar_search').slice(0,200),calendarStatus:one('calendar_status',['pending','active','needs_review','restored','cancelled','missed'],''),calendarView:one('calendar_view',['month','list'],'month'),calendarSelected:/^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(get('day'))?get('day'):''};
}
function workspaceOptions(r){return Object.fromEntries(['dashboardHours','dashboardThreshold','dashboardTab','calendarSearch','calendarStatus','calendarView','calendarSelected'].map(key=>[key,r[key]]));}
function workspaceQuery(search,state){
 const q=new URLSearchParams(search);[...q.keys()].filter(key=>key.startsWith('sdd_')).forEach(key=>q.delete(key));
 const fields={view:state.view,search:state.search,brand:state.brand,stock:state.status,source:state.source,article:state.promotionPost,promotion:state.promotion,page:state.page,size:state.size,scope:state.scope,sort:state.orderby,order:state.order,month:state.month,product:state.product,field:state.product?state.field:'',hours:state.dashboardHours,threshold:state.dashboardThreshold,task:state.dashboardTab,calendar_search:state.calendarSearch,calendar_status:state.calendarStatus,calendar_view:state.calendarView,day:state.calendarSelected};
 Object.entries(fields).forEach(([key,value])=>{if(value!==''&&value!=null)q.set('sdd_'+key,String(value));});return q.toString();
}
function DirectProduct({id,field,onClose,onSaved,onAudit,tick,onCacheJob}){
 const [row,setRow]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[loadedAt,setLoadedAt]=useState('');
 const root=useRef(null);
 const loadedRequest=useRef(null),directWrite=useRef(false);
 const requestKey=id+':'+tick+':'+retry;
 directWrite.current=loadedRequest.current===requestKey&&!busy&&!error&&!!row;
 const canWrite=()=>directWrite.current;
 const saved=(id,key,value,revision,result)=>{if(result)setRow(r=>r?applyPriceRow(r,id,key,value,revision,result):r);onSaved(id,key,value,revision,result);};
 useEffect(()=>{
  let alive=true,running=false;
  async function readStatus(){
   if(!alive||running||document.hidden)return;
   running=true;
   try{
    const response=await api('cache-updates?'+new URLSearchParams({ids:id}));
    if(alive){
     cacheUpdates.set(String(id),response.items?.[id]||{state:'unavailable'});
     window.dispatchEvent(new CustomEvent('sdd:cache-update'));
    }
   }catch(e){
    if(alive){cacheUpdates.set(String(id),{state:'unavailable'});window.dispatchEvent(new CustomEvent('sdd:cache-update'));}
   }finally{running=false;}
  }
  readStatus();const timer=setInterval(readStatus,15000);
  document.addEventListener('visibilitychange',readStatus);
  return()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',readStatus);};
 },[id,tick,retry]);
 useEffect(()=>{let alive=true;setBusy(true);setError('');api('products/'+id).then(result=>{if(alive){loadedRequest.current=requestKey;setRow(result);setLoadedAt(new Date().toISOString());}}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;directWrite.current=false;};},[id,tick,retry]);
 useEffect(()=>{if(!row||busy||error)return;const el=field==='temporary_sale'?root.current?.querySelector('[data-sdd-focus-field="temporary_sale"]'):root.current?.querySelector('[data-sdd-field="'+field+'"]');const target=field==='temporary_sale'?el:el?.disabled?el.closest('.sdd-cell')?.querySelector('button:not(:disabled)'):el?.matches('input,select')?el:el?.querySelector('input,button');target?.focus();el?.scrollIntoView({block:'nearest',behavior:'smooth'});},[id,field,!!row,busy,error]);
 return h('section',{className:'sdd-direct-product','data-product-id':id,ref:root,'aria-label':'พื้นที่แก้ไขสินค้า'},h('div',{className:'sdd-direct-heading'},h('button',{onClick:onClose},'← กลับรายการเดิม'),h('span',null,'สินค้า #'+id+(row?.parent_id?' · ตัวเลือกย่อยของ #'+row.parent_id:'')),cfg.canAudit&&h('button',{onClick:()=>onAudit(id)},'ประวัติราคา')),
 busy&&h('p',{role:'status',className:'sdd-loading-notice'},row?'กำลังตรวจข้อมูลล่าสุด…':'กำลังเปิดสินค้าที่เลือก…'),error&&h('div',{role:'alert',className:'sdd-error'},error,row&&h('p',null,'ข้อมูลด้านล่างเป็นข้อมูลก่อนหน้า ยังแก้ไขไม่ได้'),h('button',{onClick:()=>setRetry(n=>n+1)},'ลองโหลดอีกครั้ง')),
 row&&h(wp.element.Fragment,null,h('p',{className:'sdd-last-loaded'},'ข้อมูลล่าสุดที่โหลดได้ '+displayDate(loadedAt)),
 h('div',{className:'sdd-direct-fields'},h('h2',null,row.name),h(CacheUpdateStatus,{id:row.id,detail:true,onJob:onCacheJob}),row.storefront_url&&h('a',{href:row.storefront_url,target:'_blank',rel:'noopener noreferrer'},'เปิดหน้าสินค้าบนหน้าร้าน ↗'),row.attributes&&h('p',null,row.attributes),row.type==='variable'?h('p',null,'สินค้าแม่มีหลายตัวเลือก กลับไปขยายกลุ่มเพื่อเลือกตัวเลือกที่ต้องการแก้ไข'):['regular_price','sale_price','stock_status'].map(key=>h('div',{key,className:'sdd-direct-field'},h('h3',null,labels[key]),h(Cell,{row:busy||error?{...row,editable:{}}:row,field:key,onSaved:saved,canWrite})))),
 cfg.canSettings&&(['simple','variation'].includes(row.type)||row.bundle_temp_promo)&&!busy&&!error&&h(PromotionPanel,{row,onSaved,onClose,onAudit,canWrite})));
}
const bulkPriceInteger=/^(?:0|[1-9]\d{0,14})$/;
function bulkPriceDifference(before,after){
 if(before===''&&bulkPriceInteger.test(after))return h('span',{className:'sdd-bulk-difference'},'ตั้งราคาใหม่');
 if(!bulkPriceInteger.test(before)||!bulkPriceInteger.test(after))return '—';
 const delta=Number(after)-Number(before);
 if(!delta)return 'เท่าเดิม';
 return h('span',{className:'sdd-bulk-difference '+(delta>0?'is-increase':'is-decrease')},
  (delta>0?'เพิ่ม ':'ลด ')+Math.abs(delta).toLocaleString('en-US')+' บาท');
}
function bulkFormulaText({target,basis,direction,unit,amount}){
 const change=direction==='decrease'?'ลด':'เพิ่ม';
 const value=unit==='percent'?amount+'%':showValue(amount,target)+' บาท';
 if(target==='regular_price')return change+'ราคาปกติ '+value;
 if(basis==='sale_price')return change+'ราคาโปรเดิม '+value;
 return 'ตั้งราคาโปร '+(direction==='decrease'?'ต่ำกว่า':'สูงกว่า')+'ราคาปกติ '+value;
}
function bulkFormulaExample(row,{target,basis,direction,unit,amount}){
 const base=row[basis];
 if(['pending','active','needs_review'].includes(row.temporary_sale?.status))return {reason:'มีโปรชั่วคราวที่ยังไม่ปิด'};
 if(row.sale_schedule?.state&&row.sale_schedule.state!=='none')return {reason:'สินค้ามีตารางโปร'};
 if(row.editable?.[target]===false)return {reason:'ช่องราคานี้แก้ไขไม่ได้'};
 if(basis==='sale_price'&&(base===''||base==='0'))return {reason:'ยังไม่มีราคาโปรเดิมให้อิง'};
 if(!bulkPriceInteger.test(base))return {reason:'ไม่มีราคาอ้างอิงที่ใช้คำนวณได้'};
 const sign=direction==='decrease'?-1n:1n;
 const before=BigInt(base);
 let after;
 if(unit==='percent'){
  const [whole,fraction='']=amount.split('.');
  const hundredths=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  // Match the server's half-up rounding for whole-baht prices.
  after=(before*(10000n+sign*hundredths)+5000n)/10000n;
 }else{
  after=before+sign*BigInt(amount);
 }
 const value=String(after);
 if(!bulkPriceInteger.test(value))return {reason:'ราคาที่คำนวณได้อยู่นอกช่วงที่บันทึกได้'};
 if((target==='sale_price'&&(!bulkPriceInteger.test(row.regular_price)||after>=BigInt(row.regular_price)))
   ||(target==='regular_price'&&bulkPriceInteger.test(row.sale_price)&&BigInt(row.sale_price)>=after)){
  return {reason:'ราคาโปรต้องต่ำกว่าราคาปกติ'};
 }
 return {value};
}
function BulkFormulaExamples({selection,params,validAmount}){
 const rows=[...selection.values()].slice(0,3);
 const price=(value,field)=>value===''||value==null?'—':showValue(value,field)+' บาท';
 return h('section',{className:'sdd-bulk-examples','aria-labelledby':'sdd-bulk-example-title'},
  h('div',{className:'sdd-bulk-example-heading'},
   h('h3',{id:'sdd-bulk-example-title'},'ตัวอย่างจากสินค้าที่เลือก'),
   selection.size>rows.length&&h('span',null,'แสดง '+rows.length+' จาก '+selection.size+' รายการ')),
  h('p',null,validAmount?bulkFormulaText(params)+' · ราคายังไม่เปลี่ยน':'กรอกจำนวนเพื่อดูราคาใหม่ทันที'),
  h('ul',null,rows.map(row=>{
   const result=validAmount?bulkFormulaExample(row,params):{};
   return h('li',{key:row.id},
    h('div',{className:'sdd-bulk-example-product'},
     row.thumbnail_url&&h('img',{src:row.thumbnail_url,alt:'',width:44,height:44,loading:'lazy',onError:e=>{e.currentTarget.hidden=true;}}),
     h('div',null,h('strong',null,row.name),row.sku&&h('small',null,row.sku))),
    h('div',{className:'sdd-bulk-example-values'},
     h('div',null,h('span',null,params.target==='sale_price'?'ราคาโปรเดิม':'ราคาปกติเดิม'),
      h('strong',null,price(row[params.target],params.target)),
      params.basis!==params.target&&h('small',null,'อิงราคาปกติ '+price(row[params.basis],params.basis))),
     h('div',{className:'sdd-bulk-example-new'},h('span',null,'ราคาที่คำนวณได้'),
      result.value===undefined?h('span',null,'—'):h('strong',null,price(result.value,params.target))),
     h('div',{className:'sdd-bulk-example-delta'},
      result.reason?h('small',null,result.reason):result.value!==undefined&&bulkPriceDifference(row[params.target],result.value))));
  })));
}
function BulkFormulaSteps({review,activeRef}){
 return h('ol',{className:'sdd-bulk-steps','aria-label':'ขั้นตอนใช้สูตรเดียวทั้งชุด'},
  h('li',{'aria-current':review?undefined:'step'},h('span',{'aria-hidden':true},review?'✓':'1'),'ตั้งสูตร'),
  h('li',{'aria-current':review?'step':undefined,ref:activeRef,tabIndex:review?-1:undefined},h('span',{'aria-hidden':true},'2'),'ตรวจราคา'));
}
function BulkResultStatus({row}){
 const statuses={pending:'รอบันทึก',succeeded:'บันทึกแล้ว',unknown:'ยังยืนยันผลไม่ได้',skipped:'ข้าม',stopped:'หยุด',conflict:'ข้อมูลเปลี่ยน',failed:'บันทึกไม่สำเร็จ'};
 return h(wp.element.Fragment,null,statuses[row.status]||row.status,
  (row.result?.message||row.reason)&&h('small',null,row.result?.message||row.reason),
  row.child_operation_id&&h('small',null,row.child_operation_id));
}
function BulkFormulaCards({items}){
 const price=(value,field)=>value===''?'—':showValue(value,field)+' บาท';
 return h('ul',{className:'sdd-bulk-formula-cards'},items.map(row=>{
  const unapplied=!['pending','succeeded'].includes(row.status);
  return h('li',{key:row.item_id,className:unapplied?'is-unapplied':undefined},
  h('div',{className:'sdd-bulk-formula-product'},h('strong',null,row.name||'#'+row.product_id),h('span',null,labels[row.field])),
  row.status!=='pending'&&h('div',{className:'sdd-bulk-formula-status'},h(BulkResultStatus,{row})),
  h('dl',{className:'sdd-bulk-formula-prices'},
   h('div',null,h('dt',null,'ราคาเดิม'),h('dd',null,price(row.before,row.field))),
   h('div',null,h('dt',null,unapplied?'ราคาที่คำนวณ':'ราคาใหม่'),h('dd',null,h('strong',null,price(row.after,row.field)))),
   h('div',null,h('dt',null,'ส่วนต่าง'),h('dd',null,bulkPriceDifference(row.before,row.after)))));
 }));
}
function BulkTemporaryRows({rows,onPrice,busy}){
 const price=value=>value==null||value===''?'—':showValue(value,'sale_price')+' บาท';
 return h('ul',{className:'sdd-bulk-temp-rows'},rows.map(row=>{
  const {schedule}=row;
  const needsReview=schedule?.status==='needs_review';
  const openReview=needsReview||(!onPrice&&row.status==='conflict');
  const invalid=!!onPrice&&row.after!==''&&!bulkPriceInteger.test(row.after);
  const url=new URL(window.location.href);
  url.searchParams.set('sdd_product',row.product_id);
  url.searchParams.set('sdd_field','temporary_sale');
  return h('li',{key:row.item_id,className:'sdd-bulk-temp-row'},
   h('div',{className:'sdd-bulk-temp-identity'},
    h('div',null,h('strong',null,row.name),row.sku&&h('small',null,row.sku)),
    h('span',{className:'sdd-status '+(schedule?.status||'')},schedule?promoLabels[schedule.status]||schedule.status:'ยังไม่มีโปรชั่วคราว')),
   schedule&&h('div',{className:'sdd-bulk-temp-fields'},
    h('div',null,h('span',null,'ราคาโปรเดิม'),h('strong',null,price(row.before))),
    h('div',null,
     onPrice&&!needsReview?h('label',{className:'sdd-bulk-field'},'ราคาโปรใหม่ (บาท)',h('input',{
      'aria-label':'ราคาโปรใหม่ '+row.name+(row.sku?' · '+row.sku:' #'+row.product_id),
      inputMode:'numeric',value:row.after,disabled:!!busy,'aria-invalid':invalid,
      'aria-describedby':invalid?'sdd-temp-price-error-'+row.product_id:undefined,
      onChange:e=>onPrice(row.product_id,e.target.value)}),
      invalid&&h('small',{id:'sdd-temp-price-error-'+row.product_id},'จำนวนเต็มไม่เกิน 15 หลัก')):
      h(wp.element.Fragment,null,h('span',null,'ราคาโปรใหม่'),h('strong',null,price(row.after))),
     !invalid&&row.after!==''&&row.after!=null&&row.after!==row.before&&bulkPriceDifference(row.before,row.after)),
    h('div',null,h('span',null,'มีผลเมื่อ'),h('strong',null,needsReview?'รอตรวจสอบ':
     !onPrice&&!['pending','succeeded'].includes(row.status)?'—':
     schedule.status==='active'?(row.status==='succeeded'?'มีผลแล้ว':'หลังยืนยันบันทึก'):promoTime(schedule.starts_at))),
    h('div',null,h('span',null,'สิ้นสุด'),h('strong',null,promoTime(schedule.ends_at))),
    h('div',null,h('span',null,'ราคาหลังจบตามแผน'),h('strong',null,price(schedule.return_price)))),
   openReview&&h('div',{className:'sdd-bulk-temp-note'},needsReview&&h('span',null,schedule.message||'ตรวจราคาและสถานะโปรก่อนแก้ไข'),
    h('a',{href:url.href,target:'_blank',rel:'noopener noreferrer'},'เปิดจัดการโปรในแท็บใหม่')),
   !onPrice&&row.status!=='pending'&&h('div',{className:'sdd-bulk-formula-status'},h(BulkResultStatus,{row})));
 }));
}
function BulkCreatePromotions({selection,onChanged}){
 const [startNow,setStartNow]=useState(true),[start,setStart]=useState(''),[end,setEnd]=useState('');
 const [prices,setPrices]=useState({}),[review,setReview]=useState(null),[done,setDone]=useState(null);
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
 const key='sdd-bulk-create-promo:'+cfg.api+':'+cfg.userId;
 const [last,setLast]=useState(()=>{try{return sessionStorage.getItem(key)||'';}catch{return '';}});
 const heading=useRef(null);
 useEffect(()=>{heading.current?.focus();},[!!review,!!done]);
 const selected=[...selection.values()];
 const changes=selected.filter(row=>!row.temporary_sale&&row.editable?.sale_price&&prices[row.id])
  .map(row=>({id:String(row.id),price:prices[row.id]}));
 const now=localMinute(Date.now()/1000);
 const startError=!startNow&&start&&start<=now?'วันเริ่มต้องอยู่ในอนาคต':'';
 const endError=end&&(end<=now||!startNow&&start&&end<=start)?'วันจบต้องอยู่หลังเวลาเริ่มโปร':'';
 const pricingError=changes.some(row=>!bulkPriceInteger.test(row.price)||row.price==='0');
 const nextStep=!startNow&&!start?'เลือกวันและเวลาเริ่มโปร':startError?'แก้เวลาเริ่มโปร':
  !end?'เลือกวันและเวลาจบโปร':endError?'แก้เวลาจบโปร':!changes.length?'กรอกราคาโปรอย่างน้อย 1 สินค้า':
  changes.length>100?'ตั้งโปรได้สูงสุด 100 รายการต่อชุด':pricingError?'แก้ราคาที่มีข้อความแจ้ง':'';
 const valid=!nextStep;
 const money=value=>value==null||value===''?'—':showValue(value,'sale_price')+' บาท';
 const run=async(message,action)=>{
  if(busy)return;
  setBusy(message);setError('');
  try{await action();}catch(e){setError(e.message);}finally{setBusy('');}
 };
 const inspect=()=>run('กำลังตรวจผล…',async()=>{
  const response=await api('promotion-import/'+(review?.batch||last));
  if(response.status==='completed'){setDone(response);setReview(null);onChanged([]);}
  else setReview(response);
  setUncertain(false);
 });
 const preview=()=>run('กำลังตรวจราคาและช่วงโปร…',async()=>{
  const response=await api('promotion-bulk',{start:startNow?'now':start,end,rows:changes});
  setReview(response);
 });
 const confirm=()=>run('กำลังบันทึกแผนโปร…',async()=>{
  setLast(review.batch);
  try{sessionStorage.setItem(key,review.batch);}catch{}
  try{
   const result=await api('promotion-import/'+review.batch,{revision:review.revision});
   setDone(result);setReview(null);onChanged([]);
  }catch(e){if(e.code==='operation_unknown')setUncertain(true);throw e;}
 });
 const period=review?.rows[0];
 const calendarLink=done?.first_start?new URL(window.location.href):null;
 if(calendarLink){
  const day=datePart(String(done.first_start));
  calendarLink.searchParams.delete('sdd_product');
  calendarLink.searchParams.delete('sdd_field');
  calendarLink.searchParams.set('sdd_view','calendar');
  calendarLink.searchParams.set('sdd_month',day.slice(0,7));
  calendarLink.searchParams.set('sdd_day',day);
 }
 return h('section',{className:'sdd-bulk-create','aria-busy':!!busy},
  busy&&h('p',{role:'status'},busy),
  error&&h('p',{role:'alert',className:'sdd-error'},error),
  done?h('div',{className:'sdd-bulk-result',role:'status'},
   h('h3',{tabIndex:-1,ref:heading},'ตั้งโปรแล้ว '+done.count+' รายการ'),
   calendarLink&&h('a',{href:calendarLink.href},'ดูสถานะในปฏิทินโปรชั่วคราว')):
  review?h(wp.element.Fragment,null,
   h('h3',{tabIndex:-1,ref:heading},'ตรวจแผนโปรก่อนยืนยัน'),
   h('div',{className:'sdd-bulk-result'},
    h('strong',null,'พร้อมตั้งโปร '+review.rows.length+' รายการ'+(review.excluded?.length?' · ข้าม '+review.excluded.length+' รายการ':'')),
    period&&h('div',null,(review.start_now?'เริ่มหลังบันทึก':'เริ่ม '+promoTime(period.start))+' · จบ '+promoTime(period.end))),
   h('ul',{className:'sdd-bulk-temp-rows'},review.rows.map(row=>h('li',{key:row.id,className:'sdd-bulk-temp-row'},
    h('strong',null,row.name),
    h('div',{className:'sdd-bulk-create-prices'},
     h('div',null,h('small',null,'ราคาปัจจุบัน'),money(row.current_price)),
     h('div',null,h('small',null,'ราคาโปร'),h('strong',null,money(row.price))),
     h('div',null,h('small',null,'ราคาหลังจบตามแผน'),money(row.after))))),
    review.excluded?.map(row=>h('li',{key:row.id,className:'sdd-bulk-temp-row'},h('strong',null,row.name),h('p',null,row.message)))),
   h('div',{className:'sdd-bulk-footer'},
    h('button',{type:'button',disabled:!!busy||uncertain,onClick:()=>{setReview(null);setError('');}},'กลับไปแก้'),
    uncertain?h('button',{type:'button',className:'sdd-primary',disabled:!!busy,onClick:inspect},'ตรวจผลชุดเดิม'):
     h('button',{type:'button',className:'sdd-primary',disabled:!!busy||!period,onClick:confirm},
      (review.start_now?'เริ่มโปรหลังบันทึก ':'ตั้งโปรล่วงหน้า ')+review.rows.length+' รายการ'))):
  h('form',{className:'sdd-bulk-create-form',onSubmit:e=>{e.preventDefault();if(valid&&!busy)preview();}},
   last&&h('button',{type:'button',className:'sdd-bulk-recover',disabled:!!busy,onClick:inspect},'ตรวจผลชุดเดิม'),
   h('fieldset',{className:'sdd-bulk-create-dates'},
    h('legend',{tabIndex:-1,ref:heading},'ช่วงเวลาโปรของทั้งชุด'),
    h('div',{className:'sdd-bulk-start-options'},
     h('label',null,h('input',{type:'radio',name:'sdd-bulk-promo-start',checked:startNow,disabled:!!busy,onChange:()=>setStartNow(true)}),'เริ่มหลังบันทึก'),
     h('label',null,h('input',{type:'radio',name:'sdd-bulk-promo-start',checked:!startNow,disabled:!!busy,onChange:()=>setStartNow(false)}),'ตั้งวันเริ่มล่วงหน้า')),
    h('div',{className:'sdd-bulk-create-datetime'},
     !startNow&&h('label',{className:'sdd-bulk-field'},'วันและเวลาเริ่ม',h('input',{type:'datetime-local',value:start,disabled:!!busy,
      'aria-invalid':!!startError,'aria-describedby':startError?'sdd-bulk-create-start-error':'sdd-bulk-create-timezone',onChange:e=>setStart(e.target.value)}),
      startError&&h('small',{id:'sdd-bulk-create-start-error',className:'sdd-bulk-create-error'},startError)),
     h('label',{className:'sdd-bulk-field'},'วันและเวลาจบ',h('input',{type:'datetime-local',value:end,disabled:!!busy,
      'aria-invalid':!!endError,'aria-describedby':endError?'sdd-bulk-create-end-error':'sdd-bulk-create-timezone',onChange:e=>setEnd(e.target.value)}),
      endError&&h('small',{id:'sdd-bulk-create-end-error',className:'sdd-bulk-create-error'},endError))),
    h('small',{id:'sdd-bulk-create-timezone'},cfg.timezone==='Asia/Bangkok'?'เวลาไทย (UTC+7)':'เขตเวลา '+(cfg.timezone||'UTC'))),
   h('div',{className:'sdd-bulk-create-heading'},
    h('h3',null,'ราคาของสินค้าที่ร่วมโปร'),
    h('p',null,'เว้นช่องราคาโปรไว้สำหรับสินค้าที่ไม่ร่วมโปร'+(!end?' · เลือกวันจบเพื่อดูราคาที่จะคืน':''))),
   h('table',{className:'sdd-bulk-create-table',role:'table','aria-label':'ราคาสินค้าที่ร่วมโปร'},
    h('thead',{role:'rowgroup'},h('tr',{role:'row'},['สินค้า','ราคาปัจจุบัน','ราคาโปร (บาท)','คืนหลังจบตามแผน'].map(label=>h('th',{key:label,scope:'col',role:'columnheader'},label)))),
    h('tbody',{role:'rowgroup'},selected.map(row=>{
    const value=prices[row.id]||'';
    const invalid=value!==''&&(!bulkPriceInteger.test(value)||value==='0');
    const existing=row.temporary_sale;
    const url=new URL(window.location.href);
    url.searchParams.set('sdd_product',row.id);url.searchParams.set('sdd_field','temporary_sale');
    return h('tr',{key:row.id,role:'row',className:value&&!invalid?'is-priced':undefined},
     h('th',{scope:'row',role:'rowheader'},h('strong',null,row.name),row.sku&&h('small',null,row.sku)),
     existing||!row.editable?.sale_price?h('td',{role:'cell',colSpan:3,className:'sdd-bulk-create-blocked'},
      existing?h(wp.element.Fragment,null,'มีโปรชั่วคราวอยู่แล้ว',h('a',{href:url.href,target:'_blank',rel:'noopener noreferrer'},'เปิดจัดการโปร')):
       'สินค้านี้ยังตั้งราคาโปรไม่ได้'):
      h(wp.element.Fragment,null,
       h('td',{role:'cell'},h('span',{className:'sdd-bulk-create-mobile','aria-hidden':true},'ราคาปัจจุบัน'),money(row.current_price)),
       h('td',{role:'cell'},h('div',{className:'sdd-bulk-field'},
        h('span',{className:'sdd-bulk-create-mobile','aria-hidden':true},'ราคาโปร (บาท)'),
        h('input',{'aria-label':'ราคาโปร '+row.name+(row.sku?' · '+row.sku:' #'+row.id),inputMode:'numeric',placeholder:'กรอกราคา',
         value:displayPrice(value),disabled:!!busy,'aria-invalid':invalid,'aria-describedby':invalid?'sdd-bulk-create-price-'+row.id:undefined,
         onChange:e=>editPrice(e,price=>setPrices(current=>({...current,[row.id]:price})))}),
        invalid&&h('small',{id:'sdd-bulk-create-price-'+row.id,className:'sdd-bulk-create-error'},'กรอกราคาจำนวนเต็มมากกว่า 0 ไม่เกิน 15 หลัก'))),
       h('td',{role:'cell',className:'sdd-bulk-create-restore'},h('span',{className:'sdd-bulk-create-mobile','aria-hidden':true},'คืนหลังจบตามแผน'),end&&!endError?money(restoredPrice(row,end)):'—')));
   }))),
   h('div',{className:'sdd-bulk-footer sdd-bulk-create-footer'},
    h('p',{role:'status'},nextStep||(changes.length+' รายการพร้อมตรวจ')),
    h('button',{type:'submit',className:'sdd-primary',disabled:!!busy||!valid},'ตรวจแผนโปร'))));
}
function BulkPricePanel({selection,eventId,onClose,onChanged}){
 const [params,setParams]=useState({target:'regular_price',basis:'regular_price',direction:'decrease',unit:'baht',amount:''});
 const [mode,setMode]=useState('manual'),[manual,setManual]=useState({});
 const [temporary,setTemporary]=useState({});
 const [batch,setBatch]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[zero,setZero]=useState(false);
 const [needsCheck,setNeedsCheck]=useState(false);
 const heading=useRef(null),reviewHeading=useRef(null);
 const key='sdd-bulk:'+cfg.api+':'+cfg.userId+':'+(eventId||'bulk');
 const [remembered,setRemembered]=useState(()=>{try{return sessionStorage.getItem(key)||'';}catch{return '';}});
 const label=eventId?'ย้อนราคา':'แก้ราคาหลายรายการ';
 const reviewing=!!batch;
 const reviewedFormula=batch?.params?.action==='adjust_price'?batch.params.params:null;
 const temporaryView=!eventId&&(reviewing?batch.kind==='bulk_temp_price':mode==='temporary');
 const createView=!eventId&&!reviewing&&mode==='create';
 const formulaView=!eventId&&(reviewing?!!reviewedFormula:mode==='formula');
 const manualEntry=!eventId&&!reviewing&&mode==='manual'&&selection.size>0;
 const formulaPreview=formulaView&&batch?.status==='preview';
 const reviewedIds=batch?.params?.ids;
 const sameFormulaSelection=Array.isArray(reviewedIds)&&reviewedIds.length===selection.size&&reviewedIds.every(id=>selection.has(id));
 useEffect(()=>{(reviewing?reviewHeading:heading).current?.focus();},[reviewing,formulaPreview]);
 const patch=change=>setParams(current=>({...current,...change,...(change.target==='regular_price'?{basis:'regular_price'}:{})}));
 const manualField=row=>manual[row.id]?.field||(row.editable?.regular_price?'regular_price':'sale_price');
 const manualRows=[...selection.values()].map(row=>{
  const field=manualField(row);
  return {row,field,before:row[field],value:manual[row.id]?.value??''};
 });
 const changes=manualRows.filter(({row,field,before,value})=>row.editable?.[field]&&value!==''&&value!==before);
 const validManual=changes.length>0&&changes.every(({value})=>bulkPriceInteger.test(value));
 const temporaryRows=temporaryView&&!batch?[...selection.values()].map(row=>({
  item_id:row.id,product_id:row.id,name:row.name,sku:row.sku,schedule:row.temporary_sale?.id?row.temporary_sale:null,
  before:row.temporary_sale?.price??'',after:temporary[row.id]??'',
 })):[];
 const temporaryChanges=temporaryRows.filter(row=>['pending','active'].includes(row.schedule?.status)&&row.after!==''&&row.after!==row.before);
 const temporaryReviewCount=temporaryRows.filter(row=>row.schedule?.status==='needs_review').length;
 const validTemporary=temporaryChanges.length>0&&temporaryChanges.every(row=>bulkPriceInteger.test(row.after));
 const saveBatch=result=>{
  setBatch(result);
  setNeedsCheck(false);
  setRemembered(result.operation_id);
  try{sessionStorage.setItem(key,result.operation_id);}catch{}
 };
 const applySaved=result=>{
  const saved=result.items.filter(row=>row.status==='succeeded');
  if(!saved.length)return;
  if(result.kind==='bulk_temp_price'){
   setTemporary(current=>{
    const next={...current};
    for(const row of saved)if(next[row.product_id]===row.after)delete next[row.product_id];
    return next;
   });
   onChanged(saved);
   return;
  }
  setManual(current=>{
   const next={...current};
   for(const {product_id,field,after} of saved){
    if(next[product_id]?.field===field&&next[product_id].value===after)delete next[product_id];
   }
   return next;
  });
  onChanged(saved);
 };
 const run=async(message,action)=>{
  if(busy)return;
  setBusy(message);setError('');
  try{await action();}catch(e){setError(e.message);}finally{setBusy('');}
 };
 const check=()=>run('กำลังตรวจผลชุดเดิม…',async()=>{
  const result=await api('operations/'+(batch?.operation_id||remembered));
  saveBatch(result);
  applySaved(result);
 });
 const preview=()=>run('กำลังตรวจราคา…',async()=>{
  const payload=mode==='temporary'?{action:'set_temporary_prices',rows:temporaryChanges.map(row=>({id:String(row.product_id),promotion_id:row.schedule.id,value:row.after}))}:
   mode==='manual'?{action:'set_prices',rows:changes.map(({row,field,value})=>({id:String(row.id),field,value}))}:
   {ids:[...selection.keys()],action:'adjust_price',params};
  const result=eventId?await api('events/'+eventId+'/rollback-preview',{}):await api('bulk/preview',payload);
  setZero(false);saveBatch(result);
 });
 const execute=()=>run(batch.status==='preview'?'รอยืนยันการบันทึกราคา…':'กำลังบันทึกราคา…',async()=>{
  if(batch.status==='preview'&&!await confirmChange('ยืนยัน '+batch.pending+' รายการตามราคาในผลตรวจก่อนบันทึก',{title:label,confirmLabel:'ยืนยันบันทึกราคา'}))return;
  setBusy('กำลังบันทึกราคา…');
  try{
   const result=await api('operations/'+batch.operation_id+'/execute',{confirmation_hash:batch.payload_hash,acknowledgements:zero?['price_change','zero_price']:['price_change']});
   saveBatch(result);
   applySaved(result);
  }catch(e){setNeedsCheck(true);throw e;}
 });
 const stop=()=>run('กำลังหยุดรายการที่เหลือ…',async()=>{
  if(await confirmChange('หยุดรายการที่ยังไม่เริ่ม โดยคงราคาและหลักฐานของคำสั่งเดิม',{title:'หยุดชุดนี้?',confirmLabel:'ยืนยันหยุดชุด'})){
   saveBatch(await api('operations/'+batch.operation_id+'/stop',{confirmed:true}));
  }
 });
 const choice=(title,key,options)=>h('div',{className:'sdd-bulk-field'},
  h('label',{htmlFor:'sdd-bulk-'+key},title),
  h('select',{id:'sdd-bulk-'+key,disabled:busy,value:params[key],onChange:e=>patch({[key]:e.target.value})},
   options.map(([value,name])=>h('option',{key:value,value},name))));
 const zeroRequired=batch?.items.some(row=>row.status==='pending'&&row.after==='0');
 const empty=!eventId&&!batch&&!selection.size;
 const percent=params.unit==='percent';
 const validAmount=percent?/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$|^100(?:\.0{1,2})?$/.test(params.amount):bulkPriceInteger.test(params.amount);
 const amountHint=percent?'0–100% ทศนิยมไม่เกิน 2 ตำแหน่ง':'จำนวนเต็มไม่เกิน 15 หลัก';
 const editFormula=()=>{
  setMode('formula');
  setParams(reviewedFormula);
  setBatch(null);
 };
 const previewCount=batch?batch.pending+' รายการพร้อมบันทึก'+(batch.progress.skipped?' · ข้าม '+batch.progress.skipped+' รายการ':''):'';
 return h('section',{className:'sdd-setup-card sdd-bulk-panel'+(formulaView?' sdd-bulk-formula':temporaryView||createView?' sdd-bulk-temp':manualEntry?' sdd-bulk-manual':''),'aria-labelledby':'sdd-bulk-title','aria-busy':!!busy},
  h('header',{className:'sdd-bulk-header'},h('h2',{id:'sdd-bulk-title',tabIndex:-1,ref:heading},label),
   !empty&&h('button',{type:'button',disabled:busy,onClick:()=>onClose(false),
    'aria-label':formulaView||manualEntry?'กลับรายการสินค้า':undefined},eventId?'← กลับประวัติราคา':formulaView||manualEntry?'← กลับ':'← กลับรายการสินค้า')),
  error&&h('p',{role:'alert',className:'sdd-error'},error),
  busy&&h('p',{role:'status'},busy),
  !batch&&h(wp.element.Fragment,null,
   remembered&&!createView&&h('button',{type:'button',className:'sdd-bulk-recover',disabled:busy,onClick:check},'เปิดผลชุดเดิม'),
   empty?h('div',{className:'sdd-bulk-empty'},
    h('h3',null,'ยังไม่ได้เลือกสินค้า'),
    h('p',null,'กลับไปติ๊กเลือกสินค้าที่ต้องการแก้ราคา แล้วเปิด “แก้ราคาหลายรายการ” อีกครั้ง'),
    h('button',{type:'button',className:'sdd-primary',disabled:busy,onClick:()=>onClose(true)},'ไปเลือกสินค้า')):
   eventId?h('div',{className:'sdd-bulk-rollback'},h('p',null,'เหตุการณ์ #'+eventId+' · ตรวจราคาปัจจุบันและราคาที่จะย้อนก่อนยืนยัน'),
    h('button',{type:'button',className:'sdd-primary',disabled:busy,onClick:preview},'ตรวจราคาก่อนบันทึก')):
   h(wp.element.Fragment,null,
   h('div',{className:'sdd-bulk-mode','aria-label':'วิธีแก้ราคา',role:'group'},
    h('button',{type:'button','aria-pressed':mode==='manual',disabled:busy,onClick:()=>setMode('manual')},'กรอกราคาแยกแต่ละสินค้า'),
    h('button',{type:'button','aria-pressed':mode==='formula',disabled:busy,onClick:()=>setMode('formula')},'ใช้สูตรเดียวทั้งชุด'),
    cfg.canImportPromotions&&h('button',{type:'button','aria-pressed':mode==='create',disabled:busy,onClick:()=>setMode('create')},'ตั้งโปรชั่วคราว'),
    cfg.canImportPromotions&&h('button',{type:'button','aria-pressed':mode==='temporary',disabled:busy,onClick:()=>setMode('temporary')},'แก้โปรชั่วคราว')),
   createView?h(BulkCreatePromotions,{selection,onChanged}):
   temporaryView?h('form',{className:'sdd-bulk-form',onSubmit:e=>{e.preventDefault();if(!busy&&validTemporary)preview();}},
    h('p',{className:'sdd-bulk-manual-hint'},'กรอกราคาโปรใหม่รายสินค้า ระบบใช้วันเริ่ม วันจบ และแผนคืนราคาเดิม'),
    h(BulkTemporaryRows,{rows:temporaryRows,onPrice:(id,value)=>setTemporary(current=>({...current,[id]:value})),busy}),
    h('div',{className:'sdd-bulk-footer'},h('p',{role:'status'},'แก้ราคาโปร '+temporaryChanges.length+' รายการ'+
     (temporaryReviewCount?' · ต้องตรวจสอบ '+temporaryReviewCount+' รายการ':'')),
     h('button',{type:'submit',className:'sdd-primary',disabled:busy||!validTemporary},'ตรวจโปรก่อนบันทึก'))):
   mode==='manual'?h('form',{className:'sdd-bulk-form',onSubmit:e=>{e.preventDefault();if(!busy&&validManual)preview();}},
    h('p',{className:'sdd-bulk-manual-hint'},'เลือกช่องราคาแล้วกรอกจำนวนเต็ม เว้นว่างสำหรับสินค้าที่ไม่ต้องการแก้'),
    h('table',{className:'sdd-bulk-manual-table',role:'table','aria-label':'ราคาสินค้าที่เลือก'},
     h('thead',{role:'rowgroup'},h('tr',{role:'row'},['สินค้า','ช่องราคา','ราคาเดิม','ราคาใหม่ (บาท)','ส่วนต่าง'].map(text=>h('th',{key:text,scope:'col',role:'columnheader'},text)))),
     h('tbody',{role:'rowgroup'},manualRows.map(({row,field,before,value})=>{
     const invalid=value!==''&&!bulkPriceInteger.test(value);
     const edited=value!==''&&value!==before;
     const name=row.name+(row.sku?' · '+row.sku:' #'+row.id);
     return h('tr',{key:row.id,role:'row',className:'sdd-bulk-manual-row'+(edited?' is-edited':'')},
      h('th',{scope:'row',role:'rowheader',className:'sdd-bulk-manual-product'},h('strong',null,row.name),h('small',null,row.sku||'#'+row.id)),
      h('td',{role:'cell'},h('div',{className:'sdd-bulk-field'},h('span',{className:'sdd-bulk-mobile-label','aria-hidden':true},'ช่องราคา'),
       h('select',{'aria-label':'ช่องราคา '+name,value:field,disabled:busy,onChange:e=>setManual(current=>({...current,[row.id]:{field:e.target.value,value:''}}))},
        h('option',{value:'regular_price',disabled:!row.editable?.regular_price},'ราคาปกติ'),
        h('option',{value:'sale_price',disabled:!row.editable?.sale_price},'ราคาโปร')))),
      h('td',{role:'cell',className:'sdd-bulk-previous'},h('span',{className:'sdd-bulk-mobile-label','aria-hidden':true},'ราคาเดิม'),h('strong',null,showValue(before,field)),before!==''&&h('small',null,' บาท')),
      h('td',{role:'cell'},h('div',{className:'sdd-bulk-field'},h('span',{className:'sdd-bulk-mobile-label','aria-hidden':true},'ราคาใหม่ (บาท)'),
       h('input',{'aria-label':'ราคาใหม่ '+name,inputMode:'numeric',value,placeholder:'ราคาใหม่',disabled:busy||!row.editable?.[field],
        'aria-invalid':invalid,'aria-describedby':invalid?'sdd-bulk-price-error-'+row.id:undefined,
        onChange:e=>setManual(current=>({...current,[row.id]:{field,value:e.target.value}}))}),
       invalid&&h('small',{id:'sdd-bulk-price-error-'+row.id},'จำนวนเต็มไม่เกิน 15 หลัก'))),
      h('td',{role:'cell',className:'sdd-bulk-delta'},h('span',{className:'sdd-bulk-mobile-label','aria-hidden':true},'ส่วนต่าง'),
       invalid?'—':edited?bulkPriceDifference(before,value):h('span',{className:'sdd-bulk-unchanged'},'คงเดิม')));
    }))),
    h('div',{className:'sdd-bulk-footer sdd-bulk-manual-footer'},h('p',{role:'status'},'แก้ราคา '+changes.length+' จาก '+selection.size+' รายการ'),
     h('button',{type:'submit',className:'sdd-primary',disabled:busy||!validManual},'ตรวจราคาก่อนบันทึก'))):
   h('form',{className:'sdd-bulk-form',onSubmit:e=>{e.preventDefault();if(!busy&&validAmount)preview();}},
    h(BulkFormulaSteps,{review:false}),
    h('details',{className:'sdd-bulk-selection'},
     h('summary',null,'สินค้าที่เลือก '+selection.size+' รายการ'),
     h('ul',null,[...selection.values()].map(item=>h('li',{key:item.id},item.name,h('small',null,item.sku||'#'+item.id))))),
    h('div',{className:'sdd-bulk-form-settings'},
     h('div',{className:'sdd-bulk-form-grid sdd-bulk-form-basis'},
      choice('ราคาที่จะแก้','target',[['regular_price','ราคาปกติ'],['sale_price','ราคาโปร']]),
      params.target==='sale_price'&&choice('อิงจากราคา','basis',[['regular_price','ราคาปกติ'],['sale_price','ราคาโปรเดิม']])),
     h('div',{className:'sdd-bulk-form-grid sdd-bulk-form-change'},
      choice('เพิ่มหรือลด','direction',[['decrease','ลด'],['increase','เพิ่ม']]),
      h('label',{className:'sdd-bulk-field'},'จำนวน',h('input',{inputMode:percent?'decimal':'numeric',disabled:busy,value:params.amount,
       'aria-describedby':'sdd-bulk-amount-hint','aria-invalid':!!params.amount&&!validAmount,onChange:e=>patch({amount:e.target.value})})),
      choice('หน่วย','unit',[['baht','บาท'],['percent','เปอร์เซ็นต์']]),
      h('small',{id:'sdd-bulk-amount-hint'},amountHint))),
    h(BulkFormulaExamples,{selection,params,validAmount}),
    h('div',{className:'sdd-bulk-footer'},h('p',null,'ตรวจสินค้าที่เลือกทั้งหมดก่อนยืนยันบันทึก'),
     h('button',{type:'submit',className:'sdd-primary',disabled:busy||!validAmount},'ตรวจราคาก่อนบันทึก'))))),
  batch&&h('div',{className:'sdd-bulk-review'},
   formulaPreview?h(BulkFormulaSteps,{review:true,activeRef:reviewHeading}):
    h('h3',{tabIndex:-1,ref:reviewHeading},batch.status==='preview'?'ตรวจราคาก่อนบันทึก':'ผลการแก้ราคา'),
   formulaView&&h('div',{className:'sdd-bulk-formula-summary'},
    h('div',null,h('strong',null,bulkFormulaText(reviewedFormula)),
     formulaPreview&&h('p',{role:'status'},previewCount)),
    formulaPreview&&sameFormulaSelection&&h('button',{type:'button',disabled:busy||needsCheck,onClick:editFormula},'แก้สูตร')),
   !formulaPreview&&h('p',{role:'status',className:'sdd-bulk-result'},batch.status==='preview'?previewCount+' · ราคายังไม่เปลี่ยน':
    'สำเร็จ '+(batch.progress.succeeded||0)+' · รอ '+batch.pending+' · ยืนยันผลไม่ได้ '+batch.unknown+(batch.status==='stopped'?' · หยุดชุดแล้ว':'')),
   needsCheck&&h('p',{role:'status'},'ตรวจผลชุดเดิมก่อนทำรายการที่เหลือต่อ'),
   temporaryView?h(BulkTemporaryRows,{rows:batch.items}):formulaView?h(BulkFormulaCards,{items:batch.items}):h('div',{className:'sdd-tablewrap'},h('table',null,
    h('thead',null,h('tr',null,['สินค้า','ราคาเดิม','ราคาใหม่','เปลี่ยนแปลง','สถานะ'].map(text=>h('th',{key:text,scope:'col'},text)))),
    h('tbody',null,batch.items.map(row=>h('tr',{key:row.item_id},
     h('td',null,row.name||'#'+row.product_id,h('small',null,labels[row.field])),
     h('td',null,h('span',{className:'sdd-bulk-mobile-label'},'ราคาเดิม'),showValue(row.before,row.field)),
     h('td',null,h('span',{className:'sdd-bulk-mobile-label'},'ราคาใหม่'),h('strong',null,showValue(row.after,row.field))),
     h('td',null,h('span',{className:'sdd-bulk-mobile-label'},'เปลี่ยนแปลง'),bulkPriceDifference(row.before,row.after)),
     h('td',null,h(BulkResultStatus,{row}))))))),
   zeroRequired&&h('label',null,h('input',{type:'checkbox',checked:zero,disabled:busy,onChange:e=>setZero(e.target.checked)}),' ยืนยันรายการที่ตั้งเป็น 0 บาท'),
   h('div',{className:'sdd-bulk-footer sdd-bulk-review-actions'+(formulaPreview?' sdd-bulk-formula-footer':'')},
    formulaPreview&&h('p',null,'ราคาจะเปลี่ยนเมื่อยืนยันบันทึก'),
    (!formulaView||batch.status!=='preview'||needsCheck)&&h('button',{disabled:busy,className:needsCheck||batch.status==='needs_reconciliation'?'sdd-primary':undefined,onClick:check},'ตรวจผลชุดเดิม'),
    ['preview','running'].includes(batch.status)&&batch.pending>0&&h('button',{className:'sdd-primary',disabled:busy||needsCheck||(zeroRequired&&!zero),onClick:execute},batch.status==='preview'?(temporaryView?'บันทึกโปร ':'บันทึก ')+batch.pending+' รายการ':'บันทึกรายการที่เหลือต่อ'),
    batch.status==='needs_reconciliation'&&h('button',{disabled:busy,onClick:stop},'หยุดรายการที่เหลือ'),
    !formulaPreview&&h('button',{disabled:busy||needsCheck||batch.status==='needs_reconciliation',onClick:formulaView?editFormula:()=>{if(temporaryView)setMode('temporary');setBatch(null);}},eventId?'กลับไปตรวจเหตุการณ์':formulaView?'เริ่มตั้งสูตรใหม่':'กลับไปแก้ราคา'))));
}
function App(){
 const initial=useRef(readWorkspaceLocation(window.location?.search||'')).current;
 const [viewOptions,setViewOptions]=useState(workspaceOptions(initial));
 const updateOptions=patch=>setViewOptions(v=>({...v,...patch}));
 const [catalogImport,setCatalogImport]=useState(false);
 const [cacheJob,setCacheJob]=useState(''),[auditOptions,setAuditOptions]=useState(null);
 const [bulkSelection,setBulkSelection]=useState(new Map()),[bulkAction,setBulkAction]=useState(null);
 const [bulkOpenError,setBulkOpenError]=useState('');
 async function openBulk(){
  setBulkOpenError('');
  if(!bulkSelection.size){setBulkAction({});return;}
  setBulkAction({loading:true});
  try{
   const selected=[...bulkSelection.values()],update={items:[],unavailable:[]};
   for(let offset=0;offset<selected.length;offset+=100){
    const ids=selected.slice(offset,offset+100).map(row=>row.id);
    const snapshot=await api('workspace-sync',{ids,client_id:clientId.current});
    if(ids.some(id=>!snapshot.items.some(row=>row.id===id)&&!snapshot.unavailable.includes(id)))throw new Error('โหลดข้อมูลสินค้าที่เลือกไม่ครบ กรุณาลองอีกครั้ง');
    update.items.push(...snapshot.items);
    update.unavailable.push(...snapshot.unavailable);
   }
   setBulkSelection(new Map(mergeLiveRows(selected,update).map(row=>[row.id,row])));
   if(update.unavailable.length){
    setBulkOpenError('นำสินค้า '+update.unavailable.length+' รายการที่เข้าถึงไม่ได้ออกจากรายการที่เลือก กรุณาตรวจรายการที่เหลือ');
    closeBulk(false);
   }else setBulkAction({});
  }catch(e){
   setBulkOpenError('ตรวจราคาล่าสุดของรายการที่เลือกไม่ได้ · '+e.message);
   closeBulk(false);
  }
 }
 function closeBulk(chooseProduct){
  const returningToAudit=!!bulkAction?.eventId;
  setBulkAction(null);
  if(returningToAudit)return;
  requestAnimationFrame(()=>document.getElementById(chooseProduct?'sdd-catalog-search':'sdd-bulk-trigger')?.focus());
 }
 function bulkChanged(saved){
  setBulkSelection(current=>{
   const next=new Map(current);
   for(const {product_id,field,after,schedule} of saved){
    const row=next.get(product_id);
    if(!row)continue;
    if(!schedule)next.set(product_id,{...row,[field]:after});
    else if(row.temporary_sale?.id===schedule.id)next.set(product_id,{...row,
     ...(schedule.status==='active'?{sale_price:after,current_price:after}:{}),
     temporary_sale:{...schedule,price:after}});
   }
   return next;
  });
  setTick(t=>t+1);
 }
 function selectBulk(row,selected){setBulkSelection(current=>{
  const next=new Map(current);if(selected&&next.size<200)next.set(row.id,row);else if(!selected)next.delete(row.id);return next;
 });}
 const lastProductOrigin=useRef(null);
 const [focusedProduct,setFocusedProduct]=useState(initial.product?{id:initial.product,field:initial.field}:null),[calendarMonth,setCalendarMonth]=useState(initial.month);
 const [data,setData]=useState({items:[],page:1,pages:0,total:0,catalog_total:0}),[search,setSearch]=useState(initial.search),[query,setQuery]=useState(initial.search),[page,setPage]=useState(initial.page),[size,setSize]=useState(initial.size),[brand,setBrand]=useState(initial.brand),[status,setStatus]=useState(initial.status),[source,setSource]=useState(initial.source),[promotionPost,setPromotionPost]=useState(initial.promotionPost),[articleSearch,setArticleSearch]=useState(''),[articles,setArticles]=useState([]),[articlesError,setArticlesError]=useState(''),[brands,setBrands]=useState([]),[brandSearch,setBrandSearch]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[setup,setSetup]=useState(cfg.canSettings&&initial.view==='setup'),[dashboard,setDashboard]=useState(cfg.canSettings&&initial.view==='dashboard'),[calendar,setCalendar]=useState(cfg.canSettings&&initial.view==='calendar'),[alertState,setAlertState]=useState('loading'),[auditProduct,setAuditProduct]=useState(null),[tick,setTick]=useState(0),[session,setSession]=useState(false),[orderby,setOrderby]=useState(initial.orderby),[order,setOrder]=useState(initial.order),[promoId,setPromoId]=useState(null),[filters,setFilters]=useState(false),[confirmation,setConfirmation]=useState(null),[scope,setScope]=useState(initial.scope),[promotion,setPromotion]=useState(initial.promotion);
 const [draftTick,setDraftTick]=useState(0);
 useEffect(()=>{const update=()=>setDraftTick(n=>n+1);window.addEventListener('sdd:draft-update',update);return()=>window.removeEventListener('sdd:draft-update',update);},[]);
 const pendingDrafts=collectPendingDrafts(drafts,promoDrafts);
 const writeEpoch=useRef(0);
 const generation=useRef(0),clientId=useRef(uuid()),liveState=useRef({}),lastWorkspaceURL=useRef(window.location?.href||'');
 const [syncAt,setSyncAt]=useState(''),[syncMessage,setSyncMessage]=useState('');
 const [brandsStatus,setBrandsStatus]=useState('loading'),[brandsError,setBrandsError]=useState('');
 liveState.current={setup,dashboard,calendar,session,loading};
 useEffect(()=>{const restore=async()=>{const target=window.location.search;if(!await allowImportLeave()){window.history.pushState(null,'',lastWorkspaceURL.current);return;}setCatalogImport(false);const r=readWorkspaceLocation(target);setSearch(r.search);setQuery(r.search);setPage(r.page);setSize(r.size);setBrand(r.brand);setStatus(r.status);setSource(r.source);setPromotionPost(r.promotionPost);setPromotion(r.promotion);setScope(r.scope);setOrderby(r.orderby);setOrder(r.order);setDashboard(cfg.canSettings&&r.view==='dashboard');setCalendar(cfg.canSettings&&r.view==='calendar');setSetup(cfg.canSettings&&r.view==='setup');setCalendarMonth(r.month);setViewOptions(workspaceOptions(r));setFocusedProduct(r.product?{id:r.product,field:r.field}:null);setAuditProduct(null);};window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[]);
 useEffect(()=>{if(!window.history||!window.location)return;const q=workspaceQuery(window.location.search,{...viewOptions,view:dashboard?'dashboard':calendar?'calendar':setup?'setup':'products',search:query,brand,status,source,promotionPost,promotion,page,size,scope,orderby,order,month:calendarMonth,product:focusedProduct?.id||'',field:focusedProduct?.field||''});if(q!==window.location.search.replace(/^\?/,''))window.history.pushState(null,'',window.location.pathname+'?'+q+window.location.hash);lastWorkspaceURL.current=window.location.href;},[dashboard,calendar,setup,query,brand,status,source,promotionPost,promotion,page,size,scope,orderby,order,calendarMonth,focusedProduct?.id,focusedProduct?.field,viewOptions]);

 useEffect(()=>{const failed=e=>{setSession(true);setError(e.detail.message);setSyncMessage('หยุดอัปเดตอัตโนมัติชั่วคราว');};window.addEventListener('sdd:connection-error',failed);return()=>window.removeEventListener('sdd:connection-error',failed);},[]);
 useEffect(()=>{const receive=e=>{for(const id of [...e.detail.items.map(r=>r.id),...e.detail.unavailable])workspacePresence.delete(id);for(const [id,entries] of Object.entries(e.detail.presence||{}))workspacePresence.set(id,entries);setData(d=>({...d,items:mergeLiveRows(d.items,e.detail)}));setSyncAt(e.detail.server_time);setSyncMessage('');};window.addEventListener('sdd:workspace-sync',receive);return()=>window.removeEventListener('sdd:workspace-sync',receive);},[]);
 useEffect(()=>{
  if(setup||dashboard||calendar||focusedProduct||auditProduct!==null||session)return;let stopped=false,running=false,debounce,nextAttempt=0;
  const focused=()=>{const el=document.activeElement;if(!el||!el.matches('input,select,textarea')||el.disabled)return null;const row=el.closest('[data-product-id],[data-promotion-for]'),field=el.dataset.sddField||el.closest('[data-sdd-focus-field]')?.dataset.sddFocusField;return row&&field?{product_id:row.dataset.productId||row.dataset.promotionFor,field}:null;};
  const poll=async(clear=false)=>{
   if(stopped||running||liveState.current.loading||(!clear&&Date.now()<nextAttempt)||(!clear&&document.hidden))return;
   running=true;const g=generation.current,epoch=writeEpoch.current,active=clear?null:focused(),ids=clear?[]:[...new Set([...document.querySelectorAll('tr[data-product-id]')].map(e=>e.dataset.productId))];
   try{for(let offset=0;offset<Math.max(1,ids.length);offset+=100){const body={ids:ids.slice(offset,offset+100),client_id:clientId.current};if(offset===0)body.active=active;const update=await api('workspace-sync',body);if(stopped||g!==generation.current||epoch!==writeEpoch.current)break;if(!clear){Object.entries(update.cache_updates||{}).forEach(([id,status])=>cacheUpdates.set(id,status));window.dispatchEvent(new CustomEvent('sdd:cache-update'));window.dispatchEvent(new CustomEvent('sdd:workspace-sync',{detail:update}));}}}
   catch(e){if(!stopped){nextAttempt=Date.now()+(e.status===429?60000:15000);setSyncMessage('อัปเดตอัตโนมัติขัดข้อง · กดรีเฟรชเพื่อลองใหม่');if(e.status===401||e.code==='rest_cookie_invalid_nonce')setSession(true);}}
   finally{running=false;}
  };
  const focusChanged=()=>{clearTimeout(debounce);debounce=setTimeout(()=>poll(),250);};
  const visibility=()=>{if(document.hidden)poll(true);else poll();};
  window.addEventListener('focusin',focusChanged);window.addEventListener('focusout',focusChanged);document.addEventListener('visibilitychange',visibility);
  const timer=setInterval(()=>poll(),15000);
  return()=>{stopped=true;clearInterval(timer);clearTimeout(debounce);window.removeEventListener('focusin',focusChanged);window.removeEventListener('focusout',focusChanged);document.removeEventListener('visibilitychange',visibility);api('workspace-sync',{ids:[],client_id:clientId.current,active:null}).catch(()=>{});};
 },[setup,dashboard,calendar,focusedProduct?.id,auditProduct,session]);
 useEffect(()=>{if(!cfg.canSettings||session)return;let alive=true,running=false;const refresh=async()=>{if(!alive||running||document.hidden)return;running=true;try{const result=await api('promotion-alerts');if(alive)setAlertState(result.state);}catch(e){if(alive)setAlertState('unknown');}finally{running=false;}};const visible=()=>{if(!document.hidden)refresh();};refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',visible);return()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};},[tick,session]);
 useEffect(()=>{showConfirmation=setConfirmation;return()=>{showConfirmation=null;};},[]);
 useEffect(()=>{if(search===query)return;const t=setTimeout(()=>{setQuery(search);setPage(1);},300);return()=>clearTimeout(t);},[search]);
 useEffect(()=>{let alive=true;setBrandsStatus('loading');api('brands').then(r=>{if(alive){setBrands(r.items);setBrandsStatus('ready');setBrandsError('');}}).catch(e=>{if(alive){setBrandsStatus('error');setBrandsError(e.message);}});api('promotion-articles').then(r=>{setArticles(r.items);setArticlesError('');}).catch(e=>setArticlesError(e.message));return()=>{alive=false;};},[tick]);
 const catalogKey=new URLSearchParams({search:query,page,per_page:size,brand,stock_status:status,source,promotion_post:promotionPost,orderby,order,scope,promotion_status:promotion}).toString();
 const resultsMatch=search===query&&data.queryKey===catalogKey;
 const catalogWrite=useRef(null);
 catalogWrite.current=resultsMatch&&!loading&&!error?catalogKey:null;
 const canWriteCatalog=()=>catalogWrite.current===catalogKey;
 useEffect(()=>{const g=++generation.current;setLoading(true);api('products?'+catalogKey).then(r=>{if(g===generation.current){setData({...r,queryKey:catalogKey});setError('');}}).catch(e=>{if(g===generation.current){setError(e.message);if(e.status===401||e.code==='rest_cookie_invalid_nonce')setSession(true);}}).finally(()=>{if(g===generation.current)setLoading(false);});},[catalogKey,tick]);
 useEffect(()=>{const handler=e=>{if([...drafts.values(),...promoDrafts.values()].some(d=>d.state!=='clean')){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[]);
 async function refreshSession(){try{await renewNonce();connectionError=null;setSession(false);setError('');setSyncMessage('');setTick(t=>t+1);}catch(e){setSession(true);setError(e.message);}}
 function saved(id,field,value,revision,result){
  writeEpoch.current++;
  if(!result)setTick(t=>t+1);
  setData(d=>({...d,items:d.items.map(row=>applyPriceRow(row,id,field,value,revision,result))}));
 }
 const context={search:query,brand,stock_status:status,source,promotion_post:promotionPost,orderby,order,tick,scope,promotion_status:promotion};
 const shownArticles=articles.filter(a=>!articleSearch||(a.title+' '+a.id).toLocaleLowerCase().includes(articleSearch.toLocaleLowerCase())||a.id===promotionPost);
 const sortedBrands=[...brands].sort((a,b)=>a.name.localeCompare(b.name,'th',{sensitivity:'base'}));
 const selectedFilters=[
  brand&&{id:'brand',label:'แบรนด์: '+(sortedBrands.find(b=>b.id===brand)?.name||brand),clear:()=>{setBrand('');setBrandSearch('');}},
  status&&{id:'stock',label:'สต็อก: '+(stock[status]||status),clear:()=>setStatus('')},
  promotion&&{id:'promotion',label:'สถานะโปร: '+({none:'ไม่มีโปร',current:'กำลังใช้',expiring:'ใกล้หมดภายใน 24 ชั่วโมง',future:'รอเริ่ม',expired:'หมดอายุแล้ว',review:'ต้องตรวจสอบ'}[promotion]||promotion),clear:()=>setPromotion('')},
  source&&{id:'source',label:'แหล่งสินค้า: ในบทความโปรโมชัน',clear:()=>{setSource('');setPromotionPost('');setArticleSearch('');}},
  promotionPost&&{id:'article',label:'บทความ: '+(articles.find(a=>a.id===promotionPost)?.title||promotionPost),clear:()=>{setPromotionPost('');setArticleSearch('');}}
 ].filter(Boolean);
 function openDashboardProduct(id,field='temporary_sale'){return navigateFromImport(()=>{
  lastProductOrigin.current={id:String(id),dashboard,calendar,field};
  setCatalogImport(false);setAuditProduct(null);setFocusedProduct({id:String(id),field:typeof field==='string'?field:'temporary_sale'});
 });}
 function returnFromProduct(){
  const origin=lastProductOrigin.current;
  setFocusedProduct(null);
  requestAnimationFrame(()=>{
   const scope=origin?.dashboard?'[data-task-product]':origin?.calendar?'[data-calendar-product]':'[data-product-id]';
   const match=origin&&[...document.querySelectorAll(scope)].find(el=>(el.dataset.taskProduct||el.dataset.calendarProduct||el.dataset.productId)===origin.id);
   const control=match?.matches('button')?match:[...(match?.querySelectorAll('button,input,select')||[])].find(el=>!el.disabled&&el.getClientRects().length);
   (control||document.getElementById(origin?.dashboard?'sdd-task-board':origin?.calendar?'sdd-calendar-title':'sdd-catalog-search'))?.focus();
  });
 }
 function clearFilters(){setBrand('');setStatus('');setPromotion('');setSource('');setPromotionPost('');setBrandSearch('');setArticleSearch('');setPage(1);}
 const filter=(label,value,set,options)=>h('label',{className:'sdd-filter'},h('span',null,label),h('select',{'aria-label':label,value,onChange:e=>{set(e.target.value);setPage(1);}},h('option',{value:''},'ทั้งหมด'),options.map(o=>h('option',{key:o.id,value:o.id},o.name))));
 return h('div',{className:'sdd-app'},h('header',{className:'sdd-topbar'},h('a',{className:'sdd-brand',href:cfg.back,onClick:event=>{if(importLeaveGuard){event.preventDefault();navigateFromImport(()=>{window.location.href=cfg.back;});}},'aria-label':'SoundDD กลับหลังบ้าน WordPress'},h('img',{src:cfg.logo,alt:'SoundDD',width:164,height:48})),h('div',{className:'sdd-app-identity'},h('strong',null,'Stock & Price'),h('span',null,'จัดการสินค้าและโปรโมชัน')),h('nav',{className:'sdd-main-nav','aria-label':'เมนูหลัก'},[['products','สินค้า'],...(cfg.canSettings?[['dashboard','ภาพรวมงาน'],['calendar','ปฏิทินโปร'],['setup','ตั้งค่า']]:[])].map(([id,label])=>h('button',{key:id,'aria-current':(id==='products'&&!dashboard&&!calendar&&!setup&&auditProduct===null||id==='dashboard'&&dashboard||id==='calendar'&&calendar||id==='setup'&&setup)?'page':undefined,onClick:()=>navigateFromImport(()=>{setBulkAction(null);setCacheJob('');setCatalogImport(false);setFocusedProduct(null);setDashboard(id==='dashboard');setCalendar(id==='calendar');setSetup(id==='setup');setAuditProduct(null);})},label,id==='dashboard'&&alertState==='attention'&&h('span',{className:'sdd-alert-dot','aria-label':'มีโปรที่ต้องตรวจสอบ'}),id==='dashboard'&&alertState==='unknown'&&h('span',null,' · ตรวจแจ้งเตือนไม่ได้')))),h('span',{className:'sdd-spacer'}),h('span',{className:'sdd-header-user'},h('span',{className:'sdd-user-avatar','aria-hidden':true},(cfg.user||'S').slice(0,1)),cfg.user),h('button',{className:'sdd-refresh-button','aria-label':'รีเฟรชข้อมูล',onClick:()=>setTick(t=>t+1),disabled:loading},'↻ รีเฟรช')),
 h('main',{className:'sdd-wrap'},pendingDrafts.length>0&&h('div',{className:'sdd-unsaved-banner',role:'status'},h('strong',null,'มีข้อมูลที่ยังไม่บันทึกหรือรอตรวจผล '+pendingDrafts.length+' ช่อง'),h('div',{className:'sdd-draft-links'},pendingDrafts.map(d=>h('button',{key:d.id+':'+d.field,onClick:()=>openDashboardProduct(d.id,d.field)},'#'+d.id+' · '+(d.field==='temporary_sale'?'แบบร่างโปร':labels[d.field]||d.field)+(d.state==='unknown'?' · ตรวจผล':''))))),h('details',{className:'sdd-note'},h('summary',null,'ข้อมูลการอัปเดตและคีย์ลัด'),h('span',null,'ข้อมูลล่าสุด '+((syncAt||data.server_time)?displayDate(syncAt||data.server_time):'—')+' · '+(syncMessage||'อัปเดตราคาที่แสดงทุก 15 วินาที')+' · รีเฟรชเพื่อปรับผลค้นหาและลำดับ · กด Enter เพื่อยืนยันราคา · Esc เพื่อยกเลิก')),
 session&&h('div',{className:'sdd-session',role:'alert'},h('a',{href:cfg.login,target:'_blank',rel:'noopener noreferrer'},'เข้าสู่ระบบอีกแท็บ'),h('button',{onClick:refreshSession},'เชื่อมต่อใหม่'),session&&h('span',null,'หยุดการเชื่อมต่อชั่วคราว ค่าที่พิมพ์ไว้ยังอยู่ · หากเข้าสู่ระบบหมดอายุ ให้เข้าสู่ระบบอีกแท็บแล้วกดเชื่อมต่อใหม่')),
 error&&!focusedProduct&&h('p',{role:'alert',className:'sdd-error'},error),bulkAction?.loading?h('p',{role:'status',className:'sdd-loading-notice'},'กำลังโหลดราคาและโปรล่าสุดของรายการที่เลือก…'):bulkAction?h(BulkPricePanel,{selection:bulkSelection,eventId:bulkAction.eventId,onClose:closeBulk,onChanged:bulkChanged}):focusedProduct&&auditProduct===null?h(DirectProduct,{key:focusedProduct.id,id:focusedProduct.id,field:focusedProduct.field,tick,onSaved:saved,onClose:returnFromProduct,onAudit:id=>{setAuditOptions(null);setAuditProduct(id);},onCacheJob:cfg.canManageCache?job=>{setCacheJob(job);setFocusedProduct(null);setSetup(true);}:undefined}):focusedProduct&&auditProduct!==null?h(AuditPanel,{productId:auditProduct,...auditOptions,onClose:()=>{setAuditProduct(null);if(auditOptions?.fromDashboard)setDashboard(true);setAuditOptions(null);},onRollback:eventId=>setBulkAction({eventId})}):catalogImport&&cfg.canImportPromotions?h(PromotionImport,{
  closeLabel:'กลับไปจัดการสินค้า',onClose:()=>{setCatalogImport(false);requestAnimationFrame(()=>document.getElementById('sdd-import-trigger')?.focus());},onComplete:start=>{
   const day=datePart(String(start));
   setCalendarMonth(day.slice(0,7));
   updateOptions({calendarSearch:'',calendarStatus:'',calendarSelected:day});
   setCatalogImport(false);
   setCalendar(true);
  }
 }):calendar?h(PromotionCalendar,{tick,options:viewOptions,onOptions:updateOptions,month:calendarMonth,onMonthChange:setCalendarMonth,onClose:()=>setCalendar(false),onProduct:openDashboardProduct}):dashboard?h(Dashboard,{tick,options:viewOptions,onOptions:updateOptions,onClose:()=>setDashboard(false),onAudit:cfg.canAudit?(id,initialField,eventId)=>{setDashboard(false);setAuditOptions({initialField,eventId,fromDashboard:true});setAuditProduct(id);}:undefined,onSettings:()=>{setDashboard(false);setSetup(true);},onProduct:openDashboardProduct}):auditProduct!==null?h(AuditPanel,{productId:auditProduct,...auditOptions,onClose:()=>{setAuditProduct(null);if(auditOptions?.fromDashboard)setDashboard(true);setAuditOptions(null);},onRollback:eventId=>setBulkAction({eventId})}):setup?h(Setup,{jobId:cacheJob,onClose:()=>{setCacheJob('');setSetup(false);},onSaved:()=>setTick(t=>t+1)}):h(wp.element.Fragment,null,
 data.write_access&&!data.write_access.enabled&&h('section',{className:'sdd-warning',role:'status'},h('strong',null,'ขณะนี้เป็นโหมดอ่านอย่างเดียว'),h('p',null,data.write_access.reasons.join(' · ')),data.write_access.can_manage_settings?h('button',{onClick:()=>setSetup(true)},'ตั้งค่าเพื่อเปิดการแก้ไข'):h('p',null,'ติดต่อผู้ดูแลเพื่อเปิดการแก้ไขหรือปรับสิทธิ์บัญชี')),
 h('section',{className:'sdd-workspace-heading','aria-labelledby':'sdd-workspace-title'},
  h('div',{className:'sdd-workspace-heading-copy'},h('span',{className:'sdd-dashboard-eyebrow'},'พื้นที่ทำงานของร้าน'),h('h1',{id:'sdd-workspace-title'},'จัดการสินค้าและราคา'),h('p',null,'ค้นหาสินค้า แก้ราคาและสต็อก หรือตั้งโปรชั่วคราวได้ในที่เดียว')),
  h('div',{className:'sdd-workspace-heading-actions'},h('div',{className:'sdd-workspace-total'},h('span',null,'สินค้าในระบบ'),h('strong',null,loading?'…':data.catalog_total.toLocaleString('th-TH')),h('small',null,'ไม่นับตัวเลือกย่อย')),cfg.canImportPromotions&&h('button',{type:'button',id:'sdd-import-trigger','aria-label':'นำเข้าโปรจาก CSV',className:'sdd-secondary sdd-workspace-import',onClick:()=>setCatalogImport(true)},h('span',{className:'sdd-import-label-desktop'},'นำเข้าโปรจาก CSV'),h('span',{className:'sdd-import-label-mobile','aria-hidden':true},'นำเข้า CSV')))),
 bulkOpenError&&h('p',{role:'alert',className:'sdd-error'},bulkOpenError),
 cfg.canBulk&&h('div',{className:'sdd-import-actions sdd-catalog-bulk-actions'},h('button',{id:'sdd-bulk-trigger',type:'button',onClick:openBulk},'แก้ราคาหลายรายการ · '+bulkSelection.size+' ที่เลือก'),bulkSelection.size>0&&h('button',{type:'button',onClick:()=>{setBulkOpenError('');setBulkSelection(new Map());}},'ล้างรายการที่เลือก')),
 h(CatalogTabs,{scope,counts:data.tab_counts,loading,onChange:id=>{setScope(id);setPromotion('');setPage(1);setPromoId(null);}}),
 h('small',{className:'sdd-catalog-tabs-hint'},'เลื่อนแท็บเพื่อดูสถานะโปรเพิ่มเติม →'),
 ({current:'แสดงเฉพาะโปรชั่วคราวที่กำลังใช้อยู่',expiring:'เฉพาะโปรชั่วคราวที่กำลังใช้และจะสิ้นสุดภายใน 24 ชั่วโมง',upcoming:'เฉพาะโปรชั่วคราวที่ยังไม่ถึงเวลาเริ่ม'}[scope])&&h('p',{className:'sdd-recent-note',role:'note'},({current:'แสดงเฉพาะโปรชั่วคราวที่กำลังใช้อยู่',expiring:'เฉพาะโปรชั่วคราวที่กำลังใช้และจะสิ้นสุดภายใน 24 ชั่วโมง',upcoming:'เฉพาะโปรชั่วคราวที่ยังไม่ถึงเวลาเริ่ม'}[scope])),
 scope==='recent'&&h('p',{className:'sdd-recent-note'},'แสดงสินค้าที่เปลี่ยนราคาผ่านปลั๊กอินนี้ล่าสุดก่อน รวมการเริ่มและจบโปรชั่วคราว'),
 h('div',{className:'sdd-toolbar'},h('div',{className:'sdd-toolbar-search'},h('label',{className:'sdd-search'},h('span',null,'ค้นหาสินค้า'),h('input',{id:'sdd-catalog-search',value:search,onChange:e=>setSearch(e.target.value),maxLength:200,placeholder:data.brand_configured?'ชื่อสินค้า, SKU, แบรนด์ หรือ ID…':'ชื่อสินค้า, SKU หรือ ID…'})),search&&h('button',{className:'sdd-search-clear','aria-label':'ล้างคำค้นสินค้า',onClick:()=>setSearch('')},'×')),h('div',{className:'sdd-toolbar-actions'},h('button',{className:'sdd-filter-toggle','aria-expanded':filters,'aria-controls':'sdd-filter-options',onClick:()=>setFilters(v=>!v)},h('span',{'aria-hidden':true},filters?'▴ ':'▾ '),'ตัวกรอง'+([brand,status,promotion,source,promotionPost].filter(Boolean).length?' ('+[brand,status,promotion,source,promotionPost].filter(Boolean).length+')':'')),h('button',{className:'sdd-clear-filters',onClick:clearFilters,disabled:!selectedFilters.length&&!brandSearch&&!articleSearch},h('span',{'aria-hidden':true},'× '),'ล้างตัวกรอง')),h('div',{id:'sdd-filter-options',className:'sdd-filter-drawer',hidden:!filters},filter('แหล่งสินค้า',source,v=>{setSource(v);setPromotionPost('');setArticleSearch('');},[{id:'new_promotion',name:'ในบทความโปรโมชัน'}]),source==='new_promotion'&&h('label',{className:'sdd-filter sdd-article-search'},h('span',null,'ค้นหาบทความ'),h('input',{value:articleSearch,onChange:e=>setArticleSearch(e.target.value),placeholder:'ชื่อบทความหรือ ID…','aria-label':'ค้นหาบทความโปรโมชัน'})),source==='new_promotion'&&h('label',{className:'sdd-filter sdd-article-picker'},h('span',null,'บทความโปรโมชัน'),h('select',{'aria-label':'เลือกบทความโปรโมชัน',value:promotionPost,onChange:e=>{setPromotionPost(e.target.value);setPage(1);setPromoId(null);}},h('option',{value:''},'ทุกบทความ'),shownArticles.map(a=>h('option',{key:a.id,value:a.id},a.date+' · '+a.title+' (#'+a.id+')')))),h(CatalogBrandFilter,{configured:data.brand_configured,loading:brandsStatus==='loading'||(!data.server_time&&!error),error:brandsError||(!data.server_time?error:''),brands:sortedBrands,search:brandSearch,value:brand,onSearch:setBrandSearch,onChange:value=>{setBrand(value);setPage(1);},onRetry:()=>setTick(t=>t+1),onSetup:cfg.canManageCache?()=>{setSetup(true);requestAnimationFrame(()=>{const heading=document.getElementById('sdd-brands-heading');heading?.focus();heading?.scrollIntoView({block:'start'});});}:null}),filter('สถานะสต็อก',status,setStatus,Object.entries(stock).map(([id,name])=>({id,name}))),!['current','expiring','upcoming'].includes(scope)&&filter('สถานะโปร',promotion,setPromotion,[['none','ไม่มีโปร'],['current','กำลังใช้'],['expiring','ใกล้หมดภายใน 24 ชั่วโมง'],['future','รอเริ่ม'],['expired','หมดอายุแล้ว'],['review','ต้องตรวจสอบ']].map(([id,name])=>({id,name}))),scope==='recent'?h('div',{className:'sdd-filter sdd-sort-fixed',role:'status'},h('span',null,'เรียงตามเวลาที่แก้ไข'),h('div',null,'ใหม่ → เก่า')):h('label',{className:'sdd-filter'},h('span',null,'เรียงตาม'),h('select',{'aria-label':'เรียงตาม',value:orderby+':'+order,onChange:e=>{const [field,direction]=e.target.value.split(':');setOrderby(field);setOrder(direction);setPage(1);}},[['name:asc','ชื่อสินค้า A–Z'],['name:desc','ชื่อสินค้า Z–A'],['sku:asc','SKU A–Z'],['sku:desc','SKU Z–A'],['regular_price:asc','ราคาต่ำไปสูง'],['regular_price:desc','ราคาสูงไปต่ำ']].map(([v,label])=>h('option',{key:v,value:v},label)))),),h('span',{className:'sdd-count','aria-live':'polite',title:'จำนวนสินค้าแม่ที่ตรงคำค้นและตัวกรอง ไม่นับตัวเลือกย่อย'},loading?'กำลังค้นหา…':h(wp.element.Fragment,null,'พบ ',h('strong',null,data.total.toLocaleString('th-TH')),' รายการ'))),
 resultsMatch&&data.exact_sku?.type==='variation'&&h('div',{className:'sdd-recent-note'},h('strong',null,'ตัวเลือกตรง SKU '+data.exact_sku.sku),' · '+data.exact_sku.name+(data.exact_sku.attributes?' · '+data.exact_sku.attributes:''),' ',h('button',{type:'button',onClick:()=>openDashboardProduct(data.exact_sku.id,'regular_price')},'เปิดตัวเลือกนี้')),
 selectedFilters.length>0&&h('div',{className:'sdd-filter-chips','aria-label':'ตัวกรองที่เลือก'},selectedFilters.map(f=>h('button',{key:f.id,'aria-label':'ล้าง '+f.label,onClick:()=>{f.clear();setPage(1);}},f.label,h('span',{'aria-hidden':true},' ×')))),
 source==='new_promotion'&&h('div',{className:'sdd-recent-note',role:'note'},promotionPost?'แสดงสินค้าในบทความที่เลือก · ':'แสดงสินค้าจากทุกบทความที่เผยแพร่ รวมบทความเก่า · ','นับเฉพาะสินค้าที่ระบุรหัสหรือลิงก์ไว้ในบทความ',promotionPost&&articles.find(a=>a.id===promotionPost)&&h(wp.element.Fragment,null,' · ',h('a',{href:articles.find(a=>a.id===promotionPost).url,target:'_blank',rel:'noopener noreferrer'},'เปิดบทความ ↗')),articlesError&&h('span',{role:'alert'},' · โหลดรายชื่อบทความไม่ได้: '+articlesError)),
 promotion==='expired'&&h('div',{className:'sdd-recent-note',role:'note'},'แสดงโปรที่เลยวันสิ้นสุดตาม WooCommerce รวมวันโปรที่ตั้งไว้ก่อนติดตั้งปลั๊กอิน',scope==='recent'&&h(wp.element.Fragment,null,h('span',null,' · แท็บนี้แสดงเฉพาะรายการที่เคยแก้ราคาผ่านปลั๊กอิน '),h('button',{onClick:()=>{setScope('all');setPage(1);setPromoId(null);}},'ดูในสินค้าทั้งหมด'))),
 (loading||(!resultsMatch&&!error))&&h('p',{className:'sdd-loading-notice',role:'status'},'กำลังค้นหาข้อมูลล่าสุด…'),error&&resultsMatch&&data.items.length>0&&h('p',{className:'sdd-stale-notice',role:'status'},'แสดงข้อมูลก่อนหน้า · พักการบันทึกในตารางจนกว่าจะโหลดข้อมูลสำเร็จ'),
 h('div',{id:'sdd-catalog-results',className:'sdd-tablewrap'+(loading?' is-loading':''),role:'tabpanel','aria-labelledby':'sdd-catalog-tab-'+scope,'aria-description':'ตารางเลื่อนได้แนวนอนเพื่อดูทุกคอลัมน์',tabIndex:0,'aria-busy':loading},h('table',null,h('thead',null,h('tr',null,[cfg.canBulk?'เลือก / รูป':'รูป','สินค้า / SKU','ราคาปกติ','ราคาโปรที่บันทึก','สต็อก','โปรโมชั่น','จัดการ'].map(label=>h('th',{key:label,scope:'col',className:label==='จัดการ'?'sdd-action-heading':label==='ราคาปกติ'||label==='ราคาโปรที่บันทึก'?'sdd-price-heading':label==='สต็อก'||label==='โปรโมชั่น'?'sdd-status-heading':''},label)))),h('tbody',null,resultsMatch&&data.items.map(row=>h(ProductGroup,{key:row.id,row,context,onSaved:saved,promoId,onPromo:setPromoId,onAudit:id=>{setAuditOptions(null);setAuditProduct(id);},onOpen:openDashboardProduct,canWrite:canWriteCatalog,bulkSelection,onSelectBulk:cfg.canBulk?selectBulk:undefined})),(!resultsMatch||!data.items.length)&&h('tr',null,h('td',{colSpan:7,className:'sdd-empty sdd-catalog-empty'},h('div',{className:'sdd-catalog-empty-content'},h('span',{className:'sdd-catalog-empty-icon','aria-hidden':true},'⌕'),h('strong',null,(loading||(!resultsMatch&&!error))?'กำลังโหลดรายการ…':error?'ยังโหลดรายการไม่ได้':!query&&!selectedFilters.length&&['current','expiring','upcoming'].includes(scope)?'ยังไม่มีโปรชั่วคราวในสถานะนี้':'ไม่พบสินค้าตามคำค้นหรือตัวกรอง'),h('p',null,(loading||(!resultsMatch&&!error))?'กรุณารอสักครู่':error?'กดรีเฟรชเพื่อลองโหลดข้อมูลอีกครั้ง':query||selectedFilters.length?'ลองเปลี่ยนคำค้นหรือล้างตัวกรองเพื่อดูรายการเพิ่มเติม':'เลือกสถานะอื่น หรือกลับไปดูสินค้าทั้งหมดได้'),resultsMatch&&!loading&&!error&&h('button',{type:'button',className:'sdd-secondary',onClick:()=>{if(query||selectedFilters.length){clearFilters();setSearch('');}else{setScope('all');setPage(1);setPromoId(null);}}},query||selectedFilters.length?'ล้างคำค้นและตัวกรอง':'ดูสินค้าทั้งหมด'))))))),
 h('nav',{className:'sdd-pagination','aria-label':'แบ่งหน้าสินค้า'},h('button',{disabled:page<=1||loading,onClick:()=>setPage(p=>p-1)},'← ก่อนหน้า'),h('span',null,'หน้า '+page+' / '+Math.max(1,data.pages)),h('button',{disabled:page>=data.pages||loading,onClick:()=>setPage(p=>p+1)},'ถัดไป →'),h('span',{className:'sdd-spacer'}),h('label',null,'รายการต่อหน้า ',h('select',{value:size,onChange:e=>{setSize(Number(e.target.value));setPage(1);}},[20,50,100].map(n=>h('option',{key:n,value:n},n))))))),confirmation&&h(Confirmation,{key:confirmation.text,request:confirmation,onDone:answer=>{const current=confirmation;setConfirmation(null);current.resolve(answer);}}));
}
wp.element.createRoot(document.getElementById('sdd-root')).render(h(App));
})();
