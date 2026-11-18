const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8').replace(
 "wp.element.createRoot(document.getElementById('sdd-root')).render(h(App));",
 'globalThis.cacheTest={CacheSettings,setApi:fn=>api=fn,setConfirmation:fn=>showConfirmation=fn};'
);
const walk = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(walk)] : [];
const text = tree => tree && typeof tree === 'object' ? tree.children.map(text).join(' ') : tree == null ? '' : String(tree);
const fixture = () => ({
 settings: {capture_enabled:true, dispatch_enabled:true, dry_run:false, extra_urls:[]},
 connection: {zone_id:'a'.repeat(32), has_token:true, verification_state:'verified', verified_at:'2026-11-18T01:00:00Z'},
 credentials_ready:true, live_verified:true, schema_ready:true, scheduler_ready:true,
 queue:{state:'available', operational_state:'running', pending:0, attention:0, dispatch_enabled:true, dry_run:false},
 jobs:[], jobs_pagination:{page:1,per_page:25,total:0,total_pages:1,filter:'all'}
});
function mount(handler) {
 let cursor=0, tree;
 const slots=[], effects=[], pending=[], calls=[], answers=[], prompts=[];
 const element={
  Fragment:'fragment', createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
  useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},
  useRef(initial){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
  useEffect(fn,deps){const index=cursor++, previous=effects[index];if(!previous||!deps||deps.some((value,i)=>!Object.is(value,previous.deps?.[i]))){effects[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{effects[index].cleanup?.();effects[index].cleanup=fn();});}}
 };
 const context=vm.createContext({wp:{element},window:{SDD_CONFIG:{canManageCache:true,timezone:'Asia/Bangkok'},addEventListener(){},removeEventListener(){}},Intl,Date,URLSearchParams,Map,Set,BigInt,setTimeout,clearTimeout});
 vm.runInContext(source,context);
 context.cacheTest.setConfirmation(request=>{prompts.push(request);request.resolve(answers.shift()??false);});
 context.cacheTest.setApi(async(route,body)=>{calls.push({route,body});return handler(route,body);});
 function render(){cursor=0;tree=context.cacheTest.CacheSettings();while(pending.length)pending.shift()();return tree;}
 async function settle(){for(let i=0;i<10;i++){await Promise.resolve();render();}}
 render();
 return {render,settle,calls,answers,prompts,get tree(){return tree;},get text(){return text(tree);},button:label=>walk(tree).find(node=>node.type==='button'&&text(node)===label),nodes:()=>walk(tree),unmount:()=>effects.forEach(effect=>effect?.cleanup?.())};
}

test('pause keeps capturing new price changes and resume sends only saved settings',async()=>{
 let data=fixture();
 const app=mount((route,body)=>{if(route==='cache-settings'){data={...data,settings:{...body},queue:{...data.queue,dispatch_enabled:body.dispatch_enabled}};return data;}return data;});
 await app.settle();
 await app.button('พักการส่ง').props.onClick();await app.settle();
 const pause=app.calls.find(call=>call.route==='cache-settings');
 assert.equal(pause.body.capture_enabled,true);assert.equal(pause.body.dispatch_enabled,false);
 assert.match(app.text,/พักการส่งคำขอ/);
 await app.button('ส่งงานที่ค้างต่อ').props.onClick();await app.settle();
 assert.equal(app.calls.filter(call=>call.route==='cache-settings').at(-1).body.dispatch_enabled,true);
 app.unmount();
});

test('refresh and connection checks preserve unsaved URL and mode changes',async()=>{
 const data=fixture();
 const app=mount(route=>route==='cache-connection'?{connection:data.connection}:data);await app.settle();
 app.nodes().find(node=>node.type==='textarea').props.onChange({target:{value:'https://sounddd.shop/promo/'}});
 const mode=app.nodes().filter(node=>node.type==='input'&&node.props.type==='checkbox').at(-1);
 mode.props.onChange({target:{checked:true}});app.render();
 await app.button('รีเฟรชสถานะ').props.onClick();await app.settle();
 assert.equal(app.nodes().find(node=>node.type==='textarea').props.value,'https://sounddd.shop/promo/');
 assert.equal(app.nodes().filter(node=>node.type==='input'&&node.props.type==='checkbox').at(-1).props.checked,true);
 await app.button('ตรวจการเชื่อมต่อและบันทึก').props.onClick();await app.settle();
 assert.equal(app.nodes().find(node=>node.type==='textarea').props.value,'https://sounddd.shop/promo/');
 assert.equal(app.nodes().filter(node=>node.type==='input'&&node.props.type==='checkbox').at(-1).props.checked,true);
 assert.equal(app.calls.filter(call=>call.route==='cache-settings').length,0);
 app.unmount();
});

test('saved operational status is unaffected by an unsaved mode checkbox',async()=>{
 const app=mount(()=>fixture());await app.settle();
 app.nodes().filter(node=>node.type==='input'&&node.props.type==='checkbox').at(-1).props.onChange({target:{checked:true}});app.render();
 assert.match(app.text,/เปิดใช้งานจริง/);assert.doesNotMatch(app.text,/เปิดโหมดทดลอง/);app.unmount();
});

test('backend pagination and blocked retry reasons are respected',async()=>{
 const data=fixture();
 data.jobs_pagination={page:1,total_pages:2,total:26,per_page:25,filter:'all'};
 data.jobs=[{id:'2',product_id:'10',product_name:'ลำโพงตัวอย่าง',sku:'SPK-1',current_price:'12900',status:'needs_attention',retry_blocked:'configuration_changed',error_code:'configuration_changed',created_at:1794965520}];
 const app=mount((route)=>route.includes('page=2')?{...data,jobs_pagination:{...data.jobs_pagination,page:2}}:data);await app.settle();
 assert.match(app.text,/ลำโพงตัวอย่าง/);assert.match(app.text,/SPK-1/);assert.match(app.text,/12,900/);
 const retry=app.button('ลองส่งอีกครั้ง');assert.ok(!retry||retry.props.disabled);
 assert.ok(app.button('ถัดไป'));await app.button('ถัดไป').props.onClick();await app.settle();
 assert.ok(app.calls.some(call=>call.route.includes('page=2')));app.unmount();
});

test('late health responses do not update an unmounted settings screen',async()=>{
 let resolve;const app=mount(()=>new Promise(done=>resolve=done));app.unmount();resolve(fixture());await app.settle();
 assert.doesNotMatch(app.text,/เปิดใช้งานจริง/);
});

test('closing an unrecoverable job requires confirmation and preserves drafted URLs',async()=>{
 const data=fixture();data.jobs=[{id:'7',product_id:'10',status:'needs_attention',retry_blocked:'replay_limit'}];
 const app=mount(route=>route.endsWith('/close')?{ok:true}:data);await app.settle();
 app.nodes().find(node=>node.type==='textarea').props.onChange({target:{value:'https://sounddd.shop/promo/'}});app.render();
 await app.button('ปิดงานนี้').props.onClick();await app.settle();
 assert.equal(app.calls.filter(call=>call.route.endsWith('/close')).length,0);
 app.answers.push(true);await app.button('ปิดงานนี้').props.onClick();await app.settle();
 const closed=app.calls.find(call=>call.route.endsWith('/close'));
 assert.equal(closed.route,'cache-updates/7/close');assert.equal(closed.body.confirmed,true);
 assert.equal(app.nodes().find(node=>node.type==='textarea').props.value,'https://sounddd.shop/promo/');app.unmount();
});

test('rejected active-token check reloads readiness and retains the original error',async()=>{
 const data=fixture();let rejected=false;
 const app=mount(route=>{if(route==='cache-connection'){rejected=true;throw new Error('Token ถูกปฏิเสธ');}return rejected?{...data,live_verified:false,connection:{...data.connection,verification_state:'recheck_required',last_failure:'cloudflare_403'}}:data;});await app.settle();
 await app.button('ตรวจการเชื่อมต่อและบันทึก').props.onClick();await app.settle();
 assert.match(app.text,/Token ถูกปฏิเสธ/);assert.match(app.text,/ต้องตรวจการเชื่อมต่อ Cloudflare/);
 assert.equal(app.button('ส่งงานที่ค้างต่อ'),undefined);app.unmount();
});

test('a legacy token does not prevent resuming dry-run jobs',async()=>{
 const data=fixture();data.settings={...data.settings,dry_run:true,dispatch_enabled:false};data.queue={...data.queue,dry_run:true,dispatch_enabled:false,pending:2};data.live_verified=false;data.connection.verification_state='recheck_required';
 const app=mount(()=>data);await app.settle();assert.ok(app.button('ส่งงานที่ค้างต่อ'));assert.doesNotMatch(app.text,/ต้องตรวจการเชื่อมต่อ Cloudflare/);app.unmount();
});

test('queued jobs can be closed during a pause but never while actively dispatching',async()=>{
 const data=fixture();data.settings.dispatch_enabled=false;data.queue.dispatch_enabled=false;
 data.jobs=[{id:'8',product_id:'10',status:'pending'}];
 const paused=mount(()=>data);await paused.settle();assert.ok(paused.button('ปิดงานนี้'));paused.unmount();
 const running=mount(()=>({...data,settings:{...data.settings,dispatch_enabled:true},queue:{...data.queue,dispatch_enabled:true}}));await running.settle();assert.equal(running.button('ปิดงานนี้'),undefined);running.unmount();
});
