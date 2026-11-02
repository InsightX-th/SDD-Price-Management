/* WordPress-provided React; no remote fonts or runtime dependencies. */
(function () {
'use strict';
const {createElement:h, useState, useEffect, useRef} = wp.element;
const cfg = window.SDD_CONFIG;
const drafts = new Map();
const workspacePresence = new Map();
function mergeLiveRows(rows,update){
 const changed=new Map(update.items.map(r=>[r.id,r])),missing=new Set(update.unavailable);
 return rows.filter(r=>!missing.has(r.id)).map(row=>{const next=changed.get(row.id);if(!next)return row;const merged={...row,...next,latest_change:next.latest_change??row.latest_change};for(const field of Object.keys(row.revisions||{})){if(BigInt(next.revisions?.[field]||'0')<BigInt(row.revisions[field]||'0')){merged[field]=row[field];merged.revisions={...merged.revisions,[field]:row.revisions[field]};}}return merged;});
}
const signalDraft=id=>window.dispatchEvent(new CustomEvent('sdd:draft-update',{detail:String(id)}));
const stock = {instock:'มีสินค้า', outofstock:'สินค้าหมด', onbackorder:'สั่งจองได้'};
const labels = {regular_price:'ราคาปกติ',sale_price:'ราคาโปร',stock_status:'สถานะ',sale_dates:'วันราคาโปร'};
const uuid = () => crypto.randomUUID();
let nonce = cfg.nonce;
let showConfirmation,confirmationPending=false;
const confirmChange=(text,options={})=>{if(confirmationPending||!showConfirmation)return Promise.resolve(false);confirmationPending=true;return new Promise(resolve=>showConfirmation({text,...options,resolve:answer=>{confirmationPending=false;resolve(answer);}}));};
const canonicalPrice=value=>/^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(value)?value.replace(/,/g,''):value;
const displayPrice=value=>/^(0|[1-9][0-9]{0,14})$/.test(value)?BigInt(value).toLocaleString('en-US'):value;
function editPrice(event,change){
 const input=event.target,text=input.value,caret=input.selectionStart??text.length,digits=(text.slice(0,caret).match(/[0-9]/g)||[]).length;
 const type=event.nativeEvent?.inputType||'',data=event.nativeEvent?.data;
 const generated=(type==='insertText'&&typeof data==='string'&&/^[0-9]$/.test(data))||type.startsWith('delete');
 const value=canonicalPrice(generated?text.replace(/,/g,''):text);change(value);
 if(/^(0|[1-9][0-9]{0,14})$/.test(value))requestAnimationFrame(()=>{if(document.activeElement!==input)return;const shown=displayPrice(value);let count=0,pos=0;while(pos<shown.length&&count<digits){if(/[0-9]/.test(shown[pos]))count++;pos++;}input.setSelectionRange(pos,pos);});
}
function scheduleLabel(value){return (value||'|').split('|').map(token=>!token?'ไม่กำหนด':/^-?[0-9]+$/.test(token)?promoTime(token):token.replace('T',' ')).join(' → ');}
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
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000),sentNonce=nonce;
 let response,data;
 try{
  response=await fetch(cfg.api+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'X-WP-Nonce':sentNonce,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
  data=await responseJSON(response,body!==undefined);
 }catch(e){if([401,403].includes(e.status))pauseConnection(e);throw e;}
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
function Cell({row,field,onSaved}) {
 const key=row.id+':'+field;
 const [,render]=useState(0); const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;const changed=e=>{if(e.detail===row.id)render(x=>x+1);};window.addEventListener('sdd:draft-update',changed);return()=>{mounted.current=false;window.removeEventListener('sdd:draft-update',changed);};},[row.id]);
 let d=drafts.get(key);
 if (!d) { d={value:row[field],base:row[field],revision:row.revisions[field],generation:0,state:'clean',message:'',operation:null,conflict:null}; drafts.set(key,d); }
 if (d.state==='clean' && !d.busy) { d.value=row[field];d.base=row[field];d.revision=row.revisions[field]; }
 if(['dirty','error'].includes(d.state)&&!d.busy&&(d.base!==row[field]||d.revision!==row.revisions[field])){d.state='conflict';d.conflict={current_value:row[field],current_revision:row.revisions[field],changed_by:null,changed_at:null};d.message='มีข้อมูลใหม่ ตรวจราคาปัจจุบันก่อนบันทึก';}
 const refresh=()=>{if(mounted.current)render(x=>x+1);};
 const applyResult=(result,generation)=>{
  d.base=result.new_value;d.revision=result.revision;d.operation=null;d.conflict=null;
  if(d.generation===generation){d.value=result.new_value;d.state='clean';d.message='บันทึกแล้ว';}else{d.state='dirty';d.message='ค่าที่พิมพ์ใหม่ยังไม่ได้บันทึก';}
  onSaved(row.id,field,result.new_value,result.revision);refresh();
 };
 async function inspect() {
  if(!d.operation || d.busy)return;d.busy=true;
  try {const response=await api('operations/'+d.operation.operation_id);
   if(response.result?.ok){applyResult(response.result,d.sentGeneration);}
   else if(response.result?.code){fail(new ApiError(response.result,response.result.data?.status||400));d.operation=null;}
   else{d.state='unknown';d.message='ยังยืนยันผลบันทึกไม่ได้ ให้ผู้ดูแลตรวจสอบรายการเดิมก่อนบันทึกอีกครั้ง';}
  }catch(e){d.state='unknown';d.message='ตรวจผลไม่ได้: '+e.message;}
  finally{d.busy=false;refresh();signalDraft(row.id);}
 }
 function fail(e) {
  if(!(e instanceof ApiError)){d.state='unknown';d.message='การเชื่อมต่อขาดหาย ผลบันทึกยังไม่แน่ชัด';return;}
  if(e.code==='field_conflict'){d.state='conflict';d.conflict=e.data;d.message='ข้อมูลเปลี่ยนแล้ว';}
  else if(e.code==='operation_unknown'){d.state='unknown';d.message=e.message;}
  else{d.state='error';d.message=e.message+(e.data.request_id?' · '+e.data.request_id:'');}
 }
 async function commit() {
  if(d.busy || d.state==='unknown' || d.state==='conflict' || d.value===d.base)return;
  if(field!=='stock_status' && field!=='sale_dates' && !((field==='sale_price'&&d.value==='') || /^(0|[1-9][0-9]{0,14})$/.test(d.value))){d.state='error';d.message='กรอกราคาเป็นจำนวนเต็มไม่เกิน 15 หลัก เช่น 14,900 โดยไม่ใส่ทศนิยม';refresh();return;}
  if(!d.operation){
   const acks=[];
   if(field==='sale_dates'){
    if(!await confirmChange('วันราคาโปร ของ '+row.name+'\n'+showValue(d.base,field)+' → '+showValue(d.value,field)+'\nเขตเวลา '+(cfg.timezone||'UTC')+' · วันใหม่เริ่ม 00:00 / สิ้นสุด 23:59:59\nเปลี่ยนหรือล้างวันอาจทำให้โปรเริ่มหรือหยุดทันที ยืนยันบันทึก?')){d.state='dirty';refresh();return;}
    acks.push('schedule_change');
   } else if(field!=='stock_status'){
    if(!await confirmChange(labels[field]+' ของ '+row.name+'\n'+showValue(d.base,field)+' → '+showValue(d.value,field)+(d.value==='0'?'\nคำเตือน: ราคาจะเป็นศูนย์':'')+(['active','future'].includes(row.sale_schedule?.state)?'\nคงวันโปรเดิม: '+showValue(row.sale_dates,'sale_dates')+' ('+(cfg.timezone||'UTC')+')'+(row.sale_schedule.state==='active'?'\nโปรกำลังทำงาน: การเปลี่ยนราคาอาจมีผลทันที':'\nโปรอนาคต: ราคาโปรจะใช้ตามวันเริ่มเดิม'):'')+(row.sale_schedule?.state==='expired'?'\nเวลาโปรเดิมหมดอายุแล้ว ('+new Date(row.sale_schedule.to).toLocaleString('th-TH')+')\nระบบคงเวลาเดิม: แก้ราคาโปรแล้วโปรจะยังไม่เริ่มใหม่ หากต้องการเริ่มโปรเดิมอีกครั้ง ให้แก้วันโปรใน WooCommerce':'')+(['pending','active'].includes(row.temporary_sale?.status)?'\nมีโปรชั่วคราวอยู่: การแก้ราคาจะหยุดการคืนอัตโนมัติให้ตรวจสอบ':'')+'\nยืนยันบันทึกราคานี้?')){d.state='dirty';refresh();return;}
    acks.push('price_change');if(row.sale_schedule?.state==='expired')acks.push('expired_schedule');if(d.value==='0')acks.push('zero_price');
   }
   d.operation={operation_id:uuid(),field,value:d.value,base_value:d.base,base_revision:d.revision,acknowledgements:acks};d.sentGeneration=d.generation;
  }
  d.busy=true;d.state='saving';d.message='กำลังบันทึก';refresh();
  try{const result=await api('products/'+row.id+'/field',d.operation);applyResult(result,d.sentGeneration);}
  catch(e){fail(e);if(e instanceof ApiError && ![401,403,429,503].includes(e.status) && e.code!=='operation_unknown'){d.operation=null;}}
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
  d.state==='unknown'&&h('button',{className:'sdd-small',onClick:inspect},'ตรวจผลคำสั่ง'),
  d.state==='error'&&d.operation&&h('button',{className:'sdd-small',onClick:inspect},'ตรวจผลก่อนลองใหม่'),
  d.state==='conflict'&&h('div',{className:'sdd-conflict'},'ปัจจุบัน '+showValue(d.conflict.current_value,field)+' / ที่พิมพ์ '+showValue(d.value,field),h('button',{onClick:useCurrent},'ใช้ค่าปัจจุบัน'),h('button',{onClick:rebase},'เก็บค่าที่พิมพ์ไว้และตรวจใหม่')));
}
function Setup({onClose,onSaved}){
 const [settings,setSettings]=useState(null),[terms,setTerms]=useState([]),[selected,setSelected]=useState(new Set()),[enableAck,setEnableAck]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState(''),[busy,setBusy]=useState(false),[search,setSearch]=useState(''),[health,setHealth]=useState(null),[healthError,setHealthError]=useState(''),[healthBusy,setHealthBusy]=useState(false);
 const healthGeneration=useRef(0);
 const loadHealth=async()=>{const generation=++healthGeneration.current;setHealthBusy(true);try{const result=await api('health');if(generation===healthGeneration.current){setHealth(result);setHealthError('');}}catch(e){if(generation===healthGeneration.current){setHealth(null);setHealthError(e.message);}}finally{if(generation===healthGeneration.current)setHealthBusy(false);}};
 useEffect(()=>{let live=true;Promise.all([api('settings'),(async()=>{let result=[],page=1,pages=1;do{const r=await api('brand-terms?page='+page);result.push(...r.items);pages=r.pages;page++;}while(page<=pages&&page<=20);return result;})()]).then(([s,t])=>{if(!live)return;setSettings(s);setTerms(t);setSelected(new Set((s.settings.brand_ids||[]).map(String)));}).catch(e=>{if(live)setError(e.message);});loadHealth();return()=>{live=false;healthGeneration.current++;};},[]);
 const stopped=settings?.settings?.write_stop!==false;
 const blockers=[...new Set([...(settings&&!settings.schema_ready?['โครงสร้างฐานข้อมูลยังไม่พร้อม']:[]),...(health?.enable_reasons||(!health?['ยังตรวจสถานะระบบไม่สำเร็จ']:[]))])];
 const canEnable=!!settings&&!!health&&!healthBusy&&!blockers.length&&enableAck;
 async function persist(nextStop,nextAck,message){setBusy(true);setError('');setSuccess('');try{const updated=await api('settings',{brand_ids:[...selected],write_stop:nextStop,local_ack:nextAck});setSettings(updated);setSuccess(message);onSaved();await loadHealth();return true;}catch(e){const reasons=e.data?.blockers||[];setError(e.message+(reasons.length?' · '+reasons.join(' · '):''));await loadHealth();return false;}finally{setBusy(false);}}
 async function save(){return persist(stopped,!!settings?.settings?.local_ack,'บันทึกการตั้งค่าแบรนด์แล้ว โดยคงสถานะการแก้ไขเดิม');}
 async function enableEditing(){if(!enableAck){setError('ทำเครื่องหมายยืนยันก่อนเปิดให้แก้ไขสินค้า');return;}if(blockers.length){setError('ยังเปิดให้แก้ไขไม่ได้: '+blockers.join(' · '));return;}if(!await confirmChange('กำลังเปิดสิทธิ์แก้ไขสินค้าและราคาให้ผู้ใช้ที่มีสิทธิ์\nก่อนยืนยัน โปรดตรวจว่า backup และขั้นตอนกู้คืนพร้อมแล้ว\nยืนยันเปิดให้แก้ไขสินค้า?'))return;const ok=await persist(false,true,'เปิดให้แก้ไขสินค้าแล้ว');if(ok)setEnableAck(false);}
 async function pauseEditing(){if(!await confirmChange('หยุดการแก้ไขสินค้าและราคาไว้ชั่วคราวหรือไม่? ผู้ใช้ยังดูข้อมูลได้ แต่จะบันทึกไม่ได้ และโปรจะหยุดเริ่มหรือคืนราคาอัตโนมัติจนกว่าจะเปิดอีกครั้ง',{title:'หยุดการแก้ไขและงานราคา',confirmLabel:'ยืนยันหยุดชั่วคราว'}))return;await persist(true,!!settings?.settings?.local_ack,'หยุดการแก้ไขสินค้าแล้ว');setEnableAck(false);}
 const visibleTerms=terms.filter(t=>t.name.toLowerCase().includes(search.toLowerCase()));
 const allVisibleSelected=visibleTerms.length>0&&visibleTerms.every(t=>selected.has(t.id));
 return h('section',{className:'sdd-setup','aria-label':'ตั้งค่า'},h('header',{className:'sdd-setup-heading'},h('div',null,h('h2',null,'ตั้งค่าการใช้งาน'),h('p',null,'ตั้งค่าแบรนด์ ตรวจความพร้อม และควบคุมการแก้ไขสินค้า'))),
 error&&h('p',{role:'alert',className:'sdd-error'},error),success&&h('p',{role:'status',className:'sdd-success'},success),
 h('section',{className:'sdd-setup-card sdd-write-control','aria-labelledby':'sdd-write-heading'},h('div',{className:'sdd-write-header'},h('div',null,h('h3',{id:'sdd-write-heading'},'สถานะการแก้ไข'),h('p',null,'เมื่อปิดอยู่ ยังดูข้อมูลได้ แต่บันทึกราคาและสต็อกไม่ได้ รวมถึงหยุดการเริ่มและคืนราคาโปรอัตโนมัติจนกว่าจะเปิดอีกครั้ง')),h('span',{className:'sdd-write-pill '+(stopped?'paused':'enabled'),role:'status'},stopped?'ปิดการแก้ไข':'เปิดให้แก้ไขแล้ว')),
 stopped?h(wp.element.Fragment,null,h('div',{className:'sdd-readiness '+(blockers.length?'blocked':'ready')},h('strong',null,healthBusy?'กำลังตรวจความพร้อม…':blockers.length?'ยังเปิดไม่ได้':'ผ่านเงื่อนไขระบบ'),blockers.length&&h('ul',null,blockers.map((reason,i)=>h('li',{key:reason+i},reason))),!blockers.length&&h('p',null,'ระบบพร้อมในส่วนที่ปลั๊กอินตรวจได้ โปรดตรวจ backup และวิธีกู้คืนของร้านด้วย')),h('label',{className:'sdd-enable-ack'},h('input',{type:'checkbox',checked:enableAck,disabled:busy||!!blockers.length,onChange:e=>setEnableAck(e.target.checked)}),' ฉันตรวจสอบ backup และเข้าใจว่าการเปิดนี้อนุญาตให้ผู้มีสิทธิ์แก้ไขข้อมูลสินค้า'),h('button',{type:'button',className:'sdd-primary',disabled:busy||!canEnable,onClick:enableEditing},busy?'กำลังตรวจและบันทึก…':'เปิดให้แก้ไขสินค้า')):h('div',{className:'sdd-write-actions'},h('p',null,'ผู้ใช้ที่มีสิทธิ์สามารถแก้ไขสินค้าได้'),h('button',{type:'button',className:'sdd-danger-button',disabled:busy,onClick:pauseEditing},busy?'กำลังบันทึก…':'หยุดการแก้ไขชั่วคราว'))),
 h('section',{className:'sdd-setup-card','aria-labelledby':'sdd-environment-heading'},h('div',{className:'sdd-card-heading'},h('h3',{id:'sdd-environment-heading'},'สภาพแวดล้อม'),h('span',{className:'sdd-setup-version'},'ปลั๊กอิน '+(health?.version||settings?.version||'—'))),h('div',{className:'sdd-environment-grid'},[['PHP',health?.runtime?.php||settings?.php],['WordPress',health?.runtime?.wordpress],['WooCommerce',health?.runtime?.woocommerce],['สกุลเงิน',settings?.currency],['ภาษี',settings?(settings.prices_include_tax?'รวมภาษี':'ไม่รวมภาษี'):null],['เขตเวลา',health?.runtime?.timezone]].map(([label,value])=>h('div',{key:label},h('span',null,label),h('strong',null,value||'กำลังอ่าน…')))),h('div',{className:'sdd-schema-state'},h('span',{className:'sdd-status '+(settings?.schema_ready?'active':'needs_review')},'ฐานข้อมูล '+(settings?(settings.schema_ready?'พร้อม':'ไม่พร้อม'):'กำลังตรวจ')))),
 h('section',{className:'sdd-setup-card sdd-brand-settings','aria-labelledby':'sdd-brands-heading'},h('div',{className:'sdd-card-heading'},h('h3',{id:'sdd-brands-heading'},'แท็กแบรนด์'),h('span',{className:'sdd-term-count'},'เลือก '+selected.size+' / '+terms.length)),h('p',null,'เลือกแท็กที่ใช้เป็นแบรนด์สำหรับค้นหาและกรองสินค้า การเปลี่ยนแปลงนี้ไม่ย้ายหรือลบแท็ก'),h('div',{className:'sdd-term-controls'},h('input',{'aria-label':'ค้นหาแท็กแบรนด์',value:search,onChange:e=>setSearch(e.target.value),placeholder:'พิมพ์ชื่อแบรนด์เพื่อค้นหา…'}),h('button',{type:'button',disabled:busy||!terms.length,'aria-pressed':allVisibleSelected,onClick:()=>{setSelected(prev=>{const next=new Set(prev);visibleTerms.forEach(t=>allVisibleSelected?next.delete(t.id):next.add(t.id));return next;});}},allVisibleSelected?(search?'ยกเลิกผลที่แสดง':'ยกเลิกทั้งหมด'):(search?'เลือกผลที่แสดง':'เลือกทั้งหมด'))),h('div',{className:'sdd-terms'},visibleTerms.map(t=>h('label',{key:t.id},h('input',{type:'checkbox',checked:selected.has(t.id),disabled:busy,onChange:e=>{const next=new Set(selected);e.target.checked?next.add(t.id):next.delete(t.id);setSelected(next);}}),' '+t.name)),!visibleTerms.length&&h('p',{className:'sdd-empty'},terms.length?'ไม่พบแบรนด์ที่ตรงกับคำค้น':'กำลังโหลดแท็กแบรนด์…'))),
 h(HealthPanel,{data:health,error:healthError,busy:healthBusy,onRefresh:loadHealth,stopped}),cfg.canLogs&&h(LogViewer),h('div',{className:'sdd-actions'},h('button',{className:'sdd-primary',disabled:busy||!settings,onClick:save},busy?'กำลังบันทึก…':'บันทึกการตั้งค่าแบรนด์'),h('button',{onClick:onClose,disabled:busy},'กลับตาราง')));
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
 const options=files.map(f=>h('option',{key:f.id,value:f.id},new Date(f.created_at).toLocaleString('th-TH')+' · '+(f.size_bytes<1024?'น้อยกว่า 1 KB':Math.round(f.size_bytes/1024)+' KB')));
 const entries=data&&h('div',{className:'sdd-log-entries'},data.items.map((item,i)=>h('article',{key:item.occurred_at+'-'+i,className:'sdd-log-entry'},h('span',{className:'sdd-status needs_review'},item.level),h('strong',null,item.event),h('time',null,new Date(item.occurred_at).toLocaleString('th-TH')),item.request_id&&h('code',null,item.request_id))),!data.items.length&&h('p',null,'ไม่มีเหตุการณ์ที่แสดงได้ในไฟล์นี้'),data.truncated&&h('small',null,'ไฟล์มีเหตุการณ์มากกว่าที่หน้าแสดง รายการที่ดาวน์โหลดอาจไม่ครบทั้งไฟล์'));
 return h('section',{className:'sdd-health sdd-log-viewer','aria-label':'บันทึกเหตุการณ์ทางเทคนิค'},
  h('div',{className:'sdd-inspection-heading'},h('h3',null,'บันทึกเหตุการณ์ทางเทคนิค'),h('button',{disabled:busy,onClick:()=>{setSelected('');setData(null);setTick(t=>t+1);}},busy?'กำลังอ่าน…':'โหลดรายการใหม่')),
  h('p',null,'สำหรับผู้ดูแลตรวจปัญหาของ SoundDD · เก็บไฟล์ 30 วัน · แสดงเฉพาะข้อมูลที่จำเป็น ไม่เกิน 200 เหตุการณ์ต่อไฟล์'),
  error&&h('p',{role:'alert',className:'sdd-error'},error),
  h('label',null,'ไฟล์ log ',h('select',{value:selected,onChange:e=>setSelected(e.target.value)},h('option',{value:''},files.length?'เลือกไฟล์':'ไม่พบไฟล์ log'),options)),
  data&&h('div',{className:'sdd-log-download-row'},h('button',{type:'button',className:'sdd-secondary',disabled:busy||!data.items.length,onClick:()=>downloadLogCsv(data)},'ดาวน์โหลด CSV'),h('span',null,data.truncated?'ดาวน์โหลดเฉพาะรายการที่แสดง':'ดาวน์โหลดเหตุการณ์ที่ผ่านการกรองทั้งหมดในไฟล์นี้')),
  entries);
}
const promoLabels={pending:'รอเริ่ม',active:'กำลังใช้',needs_review:'ต้องตรวจสอบ',restored:'คืนราคาแล้ว',cancelled:'ปิดรายการแล้ว',missed:'เลยเวลาเริ่ม'};
function HealthPanel({data,error,busy,onRefresh,stopped}){
 const queueNames={unresolved_operations:'รายการที่ยังไม่ทราบผล',external_pending:'การเปลี่ยนข้อมูลที่รอประมวลผล',promotions_review:'โปรที่ต้องตรวจสอบ',live_promotions:'โปรที่รอเริ่มหรือกำลังใช้'};
 const cronNames={sdd_feed_publish:'เผยแพร่การเปลี่ยนแปลง',sdd_external_drain:'ประมวลผลการแก้จากภายนอก',sdd_temporary_sale_scan:'ตรวจเวลาโปรชั่วคราว',sdd_log_retention:'ลบไฟล์ log ที่เกิน 30 วัน',sdd_business_retention:'ลบประวัติและรายการดำเนินการที่จบแล้วเกิน 90 วัน'};
 return h('section',{className:'sdd-health','aria-label':'สถานะระบบ'},h('div',{className:'sdd-inspection-heading'},h('div',null,h('h3',null,'รายละเอียดการตรวจระบบ'),data?.server_time&&h('small',{className:'sdd-health-checked'},'ตรวจล่าสุด '+new Date(data.server_time).toLocaleString('th-TH'))),h('button',{disabled:busy,onClick:onRefresh},busy?'กำลังตรวจ…':'ตรวจอีกครั้ง')),busy&&!data&&h('p',{role:'status'},'กำลังอ่านสถานะระบบ…'),error&&h('p',{role:'alert',className:'sdd-error'},error),data&&h(wp.element.Fragment,null,h('div',{className:'sdd-health-grid'},(data.checks||[]).map(c=>{const statusLabel=c.key==='writer'&&stopped&&!(data.enable_reasons||[]).length?'ปิดตามการตั้งค่า':({ok:'พร้อม',blocked:'ต้องแก้ก่อนเปิด',warning:'ควรตรวจสอบ'})[c.state];return h('div',{key:c.key,className:'sdd-health-check '+c.state},h('div',{className:'sdd-health-check-heading'},h('strong',null,c.label),h('span',{className:'sdd-status '+(c.state==='ok'?'active':c.state==='blocked'?'needs_review':'expired')},statusLabel)),h('p',null,c.detail));})),h('h4',null,'งานที่รอดำเนินการ'),h('div',{className:'sdd-health-queues'},Object.entries(data.queues||{}).map(([key,q])=>h('p',{key},queueNames[key]||key,': ',h('strong',null,q.count===null?'อ่านไม่ได้':q.count+(q.at_least?'+':''))))),h('small',null,'แสดงไม่เกิน 100 รายการต่อคิว; 100+ คืออย่างน้อย 101 รายการ'),h('h4',null,'งานอัตโนมัติ'),h('ul',null,(data.cron||[]).map(c=>h('li',{key:c.job},cronNames[c.job]||c.job,': ',c.next_at?new Date(c.next_at).toLocaleString('th-TH'):'ยังไม่มีนัดหมาย',c.state==='warning'?' · ยังไม่พร้อม':c.state==='idle'?' · ยังไม่จำเป็นตอนนี้':' · มีนัดหมาย'))),h('p',{className:'sdd-plan-help'},data.cron_note,data.wp_cron_disabled?' · ปิด WP-Cron อยู่ ให้ผู้ดูแลตรวจระบบเรียกงานของเซิร์ฟเวอร์':''),h('p',{className:'sdd-warning'},'ข้อมูลนี้แสดงความพร้อมที่ปลั๊กอินตรวจได้ ตารางงานที่มีนัดหมายยังไม่ยืนยันว่ารันสำเร็จ และไม่ได้ตรวจการกู้คืน backup')));
}
function AuditPanel({productId,onClose}){
 const [input,setInput]=useState(productId||''),[id,setId]=useState(productId||''),[field,setField]=useState(''),[cursors,setCursors]=useState(['']),[tick,setTick]=useState(0),[data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const before=cursors[cursors.length-1];
 useEffect(()=>{let live=true;if(!id)return;setBusy(true);setData(null);setError('');api('audit?'+new URLSearchParams({product_id:id,field,before,per_page:'20'})).then(r=>{if(live)setData(r);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[id,field,before,tick]);
 function search(){if(!/^[1-9][0-9]{0,17}$/.test(input.trim())){setData(null);setError('กรอกรหัสสินค้า หรือรหัสตัวเลือกสินค้า เป็นตัวเลขเท่านั้น');return;}setId(input.trim());setCursors(['']);setTick(t=>t+1);setError('');}
 const sources={inline_edit:'แก้รายสินค้า',bulk_action:'แก้หลายรายการ',rollback:'ย้อนคืน',external_hook:'ช่องทางภายนอก',external_detected:'ตรวจพบค่าภายนอก',woo_schedule:'ตารางโปร WooCommerce',temporary_sale:'โปรชั่วคราว',temporary_start:'เริ่มโปรชั่วคราว',temporary_restore:'คืนโปรชั่วคราว',sale_plan:'ตั้งโปร'};
 const rows=data&&data.items.map(e=>{const login=e.actor_login||(e.user_id?'บัญชี #'+e.user_id:'ระบบ / ช่องทางภายนอก');return h('tr',{key:e.id},h('td',null,new Date(e.created_at).toLocaleString('th-TH'),h('small',null,'Event #'+e.id)),h('td',null,labels[e.field]||e.field,h('small',null,sources[e.source]||e.source)),h('td',null,h('strong',null,showValue(e.old_value,e.field)+' → '+showValue(e.new_value,e.field)),h('small',null,'Revision '+e.revision_before+' → '+e.revision_after)),h('td',{className:'sdd-audit-actor'},h('strong',null,login),e.actor_email&&h('small',null,e.actor_email),e.user_id&&!e.actor_login&&h('small',null,'ไม่พบข้อมูลบัญชีผู้ใช้'),h('details',null,h('summary',null,'รหัสสำหรับตรวจสอบ'),h('small',null,'Request: '+e.request_id),e.operation_id&&h('small',null,'Operation: '+e.operation_id),e.reverts_event_id&&h('small',null,'ย้อน Event #'+e.reverts_event_id))));});
 return h('section',{className:'sdd-audit','aria-label':'ประวัติการแก้ไข'},
  h('div',{className:'sdd-inspection-heading'},h('h2',null,'ประวัติการแก้ไข'),h('button',{onClick:onClose},'กลับตาราง')),
  h('p',null,'กรอกรหัสสินค้าเพื่อดูการแก้ไขที่ผ่านมา รวมการแก้จากช่องทางอื่นที่ระบบตรวจพบ แสดงเฉพาะสินค้าที่คุณมีสิทธิ์ดู'),
  h('div',{className:'sdd-audit-tools'},h('label',null,'ID สินค้า / ตัวเลือกสินค้า',h('input',{'aria-label':'ID สินค้าสำหรับดูประวัติ',value:input,inputMode:'numeric',maxLength:18,onChange:e=>setInput(e.target.value),onKeyDown:e=>{if(e.key==='Enter')search();}})),h('button',{className:'sdd-primary',disabled:busy,onClick:search},'ดูประวัติ'),h('label',null,'ช่องที่แก้',h('select',{'aria-label':'กรองช่องในประวัติ',value:field,onChange:e=>{setField(e.target.value);setCursors(['']);}},h('option',{value:''},'ทุกช่อง'),Object.entries(labels).filter(([key])=>['regular_price','sale_price','sale_dates','stock_status'].includes(key)).map(([key,label])=>h('option',{key,value:key},label))))),
  busy&&h('p',{role:'status'},'กำลังอ่านประวัติ…'),error&&h('p',{role:'alert',className:'sdd-error'},error),
  data&&h(wp.element.Fragment,null,h('h3',null,data.product.name+' · #'+data.product.id),h('div',{className:'sdd-tablewrap'},h('table',null,h('thead',null,h('tr',null,['เวลา','ช่อง / ช่องทาง','ก่อน → หลัง','ชื่อบัญชี / อีเมล'].map(t=>h('th',{key:t},t)))),h('tbody',null,rows,!data.items.length&&h('tr',null,h('td',{colSpan:4,className:'sdd-empty'},'ยังไม่มีประวัติที่เก็บไว้สำหรับสินค้านี้'))))),h('div',{className:'sdd-pagination'},h('button',{disabled:busy||cursors.length<=1,onClick:()=>setCursors(c=>c.slice(0,-1))},'ประวัติก่อนหน้า'),h('span',null,'หน้า '+cursors.length),h('button',{disabled:busy||!data.next_before,onClick:()=>setCursors(c=>[...c,data.next_before])},'ดูรายการเก่ากว่า'))));
}
const promoDrafts=new Map();
const promoTime=value=>{
 const tz=cfg.timezone||'UTC',offset=/^([+-])(\d{2}):(\d{2})$/.exec(tz);
 const date=new Date(Number(value)*1000+(offset?(offset[1]==='-'?-1:1)*(Number(offset[2])*60+Number(offset[3]))*60000:0));
 return new Intl.DateTimeFormat('en-GB',{timeZone:offset?'UTC':tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
};
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
function DateTimePicker({value,onChange,label,disabled,id,defaultTime='00:00'}){
 const [open,setOpen]=useState(false),[month,setMonth]=useState(()=>{const p=isoDateParts(value);const now=new Date();return {year:p?.year||now.getFullYear(),month:p?.month||now.getMonth()+1};}),[position,setPosition]=useState(null);
 const root=useRef(null),trigger=useRef(null),grid=useRef(null),popover=useRef(null);
 const selected=isoDateParts(value),time=value?.slice(11,16)||defaultTime,today=new Date(),todayISO=isoDate(today.getFullYear(),today.getMonth()+1,today.getDate());
 useEffect(()=>{if(!open)return;const outside=e=>{if(!root.current?.contains(e.target))setOpen(false);},escape=e=>{if(e.key==='Escape'){e.preventDefault();setOpen(false);trigger.current?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[open]);
 useEffect(()=>{if(!open)return;const place=()=>{const a=trigger.current?.getBoundingClientRect(),p=popover.current?.getBoundingClientRect();if(!a||!p)return;setPosition({left:Math.max(12,Math.min(a.left,window.innerWidth-p.width-12)),top:a.bottom+p.height+12>window.innerHeight?Math.max(12,a.top-p.height-8):a.bottom+8});};const raf=requestAnimationFrame(place);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);return()=>{cancelAnimationFrame(raf);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};},[open,month]);
 const dateLabel=selected?new Intl.DateTimeFormat('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(selected.year,selected.month-1,selected.day))):'เลือกวันที่';
 const monthLabel=new Intl.DateTimeFormat('th-TH',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(month.year,month.month-1,1)));
 const firstWeekday=new Date(Date.UTC(month.year,month.month-1,1)).getUTCDay(),daysInMonth=new Date(Date.UTC(month.year,month.month,0)).getUTCDate();
 const moveMonth=delta=>{const d=new Date(Date.UTC(month.year,month.month-1+delta,1));setMonth({year:d.getUTCFullYear(),month:d.getUTCMonth()+1});};
 const chooseDate=date=>onChange(date+'T'+time);
 const setTime=next=>{const date=selected?isoDate(selected.year,selected.month,selected.day):todayISO;onChange(date+'T'+next);};
 const cells=Array.from({length:42},(_,i)=>{const day=i-firstWeekday+1,date=new Date(Date.UTC(month.year,month.month-1,day)),dateISO=isoDate(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate()),inMonth=day>0&&day<=daysInMonth;return {date,dateISO,inMonth,day:date.getUTCDate()};});
 const keyMove=(event,index)=>{const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];if(delta===undefined)return;event.preventDefault();grid.current?.querySelectorAll('button[data-day]')[Math.max(0,Math.min(41,index+delta))]?.focus();};
 return h('div',{className:'sdd-datetime-picker',ref:root},h('button',{type:'button',ref:trigger,id, className:'sdd-datetime-trigger','aria-label':label+': '+(selected?dateLabel+' เวลา '+time:'ยังไม่ได้เลือกวันและเวลา'),'aria-haspopup':'dialog','aria-expanded':open,disabled,onClick:()=>{if(!open){const p=isoDateParts(value);if(p)setMonth({year:p.year,month:p.month});}setOpen(v=>!v);}},h('span',{className:'sdd-datetime-trigger-value'},selected?h( wp.element.Fragment,null,h('strong',null,dateLabel),h('span',null,time)):h('span',{className:'sdd-datetime-placeholder'},'เลือกวันและเวลา')),h('span',{className:'sdd-calendar-icon','aria-hidden':'true'},h('svg',{viewBox:'0 0 24 24',focusable:'false'},h('rect',{x:'3.5',y:'5',width:'17',height:'15',rx:'2',fill:'none',stroke:'currentColor',strokeWidth:'1.8'}),h('path',{d:'M7.5 3.5v3M16.5 3.5v3M4 9h16',fill:'none',stroke:'currentColor',strokeWidth:'1.8',strokeLinecap:'round'}),h('path',{d:'M8 12.5h2v2H8zM12 12.5h2v2h-2zM16 12.5h1v2h-1z',fill:'currentColor'})))),
 open&&h('div',{className:'sdd-calendar-popover',ref:popover,style:position?{left:position.left,top:position.top}:undefined,role:'dialog','aria-label':label+' เลือกวันและเวลา'},h('div',{className:'sdd-calendar-head'},h('button',{type:'button','aria-label':'เดือนก่อนหน้า',onClick:()=>moveMonth(-1)},'‹'),h('strong',null,monthLabel),h('button',{type:'button','aria-label':'เดือนถัดไป',onClick:()=>moveMonth(1)},'›')),
 h('div',{className:'sdd-calendar-grid'},['อา','จ','อ','พ','พฤ','ศ','ส'].map((day,i)=>h('span',{key:day+i,className:'sdd-calendar-weekday','aria-hidden':'true'},day))),
 h('div',{className:'sdd-calendar-grid sdd-calendar-days',ref:grid},cells.map((cell,i)=>h('button',{key:cell.dateISO,type:'button','data-day':cell.dateISO,tabIndex:i===cells.findIndex(c=>c.dateISO===(selected?isoDate(selected.year,selected.month,selected.day):todayISO))?0:-1,className:[cell.inMonth?'':'outside',cell.dateISO===todayISO?'today':'',selected&&cell.dateISO===isoDate(selected.year,selected.month,selected.day)?'selected':''].filter(Boolean).join(' '),'aria-label':new Intl.DateTimeFormat('th-TH',{dateStyle:'full',timeZone:'UTC'}).format(cell.date),'aria-pressed':!!selected&&cell.dateISO===isoDate(selected.year,selected.month,selected.day),onKeyDown:e=>keyMove(e,i),onClick:()=>chooseDate(cell.dateISO)},cell.day))),
 h('div',{className:'sdd-calendar-footer'},h('button',{type:'button',className:'sdd-calendar-today',onClick:()=>{chooseDate(todayISO);setMonth({year:today.getFullYear(),month:today.getMonth()+1});}},'วันนี้'),h('label',null,'เวลา',h('input',{type:'time',step:60,value:time,'aria-label':label+' เวลา',onChange:e=>setTime(e.target.value)}))),
 h('div',{className:'sdd-calendar-actions'},h('button',{type:'button',onClick:()=>{onChange('');setOpen(false);trigger.current?.focus();}},'ล้างวันที่'),h('button',{type:'button',className:'sdd-calendar-done',onClick:()=>{setOpen(false);trigger.current?.focus();}},'เสร็จสิ้น'))));
}
function restorationSummary(plan,now=Date.now()/1000){
 const after=plan.revive_expired?plan.original.sale_price:restoredPrice(plan.original,localMinute(plan.ends_at));
 if(plan.status==='restored')return {tone:'success',title:'คืนราคาและตารางเดิมแล้ว',detail:'ระบบบันทึกการคืนราคาสำเร็จแล้ว',after};
 if(plan.status==='needs_review')return {tone:'attention',title:'ต้องตรวจราคาก่อนคืนอัตโนมัติ',detail:'พบข้อมูลเปลี่ยนหรือมีปัญหา ระบบจึงคงราคาปัจจุบันไว้ ให้ตรวจประวัติราคาแล้วตัดสินใจต่อ',after};
 if(plan.status==='cancelled')return {tone:'neutral',title:'ปิดรายการแล้ว',detail:'ดูผลการปิดรายการและราคาปัจจุบันด้านล่าง',after};
 if(plan.status==='missed')return {tone:'attention',title:'โปรนี้ไม่ได้เริ่มตามกำหนด',detail:'ตรวจราคาปัจจุบันและประวัติก่อนทำรายการต่อ',after};
 if(plan.status==='pending'&&Number(plan.starts_at)<now-300)return {tone:'attention',title:'เลยเวลาเริ่มแล้ว ยังไม่ยืนยันการเริ่มโปร',detail:'ตรวจงานอัตโนมัติหรือแจ้งผู้ดูแลก่อนทำรายการซ้ำ',after};
 if(plan.status==='active'&&Number(plan.ends_at)<now-300)return {tone:'attention',title:'เลยเวลาคืนราคาแล้ว กำลังรอตรวจสอบ',detail:'ยังไม่ยืนยันการคืนราคา ตรวจงานอัตโนมัติหรือแจ้งผู้ดูแล',after};
 return {tone:'scheduled',title:'ตั้งให้กลับเป็น '+showValue(after,'sale_price')+' บาทหลังจบ',detail:'กำหนดคืนราคา '+promoTime(plan.ends_at)+' · ดูผลการคืนราคาได้ที่นี่',after};
}
function RestorationCard({plan,currentPrice,automation}){
 const result=restorationSummary(plan);
 const paused=automation?.blocked&&['pending','active'].includes(plan.status);
 return h('section',{className:'sdd-restoration-card '+(paused?'attention':result.tone),'aria-label':'การคืนราคาหลังจบโปร'},h('span',{className:'sdd-restoration-icon','aria-hidden':true},result.tone==='success'?'✓':paused||result.tone==='attention'?'!':'↩'),h('div',null,h('strong',null,paused?'งานราคาอัตโนมัติหยุดอยู่':result.title),h('p',null,paused?'ต้องให้ผู้ดูแลเปิดการทำงานอีกครั้ง เพื่อให้ระบบเริ่มและคืนราคาโปรได้':result.detail),plan.status==='restored'&&plan.updated_at&&h('p',null,'บันทึกผลเมื่อ '+promoTime(String(Date.parse(plan.updated_at)/1000))),h('div',{className:'sdd-restoration-prices'},h('span',null,'หลังจบตามแผน ',h('b',null,showValue(result.after,'sale_price')+' บาท')),typeof currentPrice==='string'&&h('span',null,'ราคาข้อมูลล่าสุด ',h('b',null,showValue(currentPrice,'sale_price')+' บาท'))),h('details',null,h('summary',null,'ระบบคืนราคาอย่างไร'),h('p',null,'ระบบเก็บราคาและตารางเดิมไว้ และจะพยายามคืนให้เมื่อครบเวลา โดยไม่ต้องตั้งโปรเดิมใหม่ หากมีการแก้ราคาแทรก ระบบจะหยุดไว้ให้ตรวจสอบเพื่อไม่ทับค่าที่แก้ใหม่ งานอัตโนมัติของเว็บอาจทำให้คืนราคาช้ากว่ากำหนด'))));
}
function TemporarySale({row,onSaved}){
 const [data,setData]=useState(null),[working,setBusy]=useState(false),[error,setError]=useState(''),[readError,setReadError]=useState(false),[,render]=useState(0);
 const readGeneration=useRef(0),activeReads=useRef(0);
 const key=row.id,priceReadonly=!row.editable.sale_price; let d=promoDrafts.get(key);
 if(!d){d={price:'',start:'',end:'',revive:false,operation:null,state:'clean'};promoDrafts.set(key,d);}
 const busy=working||d.state==='saving';
 const livePlan=data?.items?.find(p=>['pending','active','needs_review'].includes(p.status));
 const originalDates=livePlan?.original?.sale_dates??data?.baseline?.sale_dates??row.sale_dates??'|';
 const originalState=originalScheduleState(originalDates,Number(data?.server_time||Date.now()/1000));
 const change=(field,value)=>{d[field]=value;d.state='dirty';render(x=>x+1);signalDraft(row.id);};
 useEffect(()=>{load();const refresh=()=>{if(!document.hidden&&d.state!=='saving')load(true);};const timer=setInterval(refresh,30000);document.addEventListener('visibilitychange',refresh);return()=>{readGeneration.current++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[row.id,row.temporary_sale?.status,row.regular_price,row.sale_price,row.sale_dates]);
 useEffect(()=>{const changed=e=>{if(e.detail===row.id)render(x=>x+1);};window.addEventListener('sdd:draft-update',changed);return()=>window.removeEventListener('sdd:draft-update',changed);},[row.id]);
 const load=async(background=false)=>{if(background&&activeReads.current)return false;activeReads.current++;const generation=++readGeneration.current;if(!background)setBusy(true);setReadError(false);try{const latest=await api('products/'+row.id+'/temporary-sales');if(generation!==readGeneration.current)return false;setData(latest);setError('');return true;}catch(e){if(generation===readGeneration.current){setReadError(true);setError('ตรวจข้อมูลล่าสุดไม่สำเร็จ · '+e.message);}return false;}finally{activeReads.current--;if(!background&&generation===readGeneration.current)setBusy(false);}};
 const done=async()=>{d.state='clean';d.operation=null;d.price='';d.start='';d.end='';d.revive=false;signalDraft(row.id);await load();onSaved(row.id,'sale_price',row.sale_price,row.revisions.sale_price);};
 async function save(){
  if(!data?.baseline||busy||readError||d.state==='unknown')return;
  if(!/^(0|[1-9][0-9]{0,14})$/.test(d.price)||!d.start||!d.end||d.end<=d.start){setError('กรอกราคาเป็นจำนวนเต็ม พร้อมวันเริ่มและวันสิ้นสุด โดยวันสิ้นสุดต้องหลังวันเริ่ม');return;}
  const now=localMinute(Date.now()/1000),reference=referenceAt(data.baseline,d.start>now?d.start:now);
  if(BigInt(d.price)>=BigInt(reference.price)){setError('ราคาโปรชั่วคราวต้องต่ำกว่าราคาปกติ '+showValue(reference.price,'regular_price'));return;}
  if([...drafts.entries()].some(([k,v])=>k.startsWith(row.id+':')&&v.state!=='clean')){setError('บันทึกหรือยกเลิกราคาที่แก้ค้างไว้ของสินค้านี้ ก่อนตั้งโปรชั่วคราว');return;}
  const after=d.revive&&canRevive(data.baseline,d.end)?data.baseline.sale_price:restoredPrice(data.baseline,d.end);
  const summary=row.name+'\nราคาโปร '+showValue(d.price,'sale_price')+' บาท\nเริ่ม '+d.start+' · จบ '+d.end+' ('+(cfg.timezone||'UTC')+')\nหลังจบตามแผน '+showValue(after,'sale_price')+' บาท\nระบบเก็บราคาและตารางเดิมไว้เพื่อคืนอัตโนมัติ ดูผลการคืนได้ในรายการโปรนี้'+(d.revive&&canRevive(data.baseline,d.end)?'\nคุณเลือกใช้ราคาโปรเดิมต่อแม้หมดอายุ โดยล้างวันเริ่ม–จบเดิม':'');
  if(!await confirmChange(summary,{title:'ตั้งโปรพร้อมแผนคืนราคา',confirmLabel:'ยืนยันตั้งโปรชั่วคราว'}))return;
  if(d.price==='0'&&!await confirmChange('ราคาโปรเป็นศูนย์ ยืนยันให้สินค้านี้ราคา 0?'))return;
  d.operation={operation_id:uuid(),price:d.price,start:d.start,end:d.end,baseline:data.baseline,confirmed:true,zero_ack:d.price==='0',revive_expired:!!d.revive&&canRevive(data.baseline,d.end)};d.state='saving';setBusy(true);setError('');
  try{await api('products/'+row.id+'/temporary-sales',d.operation);await done();}
  catch(e){if(!(e instanceof ApiError)||e.code==='operation_unknown'){d.state='unknown';setError('ยังยืนยันผลไม่ได้ กดตรวจผลคำสั่งเดิมก่อนตั้งโปรอีกครั้ง');}else{d.state='dirty';d.operation=null;setError(e.message);if(e.code==='field_conflict'){const loaded=await load();setError(e.message+(loaded?' · แสดงราคาเดิมล่าสุดแล้ว กรุณาตรวจและยืนยันใหม่':' · อ่านราคาเดิมล่าสุดไม่สำเร็จ กรุณาลองอีกครั้ง'));}}}
  finally{setBusy(false);render(x=>x+1);signalDraft(row.id);}
 }
 async function inspect(){setBusy(true);try{const r=await api('operations/'+d.operation.operation_id);if(r.status==='succeeded'&&r.result?.ok){await done();}else{setError('ยังยืนยันผลไม่ได้ เก็บรหัส '+d.operation.operation_id+' ให้ผู้ดูแลตรวจสอบ');}}catch(e){setError(e.message+' · เก็บรหัส '+d.operation.operation_id+' ห้ามส่งใหม่');}finally{setBusy(false);}}
 async function closePromo(p){
  const review=p.status==='needs_review',pending=p.status==='pending',after=p.revive_expired?p.original.sale_price:restoredPrice(p.original,localMinute(Date.now()/1000));
  const title=review?'ปิดรายการตรวจสอบ':pending?'ยกเลิกโปรที่รอเริ่ม':'จบโปรก่อนกำหนด';
  const message=review?'ปิดรายการนี้และคงราคาปัจจุบันไว้ ระบบจะไม่คืนราคาให้':pending?'ยกเลิกก่อนเริ่ม โดยไม่เปลี่ยนราคาสินค้า':'ระบบจะพยายามคืนราคาเป็น '+showValue(after,'sale_price')+' บาท พร้อมตารางเดิม หากข้อมูลยังตรงกัน';
  if(!await confirmChange(message,{title,confirmLabel:review?'ปิดรายการและคงราคา':pending?'ยืนยันยกเลิกโปร':'ยืนยันจบโปรและคืนราคา'}))return;
  setBusy(true);try{await api('products/'+row.id+'/temporary-sales/'+p.id+'/cancel',{confirmed:true});await load();onSaved(row.id,'sale_price',row.sale_price,row.revisions.sale_price);}catch(e){await load();setError(e.message+' · ตรวจสถานะล่าสุดก่อนทำต่อ');}finally{setBusy(false);}
 }

 const openPlans=(data?.items||[]).filter(p=>['pending','active','needs_review'].includes(p.status));
 const history=(data?.items||[]).filter(p=>!['pending','active','needs_review'].includes(p.status));
 const planDetails=p=>[h('small',{key:'restore'},'คืนเดิม '+showValue(p.original.sale_price,'sale_price')+' · '+showValue(p.original.sale_dates,'sale_dates')+(p.revive_expired?' · เลือกคืนโปรเดิมแม้หมดอายุ: ล้างวันหากหมดอายุเมื่อคืน':' · คืนตารางเดิมตามจริง')),h('small',{key:'message'},p.message)];
 const planTitle=p=>[h('span',{key:'status',className:'sdd-status '+p.status},promoLabels[p.status]||p.status),h('strong',{key:'price'},'ราคาโปร '+showValue(p.price,'sale_price')+' บาท'),h('small',{key:'dates',className:'sdd-history-dates'},promoTime(p.starts_at)+' → '+promoTime(p.ends_at))];
 return h('div',{className:'sdd-temporary'},h('div',{className:'sdd-temporary-layout'},
 h('section',{className:'sdd-promo-history','aria-label':'ประวัติโปรชั่วคราว'},h('h3',null,'โปรที่สิ้นสุดในรายการล่าสุด',data&&h('span',{className:'sdd-history-count'},history.length.toLocaleString('th-TH')+' รายการ')),
 h('div',{className:'sdd-history-scroll',tabIndex:0,role:'region','aria-label':'รายการประวัติโปรชั่วคราว'},!data&&h('p',{className:'sdd-plan-help'},readError?'ยังโหลดประวัติไม่ได้':'กำลังโหลดประวัติ…'),data&&!history.length&&h('p',{className:'sdd-plan-help'},'ยังไม่มีประวัติโปรชั่วคราว'),history.map(p=>h('details',{key:p.id,className:'sdd-promotion sdd-history-item'},h('summary',null,planTitle(p),h('span',{className:'sdd-history-more'},'ดูรายละเอียด')),h(RestorationCard,{plan:p,currentPrice:data?.current_price}),planDetails(p))))),
 h('section',{className:'sdd-promo-editor','aria-label':'จัดการโปรชั่วคราว'},h('h3',null,livePlan?'โปรชั่วคราวปัจจุบัน':'ตั้งโปรชั่วคราว'),
 data?.server_time&&h('p',{className:'sdd-last-loaded'},(readError?'ข้อมูลก่อนหน้า · ตรวจล่าสุด ':'ตรวจสถานะล่าสุด ')+promoTime(data.server_time)+' · ตรวจซ้ำเมื่อเปิดหน้านี้ทุก 30 วินาที'),openPlans.map(p=>h('div',{key:p.id,className:'sdd-promotion sdd-current-promotion'},planTitle(p),h(RestorationCard,{plan:p,currentPrice:data?.current_price,automation:data?.automation}),p.status==='needs_review'&&h('p',{className:'sdd-plan-help'},p.message),h('button',{disabled:busy||readError,onClick:()=>closePromo(p)},p.status==='needs_review'?'ปิดรายการและคงราคาปัจจุบัน':p.status==='pending'?'ยกเลิกโปรที่รอเริ่ม':'จบโปรก่อนกำหนด'))),
 h(livePlan?'details':'div',{className:'sdd-promo-reference'},livePlan&&h('summary',null,'ดูราคาและตารางเดิมที่เก็บไว้'),data?.baseline&&h('strong',null,'ราคาเดิมที่เก็บไว้ · ปกติ '+showValue((livePlan?.original||data.baseline).regular_price,'regular_price')+' · ราคาโปร '+showValue((livePlan?.original||data.baseline).sale_price,'sale_price')),h('div',{className:'sdd-original-schedule',role:'note'},h('div',{className:'sdd-original-schedule-head'},h('span',{className:'sdd-status '+originalState.className},originalState.label)),h('div',{className:'sdd-original-schedule-dates'},h('span',null,'เริ่ม '+(originalDates.split('|')[0]?promoTime(originalDates.split('|')[0]):'ไม่กำหนด')),h('span',null,'สิ้นสุด '+(originalDates.split('|')[1]?promoTime(originalDates.split('|')[1]):'ไม่กำหนด'))),h('small',null,'เลือกวันเริ่ม–สิ้นสุดของโปรชั่วคราวได้เอง โดยไม่เปลี่ยนวันโปรเดิม'))),
 busy&&!data&&h('p',{role:'status'},'กำลังอ่านราคาเดิมและประวัติโปร…'),
 data&&!livePlan&&h('div',{className:'sdd-plan-grid'},h('div',null,h('label',{className:'sdd-plan-field'},'ราคาโปรชั่วคราว (บาท)',h('input',{'aria-label':'ราคาโปรชั่วคราว #'+row.id,inputMode:'numeric',maxLength:19,value:displayPrice(d.price),disabled:busy||readError||d.state==='unknown'||priceReadonly,onChange:e=>editPrice(e,v=>change('price',v))})),h('div',{className:'sdd-plan-dates'},['start','end'].map((field,i)=>h('label',{className:'sdd-plan-field sdd-plan-date-field',key:field},i?'สิ้นสุดโปรชั่วคราว':'เริ่มโปรชั่วคราว',h(DateTimePicker,{id:'sdd-promo-'+row.id+'-'+field,label:(i?'สิ้นสุด':'เริ่ม')+'โปรชั่วคราว #'+row.id,value:d[field],defaultTime:i?'23:59':'00:00',disabled:busy||readError||d.state==='unknown'||priceReadonly,onChange:value=>change(field,value)})))),h('p',{className:'sdd-plan-help'},'หากเวลาเริ่มผ่านไปแล้ว ระบบจะพยายามเริ่มทันทีหลังยืนยัน · เขตเวลา '+(cfg.timezone||'UTC'))),
 h('div',null,canRevive(data.baseline,d.end)&&h('label',{className:'sdd-revive-choice'},h('input',{type:'checkbox',checked:!!d.revive,disabled:busy||readError||d.state==='unknown'||priceReadonly,onChange:e=>change('revive',e.target.checked)}),' หลังจบโปรชั่วคราว ให้กลับมาใช้ราคาโปรเดิมแม้หมดอายุแล้ว'),h(PlanSummary,{row:{...row,...data.baseline},price:d.price,dates:d.start+'|'+d.end,temporary:true,revive:!!d.revive&&canRevive(data.baseline,d.end)}),h('p',{className:'sdd-plan-help'},'ระบบเก็บราคาและตารางเดิมไว้เพื่อคืนหลังจบ ดูแผนและผลการคืนได้ในรายการโปรนี้'),h('div',{className:'sdd-plan-actions'},h('button',{className:'sdd-primary',disabled:busy||readError||d.state==='unknown'||priceReadonly,onClick:save},'ยืนยันตั้งโปรชั่วคราว'),d.state!=='unknown'&&h('button',{disabled:busy,onClick:()=>{d.price='';d.start='';d.end='';d.revive=false;d.state='clean';render(x=>x+1);signalDraft(row.id);}},'ล้างข้อมูลที่กรอก')))),
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
 return h('section',{className:'sdd-plan-summary','aria-label':'สรุปผลโปร'},h('strong',null,'ราคาโปรและแผนคืนราคา'),price!==''&&Number(price)>Number(restoredPrice(row,start||now))&&h('p',{className:'sdd-summary-warning'},'ราคาใหม่สูงกว่าราคาก่อนเริ่มตามตารางเดิม '+displayPrice(String(Number(price)-Number(restoredPrice(row,start||now))))) ,
 [['ก่อนเริ่มตามตารางเดิม',restoredPrice(row,start||now)],['ระหว่างโปร',price===''?'':price],['หลังจบตามตารางเดิม',after]].flatMap(([label,value],index)=>[h('div',{className:'sdd-plan-stage',key:label},h('span',null,label),h('strong',null,showValue(value,label==='ราคาปกติ'?'regular_price':'sale_price'))),index<2&&h('span',{className:'sdd-plan-arrow','aria-hidden':true,key:'arrow-'+index},'→')].filter(Boolean)),
 h('div',{className:'sdd-plan-context',role:'group','aria-label':'รายละเอียดราคาอ้างอิง วันโปรเดิม และการคืนราคา'},h('span',null,'ราคาปกติอ้างอิง '+showValue(reference.price,'regular_price')+' บาท · ราคานี้ยังไม่รวมคูปองหรือส่วนลดในตะกร้า'),h('span',null,showValue(dates,'sale_dates')+' · '+(cfg.timezone||'UTC')),h('strong',{className:'sdd-return-plan'},'↩ ตั้งให้กลับเป็น '+showValue(after,'sale_price')+' บาทหลังจบ'),h('details',null,h('summary',null,'ดูเงื่อนไขการคืนราคา'),h('span',null,revive?'คืนโปรเดิมและล้างวันเริ่ม–จบ เพื่อใช้โปรเดิมต่อ':'ระบบเก็บตารางเดิมไว้ หากโปรเดิมหมดอายุแล้วจะใช้ราคาปกติ'),h('span',null,'หากมีการแก้ราคาแทรก ระบบจะหยุดให้ตรวจสอบ และงานอัตโนมัติอาจทำให้คืนราคาช้ากว่ากำหนด'))));
}

function PromotionPanel({row,onSaved,onClose}){
 return h('section',{id:'sdd-promotion-panel-'+row.id,tabIndex:-1,className:'sdd-promotion-panel','data-sdd-focus-field':'temporary_sale','aria-label':'จัดการโปร #'+row.id},h('div',{className:'sdd-panel-head'},h('div',null,h('h2',null,'จัดการโปร · ',row.name),h('small',null,'#'+row.id+' · '+(row.sku||'ไม่มี SKU')+' · ราคาปกติ '+showValue(row.regular_price,'regular_price')+' / ราคาโปรที่บันทึก '+showValue(row.sale_price,'sale_price'))),h('button',{onClick:onClose,'aria-label':'ปิดแผงจัดการโปร '+row.name},'ปิดแผง ×')),
 h('aside',{className:'sdd-promo-product-card'},row.thumbnail_url&&h('img',{src:row.thumbnail_url,alt:row.name}),h('span',{className:'sdd-dashboard-eyebrow'},'สินค้าที่กำลังจัดการ'),h('h3',null,row.name),h('p',null,'SKU: '+(row.sku||'ไม่ระบุ')+' · #'+row.id),h('span',{className:'sdd-status active'},'เผยแพร่แล้ว'),h('div',{className:'sdd-promo-product-price'},h('span',null,'ราคาปกติอ้างอิง'),h('strong',null,showValue(row.regular_price,'regular_price')+' บาท')),h('p',{className:'sdd-plan-help'},'ราคาโปรยังอาจได้รับส่วนลดเพิ่มเติมจากกฎในตะกร้าหรือคูปอง')),cfg.canSettings?h(TemporarySale,{row,onSaved}):h('p',{className:'sdd-plan-help'},'เฉพาะผู้ดูแลระบบสามารถตั้งโปรชั่วคราวได้'));
}
function Confirmation({request,onDone}){
 const dialog=useRef(null),cancel=useRef(null);
 useEffect(()=>{dialog.current.showModal();cancel.current.focus();return()=>{if(dialog.current?.open)dialog.current.close();};},[]);
 return h('dialog',{ref:dialog,className:'sdd-confirmation','aria-label':'ยืนยันการเปลี่ยนแปลง',onCancel:e=>{e.preventDefault();onDone(false);}},h('h2',null,request.title||'ยืนยันการเปลี่ยนแปลง'),h('p',null,request.text),h('div',{className:'sdd-plan-actions'},h('button',{ref:cancel,onClick:()=>onDone(false)},'ยกเลิก'),h('button',{className:'sdd-primary',onClick:()=>onDone(true)},request.confirmLabel||'ยืนยันบันทึก')));
}

function VariablePriceSummary({summary}){
 const value=summary?.regular_min==null?'—':showValue(summary.regular_min,'regular_price')+(summary.regular_max!==summary.regular_min?' – '+showValue(summary.regular_max,'regular_price'):'');
 return h('div',{className:'sdd-variable-price-summary'},h('strong',null,value),h('small',null,summary?.count?'ช่วงราคาจาก '+summary.count+' ตัวเลือก':'ยังไม่มีข้อมูลราคา'));
}
function VariableSaleSummary({summary}){
 const count=summary?.sale_count||0,total=summary?.count||0;
 return count?h('span',{className:'sdd-variation-sale-summary'},'มีราคาโปร '+count+' / '+total+' ตัวเลือก'):h('span',{className:'sdd-variation-empty','aria-label':'ไม่มีราคาโปร'},'—');
}
function VariableStockSummary({summary}){
 const counts=summary?.stock_counts||{},parts=[['instock','มีสินค้า','instock'],['outofstock','สินค้าหมด','outofstock'],['onbackorder','สั่งจองได้','onbackorder']].filter(([key])=>(counts[key]||0)>0);
 return parts.length?h('div',{className:'sdd-variation-stocks','aria-label':'สรุปสถานะสต็อกตัวเลือก'},parts.map(([key,label,className])=>h('span',{key,className:'sdd-variation-stock '+className},label+' '+counts[key]))):h('span',{className:'sdd-variation-stock-empty'},summary?.count?'ไม่มีข้อมูลสต็อก':'ไม่มีตัวเลือก');
}

function ProductRow({row,onSaved,open,onExpand,promoId,onPromo,scope,onAudit,onOpen}){
 const parent=row.type==='variable',summary=row.variation_summary,promoOpen=promoId===row.id;
 const presence=workspacePresence.get(row.id)||[];
 const promoStatus=row.temporary_sale?h('span',{className:'sdd-status '+row.temporary_sale.status},promoLabels[row.temporary_sale.status]):row.sale_schedule&&row.sale_schedule.state!=='none'?h('span',{className:'sdd-status '+({active:'active',future:'pending',expired:'expired',invalid:'needs_review'}[row.sale_schedule.state]||'')},({active:'โปรกำลังใช้',future:'โปรรอเริ่ม',expired:'โปรเดิมหมดอายุ',invalid:'ตรวจวันโปร'})[row.sale_schedule.state]):null;
 return h(wp.element.Fragment,null,h('tr',{'data-product-id':row.id,className:(row.stock_status==='outofstock'?'sdd-out ':row.stock_status==='onbackorder'?'sdd-backorder ':'')+(row.parent_id?'sdd-child ':'')+(promoOpen?'sdd-row-active ':'')+(parent&&open?'sdd-variable-open':'')},
 h('td',{className:'sdd-thumbnail-cell'},row.thumbnail_url?h('img',{src:row.thumbnail_url,alt:'',width:40,height:40,loading:'lazy'}):h('span',{className:'sdd-thumb'},'—')),
 h('td',{className:'sdd-product'},parent&&h('button',{className:'sdd-expand','aria-expanded':open,'aria-label':(open?'ยุบ':'ขยาย')+'ตัวเลือก #'+row.id,onClick:onExpand},open?'− ยุบตัวเลือก':'+ ดูตัวเลือก ('+(summary?.count||0)+')'),' ',row.edit_url?h('a',{id:'sdd-product-name-'+row.id,href:row.edit_url,target:'_blank',rel:'noopener noreferrer'},row.name):h('span',{id:'sdd-product-name-'+row.id},row.name),
 h('small',null,h('code',null,row.sku||'ไม่มี SKU'),' · #'+row.id+(row.brands.length?' · '+row.brands.join(', '):'')+(summary?' · '+summary.count+' ตัวเลือก':'')),row.attributes&&h('small',{className:'sdd-variation-attributes'},row.attributes),h('div',{className:'sdd-mobile-product-summary'},h('span',null,'ราคาปกติ ',h('b',null,parent?showValue(summary?.regular_min??'','regular_price'):showValue(row.regular_price,'regular_price'))),h('span',null,parent?'มีราคาโปร '+(summary?.sale_count||0)+' ตัวเลือก':'ราคาโปรที่บันทึก ',!parent&&h('b',null,showValue(row.sale_price,'sale_price'))),h('span',null,stock[row.stock_status]||row.stock_status)),row.latest_change&&h('small',{className:'sdd-latest-change'},'แก้ราคาล่าสุด '+promoTime(Date.parse(row.latest_change)/1000)),cfg.canAudit&&h('button',{className:'sdd-audit-row-link',onClick:()=>onAudit(row.id)},'ประวัติราคา'),
 presence.length>0&&h('small',{className:'sdd-presence',role:'status'},presence.map(p=>(p.own_user?'อีกแท็บของคุณ':p.actor)+' กำลังแก้'+(labels[p.field]||'โปรชั่วคราว')).join(' · ')),row.readonly_reasons.length>0&&h('details',null,h('summary',null,'ข้อจำกัดการแก้ไข'),h('small',{className:'sdd-reason'},row.readonly_reasons.join(' · ')),row.edit_url&&h('a',{className:'sdd-wc-link',href:row.edit_url,target:'_blank',rel:'noopener noreferrer'},'แก้ไขใน WooCommerce ↗'))),
 ['regular_price','sale_price','stock_status'].map(field=>h('td',{key:field,'data-label':labels[field],className:(field==='regular_price'||field==='sale_price'?'sdd-price-cell':field==='stock_status'?'sdd-stock-cell':'')+(parent?' sdd-aggregate-cell':'')},parent?field==='regular_price'?h(VariablePriceSummary,{summary}):field==='sale_price'?h(VariableSaleSummary,{summary}):h(VariableStockSummary,{summary}):h(Cell,{row,field,onSaved}))),
 h('td',{className:'sdd-promo-status'},promoStatus||h('span',{className:'sdd-empty-status','aria-label':'ไม่มีโปรโมชัน'},'—'),row.temporary_sale?.status==='needs_review'&&h('small',{className:'sdd-error'},row.temporary_sale.message)),
 h('td',{className:'sdd-action-cell'},!parent&&h('button',{className:'sdd-mobile-edit',onClick:()=>onOpen(row.id,'regular_price')},'เปิดแก้ไขสินค้า →'),!parent&&['simple','variation'].includes(row.type)?h('button',{id:'sdd-promo-toggle-'+row.id,'aria-expanded':promoOpen,'aria-controls':promoOpen?'sdd-promotion-panel-'+row.id:undefined,'aria-label':'จัดการโปร #'+row.id,'aria-describedby':'sdd-product-name-'+row.id,onClick:()=>onPromo(promoOpen?null:row.id)},'จัดการโปร'):h('span',{className:'sdd-empty-status','aria-hidden':true},'—'))),
 promoOpen&&h('tr',{className:'sdd-promotion-row','data-promotion-for':row.id},h('td',{colSpan:7},h(PromotionPanel,{row,onSaved,onClose:()=>{onPromo(null);requestAnimationFrame(()=>document.getElementById('sdd-promo-toggle-'+row.id)?.focus());}}))));
}
function ProductGroup({row,context,onSaved,promoId,onPromo,onAudit,onOpen}){
 const [open,setOpen]=useState(false),[page,setPage]=useState(1),[size,setSize]=useState(20),[all,setAll]=useState(false),[data,setData]=useState({items:[],total:0,pages:0}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const contextKey=JSON.stringify(context); const filterKey=JSON.stringify({...context,tick:0});
 useEffect(()=>{const receive=e=>setData(d=>({...d,items:mergeLiveRows(d.items,e.detail)}));window.addEventListener('sdd:workspace-sync',receive);return()=>window.removeEventListener('sdd:workspace-sync',receive);},[]);
 useEffect(()=>{setPage(1);setAll(false);},[filterKey]);
 useEffect(()=>{let live=true;if(!open||row.type!=='variable')return;setBusy(true);setError('');setData({items:[],total:0,pages:0});
  const params=new URLSearchParams({...context,page,per_page:size,all:all?'1':'0'});params.delete('tick');
  api('products/'+row.id+'/variations?'+params).then(r=>{if(live)setData(r);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};
 },[open,row.id,contextKey,page,size,all]);
 function saved(id,field,value,revision){setData(d=>({...d,items:d.items.map(r=>r.id===id?{...r,[field]:value,revisions:{...r.revisions,[field]:revision}}:r)}));onSaved(id,field,value,revision);}
 return h(wp.element.Fragment,null,h(ProductRow,{row,onSaved,promoId,onPromo,scope:context.scope,onAudit,onOpen,open,onExpand:()=>setOpen(v=>!v)}),open&&row.type==='variable'&&h(wp.element.Fragment,null,
 h('tr',{className:'sdd-child-tools'},h('td',{colSpan:7},h('div',{className:'sdd-child-toolbar'},h('strong',null,'ตัวเลือกสินค้า · '+row.name),h('span',null,all?'แสดงทั้งหมด — อาจอยู่นอกคำค้น/สถานะที่กรอง':'แสดงเฉพาะตัวเลือกที่ตรงคำค้น/ตัวกรอง'),h('button',{onClick:()=>{setAll(v=>!v);setPage(1);}},all?'แสดงเฉพาะที่ตรงตัวกรอง':'แสดงตัวเลือกทั้งหมด'),h('span',null,busy?'กำลังโหลด…':data.total+' ตัวเลือก'),h('button',{disabled:busy||page<=1,onClick:()=>setPage(v=>v-1),'aria-label':'ตัวเลือกก่อนหน้า #'+row.id},'←'),h('span',null,'หน้า '+page+' / '+Math.max(1,data.pages)),h('button',{disabled:busy||page>=data.pages,onClick:()=>setPage(v=>v+1),'aria-label':'ตัวเลือกถัดไป #'+row.id},'→'),h('select',{'aria-label':'จำนวนตัวเลือกต่อหน้า #'+row.id,value:size,onChange:e=>{setSize(Number(e.target.value));setPage(1);}},[20,50,100].map(n=>h('option',{key:n,value:n},n+' / หน้า')))),error&&h('p',{role:'alert',className:'sdd-error'},error))),
 data.items.map(child=>h(ProductRow,{key:child.id,row:child,onSaved:saved,promoId,onPromo,scope:context.scope,onAudit,onOpen})),!busy&&!error&&!data.items.length&&h('tr',null,h('td',{colSpan:7,className:'sdd-empty'},'ไม่พบตัวเลือกที่ตรงเงื่อนไข')),h('tr',{className:'sdd-child-footer'},h('td',{colSpan:7},h('span',null,'สิ้นสุดตัวเลือก · '+row.name),h('button',{'aria-label':'ปิดกลุ่มตัวเลือก #'+row.id,onClick:()=>setOpen(false)},'ยุบตัวเลือก')))));
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
  week.dates.map((day,col)=>day?h('button',{key:day,className:'sdd-timeline-date'+(day===selected?' is-selected':'')+(day===today?' is-today':''),style:{gridColumn:col+1,gridRow:'1 / span '+(week.lanes+2)},'aria-pressed':day===selected,'aria-label':day+(busy?' กำลังโหลด':error?' อ่านข้อมูลไม่ได้':' เลือกดูโปรในวันนี้'),onClick:()=>onSelect(day)},h('span',null,Number(day.slice(-2)))):h('div',{key:'empty'+col,className:'sdd-timeline-outside',style:{gridColumn:col+1,gridRow:'1 / span '+(week.lanes+2)}})),
  week.segments.map(({item,start,end,lane,column})=>h('button',{key:item.promotion_id,className:'sdd-timeline-bar sdd-calendar-state-'+item.status,style:{gridColumn:column+' / span '+(end-start+1),gridRow:lane+2},title:item.name+' · '+promoLabels[item.status]+' · '+promoTime(item.starts_at)+' → '+promoTime(item.ends_at),onClick:()=>onSelect(month+'-'+String(start).padStart(2,'0'))},h('span',{className:'sdd-timeline-bar-name'},item.name),h('span',{className:'sdd-timeline-bar-meta'},showValue(item.price,'sale_price')+' บาท · '+(promoLabels[item.status]||item.status)))),
  week.hidden>0&&h('button',{className:'sdd-timeline-overflow',style:{gridColumn:'1 / -1',gridRow:week.lanes+2},onClick:onList},'อีก '+week.hidden+' รายการในสัปดาห์นี้ · เปิดรายการทั้งหมด')
 )));
}
function PromotionCalendar({onClose,onProduct,tick,month:controlledMonth,onMonthChange,options={},onOptions}){
 const today=datePart(String(Math.floor(Date.now()/1000)));
 const [fallbackMonth,setFallbackMonth]=useState(today.slice(0,7));
 const month=controlledMonth||fallbackMonth,setMonth=onMonthChange||setFallbackMonth;
 const [localSelected,setLocalSelected]=useState(month===today.slice(0,7)?today:month+'-01'),[data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const selected=options.calendarSelected||localSelected,setSelected=value=>onOptions?onOptions({calendarSelected:value}):setLocalSelected(value);
 useEffect(()=>{let current=true;setBusy(true);setError('');setData(null);api('promotion-calendar?'+new URLSearchParams({month})).then(r=>{if(current)setData(r);}).catch(e=>{if(current)setError(e.message);}).finally(()=>{if(current)setBusy(false);});return()=>{current=false;};},[month,tick]);
 useEffect(()=>{if(selected.slice(0,7)!==month)setSelected(month+'-01');},[month]);
 const [year,m]=month.split('-').map(Number),first=new Date(Date.UTC(year,m-1,1)),days=new Date(Date.UTC(year,m,0)).getUTCDate(),offset=first.getUTCDay();
 const monthName=new Intl.DateTimeFormat('th-TH',{timeZone:'UTC',month:'long',year:'numeric'}).format(first);
 const shift=delta=>{const next=new Date(Date.UTC(year,m-1+delta,1));const value=next.getUTCFullYear()+'-'+String(next.getUTCMonth()+1).padStart(2,'0');setMonth(value);setSelected(value+'-01');};
 const applies=(item,day)=>datePart(String(item.starts_at))<=day&&datePart(String(item.ends_at))>=day;
 const [localSearch,setLocalSearch]=useState(''),[localStatus,setLocalStatus]=useState(''),[localView,setLocalView]=useState('month');
 const calendarSearch=options.calendarSearch??localSearch,calendarStatus=options.calendarStatus??localStatus,calendarView=options.calendarView||localView;
 const setCalendarSearch=value=>onOptions?onOptions({calendarSearch:value}):setLocalSearch(value),setCalendarStatus=value=>onOptions?onOptions({calendarStatus:value}):setLocalStatus(value),setCalendarView=value=>onOptions?onOptions({calendarView:value}):setLocalView(value);
 const items=(data?.items||[]).filter(item=>(!calendarStatus||item.status===calendarStatus)&&(!calendarSearch||(item.name+' '+item.id+' '+(item.sku||'')).toLocaleLowerCase().includes(calendarSearch.toLocaleLowerCase()))),selectedItems=items.filter(item=>applies(item,selected));
 const eventLabel=(item,day)=>{const start=datePart(String(item.starts_at))===day,end=datePart(String(item.ends_at))===day;return start&&end?'กำหนดเริ่มและจบ':start?'กำหนดเริ่ม':end?'กำหนดจบ':'อยู่ในช่วงที่ตั้งไว้';};
 return h('section',{className:'sdd-promo-calendar'},h('div',{className:'sdd-calendar-page-head'},h('div',null,h('span',{className:'sdd-dashboard-eyebrow'},'วางแผนโปรโมชัน'),h('h1',null,'ปฏิทินโปรชั่วคราว'),h('p',null,'เฉพาะโปรชั่วคราวในปลั๊กอินนี้ · 1 รายการคือสินค้า หรือตัวเลือกสินค้า 1 ตัว')),h('button',{onClick:onClose},'← กลับไปจัดการสินค้า')),
 h('div',{className:'sdd-calendar-filters'},h('label',null,'ค้นหาโปร',h('input',{value:calendarSearch,onChange:e=>setCalendarSearch(e.target.value),placeholder:'ชื่อสินค้า, SKU หรือ ID'})),h('label',null,'สถานะปัจจุบัน',h('select',{value:calendarStatus,onChange:e=>setCalendarStatus(e.target.value)},h('option',{value:''},'ทุกสถานะ'),Object.entries(promoLabels).map(([id,label])=>h('option',{key:id,value:id},label)))),h('div',{className:'sdd-view-switch'},[['month','เดือน'],['list','รายการ']].map(([id,label])=>h('button',{key:id,'aria-pressed':calendarView===id,onClick:()=>setCalendarView(id)},label)))),
 h('div',{className:'sdd-calendar-layout'},h('section',{className:'sdd-calendar-card'},h('div',{className:'sdd-calendar-toolbar'},h('button',{onClick:()=>shift(-1),disabled:month==='2000-01','aria-label':'เดือนก่อนหน้า'},'←'),h('h2',{'aria-live':'polite'},monthName),h('button',{onClick:()=>shift(1),disabled:month==='2099-12','aria-label':'เดือนถัดไป'},'→'),h('button',{onClick:()=>{setMonth(today.slice(0,7));setSelected(today);}},'วันนี้')),
 h('p',{className:'sdd-calendar-note'},'เวลาตามเว็บไซต์ '+(cfg.timezone||'UTC')+' · วันในปฏิทินเป็นช่วงที่ตั้งไว้ สถานะบอกผลล่าสุด'),h('div',{className:'sdd-calendar-legend'},[['pending','รอเริ่ม'],['active','กำลังใช้'],['needs_review','ต้องตรวจสอบ / เลยเวลาเริ่ม'],['restored','สิ้นสุด / ปิดแล้ว']].map(([key,label])=>h('span',{key},h('i',{className:'sdd-calendar-dot '+key,'aria-hidden':true}),label))),
 busy&&h('p',{role:'status'},'กำลังโหลดปฏิทิน…'),error&&h('p',{className:'sdd-error',role:'alert'},error),data?.limited&&h('p',{className:'sdd-dashboard-limit'},'แสดงจาก 200 โปรแรกในเดือนนี้ ยังมีรายการอื่นที่ไม่ได้แสดง'),
 h('div',{className:'sdd-month-view'+(calendarView==='list'?' is-hidden':'')},h(CalendarMonth,{month,items,selected,today,busy,error,onSelect:setSelected,onList:()=>setCalendarView('list')}))),
 h('section',{className:'sdd-month-agenda'+(calendarView==='list'?' is-visible':''),'aria-label':'รายการโปรในเดือน'},h('h2',null,'รายการโปร · '+monthName),busy?h('p',{role:'status'},'กำลังโหลด…'):error?h('p',null,'อ่านรายการไม่ได้ กรุณารีเฟรช'):!items.length?h('p',null,'ไม่พบโปรที่ตรงเงื่อนไขในเดือนนี้'):h('ul',null,items.map(item=>h('li',{key:item.promotion_id},h('span',{className:'sdd-status '+item.status},promoLabels[item.status]||item.status),h('button',{className:'sdd-calendar-product',onClick:()=>onProduct(item.id)},item.name),h('p',null,'ราคาโปร '+showValue(item.price,'sale_price')+' บาท'),h('small',null,promoTime(item.starts_at)+' → '+promoTime(item.ends_at)))))),
 h('section',{className:'sdd-calendar-details'},h('h2',null,'โปรวันที่ '+selected.split('-').reverse().join('/')),h('p',{className:'sdd-calendar-note'},'กดชื่อสินค้าเพื่อเปิดในตารางจัดการ'),busy?h('p',null,'กำลังโหลด…'):error?h('p',null,'ไม่สามารถแสดงรายการได้'):selectedItems.length?h('ul',null,selectedItems.map(item=>h('li',{key:item.promotion_id},h('span',{className:'sdd-calendar-detail-event'},eventLabel(item,selected)),h('span',{className:'sdd-status '+item.status},promoLabels[item.status]||item.status),h('button',{className:'sdd-calendar-product',onClick:()=>onProduct(item.id)},item.name),h('small',null,'#'+item.id+(item.sku?' · '+item.sku:'')),h('p',null,'ราคาโปร '+showValue(item.price,'sale_price')+' บาท'),h('small',null,'กำหนด '+promoTime(item.starts_at)+' → '+promoTime(item.ends_at)),item.message&&h('p',{className:'sdd-calendar-message'},item.message)))):h('p',{className:'sdd-dashboard-empty'},'ไม่มีโปรในวันที่เลือก'),h('p',{className:'sdd-calendar-note'},'วันเริ่มและสิ้นสุดเป็นเวลาที่ตั้งไว้ สถานะบอกผลล่าสุด'))));
}
function DashboardGroup({title,subtitle,group,render,empty,tone='blue',wide=false}){
 const [visible,setVisible]=useState(5);
 const total=group.items.length;
 return h('section',{className:'sdd-dashboard-card sdd-dashboard-card--'+tone+(wide?' sdd-dashboard-card--wide':'')},
  h('div',{className:'sdd-dashboard-card-header'},h('div',null,h('h2',null,title),h('p',{className:'sdd-dashboard-card-subtitle'},subtitle)),h('span',{className:'sdd-dashboard-count','aria-label':'แสดง '+total+' รายการ'},total)),
  group.limited&&h('p',{className:'sdd-dashboard-limit'},'แสดงสูงสุด 100 รายการแรก ยังมีรายการอื่นที่ไม่ได้แสดง'),
  total?h(wp.element.Fragment,null,h('ul',{className:'sdd-dashboard-list'},group.items.slice(0,visible).map(render)),visible<total&&h('button',{className:'sdd-dashboard-more',onClick:()=>setVisible(n=>Math.min(n+10,total))},'แสดงเพิ่มอีก '+Math.min(10,total-visible)+' รายการ'),visible>5&&h('button',{className:'sdd-dashboard-more',onClick:()=>setVisible(5)},'ย่อรายการ')):h('p',{className:'sdd-dashboard-empty'},h('span',{'aria-hidden':true},'✓'),group.limited?'ไม่พบรายการที่มีสิทธิ์ดูใน 100 รายการแรก':empty));
}
function DashboardTasks({data,onProduct,date,selectedTab,onTabChange}){
 const [localTab,setLocalTab]=useState('problems'),[visible,setVisible]=useState(10);
 const tab=selectedTab||localTab,setTab=value=>{setLocalTab(value);onTabChange?.(value);};
 const groups={problems:data.problems.items.map(item=>({...item,kind:'problems',label:'ต้องตรวจสอบ',detail:item.message})),upcoming:data.upcoming.items.map(item=>({...item,kind:'upcoming',label:item.event_type==='start'?'ใกล้เริ่ม':'ใกล้จบ',detail:(item.event_type==='start'?'กำหนดเริ่ม ':'กำหนดจบ ')+date(item.at)})),changes:data.changes.items.map(item=>({...item,kind:'changes',label:'ราคาลดลง',detail:(labels[item.field]||item.field)+' '+displayPrice(item.old_value)+' → '+displayPrice(item.new_value)+' บาท · '+date(item.at)}))};
 const rows=tab==='all'?Object.values(groups).flat():groups[tab];
 return h('section',{className:'sdd-task-board',id:'sdd-task-board'},h('div',{className:'sdd-task-board-heading'},h('div',null,h('span',{className:'sdd-dashboard-eyebrow'},'ติดตามและดำเนินการ'),h('h2',null,'รายการงานของร้าน')),h('span',{className:'sdd-task-total'},rows.length+' รายการที่โหลดได้')),
 h('div',{className:'sdd-task-tabs','aria-label':'ประเภทงาน'},[['problems','ต้องตรวจสอบ'],['upcoming','ใกล้เริ่ม / จบ'],['changes','ราคาลดลง'],['all','ทั้งหมด']].map(([id,label])=>h('button',{key:id,'aria-pressed':tab===id,onClick:()=>{setTab(id);setVisible(10);}},label,h('span',null,id==='all'?Object.values(groups).flat().length:groups[id].length)))),
 Object.entries({problems:data.problems,upcoming:data.upcoming,changes:data.changes}).some(([key,group])=>group.limited&&(tab==='all'||tab===key))&&h('p',{className:'sdd-dashboard-limit'},'ข้อมูลแต่ละประเภทแสดงไม่เกิน 100 รายการแรก ตัวเลขนี้ไม่ใช่ยอดทั้งหมด'),
 !rows.length?h('div',{className:'sdd-task-empty'},h('span',{'aria-hidden':true},'✓'),h('strong',null,'ไม่มีรายการในหมวดนี้'),h('p',null,'เลือกหมวดอื่นหรือปรับช่วงเวลาที่ต้องการดู')):h('div',{className:'sdd-task-table-wrap'},h('table',{className:'sdd-task-table'},h('thead',null,h('tr',null,['สินค้า','สถานะงาน','รายละเอียด','ดำเนินการ'].map(label=>h('th',{key:label,scope:'col'},label)))),h('tbody',null,rows.slice(0,visible).map((item,index)=>h('tr',{key:item.kind+':'+item.id+':'+index},h('td',{'data-label':'สินค้า'},h('button',{className:'sdd-dashboard-product',onClick:()=>onProduct(item.id)},item.name),h('small',null,'#'+item.id+(item.sku?' · '+item.sku:''))),h('td',{'data-label':'สถานะงาน'},h('span',{className:'sdd-task-badge '+item.kind},item.label)),h('td',{'data-label':'รายละเอียด'},item.detail),h('td',{'data-label':'ดำเนินการ'},h('button',{className:'sdd-task-action',onClick:()=>onProduct(item.id)},item.kind==='problems'?'ตรวจสอบโปร →':'เปิดสินค้า →'))))))),visible<rows.length&&h('button',{className:'sdd-dashboard-more',onClick:()=>setVisible(n=>n+10)},'แสดงเพิ่มอีก '+Math.min(10,rows.length-visible)+' รายการ'));
}
function Dashboard({onClose,onProduct,onSettings,tick,options={},onOptions}){
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
 data.problems.items.length>0&&h('div',{className:'sdd-attention-banner',role:'status'},h('span',{className:'sdd-attention-icon','aria-hidden':true},'!'),h('div',null,h('strong',null,'มีโปรที่ควรตรวจสอบ '+data.problems.items.length+' รายการ'+(data.problems.limited?'ขึ้นไป':'')),h('p',null,'บางรายการหยุดทำงานหรือเลยกำหนด เริ่มตรวจจากรายการงานด้านล่าง')),h('a',{href:'#sdd-task-board'},'ดูรายการที่ต้องตรวจ →')),
 h('div',{className:'sdd-overview-stats'},[['ต้องตรวจสอบ',data.problems.items.length,'red',data.problems.limited?'แสดง 100 รายการแรก':'โปรที่ควรจัดการก่อน'],['ใกล้เริ่มหรือจบ',data.upcoming.items.length,'blue','ตามช่วงเวลาที่เลือก'],['ราคาลดถึงเกณฑ์',data.changes.items.length,'amber','เหตุการณ์ใน 7 วันล่าสุด'],['งานระบบที่ควรตรวจ',data.jobs.length,'violet','ตรวจรายละเอียดด้านล่าง']].map(([label,count,tone,note])=>h('div',{key:label,className:'sdd-overview-stat '+tone},h('span',null,label),h('strong',null,count),h('small',null,note)))),
 h('div',{className:'sdd-dashboard-grid sdd-dashboard-workspace'},h(DashboardTasks,{data,onProduct,date,selectedTab:options.dashboardTab,onTabChange:tab=>onOptions?.({dashboardTab:tab})}),
 h('section',{className:'sdd-dashboard-card sdd-dashboard-card--blue sdd-dashboard-jobs'},h('div',{className:'sdd-dashboard-card-header'},h('div',null,h('h2',null,'สถานะงานอัตโนมัติ'),h('p',{className:'sdd-dashboard-card-subtitle'},'ตรวจงานเบื้องหลัง เช่น การเริ่มและจบโปร')),h('span',{className:'sdd-dashboard-count'},data.jobs.length)),data.jobs.length?h('ul',{className:'sdd-dashboard-list'},data.jobs.map(j=>h('li',{key:j.job,className:'sdd-dashboard-job'},h('strong',null,jobs[j.job]||j.job),h('div',{className:'sdd-dashboard-detail'},j.next_at?'ถึงเวลาทำงานแล้วเมื่อ '+date(j.next_at)+' แต่ยังพบงานค้างอยู่':'ไม่พบกำหนดเวลาทำงาน')))):h('p',{className:'sdd-dashboard-empty'},h('span',{'aria-hidden':true},'✓'),'ไม่พบงานที่เลยกำหนดหรือไม่มีกำหนดเวลา'),h('div',{className:'sdd-dashboard-job-note'},h('strong',null,'รายการที่ยังไม่ทราบผล'),h('p',null,data.operations.state==='unavailable'?'ตรวจรายการไม่สำเร็จ กรุณาลองรีเฟรช':data.operations.count?(data.operations.at_least?'อย่างน้อย ':'')+data.operations.count+' รายการ · ตรวจผลก่อนทำรายการเดิมซ้ำ':'ไม่มีรายการที่รอตรวจ')),h('p',{className:'sdd-dashboard-caption'},'การมีกำหนดเวลาไม่ได้ยืนยันว่างานสำเร็จ หากพบปัญหาให้ตรวจรายละเอียดในหน้าตั้งค่า'),h('button',{className:'sdd-dashboard-more',onClick:onSettings},'ดูสถานะระบบในการตั้งค่า')))));
}
function collectPendingDrafts(fields,promotions){
 return [...[...fields.entries()].filter(([,d])=>d.state!=='clean').map(([key,d])=>({id:key.split(':')[0],field:key.split(':')[1],state:d.state})),...[...promotions.entries()].filter(([,d])=>d.state!=='clean').map(([id,d])=>({id,field:'temporary_sale',state:d.state}))];
}
function readWorkspaceLocation(search){
 const q=new URLSearchParams(search),get=key=>q.get('sdd_'+key)||'',id=v=>/^[1-9][0-9]{0,17}$/.test(v)?v:'';
 const one=(key,values,fallback)=>values.includes(get(key))?get(key):fallback;
 return {view:one('view',['products','dashboard','calendar','setup'],'products'),search:get('search').slice(0,200),brand:id(get('brand')),status:one('stock',['instock','outofstock','onbackorder'],''),source:one('source',['new_promotion'],''),promotionPost:id(get('article')),promotion:one('promotion',['none','current','future','expired','review'],''),page:/^[1-9][0-9]{0,5}$/.test(get('page'))?Number(get('page')):1,size:[20,50,100].includes(Number(get('size')))?Number(get('size')):50,scope:one('scope',['all','recent'],'all'),orderby:one('sort',['name','sku','regular_price'],'name'),order:one('order',['asc','desc'],'asc'),month:/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(get('month'))?get('month'):datePart(String(Math.floor(Date.now()/1000))).slice(0,7),product:id(get('product')),field:one('field',['regular_price','sale_price','stock_status','temporary_sale'],'temporary_sale'),dashboardHours:one('hours',['24','168'],'24'),dashboardThreshold:one('threshold',['10','20','30','50'],'30'),dashboardTab:one('task',['problems','upcoming','changes','all'],'problems'),calendarSearch:get('calendar_search').slice(0,200),calendarStatus:one('calendar_status',['pending','active','needs_review','restored','cancelled','missed'],''),calendarView:one('calendar_view',['month','list'],'month'),calendarSelected:/^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(get('day'))?get('day'):''};
}
function workspaceOptions(r){return Object.fromEntries(['dashboardHours','dashboardThreshold','dashboardTab','calendarSearch','calendarStatus','calendarView','calendarSelected'].map(key=>[key,r[key]]));}
function workspaceQuery(search,state){
 const q=new URLSearchParams(search);[...q.keys()].filter(key=>key.startsWith('sdd_')).forEach(key=>q.delete(key));
 const fields={view:state.view,search:state.search,brand:state.brand,stock:state.status,source:state.source,article:state.promotionPost,promotion:state.promotion,page:state.page,size:state.size,scope:state.scope,sort:state.orderby,order:state.order,month:state.month,product:state.product,field:state.product?state.field:'',hours:state.dashboardHours,threshold:state.dashboardThreshold,task:state.dashboardTab,calendar_search:state.calendarSearch,calendar_status:state.calendarStatus,calendar_view:state.calendarView,day:state.calendarSelected};
 Object.entries(fields).forEach(([key,value])=>{if(value!==''&&value!=null)q.set('sdd_'+key,String(value));});return q.toString();
}
function DirectProduct({id,field,onClose,onSaved,onAudit,tick}){
 const [row,setRow]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[loadedAt,setLoadedAt]=useState('');
 const root=useRef(null);
 useEffect(()=>{let alive=true;setBusy(true);setError('');api('products/'+id).then(result=>{if(alive){setRow(result);setLoadedAt(new Date().toISOString());}}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};},[id,tick,retry]);
 useEffect(()=>{if(!row||busy||error)return;const el=field==='temporary_sale'?root.current?.querySelector('[data-sdd-focus-field="temporary_sale"]'):root.current?.querySelector('[data-sdd-field="'+field+'"]');const target=field==='temporary_sale'?el:el?.disabled?el.closest('.sdd-cell')?.querySelector('button:not(:disabled)'):el?.matches('input,select')?el:el?.querySelector('input,button');target?.focus();el?.scrollIntoView({block:'nearest',behavior:'smooth'});},[id,field,!!row,busy,error]);
 return h('section',{className:'sdd-direct-product',ref:root,'aria-label':'พื้นที่แก้ไขสินค้า'},h('div',{className:'sdd-direct-heading'},h('button',{onClick:onClose},'← กลับรายการเดิม'),h('span',null,'สินค้า #'+id+(row?.parent_id?' · ตัวเลือกย่อยของ #'+row.parent_id:'')),cfg.canAudit&&h('button',{onClick:()=>onAudit(id)},'ประวัติราคา')),
 busy&&h('p',{role:'status',className:'sdd-loading-notice'},row?'กำลังตรวจข้อมูลล่าสุด…':'กำลังเปิดสินค้าที่เลือก…'),error&&h('div',{role:'alert',className:'sdd-error'},error,row&&h('p',null,'ข้อมูลด้านล่างเป็นข้อมูลก่อนหน้า ยังแก้ไขไม่ได้'),h('button',{onClick:()=>setRetry(n=>n+1)},'ลองโหลดอีกครั้ง')),
 row&&h(wp.element.Fragment,null,h('p',{className:'sdd-last-loaded'},'ข้อมูลล่าสุดที่โหลดได้ '+new Date(loadedAt).toLocaleString('th-TH')),
 h('div',{className:'sdd-direct-fields'},h('h2',null,row.name),row.attributes&&h('p',null,row.attributes),row.type==='variable'?h('p',null,'สินค้าแม่มีหลายตัวเลือก กลับไปขยายกลุ่มเพื่อเลือกตัวเลือกที่ต้องการแก้ไข'):['regular_price','sale_price','stock_status'].map(key=>h('div',{key,className:'sdd-direct-field'},h('h3',null,labels[key]),h(Cell,{row:busy||error?{...row,editable:{}}:row,field:key,onSaved})))),
 cfg.canSettings&&['simple','variation'].includes(row.type)&&!busy&&!error&&h(PromotionPanel,{row,onSaved,onClose})));
}
function App(){
 const initial=useRef(readWorkspaceLocation(window.location?.search||'')).current;
 const [viewOptions,setViewOptions]=useState(workspaceOptions(initial));
 const updateOptions=patch=>setViewOptions(v=>({...v,...patch}));
 const [focusedProduct,setFocusedProduct]=useState(initial.product?{id:initial.product,field:initial.field}:null),[calendarMonth,setCalendarMonth]=useState(initial.month);
 const [data,setData]=useState({items:[],page:1,pages:0,total:0,catalog_total:0}),[search,setSearch]=useState(initial.search),[query,setQuery]=useState(initial.search),[page,setPage]=useState(initial.page),[size,setSize]=useState(initial.size),[brand,setBrand]=useState(initial.brand),[status,setStatus]=useState(initial.status),[source,setSource]=useState(initial.source),[promotionPost,setPromotionPost]=useState(initial.promotionPost),[articleSearch,setArticleSearch]=useState(''),[articles,setArticles]=useState([]),[articlesError,setArticlesError]=useState(''),[brands,setBrands]=useState([]),[brandSearch,setBrandSearch]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState(''),[setup,setSetup]=useState(cfg.canSettings&&initial.view==='setup'),[dashboard,setDashboard]=useState(cfg.canSettings&&initial.view==='dashboard'),[calendar,setCalendar]=useState(cfg.canSettings&&initial.view==='calendar'),[alertState,setAlertState]=useState('loading'),[auditProduct,setAuditProduct]=useState(null),[tick,setTick]=useState(0),[session,setSession]=useState(false),[orderby,setOrderby]=useState(initial.orderby),[order,setOrder]=useState(initial.order),[promoId,setPromoId]=useState(null),[filters,setFilters]=useState(false),[confirmation,setConfirmation]=useState(null),[scope,setScope]=useState(initial.scope),[promotion,setPromotion]=useState(initial.promotion);
 const [draftTick,setDraftTick]=useState(0);
 useEffect(()=>{const update=()=>setDraftTick(n=>n+1);window.addEventListener('sdd:draft-update',update);return()=>window.removeEventListener('sdd:draft-update',update);},[]);
 const pendingDrafts=collectPendingDrafts(drafts,promoDrafts);
 const generation=useRef(0),clientId=useRef(uuid()),liveState=useRef({});
 const [syncAt,setSyncAt]=useState(''),[syncMessage,setSyncMessage]=useState('');
 liveState.current={setup,dashboard,calendar,session,loading};
 useEffect(()=>{const restore=()=>{const r=readWorkspaceLocation(window.location.search);setSearch(r.search);setQuery(r.search);setPage(r.page);setSize(r.size);setBrand(r.brand);setStatus(r.status);setSource(r.source);setPromotionPost(r.promotionPost);setPromotion(r.promotion);setScope(r.scope);setOrderby(r.orderby);setOrder(r.order);setDashboard(cfg.canSettings&&r.view==='dashboard');setCalendar(cfg.canSettings&&r.view==='calendar');setSetup(cfg.canSettings&&r.view==='setup');setCalendarMonth(r.month);setViewOptions(workspaceOptions(r));setFocusedProduct(r.product?{id:r.product,field:r.field}:null);setAuditProduct(null);};window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[]);
 useEffect(()=>{if(!window.history||!window.location)return;const q=workspaceQuery(window.location.search,{...viewOptions,view:dashboard?'dashboard':calendar?'calendar':setup?'setup':'products',search:query,brand,status,source,promotionPost,promotion,page,size,scope,orderby,order,month:calendarMonth,product:focusedProduct?.id||'',field:focusedProduct?.field||''});if(q!==window.location.search.replace(/^\?/,''))window.history.pushState(null,'',window.location.pathname+'?'+q+window.location.hash);},[dashboard,calendar,setup,query,brand,status,source,promotionPost,promotion,page,size,scope,orderby,order,calendarMonth,focusedProduct?.id,focusedProduct?.field,viewOptions]);

 useEffect(()=>{const failed=e=>{setSession(true);setError(e.detail.message);setSyncMessage('หยุดอัปเดตอัตโนมัติชั่วคราว');};window.addEventListener('sdd:connection-error',failed);return()=>window.removeEventListener('sdd:connection-error',failed);},[]);
 useEffect(()=>{const receive=e=>{for(const id of [...e.detail.items.map(r=>r.id),...e.detail.unavailable])workspacePresence.delete(id);for(const [id,entries] of Object.entries(e.detail.presence||{}))workspacePresence.set(id,entries);setData(d=>({...d,items:mergeLiveRows(d.items,e.detail)}));setSyncAt(e.detail.server_time);setSyncMessage('');};window.addEventListener('sdd:workspace-sync',receive);return()=>window.removeEventListener('sdd:workspace-sync',receive);},[]);
 useEffect(()=>{
  if(setup||dashboard||calendar||focusedProduct||auditProduct!==null||session)return;let stopped=false,running=false,debounce,nextAttempt=0;
  const focused=()=>{const el=document.activeElement;if(!el||!el.matches('input,select,textarea')||el.disabled)return null;const row=el.closest('[data-product-id],[data-promotion-for]'),field=el.dataset.sddField||el.closest('[data-sdd-focus-field]')?.dataset.sddFocusField;return row&&field?{product_id:row.dataset.productId||row.dataset.promotionFor,field}:null;};
  const poll=async(clear=false)=>{
   if(stopped||running||liveState.current.loading||(!clear&&Date.now()<nextAttempt)||(!clear&&document.hidden))return;
   running=true;const g=generation.current,active=clear?null:focused(),ids=clear?[]:[...new Set([...document.querySelectorAll('tr[data-product-id]')].map(e=>e.dataset.productId))];
   try{for(let offset=0;offset<Math.max(1,ids.length);offset+=100){const body={ids:ids.slice(offset,offset+100),client_id:clientId.current};if(offset===0)body.active=active;const update=await api('workspace-sync',body);if(stopped||g!==generation.current)break;if(!clear)window.dispatchEvent(new CustomEvent('sdd:workspace-sync',{detail:update}));}}
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
 useEffect(()=>{api('brands').then(r=>setBrands(r.items)).catch(()=>{});api('promotion-articles').then(r=>{setArticles(r.items);setArticlesError('');}).catch(e=>setArticlesError(e.message));},[tick]);
 useEffect(()=>{const g=++generation.current;setLoading(true);const q=new URLSearchParams({search:query,page,per_page:size,brand,stock_status:status,source,promotion_post:promotionPost,orderby,order,scope,promotion_status:promotion});api('products?'+q).then(r=>{if(g===generation.current){setData(r);setError('');}}).catch(e=>{if(g===generation.current){setError(e.message);if(e.status===401||e.code==='rest_cookie_invalid_nonce')setSession(true);}}).finally(()=>{if(g===generation.current)setLoading(false);});},[query,page,size,brand,status,source,promotionPost,tick,orderby,order,scope,promotion]);
 useEffect(()=>{const handler=e=>{if([...drafts.values(),...promoDrafts.values()].some(d=>d.state!=='clean')){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[]);
 async function refreshSession(){try{await renewNonce();connectionError=null;setSession(false);setError('');setSyncMessage('');setTick(t=>t+1);}catch(e){setSession(true);setError(e.message);}}
 function saved(id,field,value,revision){generation.current++;setTick(t=>t+1);setData(d=>({...d,items:d.items.map(row=>row.id===id?{...row,[field]:value,revisions:{...row.revisions,[field]:revision}}:row)}));}
 const context={search:query,brand,stock_status:status,source,promotion_post:promotionPost,orderby,order,tick,scope,promotion_status:promotion};
 const shownArticles=articles.filter(a=>!articleSearch||(a.title+' '+a.id).toLocaleLowerCase().includes(articleSearch.toLocaleLowerCase())||a.id===promotionPost);
 const sortedBrands=[...brands].sort((a,b)=>a.name.localeCompare(b.name,'th',{sensitivity:'base'}));
 const shownBrands=sortedBrands.filter(b=>b.name.toLocaleLowerCase().includes(brandSearch.toLocaleLowerCase())||b.id===brand);
 const selectedFilters=[
  brand&&{id:'brand',label:'แบรนด์: '+(sortedBrands.find(b=>b.id===brand)?.name||brand),clear:()=>{setBrand('');setBrandSearch('');}},
  status&&{id:'stock',label:'สต็อก: '+(stock[status]||status),clear:()=>setStatus('')},
  promotion&&{id:'promotion',label:'สถานะโปร: '+({none:'ไม่มีโปร',current:'กำลังใช้',future:'รอเริ่ม',expired:'หมดอายุแล้ว',review:'ต้องตรวจสอบ'}[promotion]||promotion),clear:()=>setPromotion('')},
  source&&{id:'source',label:'แหล่งสินค้า: ในบทความโปรโมชัน',clear:()=>{setSource('');setPromotionPost('');setArticleSearch('');}},
  promotionPost&&{id:'article',label:'บทความ: '+(articles.find(a=>a.id===promotionPost)?.title||promotionPost),clear:()=>{setPromotionPost('');setArticleSearch('');}}
 ].filter(Boolean);
 function openDashboardProduct(id,field='temporary_sale'){setAuditProduct(null);setFocusedProduct({id:String(id),field:typeof field==='string'?field:'temporary_sale'});}
 function clearFilters(){setBrand('');setStatus('');setPromotion('');setSource('');setPromotionPost('');setBrandSearch('');setArticleSearch('');setPage(1);}
 const filter=(label,value,set,options)=>h('label',{className:'sdd-filter'},h('span',null,label),h('select',{'aria-label':label,value,onChange:e=>{set(e.target.value);setPage(1);}},h('option',{value:''},'ทั้งหมด'),options.map(o=>h('option',{key:o.id,value:o.id},o.name))));
 return h('div',{className:'sdd-app'},h('header',{className:'sdd-topbar'},h('a',{className:'sdd-brand',href:cfg.back,'aria-label':'SoundDD กลับหลังบ้าน WordPress'},h('img',{src:cfg.logo,alt:'SoundDD',width:164,height:48})),h('div',{className:'sdd-app-identity'},h('strong',null,'Stock & Price'),h('span',null,'จัดการสินค้าและโปรโมชัน')),h('nav',{className:'sdd-main-nav','aria-label':'เมนูหลัก'},[['products','สินค้า'],...(cfg.canSettings?[['dashboard','ภาพรวมงาน'],['calendar','ปฏิทินโปร'],['setup','ตั้งค่า']]:[])].map(([id,label])=>h('button',{key:id,'aria-current':(id==='products'&&!dashboard&&!calendar&&!setup&&auditProduct===null||id==='dashboard'&&dashboard||id==='calendar'&&calendar||id==='setup'&&setup)?'page':undefined,onClick:()=>{setFocusedProduct(null);setDashboard(id==='dashboard');setCalendar(id==='calendar');setSetup(id==='setup');setAuditProduct(null);}},label,id==='dashboard'&&alertState==='attention'&&h('span',{className:'sdd-alert-dot','aria-label':'มีโปรที่ต้องตรวจสอบ'}),id==='dashboard'&&alertState==='unknown'&&h('span',null,' · ตรวจแจ้งเตือนไม่ได้')))),h('span',{className:'sdd-spacer'}),h('span',{className:'sdd-header-user'},h('span',{className:'sdd-user-avatar','aria-hidden':true},(cfg.user||'S').slice(0,1)),cfg.user),h('button',{className:'sdd-refresh-button','aria-label':'รีเฟรชข้อมูล',onClick:()=>setTick(t=>t+1),disabled:loading},'↻ รีเฟรช')),
 h('main',{className:'sdd-wrap'},pendingDrafts.length>0&&h('div',{className:'sdd-unsaved-banner',role:'status'},h('strong',null,'มีข้อมูลที่ยังไม่บันทึกหรือรอตรวจผล '+pendingDrafts.length+' ช่อง'),h('div',{className:'sdd-draft-links'},pendingDrafts.map(d=>h('button',{key:d.id+':'+d.field,onClick:()=>openDashboardProduct(d.id,d.field)},'#'+d.id+' · '+(d.field==='temporary_sale'?'แบบร่างโปร':labels[d.field]||d.field)+(d.state==='unknown'?' · ตรวจผล':''))))),h('details',{className:'sdd-note'},h('summary',null,'ข้อมูลการอัปเดตและคีย์ลัด'),h('span',null,'ข้อมูลล่าสุด '+((syncAt||data.server_time)?new Date(syncAt||data.server_time).toLocaleString('th-TH'):'—')+' · '+(syncMessage||'อัปเดตราคาที่แสดงทุก 15 วินาที')+' · รีเฟรชเพื่อปรับผลค้นหาและลำดับ · กด Enter เพื่อยืนยันราคา · Esc เพื่อยกเลิก')),
 session&&h('div',{className:'sdd-session',role:'alert'},h('a',{href:cfg.login,target:'_blank',rel:'noopener noreferrer'},'เข้าสู่ระบบอีกแท็บ'),h('button',{onClick:refreshSession},'เชื่อมต่อใหม่'),session&&h('span',null,'หยุดการเชื่อมต่อชั่วคราว ค่าที่พิมพ์ไว้ยังอยู่ · หากเข้าสู่ระบบหมดอายุ ให้เข้าสู่ระบบอีกแท็บแล้วกดเชื่อมต่อใหม่')),
 error&&!focusedProduct&&h('p',{role:'alert',className:'sdd-error'},error),focusedProduct&&auditProduct===null?h(DirectProduct,{key:focusedProduct.id,id:focusedProduct.id,field:focusedProduct.field,tick,onSaved:saved,onClose:()=>setFocusedProduct(null),onAudit:setAuditProduct}):focusedProduct&&auditProduct!==null?h(AuditPanel,{productId:auditProduct,onClose:()=>setAuditProduct(null)}):calendar?h(PromotionCalendar,{tick,options:viewOptions,onOptions:updateOptions,month:calendarMonth,onMonthChange:setCalendarMonth,onClose:()=>setCalendar(false),onProduct:openDashboardProduct}):dashboard?h(Dashboard,{tick,options:viewOptions,onOptions:updateOptions,onClose:()=>setDashboard(false),onSettings:()=>{setDashboard(false);setSetup(true);},onProduct:openDashboardProduct}):auditProduct!==null?h(AuditPanel,{productId:auditProduct,onClose:()=>setAuditProduct(null)}):setup?h(Setup,{onClose:()=>setSetup(false),onSaved:()=>setTick(t=>t+1)}):h(wp.element.Fragment,null,
 data.write_access&&!data.write_access.enabled&&h('section',{className:'sdd-warning',role:'status'},h('strong',null,'ขณะนี้เป็นโหมดอ่านอย่างเดียว'),h('p',null,data.write_access.reasons.join(' · ')),data.write_access.can_manage_settings?h('button',{onClick:()=>setSetup(true)},'ตั้งค่าเพื่อเปิดการแก้ไข'):h('p',null,'ติดต่อผู้ดูแลเพื่อเปิดการแก้ไขหรือปรับสิทธิ์บัญชี')),
 !data.brand_configured&&h('p',{className:'sdd-warning'},'ยังไม่ได้เลือกแท็กแบรนด์ในหน้าตั้งค่า ขณะนี้ค้นหาด้วยชื่อสินค้า SKU หรือ ID ได้'),
 h('section',{className:'sdd-workspace-heading'},h('div',null,h('span',{className:'sdd-dashboard-eyebrow'},'พื้นที่ทำงานของร้าน'),h('h1',null,'จัดการสินค้าและราคา'),h('p',null,'ค้นหาสินค้า แก้ราคาและสต็อก หรือตั้งโปรชั่วคราวได้ในที่เดียว')),h('div',{className:'sdd-workspace-total'},h('span',null,'สินค้าในระบบ'),h('strong',null,loading?'…':data.catalog_total.toLocaleString('th-TH')),h('small',null,'ไม่นับตัวเลือกย่อย'))),
 h('div',{className:'sdd-catalog-tabs',role:'tablist','aria-label':'รายการสินค้า'},[['all','สินค้าทั้งหมด'],['recent','แก้ไขล่าสุด']].map(([id,label])=>h('button',{key:id,id:'sdd-catalog-tab-'+id,role:'tab','aria-controls':'sdd-catalog-results','aria-selected':scope===id,tabIndex:scope===id?0:-1,onClick:()=>{setScope(id);setPage(1);setPromoId(null);},onKeyDown:e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setScope(scope==='all'?'recent':'all');setPage(1);setPromoId(null);e.currentTarget.parentElement.querySelector('[aria-selected="false"]').focus();}}},label))),
 scope==='recent'&&h('p',{className:'sdd-recent-note'},'แสดงสินค้าที่เปลี่ยนราคาผ่านปลั๊กอินนี้ล่าสุดก่อน รวมการเริ่มและจบโปรชั่วคราว'),
 h('div',{className:'sdd-toolbar'},h('label',{className:'sdd-search'},h('span',null,'ค้นหาสินค้า'),h('input',{value:search,onChange:e=>setSearch(e.target.value),maxLength:200,placeholder:'ชื่อสินค้า, SKU, แบรนด์ หรือ ID…'})),search&&h('button',{className:'sdd-search-clear','aria-label':'ล้างคำค้นสินค้า',onClick:()=>setSearch('')},'×'),h('button',{className:'sdd-filter-toggle','aria-expanded':filters,'aria-controls':'sdd-filter-options',onClick:()=>setFilters(v=>!v)},h('span',{'aria-hidden':true},'▼ '),'ตัวกรอง'+([brand,status,promotion,source,promotionPost].filter(Boolean).length?' ('+[brand,status,promotion,source,promotionPost].filter(Boolean).length+')':'')),h('button',{className:'sdd-clear-filters',onClick:clearFilters,disabled:!selectedFilters.length&&!brandSearch&&!articleSearch},h('span',{'aria-hidden':true},'× '),'ล้างฟิลเตอร์'),h('div',{id:'sdd-filter-options',className:'sdd-filter-drawer',hidden:!filters},filter('แหล่งสินค้า',source,v=>{setSource(v);setPromotionPost('');setArticleSearch('');},[{id:'new_promotion',name:'ในบทความโปรโมชัน'}]),source==='new_promotion'&&h('label',{className:'sdd-filter sdd-article-search'},h('span',null,'ค้นหาบทความ'),h('input',{value:articleSearch,onChange:e=>setArticleSearch(e.target.value),placeholder:'ชื่อบทความหรือ ID…','aria-label':'ค้นหาบทความโปรโมชัน'})),source==='new_promotion'&&h('label',{className:'sdd-filter sdd-article-picker'},h('span',null,'บทความโปรโมชัน'),h('select',{'aria-label':'เลือกบทความโปรโมชัน',value:promotionPost,onChange:e=>{setPromotionPost(e.target.value);setPage(1);setPromoId(null);}},h('option',{value:''},'ทุกบทความ'),shownArticles.map(a=>h('option',{key:a.id,value:a.id},a.date+' · '+a.title+' (#'+a.id+')')))),h('label',{className:'sdd-filter sdd-brand-search'},h('span',null,'ค้นหาแบรนด์'),h('input',{type:'search',value:brandSearch,onChange:e=>setBrandSearch(e.target.value),placeholder:'พิมพ์ชื่อแบรนด์…','aria-label':'ค้นหาแบรนด์'})),h('label',{className:'sdd-filter sdd-brand-picker'},h('span',null,'แบรนด์'),h('select',{'aria-label':'เลือกแบรนด์',value:brand,onChange:e=>{setBrand(e.target.value);setPage(1);}},h('option',{value:''},'ทุกแบรนด์'),shownBrands.map(b=>h('option',{key:b.id,value:b.id},b.name)),brand&&!shownBrands.some(b=>b.id===brand)&&h('option',{value:brand},sortedBrands.find(b=>b.id===brand)?.name||'แบรนด์ที่เลือก'))),filter('สถานะสต็อก',status,setStatus,Object.entries(stock).map(([id,name])=>({id,name}))),filter('สถานะโปร',promotion,setPromotion,[['none','ไม่มีโปร'],['current','กำลังใช้'],['future','รอเริ่ม'],['expired','หมดอายุแล้ว'],['review','ต้องตรวจสอบ']].map(([id,name])=>({id,name}))),scope==='recent'?h('div',{className:'sdd-filter sdd-sort-fixed',role:'status'},h('span',null,'เรียงตามเวลาที่แก้ไข'),h('div',null,'ใหม่ → เก่า')):h('label',{className:'sdd-filter'},h('span',null,'เรียงตาม'),h('select',{'aria-label':'เรียงตาม',value:orderby+':'+order,onChange:e=>{const [field,direction]=e.target.value.split(':');setOrderby(field);setOrder(direction);setPage(1);}},[['name:asc','ชื่อสินค้า A–Z'],['name:desc','ชื่อสินค้า Z–A'],['sku:asc','SKU A–Z'],['sku:desc','SKU Z–A'],['regular_price:asc','ราคาต่ำไปสูง'],['regular_price:desc','ราคาสูงไปต่ำ']].map(([v,label])=>h('option',{key:v,value:v},label)))),),h('span',{className:'sdd-count'},loading?'กำลังโหลด…':data.total.toLocaleString('th-TH')+' / '+data.catalog_total.toLocaleString('th-TH')+' รายการสินค้า (ไม่นับตัวเลือกย่อย)')),
 h('div',{className:'sdd-filter-chips','aria-label':'ตัวกรองที่เลือก'},selectedFilters.map(f=>h('button',{key:f.id,'aria-label':'ล้าง '+f.label,onClick:()=>{f.clear();setPage(1);}},f.label,h('span',{'aria-hidden':true},' ×'))),h('span',{className:'sdd-filter-result-count','aria-live':'polite'},loading?'กำลังโหลด…':data.total.toLocaleString('th-TH')+' รายการ')),
 source==='new_promotion'&&h('div',{className:'sdd-recent-note',role:'note'},promotionPost?'แสดงสินค้าในบทความที่เลือก · ':'แสดงสินค้าจากทุกบทความที่เผยแพร่ รวมบทความเก่า · ','นับเฉพาะสินค้าที่ระบุรหัสหรือลิงก์ไว้ในบทความ',promotionPost&&articles.find(a=>a.id===promotionPost)&&h(wp.element.Fragment,null,' · ',h('a',{href:articles.find(a=>a.id===promotionPost).url,target:'_blank',rel:'noopener noreferrer'},'เปิดบทความ ↗')),articlesError&&h('span',{role:'alert'},' · โหลดรายชื่อบทความไม่ได้: '+articlesError)),
 promotion==='expired'&&h('div',{className:'sdd-recent-note',role:'note'},'แสดงโปรที่เลยวันสิ้นสุดตาม WooCommerce รวมวันโปรที่ตั้งไว้ก่อนติดตั้งปลั๊กอิน',scope==='recent'&&h(wp.element.Fragment,null,h('span',null,' · แท็บนี้แสดงเฉพาะรายการที่เคยแก้ราคาผ่านปลั๊กอิน '),h('button',{onClick:()=>{setScope('all');setPage(1);setPromoId(null);}},'ดูในสินค้าทั้งหมด'))),
 loading&&h('p',{className:'sdd-loading-notice',role:'status'},'กำลังค้นหาข้อมูลล่าสุด…'),error&&data.items.length>0&&h('p',{className:'sdd-stale-notice',role:'status'},'แสดงข้อมูลก่อนหน้า การโหลดล่าสุดไม่สำเร็จ · กดรีเฟรชเพื่อลองอีกครั้ง'),
 h('div',{id:'sdd-catalog-results',className:'sdd-tablewrap'+(loading?' is-loading':''),role:'tabpanel','aria-labelledby':'sdd-catalog-tab-'+scope,'aria-description':'ตารางเลื่อนได้แนวนอนเพื่อดูทุกคอลัมน์',tabIndex:0,'aria-busy':loading},h('table',null,h('thead',null,h('tr',null,['รูป','สินค้า / SKU','ราคาปกติ','ราคาโปร','สต็อก','โปรโมชั่น','จัดการ'].map(label=>h('th',{key:label,scope:'col',className:label==='จัดการ'?'sdd-action-heading':label==='ราคาปกติ'||label==='ราคาโปร'?'sdd-price-heading':label==='สต็อก'||label==='โปรโมชั่น'?'sdd-status-heading':''},label)))),h('tbody',null,data.items.map(row=>h(ProductGroup,{key:row.id,row,context,onSaved:saved,promoId,onPromo:setPromoId,onAudit:setAuditProduct,onOpen:openDashboardProduct})),!data.items.length&&h('tr',null,h('td',{colSpan:7,className:'sdd-empty'},loading?'กำลังโหลด…':error?'ยังโหลดรายการไม่ได้ กรุณากดรีเฟรช':'ไม่พบสินค้าที่ตรงคำค้นหรือตัวกรอง',!loading&&!error&&h('button',{onClick:()=>{clearFilters();setSearch('');}},'ล้างคำค้นและตัวกรอง')))))),
 h('nav',{className:'sdd-pagination','aria-label':'แบ่งหน้าสินค้า'},h('button',{disabled:page<=1||loading,onClick:()=>setPage(p=>p-1)},'← ก่อนหน้า'),h('span',null,'หน้า '+page+' / '+Math.max(1,data.pages)),h('button',{disabled:page>=data.pages||loading,onClick:()=>setPage(p=>p+1)},'ถัดไป →'),h('span',{className:'sdd-spacer'}),h('label',null,'รายการต่อหน้า ',h('select',{value:size,onChange:e=>{setSize(Number(e.target.value));setPage(1);}},[20,50,100].map(n=>h('option',{key:n,value:n},n))))))),confirmation&&h(Confirmation,{key:confirmation.text,request:confirmation,onDone:answer=>{const current=confirmation;setConfirmation(null);current.resolve(answer);}}));
}
wp.element.createRoot(document.getElementById('sdd-root')).render(h(App));
})();
