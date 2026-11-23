const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/app.js'),'utf8').replace("wp.element.createRoot(document.getElementById('sdd-root')).render(h(App));","globalThis.testSetup={Setup,setApi:fn=>api=fn,confirm:()=>showConfirmation=request=>request.resolve(true)};");
const walk=tree=>tree&&typeof tree==='object'?[tree,...tree.children.flatMap(walk)]:[];
const text=tree=>tree&&typeof tree==='object'?tree.children.map(text).join(' '):tree==null?'':String(tree);
const settings=(stop=false)=>({settings:{write_stop:stop,brand_ids:[]},schema_ready:true,currency:'THB',prices_include_tax:true});
const health={enable_reasons:[],runtime:{},checks:[],queues:{},cron:[]};
function mount(handler){
 let cursor=0,tree,writes=0;const slots=[],effects=[],pending=[],calls=[];
 const element={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),Fragment:'fragment',
  useState(value){const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return [slots[i],next=>{writes++;slots[i]=typeof next==='function'?next(slots[i]):next;}];},
  useRef(value){const i=cursor++;if(!(i in slots))slots[i]={current:value};return slots[i];},
  useEffect(fn,deps){const i=cursor++,previous=effects[i];if(!previous||deps.some((value,index)=>!Object.is(value,previous.deps[index]))){effects[i]={deps,cleanup:previous?.cleanup};pending.push(()=>{effects[i].cleanup?.();effects[i].cleanup=fn();});}}};
 const ctx=vm.createContext({wp:{element},window:{SDD_CONFIG:{canManageCache:true,timezone:'Asia/Bangkok'}},Intl,Date,URLSearchParams,Map,Set,BigInt});
 vm.runInContext(source,ctx);ctx.testSetup.confirm();ctx.testSetup.setApi(async (route,body)=>{calls.push(route);return handler(route,body);});
 function render(){cursor=0;tree=ctx.testSetup.Setup({onClose:()=>{},onSaved:()=>{}});while(pending.length)pending.shift()();return tree;}
 async function settle(){for(let i=0;i<8;i++){await Promise.resolve();render();}}
 render();return {render,settle,calls,unmount:()=>effects.forEach(e=>e?.cleanup?.()),get text(){return text(tree);},get writes(){return writes;},get pill(){return walk(tree).find(n=>String(n.props.className||'').startsWith('sdd-write-pill'));},button:label=>walk(tree).find(n=>n.type==='button'&&text(n)===label)};
}
test('initial setup loading never claims editing is disabled or a health check has failed',()=>{
 const app=mount(()=>new Promise(()=>{}));assert.match(text(app.pill),/กำลังอ่านสถานะ/);assert.match(app.pill.props.className,/neutral/);assert.doesNotMatch(app.text,/ยังตรวจสถานะระบบไม่สำเร็จ/);app.unmount();
});
test('saved enabled state is shown independently of slow health and brand responses',async()=>{
 const app=mount(route=>route==='settings'?settings(false):new Promise(()=>{}));await app.settle();assert.equal(text(app.pill),'เปิดให้แก้ไขแล้ว');assert.doesNotMatch(app.text,/ยังตรวจสถานะระบบไม่สำเร็จ/);app.unmount();
});
test('paused setup keeps readiness neutral while health is pending',async()=>{
 const app=mount(route=>route==='settings'?settings(true):route==='health'?new Promise(()=>{}):{items:[],pages:1});await app.settle();assert.equal(text(app.pill),'ปิดการแก้ไข');assert.match(app.text,/กำลังตรวจความพร้อม/);assert.doesNotMatch(app.text,/ยังเปิดไม่ได้|ผ่านเงื่อนไขระบบ|ยังตรวจความพร้อมไม่ได้/);assert.equal(app.button('เปิดให้แก้ไขสินค้า').props.disabled,true);app.unmount();
});
test('failed health checks show recovery and never permit enabling the writer',async()=>{
 const app=mount(route=>{if(route==='health')throw new Error('Health unavailable');return route==='settings'?settings(true):{items:[],pages:1};});await app.settle();assert.match(app.text,/ยังตรวจความพร้อมไม่ได้/);assert.ok(app.button('ลองตรวจความพร้อมอีกครั้ง'));assert.equal(app.button('เปิดให้แก้ไขสินค้า').props.disabled,true);app.unmount();
});
test('brand loading failure does not discard the saved editing status',async()=>{
 const app=mount(route=>{if(route.startsWith('brand-terms'))throw new Error('Terms unavailable');return route==='settings'?settings(false):health;});await app.settle();assert.equal(text(app.pill),'เปิดให้แก้ไขแล้ว');assert.match(app.text,/ยังอ่านแท็กแบรนด์ไม่ได้/);app.unmount();
});
test('settings can be retried and late responses after leaving do not change state',async()=>{
 let reads=0;const app=mount(route=>{if(route==='settings'){if(!reads++)throw new Error('Settings unavailable');return settings(false);}return route==='health'?health:{items:[],pages:1};});await app.settle();assert.match(text(app.pill),/ยังอ่านสถานะไม่ได้/);await app.button('ลองอ่านการตั้งค่าอีกครั้ง').props.onClick();await app.settle();assert.equal(text(app.pill),'เปิดให้แก้ไขแล้ว');app.unmount();
 let resolve;const late=mount(route=>route==='settings'?new Promise(done=>resolve=done):route==='health'?health:{items:[],pages:1});await late.settle();late.unmount();const before=late.writes;resolve(settings());for(let i=0;i<5;i++)await Promise.resolve();assert.equal(late.writes,before);
});
test('pausing editing sends only the pause setting and keeps the unsaved brand draft',async()=>{
 let payload;
 const app=mount((route,body)=>{
  if(route==='settings'){if(body)payload=body;return settings(!!body);}
  return route==='health'?health:{items:[{id:'9',name:'Brand fixture'}],pages:1};
 });
 await app.settle();
 app.button('เลือกทั้งหมด').props.onClick();
 app.render();
 await app.button('หยุดการแก้ไขชั่วคราว').props.onClick();
 await app.settle();
 assert.equal(JSON.stringify(payload),'{"write_stop":true}');
 assert.match(app.text,/เลือก 1 \/ 1/);
 assert.equal(text(app.pill),'ปิดการแก้ไข');
 app.unmount();
});
