const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8');
const client = source.slice(source.indexOf('class ApiError'), source.indexOf('const datePart='));
const json = (data, status=200, nonce) => new Response(JSON.stringify(data), {status, headers:nonce?{'X-WP-Nonce':nonce}:{}});
const html = status => new Response('<!DOCTYPE html><title>Access denied</title>', {status});
function setup(handler) {
 const calls=[], events=[];
 const context = vm.createContext({cfg:{api:'/wp-json/sdd/v1/',ajax:'/wp-admin/admin-ajax.php',nonce:'old',userId:7},AbortController,setTimeout,clearTimeout,CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},window:{dispatchEvent:e=>events.push(e)},fetch:async(url,options)=>{calls.push({url,options});return handler(url,options,calls.length);}});
 vm.runInContext("let nonce=cfg.nonce;\n"+client+"\nthis.client={api,renewNonce,reconnect:async()=>{await renewNonce();connectionError=null;}}",context);
 return {...context.client,calls,events};
}
const tests=[];
const test=(name,fn)=>tests.push([name,fn]);
test('fresh REST nonce is used by the next request',async()=>{
 const s=setup((u,o,n)=>{assert.equal(o.headers['X-WP-Nonce'],n===1?'old':'fresh');return json({ok:true},200,'fresh');});
 await s.api('products');await s.api('brands');assert.equal(s.calls.length,2);
});
test('explicit nonce rejection renews once and retries the same operation',async()=>{
 const body={operation_id:'existing-operation',price:'12000'};
 const s=setup((u,o,n)=>u.includes('admin-ajax')?json({success:true,data:{nonce:'new',user_id:7}}):o.headers['X-WP-Nonce']==='old'?json({code:'rest_cookie_invalid_nonce',message:'expired'},403):json({ok:true}));
 assert.equal((await s.api('products/1/field',body)).ok,true);assert.equal(s.calls.length,3);
 assert.equal(s.calls[0].options.body,s.calls[2].options.body);assert.equal(s.events.length,0);
});
test('parallel nonce failures share one refresh request',async()=>{
 const s=setup(async(u,o)=>u.includes('admin-ajax')?json({success:true,data:{nonce:'new',user_id:7}}):o.headers['X-WP-Nonce']==='old'?json({code:'rest_cookie_invalid_nonce',message:'expired'},403):json({ok:true}));
 await Promise.all([s.api('products'),s.api('brands'),s.api('promotion-articles')]);assert.equal(s.calls.filter(c=>c.url.includes('admin-ajax')).length,1);assert.equal(s.calls.length,7);
});
test('HTML 403 pauses requests without exposing a JSON parsing error',async()=>{
 const s=setup(()=>html(403));await assert.rejects(s.api('products'),e=>e.status===403&&e.code==='request_blocked'&&!e.message.includes('Unexpected token'));
 await assert.rejects(s.api('brands'),e=>e.code==='session_unavailable');assert.equal(s.calls.length,1);assert.equal(s.events.length,1);
});
test('HTML 403 during a save keeps the result unknown and never replays it',async()=>{
 const s=setup(()=>html(403));await assert.rejects(s.api('products/1/field',{operation_id:'same-id'}),e=>e.code==='operation_unknown');assert.equal(s.calls.length,1);assert.equal(s.events.length,1);
});
test('HTML 200 during a save remains unknown without replay',async()=>{
 const s=setup(()=>html(200));await assert.rejects(s.api('products/1/field',{operation_id:'same-id'}),e=>e.code==='operation_unknown');assert.equal(s.calls.length,1);
});
test('expired login pauses without trying nonce refresh',async()=>{
 const s=setup(()=>json({code:'cookie_required',message:'กรุณาเข้าสู่ระบบ'},401));await assert.rejects(s.api('products'),e=>e.status===401);assert.equal(s.calls.length,1);assert.equal(s.events.length,1);
});
test('a product permission failure does not log out the whole workspace',async()=>{
 const s=setup((u,o,n)=>n===1?json({code:'forbidden',message:'ไม่มีสิทธิ์แก้สินค้านี้'},403):json({ok:true}));await assert.rejects(s.api('products/1/field',{}),e=>e.code==='forbidden');await s.api('products');assert.equal(s.events.length,0);
});
test('blocked nonce endpoint pauses rather than looping',async()=>{
 const s=setup(u=>u.includes('admin-ajax')?html(403):json({code:'rest_cookie_invalid_nonce',message:'expired'},403));await assert.rejects(s.api('products'),e=>e.status===403);await assert.rejects(s.api('brands'));assert.equal(s.calls.length,2);assert.equal(s.events.length,1);
});
test('nonce is never replayed under a different account',async()=>{
 const s=setup(u=>u.includes('admin-ajax')?json({success:true,data:{nonce:'new',user_id:8}}):json({code:'rest_cookie_invalid_nonce',message:'expired'},403));await assert.rejects(s.api('products/1/field',{}),e=>e.code==='session_changed');assert.equal(s.calls.length,2);assert.equal(s.events.length,1);
});
test('a repeated nonce rejection stops after one retry',async()=>{
 const s=setup(u=>u.includes('admin-ajax')?json({success:true,data:{nonce:'new',user_id:7}}):json({code:'rest_cookie_invalid_nonce',message:'expired'},403));await assert.rejects(s.api('products'));assert.equal(s.calls.length,3);assert.equal(s.events.length,1);
});
test('manual reconnect resumes requests after successful cookie authentication',async()=>{
 let blocked=true;
 const s=setup(u=>u.includes('admin-ajax')?json({success:true,data:{nonce:'new',user_id:7}}):blocked?html(403):json({ok:true}));await assert.rejects(s.api('products'));blocked=false;await s.reconnect();assert.equal((await s.api('products')).ok,true);assert.equal(s.calls.length,3);
});
(async()=>{for(const [name,fn] of tests){await fn();console.log('PASS '+name);}console.log(tests.length+' scenarios passed');})().catch(e=>{console.error(e);process.exitCode=1;});
