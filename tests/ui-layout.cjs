const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/app.js'),'utf8').replace("wp.element.createRoot(document.getElementById('sdd-root')).render(h(App));","globalThis.ui={Setup,CatalogBrandFilter,ImportPriceSummary,priceChange,MobileProductPrices,importPriceLimit,displayDate,csvRowValues,csvRowIdentity,csvDraftDirty,mergeCsvDrafts,CatalogTabs,CatalogPromotionTiming,PromotionImportReadyRow,App,calendarWeeks,CalendarMonth,DashboardTasks,Dashboard,PromotionCalendar,PromotionImport,PromotionDuplicateChoice,restorationSummary,promotionDraftError,RestorationCard,collectPendingDrafts,readWorkspaceLocation,workspaceQuery,Confirmation,DirectProduct,cacheUpdateText,CacheQueueSummary,CacheSettings};");
function setup(states=[],config={}){let index=0;const h=(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)});const ctx=vm.createContext({wp:{element:{createElement:h,useState:v=>[index<states.length?states[index++]:typeof v==='function'?v():v,()=>{}],useEffect:()=>{},useRef:v=>({current:v}),Fragment:'fragment'}},window:{SDD_CONFIG:{timezone:'Asia/Bangkok',...config}},crypto:{randomUUID:()=> 'test-id'},Intl,Date,URLSearchParams,Map,Set,BigInt});vm.runInContext(source,ctx);return ctx.ui;}
const epoch=date=>Date.parse(date+'T12:00:00+07:00')/1000;
const item=(id,start,end)=>({promotion_id:id,id,name:'Product '+id,status:'active',price:'8000',starts_at:epoch(start),ends_at:epoch(end)});
const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...tree.children.flatMap(nodes)];
const text=tree=>!tree?'':typeof tree==='object'?tree.children.map(text).join(' '):String(tree);
test('calendar clips cross-month promotions and splits them at week boundaries',()=>{const ui=setup(),weeks=ui.calendarWeeks('2026-11',[item('1','2026-10-30','2026-11-10')]);assert.equal(weeks[0].segments[0].start,1);assert.equal(weeks[0].segments[0].end,7);assert.equal(weeks[1].segments[0].start,8);assert.equal(weeks[1].segments[0].end,10);assert.equal(weeks[2].segments.length,0);});
test('overlapping promotions get separate lanes; adjacent promotions share a lane',()=>{const ui=setup(),week=ui.calendarWeeks('2026-11',[item('1','2026-11-01','2026-11-03'),item('2','2026-11-02','2026-11-04'),item('3','2026-11-04','2026-11-06')])[0];assert.equal(week.segments[0].lane,0);assert.equal(week.segments[1].lane,1);assert.equal(week.segments[2].lane,0);});
test('crowded weeks expose overflow instead of overlapping more than four lanes',()=>{const week=setup().calendarWeeks('2026-11',Array.from({length:6},(_,i)=>item(String(i),'2026-11-01','2026-11-07')))[0];assert.equal(week.segments.length,4);assert.equal(week.hidden,2);});
test('short February and December cross-year ranges stay inside the selected month',()=>{const weeks=setup().calendarWeeks('2027-02',[]);assert.equal(weeks.flatMap(w=>w.dates).filter(Boolean).length,28);const dec=setup().calendarWeeks('2026-12',[item('x','2026-12-30','2027-01-02')]);const last=dec.at(-1).segments[0];assert.equal(last.end,31);});
const data={problems:{items:[{id:'12',name:'Test product',sku:'SKU',message:'Manual price change'}],limited:false},upcoming:{items:[],limited:false},changes:{items:[],limited:false},jobs:[],operations:{state:'available',count:0},server_time:new Date().toISOString()};
test('review task action opens the affected product without a write request',()=>{let opened;const tree=setup().DashboardTasks({data,onProduct:id=>opened=id,date:String});const action=nodes(tree).find(n=>n.props.className==='sdd-task-action');assert.ok(action);action.props.onClick();assert.equal(opened,'12');assert.match(text(tree),/Manual price change/);});
test('dashboard renders alert, summary and task board when data loads',()=>{const tree=setup(['24','30',data,'',false]).Dashboard({onClose:()=>{},onProduct:()=>{},onSettings:()=>{}});assert.ok(nodes(tree).some(n=>n.props.className==='sdd-attention-banner'));assert.equal(nodes(tree).filter(n=>(n.props.className||'').startsWith('sdd-overview-stat ')).length,4);assert.ok(nodes(tree).some(n=>typeof n.type==='function'&&n.type.name==='DashboardTasks'));});
test('return plan accounts for expired original sales and explicit revival',()=>{const ui=setup(),plan={status:'active',original:{regular_price:'10000',sale_price:'9000',sale_dates:epoch('2026-11-01')+'|'+epoch('2026-11-05')},starts_at:epoch('2026-11-02'),ends_at:epoch('2026-11-10')};assert.equal(ui.restorationSummary(plan,epoch('2026-11-03')).after,'10000');assert.equal(ui.restorationSummary({...plan,revive_expired:true},epoch('2026-11-03')).after,'9000');});
test('successful, stopped and overdue restoration never share a success message',()=>{const ui=setup(),plan={status:'active',original:{regular_price:'10000',sale_price:'',sale_dates:'|'},starts_at:100,ends_at:200};assert.equal(ui.restorationSummary(plan,1000).tone,'attention');assert.equal(ui.restorationSummary({...plan,status:'needs_review'},150).tone,'attention');assert.equal(ui.restorationSummary({...plan,status:'restored'},1000).tone,'success');const tree=ui.RestorationCard({plan,currentPrice:'8500',automation:{blocked:true}});assert.match(text(tree),/หยุดอยู่/);assert.doesNotMatch(text(tree),/คืนราคาและตารางเดิมแล้ว/);});
test('pending drafts include promotion forms and preserve the exact field to reopen',()=>{const result=setup().collectPendingDrafts(new Map([['123:sale_price',{state:'dirty'}],['9:regular_price',{state:'clean'}]]),new Map([['555',{state:'unknown'}]]));assert.equal(result.length,2);assert.equal(result[0].field,'sale_price');assert.equal(result[1].id,'555');assert.equal(result[1].field,'temporary_sale');assert.equal(result[1].state,'unknown');});
test('URL round-trip preserves filters, page, month and a variation workspace',()=>{const ui=setup(),r=ui.readWorkspaceLocation('?page=sdd-stock-price&sdd_view=calendar&sdd_search=JBL&sdd_brand=123&sdd_page=5&sdd_month=2027-02&sdd_product=555&sdd_field=sale_price&sdd_stock=instock&sdd_hours=168&sdd_threshold=50&sdd_task=upcoming&sdd_calendar_search=JBL&sdd_calendar_status=active&sdd_calendar_view=list');const query=ui.workspaceQuery('?page=sdd-stock-price',r),next=ui.readWorkspaceLocation(query);assert.equal(new URLSearchParams(query).get('page'),'sdd-stock-price');for(const key of ['view','search','brand','page','month','product','field','status','dashboardHours','dashboardThreshold','dashboardTab','calendarSearch','calendarStatus','calendarView'])assert.equal(next[key],r[key]);});
test('invalid URL values fall back to supported controls',()=>{const r=setup().readWorkspaceLocation('?sdd_view=evil&sdd_page=-5&sdd_month=2027-13&sdd_product=abc&sdd_size=999&sdd_field=secret');assert.equal(r.view,'products');assert.equal(r.page,1);assert.equal(r.product,'');assert.equal(r.size,50);assert.equal(r.field,'temporary_sale');assert.notEqual(r.month,'2027-13');});
test('confirmation button states the actual consequence',()=>{const tree=setup().Confirmation({request:{title:'ปิดรายการตรวจสอบ',text:'คงราคาปัจจุบัน',confirmLabel:'ปิดรายการและคงราคา'},onDone:()=>{}});assert.match(text(tree),/ปิดรายการและคงราคา/);assert.doesNotMatch(text(tree),/ยืนยันบันทึก/);});

test('cache status distinguishes provider acceptance from verification and dry run',()=>{const ui=setup();assert.equal(ui.cacheUpdateText({state:'disabled'}),'');assert.equal(ui.cacheUpdateText({state:'idle'}),'');assert.match(ui.cacheUpdateText({state:'accepted'}),/รับคำขอ/);assert.doesNotMatch(ui.cacheUpdateText({state:'accepted'}),/ตรวจพบ|ทุกหน้า|สำเร็จ/);assert.match(ui.cacheUpdateText({state:'simulated'}),/ยังไม่ได้อัปเดตบนเว็บไซต์จริง/);assert.match(ui.cacheUpdateText({state:'retry_wait'}),/ลองใหม่/);assert.match(ui.cacheUpdateText({state:'unavailable'}),/ตรวจสถานะ/);});
test('paused cache queue reports retained work without implying a price failure',()=>{const tree=setup().CacheQueueSummary({data:{state:'available',pending:3,attention:1,dry_run:true,dispatch_enabled:false}});assert.match(text(tree),/2\s+รายการกำลังรอ/);assert.match(text(tree),/1\s+รายการต้องตรวจสอบ/);assert.match(text(tree),/รายการที่รอยังอยู่/);assert.match(text(tree),/ทดลองอยู่/);assert.doesNotMatch(text(tree),/บันทึกราคาล้มเหลว/);assert.equal(setup().CacheQueueSummary({data:{state:'disabled'}}),null);});

test('cache queue summary distinguishes connection failure from a stalled worker',()=>{const {CacheQueueSummary}=setup();const queue={state:'available',pending:1,attention:0};assert.match(text(CacheQueueSummary({data:{...queue,operational_state:'paused_error'}})),/ตรวจการเชื่อมต่อ Cloudflare/);assert.match(text(CacheQueueSummary({data:{...queue,operational_state:'stalled',dispatch_enabled:true}})),/เบื้องหลังล่าช้า/);});
test('Cloudflare setup needs only connection credentials and hides page-count/device configuration',()=>{const data={credentials_ready:false,live_verified:false,schema_ready:true,scheduler_ready:true,connection:{zone_id:'',has_token:false},settings:{capture_enabled:false,dispatch_enabled:false,dry_run:true,extra_urls:[]},queue:{state:'disabled'},jobs:[]};const tree=setup([data]).CacheSettings();assert.match(text(tree),/Zone ID/);assert.match(text(tree),/API Token/);assert.match(text(tree),/ตรวจการเชื่อมต่อและบันทึก/);assert.doesNotMatch(text(tree),/จำนวนสินค้าที่แสดงต่อหน้า|เว็บไซต์แยกข้อมูลตามอุปกรณ์|SDD_CF_/);const toggles=nodes(tree).filter(n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(toggles.length,2);const master=nodes(tree).find(n=>n.props.className==='sdd-cache-master-toggle');assert.ok(master);});

test('CSV review puts blocking rows first and prevents partial confirmation',()=>{
 const preview={total:2,batch:null,errors:[{row:3,name:'MIC-008',message:'มีโปรรอเริ่ม'}],rows:[{row:2,sku:'001',name:'Mic',before:'100',price:'80',after:'100',from:'2026-11-20 09:00',until:'2026-11-20 23:00'}]};
 const tree=setup(['',preview,'promo.csv',false,'',null,false]).PromotionImport({onClose:()=>{},onComplete:()=>{}});
 const parts=nodes(tree), issue=parts.findIndex(n=>n.props.className==='sdd-import-issues'), detail=parts.findIndex(n=>n.type==='details');
 assert.ok(issue>=0&&detail>issue);
 assert.match(text(parts[issue]),/แถว 3 · MIC-008/);
 assert.equal(parts.find(n=>n.type==='button'&&text(n)==='ยืนยันตั้งโปร 2 รายการ').props.disabled,true);
});

test('catalog and promotion calendar both show the CSV entry for allowed users',()=>{
 const ui=setup([],{canImportPromotions:true,canSettings:true});
 for(const view of [ui.App(),ui.PromotionCalendar({})]){
  assert.ok(nodes(view).some(n=>n.type==='button'&&(n.props['aria-label']||text(n))==='นำเข้าโปรจาก CSV'));
 }
 assert.equal(nodes(setup().App()).some(n=>n.type==='button'&&(n.props['aria-label']||text(n))==='นำเข้าโปรจาก CSV'),false);
});
test('CSV review shows detected full title with an override and separates unresolved products',()=>{
 const inferred={row:2,id:40,input:'acs 1200s',name:'SOUNDVISION ACS-1200S',method:'model',before:'100',price:'80',after:'100',from:'2026-12-01 09:00',until:'2026-12-08 23:59'};
 const preview={total:2,batch:'test',errors:[{row:3,name:'Unknown',selectable:true,message:'ยังไม่พบสินค้า'}],rows:[inferred]};
 const tree=setup(['test',preview,'promo.csv',false,'',null,false]).PromotionImport({onClose:()=>{},onComplete:()=>{}});
 const editable=nodes(tree).find(n=>typeof n.type==='function'&&n.type.name==='PromotionImportReadyRow');
 assert.ok(editable);
 const rowTree=setup().PromotionImportReadyRow(editable.props);
 assert.match(text(rowTree),/SOUNDVISION ACS-1200S.*acs 1200s/);
 assert.ok(nodes(rowTree).some(n=>n.type==='button'&&text(n)==='แก้ไข'));
 assert.ok(nodes(tree).some(n=>n.type==='button'&&text(n)==='ค้นหาและเลือกสินค้า'));
 assert.equal(nodes(rowTree).some(n=>n.type==='button'&&text(n)==='เปลี่ยนสินค้า'),false);
 const editingTree=setup().PromotionImportReadyRow({...editable.props,editing:true});
 assert.ok(nodes(editingTree).some(n=>n.type==='button'&&text(n)==='เปลี่ยนสินค้า'));
 assert.equal(nodes(tree).find(n=>n.type==='button'&&text(n)==='ยืนยันตั้งโปร 2 รายการ').props.disabled,true);
});

test('duplicate comparison shows both promotion schedules and sends the row the user chose to keep',()=>{
 const ui=setup();
 let kept;
 const tree=ui.PromotionDuplicateChoice({
  row:{row:14,name:'D-235O',price:'80',from:'2026-12-01 09:00',until:'2026-12-08 23:59'},
  other:{row:4,name:'SOUNDVISION D-2350',price:'90',from:'2026-12-02 09:00',until:'2026-12-09 23:59'},
  onKeep:number=>{kept=number;}
 });
 assert.match(text(tree),/แถว 14 กับแถว 4 เป็นสินค้าเดียวกัน/);
 assert.match(text(tree),/90 บาท.*80 บาท/);
 nodes(tree).find(n=>n.type==='button'&&text(n)==='เก็บแถว 14').props.onClick();
 assert.equal(kept,14);
});

test('CSV import offers both promotion types and hides restoration columns for permanent prices',()=>{
 const upload=setup().PromotionImport({onClose:()=>{},onComplete:()=>{}});
 const options=nodes(upload).filter(node=>node.type==='input'&&node.props.type==='radio');
 assert.equal(options.length,2);
 assert.equal(options.find(node=>node.props.value==='temporary').props.checked,true);
 const preview={mode:'permanent',total:1,batch:'test',revision:1,errors:[],rows:[
  {row:2,id:40,name:'SOUNDVISION',method:'exact',current_price:'100',price:'80',permanent:true}
 ]};
 const review=setup(['test',preview,'promo.csv',false,'',null,false]).PromotionImport({onClose:()=>{},onComplete:()=>{}});
 assert.match(text(review),/ยืนยันเปลี่ยนราคา 1 รายการ/);
 assert.doesNotMatch(text(review),/คาดว่าหลังจบโปร|จบรายการสุดท้าย/);
});

test('approved CSV row edits price and dates before applying a checked draft update',()=>{
 const row={row:2,name:'Product',price:'80',current_price:'100',after:'100',from:'2026-12-01 09:00',until:'2026-12-08 23:59'};
 let saved;
 const tree=setup().PromotionImportReadyRow({row,editing:true,busy:false,onCheck:values=>{saved=values;},onCancel:()=>{}});
 const inputs=nodes(tree).filter(node=>node.type==='input');
 assert.equal(inputs.length,3);
 assert.equal(inputs.filter(node=>node.props.type==='datetime-local').length,2);
 nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault:()=>{}});
 assert.equal(saved.price,'80');assert.equal(saved.from,row.from);assert.equal(saved.until,row.until);
 assert.match(text(tree),/ตรวจแถวนี้.*ยกเลิก/);
});


test('catalog tabs expose all five scopes, counts and keyboard navigation',()=>{
 let selected,focused;
 const tree=setup().CatalogTabs({scope:'expiring',counts:{all:20,recent:8,current:7,expiring:2,upcoming:3},loading:false,onChange:id=>selected=id});
 const tabs=nodes(tree).filter(n=>n.props.role==='tab');
 assert.equal(tabs.length,5);assert.equal(tabs[3].props['aria-selected'],true);assert.equal(tabs.filter(n=>n.props.tabIndex===0).length,1);
 assert.match(text(tabs[3]),/โปรชั่วคราวใกล้หมด.*2/);tabs[4].props.onClick();assert.equal(selected,'upcoming');
 const event={key:'ArrowRight',preventDefault(){},currentTarget:{parentElement:{querySelectorAll:()=>tabs.map((_,i)=>({focus:()=>focused=i}))}}};
 tabs[4].props.onKeyDown(event);assert.equal(selected,'all');assert.equal(focused,0);
 tabs[2].props.onKeyDown({...event,key:'End'});assert.equal(selected,'upcoming');assert.equal(focused,4);
});
test('promotion tabs survive URL round trips alongside existing filters',()=>{
 const ui=setup();for(const scope of ['current','expiring','upcoming']){
 const state=ui.readWorkspaceLocation('?sdd_scope='+scope+'&sdd_search=ACS&sdd_brand=12&sdd_stock=instock&sdd_promotion=review');
 const next=ui.readWorkspaceLocation(ui.workspaceQuery('',state));assert.equal(next.scope,scope);assert.equal(next.search,'ACS');assert.equal(next.brand,'12');assert.equal(next.status,'instock');assert.equal(next.promotion,'');
 }
});
test('catalog displays the relevant promotion start or end date',()=>{
 const ui=setup(),at=epoch('2026-12-01');
 assert.match(text(ui.CatalogPromotionTiming({row:{temporary_sale:{status:'pending',starts_at:at,ends_at:at+3600}}})),/เริ่ม/);
 assert.match(text(ui.CatalogPromotionTiming({row:{temporary_sale:{status:'active',starts_at:at,ends_at:at+3600}}})),/สิ้นสุด/);
 assert.equal(ui.CatalogPromotionTiming({row:{sale_schedule:{state:'none'}}}),null);
});

test('recovered import explains the next action and offers safe cancellation',()=>{
 const tree=setup(['saved-batch',null,'',false,'',null,true]).PromotionImport({onClose:()=>{},onComplete:()=>{}});
 assert.match(text(tree),/กำลังเปิดชุดนำเข้าเดิม/);
 assert.ok(nodes(tree).find(n=>n.type==='button'&&text(n)==='ตรวจสถานะชุดเดิม'));
 assert.equal(nodes(tree).find(n=>n.type==='button'&&text(n)==='ยกเลิกชุดนี้').props.disabled,true);
});
test('cancellation is disabled while a permanent batch is already processing',()=>{
 const progress={mode:'permanent',status:'running',count:1,processed:1,total:5};
 const tree=setup(['saved-batch',null,'',false,'',null,false,null,'permanent',progress]).PromotionImport({onClose:()=>{},onComplete:()=>{}});
 assert.equal(nodes(tree).find(n=>n.type==='button'&&text(n)==='ยกเลิกชุดนี้').props.disabled,true);
 assert.match(text(tree),/ชุดนี้เริ่มบันทึกแล้ว/);
 assert.ok(nodes(tree).find(n=>n.type==='button'&&text(n)==='ทำรายการที่เหลือต่อ'));
});

test('Thai display uses Buddhist years while timezone offsets and ISO values stay intact',()=>{
 const ui=setup();const input='2026-11-11 13:58';assert.match(ui.displayDate(input),/2569/);assert.match(ui.displayDate(input),/13:58/);assert.equal(input,'2026-11-11 13:58');
 const timestamp=Date.parse('2026-11-11T06:58:00Z')/1000;assert.equal(ui.displayDate(timestamp),ui.displayDate(input));
 const offset=setup([],{timezone:'+07:00'});assert.equal(offset.displayDate(timestamp),ui.displayDate(input));
 assert.match(ui.displayDate('2026-12-31T17:30:00Z'),/2570/);assert.equal(ui.displayDate('bad'),'—');assert.equal(ui.displayDate(null),'—');
});
test('merging a checked row preserves the raw input in another row and detects identity conflicts',()=>{
 const ui=setup(),a={row:2,id:22,name:'A',price:'80',from:'',until:''},b={row:3,id:33,name:'B',price:'70',from:'',until:''};
 const draft=row=>({base:ui.csvRowValues(row),values:{...ui.csvRowValues(row),price:'65'},identity:ui.csvRowIdentity(row),name:row.name});
 const merged=ui.mergeCsvDrafts({'2':draft(a),'3':draft(b)},{rows:[{...a,price:'65'},b],errors:[]},{row:2,values:{price:'65'}});
 assert.equal(merged['2'],undefined);assert.equal(merged['3'].values.price,'65');assert.equal(merged['3'].conflict,false);
 const conflict=ui.mergeCsvDrafts(merged,{rows:[{...b,id:44,name:'Other'}],errors:[]});assert.equal(conflict['3'].conflict,true);assert.equal(conflict['3'].values.price,'65');
 const missing=ui.mergeCsvDrafts(merged,{rows:[],errors:[]});assert.equal(missing['3'].missing,true);assert.equal(missing['3'].values.price,'65');
});


test('mobile expired promotions distinguish the system price from the stored sale',()=>{
 const tree=setup().MobileProductPrices({row:{type:'simple',regular_price:'21900',sale_price:'18615',current_price:'21900',stock_status:'outofstock'}});
 assert.match(text(tree),/ราคาในระบบตอนนี้.*21,900\s+บาท/);
 assert.match(text(tree),/ราคาโปรที่บันทึก.*18,615/);
 const unknown=setup().MobileProductPrices({row:{type:'simple',regular_price:'21900',sale_price:'18615',stock_status:'instock'}});
 assert.match(text(nodes(unknown).find(n=>n.props.className==='sdd-mobile-current-price')),/—/);
});
test('mobile variable products retain both price ranges and the sale count',()=>{
 const tree=setup().MobileProductPrices({row:{type:'variable',variation_summary:{current_min:'800',current_max:'1500',regular_min:'1000',regular_max:'2000',count:3,sale_count:2},stock_status:'instock'}});
 assert.match(text(tree),/ราคาในระบบตอนนี้.*800 – 1,500\s+บาท/);
 assert.match(text(tree),/ช่วงราคาปกติ.*1,000 – 2,000/);
 assert.match(text(tree),/มีโปร 2 \/ 3 ตัวเลือก/);
});
test('CSV editing shows the regular-price ceiling and links the constraint to the input',()=>{
 const row={row:2,name:'Product',price:'80',current_price:'90',regular_price:'100',permanent:true};
 const tree=setup().PromotionImportReadyRow({row,editing:true,busy:false,onCheck:()=>{},onCancel:()=>{}});
 assert.match(text(tree),/ราคาในระบบตอนนี้\s+90 บาท/);assert.match(text(tree),/ราคาปกติ\s+100 บาท/);assert.match(text(tree),/1–99 บาท/);
 const input=nodes(tree).find(n=>n.type==='input');assert.ok(nodes(tree).find(n=>n.props.id===input.props['aria-describedby']));assert.equal(input.props.value,'80');
});
test('price ceiling text preserves integer precision and does not invent a missing ceiling',()=>{
 const ui=setup();assert.match(ui.importPriceLimit('999999999999999'),/999,999,999,999,998/);assert.match(ui.importPriceLimit(null),/ตรวจข้อมูลสินค้า/);assert.match(ui.importPriceLimit('1'),/ยังไม่รองรับ/);
});


test('calendar date buttons and selected-day headings use Thai Buddhist years',()=>{
 const ui=setup();const month=ui.CalendarMonth({month:'2026-11',items:[],selected:'2026-11-17',today:'2026-11-17'});
 const button=nodes(month).find(n=>n.props['aria-pressed']===true);assert.match(button.props['aria-label'],/17.*2569/);assert.doesNotMatch(button.props['aria-label'],/2026/);
 const calendar=setup([false,0,'2026-11','2026-11-17',null,'',false]).PromotionCalendar({month:'2026-11',options:{calendarSelected:'2026-11-17'}});
 assert.match(text(calendar),/โปรวันที่ 17.*2569/);assert.doesNotMatch(text(calendar),/17\/11\/2026/);
});
test('normal calendar messages stay neutral while review messages carry an attention class',()=>{
 function message(status){const value={...item(1,'2026-11-17','2026-11-18'),status,message:'ข้อความสถานะ'};const tree=setup([false,0,'2026-11','2026-11-17',{items:[value]},'',false]).PromotionCalendar({month:'2026-11',options:{calendarSelected:'2026-11-17'}});return nodes(tree).find(n=>String(n.props.className||'').startsWith('sdd-calendar-message'));}
 assert.equal(message('active').props.className,'sdd-calendar-message');assert.match(message('needs_review').props.className,/is-attention/);
});
test('permanent CSV instructions and edit labels do not mention date inputs',()=>{
 const preview={mode:'permanent',total:1,batch:'test',revision:1,errors:[],rows:[{row:2,id:40,name:'Product',price:'80',current_price:'80',permanent:true}]};
 const review=setup(['test',preview,'promo.csv',false,'',null,false]).PromotionImport({onClose:()=>{},onComplete:()=>{}});assert.doesNotMatch(text(review),/ช่องวันเวลา|ค.ศ./);assert.match(text(review),/ล้างวันโปรเดิม/);
 const row=setup().PromotionImportReadyRow({row:preview.rows[0],editing:false});assert.match(nodes(row).find(n=>n.props['data-import-edit']).props['aria-label'],/^แก้ไขราคา แถว/);assert.match(text(row),/ราคาเท่าเดิม/);
});
test('price comparisons handle increases, decreases, zero and large integers exactly',()=>{
 const ui=setup();assert.equal(ui.priceChange('100','80').label,'ลดลง 20 บาท (20%)');assert.equal(ui.priceChange('80','100').label,'เพิ่มขึ้น 20 บาท (25%)');assert.equal(ui.priceChange('0','80').label,'เพิ่มขึ้น 80 บาท');assert.equal(ui.priceChange('999999999999999','999999999999998').kind,'decreased');assert.equal(ui.priceChange('80','80').kind,'same');assert.equal(ui.priceChange(null,'80').kind,'unknown');
 const summary=ui.ImportPriceSummary({permanent:true,rows:[{current_price:'80',price:'80',clears_schedule:true},{current_price:'100',price:'80'}]});assert.match(text(summary),/เท่าเดิม 1 รายการ/);assert.match(text(summary),/ลดลง 1 รายการ/);assert.match(text(summary),/ล้างวันโปรเดิม 1 รายการ/);
});
test('brand controls distinguish not configured, loading, failure and no matches',()=>{
 const ui=setup();let tree=ui.CatalogBrandFilter({configured:false,onSetup:()=>{}});assert.equal(nodes(tree).filter(n=>n.type==='input'||n.type==='select').length,0);assert.match(text(tree),/ตั้งค่าตัวกรองแบรนด์/);
 tree=ui.CatalogBrandFilter({configured:false,loading:true});assert.match(text(tree),/กำลังอ่าน/);assert.doesNotMatch(text(tree),/ยังไม่เปิด/);
 tree=ui.CatalogBrandFilter({configured:true,error:'Network',onRetry:()=>{}});assert.match(text(tree),/ลองโหลดแบรนด์อีกครั้ง/);
 tree=ui.CatalogBrandFilter({configured:true,brands:[{id:'1',name:'Soundvision'}],search:'Missing',value:''});assert.match(text(tree),/ไม่พบแบรนด์ตามคำค้น/);
});
test('restoration review shows the next actions and opens audit separately from closing',()=>{
 const {RestorationCard}=setup();
 const plan={status:'needs_review',message:'ราคาที่แสดงเปลี่ยน',original:{regular_price:'10000',sale_price:'',sale_dates:'|'},ends_at:200};
 let audit=0,closed=0;
 const tree=RestorationCard({plan,currentPrice:'8500',onAudit:()=>audit++,onCloseReview:()=>closed++});
 assert.match(text(tree),/ราคาในระบบล่าสุด\s+8,500/);
 assert.match(text(tree),/ราคาหลังจบตามแผนเดิม\s+10,000/);
 assert.match(text(tree),/ราคาที่แสดงเปลี่ยน/);
 assert.match(text(tree),/เปิดงานนี้ไว้/);
 const button=label=>nodes(tree).find(n=>n.type==='button'&&text(n)===label);
 button('เปิดประวัติราคา').props.onClick();
 assert.equal(audit,1);
 assert.equal(closed,0);
 button('ปิดงานและคงราคาปัจจุบัน').props.onClick();
 assert.equal(closed,1);
 const readOnly=RestorationCard({plan});
 assert.match(text(readOnly),/ให้ผู้ดูแลที่มีสิทธิ์/);
 assert.equal(nodes(readOnly).filter(n=>n.type==='button').length,0);
});
test('matching prices and a committed start are not reported as a successful restoration',()=>{
 const {RestorationCard}=setup();
 const plan={status:'needs_review',original:{regular_price:'35900',sale_price:'',sale_dates:'|'},ends_at:200};
 const tree=RestorationCard({plan,currentPrice:'35900',onCheck:()=>{},check:{result:{start:{status:'succeeded'},end:{status:'unknown'}}}});
 assert.match(text(tree),/ราคาในระบบตรงกับแผนเดิม แต่ยังต้องตรวจผลคำสั่ง/);
 assert.match(text(tree),/เริ่มโปร ·\s+พบผลบันทึกว่าสำเร็จ/);
 assert.match(text(tree),/คืนราคาหลังจบ ·\s+พบคำสั่ง แต่ยังยืนยันผลไม่ได้/);
 assert.doesNotMatch(text(tree),/พบหลักฐานว่าการคืนราคาบันทึกสำเร็จแล้ว/);
});
test('promo draft catches the first invalid field before asking for confirmation',()=>{
 const {promotionDraftError}=setup();
 const valid={price:'30000',start:'2026-11-19T10:00',end:'2026-11-19T12:00'};
 assert.equal(promotionDraftError(valid,'70000','2026-11-19T11:00'),null);
 assert.equal(promotionDraftError({...valid,price:'70000'},'70000','2026-11-19T11:00')[0],'price');
 assert.equal(promotionDraftError({...valid,start:''},'70000','2026-11-19T11:00')[0],'start');
 assert.match(promotionDraftError(valid,'70000','2026-11-19T12:00')[1],/สิ้นสุดแล้ว/);
 assert.match(promotionDraftError({...valid,end:valid.start},'70000','2026-11-19T10:00')[1],/หลังเวลาเริ่ม/);
});
