const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/app.js'),'utf8').replace(
 "wp.element.createRoot(document.getElementById('sdd-root')).render(h(App));",
 "globalThis.testImport={PromotionImport,setApi:fn=>api=fn,setConfirmation:fn=>showConfirmation=fn,leave:()=>allowImportLeave()};");
const walk=tree=>tree&&typeof tree==='object'?[tree,...tree.children.flatMap(walk)]:[];
const text=tree=>tree&&typeof tree==='object'?tree.children.map(text).join(' '):tree==null?'':String(tree);
const row=(number=2)=>({row:number,id:number+100,name:'Product '+number,input:'Product '+number,price:'80',current_price:'100',permanent:true,from:'',until:''});
const ready=(extra={})=>({status:'ready',batch:'batch-a',revision:1,mode:'permanent',total:1,rows:[row()],errors:[],removed:[],expires_at:1900,server_time:1000,...extra});
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
function mount(handler,{saved='batch-a',now=1000000}={}){
 let cursor=0,tree,closed=0,writes=0;
 const slots=[],effectSlots=[],pending=[],calls=[],listeners=new Map(),intervals=new Map(),storage=new Map(saved?[['sdd-promotion-import-7',saved]]:[]),prompts=[],answers=[];
 const fakeDate=class extends Date{static now(){return now;}};
 const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)});
 const element={createElement:h,Fragment:'fragment',useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{writes++;slots[index]=typeof value==='function'?value(slots[index]):value;}];},useRef(value){const index=cursor++;if(!(index in slots))slots[index]={current:value};return slots[index];},useEffect(fn,deps){const index=cursor++,previous=effectSlots[index];if(!previous||!deps||deps.some((v,i)=>!Object.is(v,previous.deps?.[i]))){effectSlots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{effectSlots[index].cleanup?.();effectSlots[index].cleanup=fn();});}}};
 const window={SDD_CONFIG:{userId:7,timezone:'Asia/Bangkok'},addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)};
 const ctx=vm.createContext({wp:{element},window,Date:fakeDate,Intl,Map,Set,BigInt,URLSearchParams,crypto:{randomUUID:()=> 'id'},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},requestAnimationFrame:fn=>fn(),setInterval:fn=>{const id=intervals.size+1;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id),setTimeout,clearTimeout,FormData,Blob});
 vm.runInContext(source,ctx);
 ctx.testImport.setApi(async(route,body)=>{calls.push({route,body});return handler(route,body,calls);});
 ctx.testImport.setConfirmation(request=>{prompts.push(request);request.resolve(answers.shift()??false);});
 function render(){cursor=0;tree=ctx.testImport.PromotionImport({onClose:()=>closed++,onComplete:()=>{},closeLabel:'กลับไปจัดการสินค้า'});while(pending.length)pending.shift()();return tree;}
 async function settle(){for(let i=0;i<5;i++){await Promise.resolve();render();}return tree;}
 function component(name,number){return walk(tree).find(node=>typeof node.type==='function'&&node.type.name===name&&(number==null||(node.props.row||node.props.issue)?.row===number));}
 function button(label){return walk(tree).find(node=>node.type==='button'&&text(node)===label);}
 function unmount(){effectSlots.forEach(effect=>effect?.cleanup?.());}
 render();
 return {settle,render,component,button,calls,storage,prompts,answers,listeners,unmount,leave:()=>ctx.testImport.leave(),advance:async millis=>{now+=millis;for(const fn of [...intervals.values()])fn();return settle();},get root(){return tree.props.ref;},get text(){return text(tree);},get closed(){return closed;},get writes(){return writes;}};
}

test('restoring a ready batch makes one GET and never submits a save',async()=>{
 const app=mount(()=>ready());await app.settle();
 assert.equal(app.calls.length,1);assert.equal(app.calls[0].body,undefined);assert.match(app.text,/ยืนยันเปลี่ยนราคา 1 รายการ/);assert.match(app.text,/เก็บชุดนี้ไว้ถึง/);assert.ok(app.component('PromotionImportReadyRow',2));app.unmount();
});
test('a running permanent batch resumes only after an explicit click using the same batch',async()=>{
 const running={status:'running',mode:'permanent',revision:4,count:1,processed:1,total:2};
 const app=mount((route,body)=>body?{status:'completed',mode:'permanent',count:1,total:2,errors:[{row:3,name:'B',message:'ราคาเปลี่ยนไป'}]}:running);await app.settle();
 assert.equal(app.calls.filter(call=>call.body).length,0);assert.equal(app.button('ยกเลิกชุดนี้').props.disabled,true);
 await app.button('ทำรายการที่เหลือต่อ').props.onClick();await app.settle();
 assert.equal(app.calls[1].route,'promotion-import/batch-a');assert.equal(app.calls[1].body.revision,4);assert.match(app.text,/ราคาเปลี่ยนไป/);assert.match(app.text,/ผลการนำเข้า/);assert.equal(app.storage.size,0);app.unmount();
});
test('late GET responses cannot update an unmounted import or clear its remembered batch',async()=>{
 let resolve;const app=mount(()=>new Promise(r=>resolve=r));const writes=app.writes;app.unmount();resolve({status:'completed',mode:'permanent',count:1,total:1,errors:[]});await Promise.resolve();await Promise.resolve();
 assert.equal(app.writes,writes);assert.equal(app.storage.get('sdd-promotion-import-7'),'batch-a');
});
test('checking one correction preserves the values typed into another row',async()=>{
 const issue=number=>({row:number,name:'Product '+number,edit:'price',message:'ตรวจราคา',values:{price:'0',from:'',until:''}});
 const app=mount((route,body)=>body?ready({revision:2,total:2,rows:[{...row(2),price:'75'}],errors:[issue(3)]}):ready({total:2,rows:[],errors:[issue(2),issue(3)]}));await app.settle();
 app.component('PromotionImportCorrection',2).props.onDraft({price:'75'});app.render();app.component('PromotionImportCorrection',3).props.onDraft({price:'65'});app.render();
 await app.component('PromotionImportCorrection',2).props.onCheck({price:'75'});await app.settle();
 assert.equal(app.component('PromotionImportCorrection',3).props.draft.values.price,'65');assert.equal(app.button('ยืนยันเปลี่ยนราคา 2 รายการ').props.disabled,true);app.unmount();
});
test('validation failures retain raw values and do not claim an unknown price write',async()=>{
 const app=mount((route,body)=>{if(body)throw fail('invalid_price',400);return ready();});await app.settle();
 app.component('PromotionImportReadyRow',2).props.onEdit();app.render();app.component('PromotionImportReadyRow',2).props.onDraft({price:'9999'});app.render();
 await app.component('PromotionImportReadyRow',2).props.onCheck({price:'9999'});await app.settle();
 assert.equal(app.component('PromotionImportReadyRow',2).props.draft.values.price,'9999');assert.match(app.text,/invalid_price/);assert.equal(app.button('ตรวจสถานะชุดเดิม'),undefined);app.unmount();
});
test('GET after a revision conflict preserves input and requires acknowledgment of a different product',async()=>{
 let reads=0;const app=mount((route,body)=>{if(body)throw fail('review_required');return reads++?ready({revision:2,rows:[{...row(),id:999,name:'Different product'}]}):ready();});await app.settle();
 app.component('PromotionImportReadyRow',2).props.onEdit();app.render();app.component('PromotionImportReadyRow',2).props.onDraft({price:'75'});app.render();await app.component('PromotionImportReadyRow',2).props.onCheck({price:'75'});await app.settle();
 await app.button('ตรวจสถานะชุดเดิม').props.onClick();await app.settle();
 const entry=app.component('PromotionImportReadyRow',2).props;assert.equal(entry.draft.values.price,'75');assert.equal(entry.draft.conflict,true);assert.equal(app.calls.filter(call=>call.body).length,1);app.unmount();
});
test('expiry uses elapsed server time despite a skewed device clock and preserves current inputs',async()=>{
 let reads=0;const app=mount(()=>{if(reads++)throw fail('preview_expired',404);return ready();},{now:9999999999});await app.settle();
 app.component('PromotionImportReadyRow',2).props.onEdit();app.render();app.component('PromotionImportReadyRow',2).props.onDraft({price:'74'});app.render();
 await app.advance(600000);assert.match(app.text,/เหลือเวลาไม่เกิน 5 นาที/);assert.equal(app.calls.length,1);
 await app.advance(300000);assert.equal(app.calls.length,2);assert.match(app.text,/ชุดตรวจหมดอายุแล้ว/);assert.match(app.text,/74/);assert.equal(app.component('PromotionImportReadyRow',2).props.draft.values.price,'74');assert.equal(app.button('ยืนยันเปลี่ยนราคา 1 รายการ').props.disabled,true);assert.equal(app.storage.size,1);app.unmount();
});
test('leaving with unchecked values asks once and only discards local values when accepted',async()=>{
 const app=mount(()=>ready());await app.settle();app.component('PromotionImportReadyRow',2).props.onDraft({price:'71'});app.render();
 let prevented=false;for(const fn of app.listeners.get('beforeunload'))fn({preventDefault:()=>prevented=true});assert.equal(prevented,true);
 app.answers.push(false);assert.equal(await app.leave(),false);assert.equal(app.storage.size,1);
 app.answers.push(true);assert.equal(await app.leave(),true);app.render();assert.equal(app.storage.size,1);assert.equal(app.prompts[1].cancelLabel,'กลับไปแก้ต่อ');assert.equal(app.calls.length,1);app.unmount();
});
test('canceling an edited draft requires confirmation and clears only after server acceptance',async()=>{
 const app=mount((route,body)=>body?{status:'cancelled'}:ready({revision:2}));await app.settle();
 app.answers.push(false);await app.button('ยกเลิกชุดนี้').props.onClick();await app.settle();assert.equal(app.calls.length,1);assert.equal(app.storage.size,1);
 app.answers.push(true);await app.button('ยกเลิกชุดนี้').props.onClick();await app.settle();assert.equal(app.calls[1].route,'promotion-import/batch-a/cancel');assert.equal(app.storage.size,0);assert.match(app.text,/เลือกประเภทโปร/);app.unmount();
});
test('a server refusal to cancel preserves operation recovery',async()=>{
 const app=mount((route,body)=>{if(body)throw fail('import_started');return ready();});await app.settle();await app.button('ยกเลิกชุดนี้').props.onClick();await app.settle();
 assert.equal(app.storage.size,1);assert.ok(app.button('ตรวจสถานะชุดเดิม'));assert.match(app.text,/import_started/);app.unmount();
});
test('a failed initial GET keeps the batch and retries with GET only',async()=>{
 let reads=0;const app=mount(()=>{if(!reads++)throw fail('status_unavailable',503);return ready();});await app.settle();assert.equal(app.storage.size,1);await app.button('ตรวจสถานะชุดเดิม').props.onClick();await app.settle();assert.equal(app.calls.length,2);assert.ok(app.calls.every(call=>call.body===undefined));assert.match(app.text,/ยืนยันเปลี่ยนราคา/);app.unmount();
});
test('restoring a completed partial result shows errors without submitting again',async()=>{
 const app=mount(()=>({status:'completed',mode:'permanent',count:1,total:2,errors:[{row:3,name:'Product B',message:'ราคาฐานเปลี่ยน'}]}));await app.settle();
 assert.match(app.text,/1 \/ 2 รายการ/);assert.match(app.text,/Product B/);assert.match(app.text,/ราคาฐานเปลี่ยน/);assert.equal(app.calls.length,1);assert.equal(app.storage.size,0);app.unmount();
});
test('an incomplete ready response preserves the remembered batch for another status check',async()=>{
 const app=mount(()=>({status:'ready',batch:'batch-a',revision:2}));await app.settle();assert.equal(app.storage.size,1);assert.ok(app.button('ตรวจสถานะชุดเดิม'));assert.equal(app.component('PromotionImportReadyRow',2),undefined);app.unmount();
});
test('expiry checks for a completed operation before treating the draft as lost',async()=>{
 let reads=0;const app=mount(()=>reads++?{status:'completed',count:1,first_start:1800}:ready());await app.settle();await app.advance(900000);
 assert.match(app.text,/ตั้งโปรแล้ว 1 รายการ/);assert.doesNotMatch(app.text,/ชุดตรวจหมดอายุแล้ว/);assert.equal(app.calls.length,2);assert.ok(app.calls.every(call=>call.body===undefined));assert.equal(app.storage.size,0);app.unmount();
});


test('CSV row editing, canceling and successful checking restore the relevant keyboard focus',async()=>{
 const focused=[];let checks=0;
 const app=mount((route,body)=>body?ready({revision:++checks+1,rows:[{...row(),price:'75'}]}):ready());await app.settle();
 app.root.current={querySelector:()=>({querySelector:selector=>selector==='[aria-invalid="true"]'?null:{focus:()=>focused.push(selector),scrollIntoView:()=>{}}})};
 app.component('PromotionImportReadyRow',2).props.onEdit();app.render();assert.equal(focused.at(-1),'input:not(:disabled)');
 app.component('PromotionImportReadyRow',2).props.onCancel();app.render();assert.equal(focused.at(-1),'[data-import-edit]');
 app.component('PromotionImportReadyRow',2).props.onEdit();app.render();app.component('PromotionImportReadyRow',2).props.onDraft({price:'75'});app.render();
 await app.component('PromotionImportReadyRow',2).props.onCheck({price:'75'});await app.settle();assert.equal(focused.at(-1),'[data-import-edit]');assert.equal(app.calls.filter(call=>call.body).length,1);app.unmount();
});
