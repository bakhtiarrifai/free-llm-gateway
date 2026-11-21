import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const servers=[],sockets=new Set(),closed=new Set(),seen=[];
let base,gateway,home,callOpenAI,config;
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
const listen=async handler=>{const s=createServer(handler);servers.push(s);s.on('connection',x=>{sockets.add(x);x.on('close',()=>sockets.delete(x));});await new Promise(ok=>s.listen(0,'127.0.0.1',ok));return `http://127.0.0.1:${s.address().port}`;};
before(async()=>{
  base=await listen(async(req,res)=>{
    let text='';for await(const c of req)text+=c;const body=JSON.parse(text);const m=body.model;seen.push(m);res.on('close',()=>closed.add(m));
    if(m.startsWith('hang'))return;
    if(m==='body-stall'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
    if(m==='prime-stall'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': heartbeat\n\n');return;}
    if(body.stream){
      res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"id":"mock","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');
      if(m==='idle')return;
      const t=setTimeout(()=>res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),m==='pause'?90:0);res.on('close',()=>clearTimeout(t));return;
    }
    res.end('{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}');
  });
  home=mkdtempSync(join(tmpdir(),'free-gateway-timeouts-'));
  writeFileSync(join(home,'config.json'),JSON.stringify({providers:[{id:'mock',base:`${base}/v1`,optionalKey:true,models:['hang-1','hang-2','hang-3','hang-4','good']}],firstByteTimeoutMs:65,requestTimeoutMs:150,streamIdleTimeoutMs:140,sseHeartbeatMs:15}));
  Object.assign(process.env,{GATEWAY_HOME:home,GATEWAY_ENV:join(home,'none'),GATEWAY_KEY:'loopback-test-key-123'});
  ({callOpenAI}=await import('../src/providers.js'));({config}=await import('../src/config.js'));
  const {refreshCatalog}=await import('../src/providers.js');await refreshCatalog();
  const {createGateway}=await import('../src/server.js');const s=createGateway();servers.push(s);s.on('connection',x=>{sockets.add(x);x.on('close',()=>sockets.delete(x));});await new Promise(ok=>s.listen(0,'127.0.0.1',ok));gateway=`http://127.0.0.1:${s.address().port}`;
});
after(async()=>{for(const x of sockets)x.destroy();await Promise.all(servers.map(s=>new Promise(ok=>s.close(ok))));rmSync(home,{recursive:true,force:true});});
const provider=()=>({id:'mock',base:`${base}/v1`,optionalKey:true,firstByteTimeoutMs:45});
const request=(path,body,signal)=>fetch(gateway+path,{method:'POST',headers:{'content-type':'application/json','x-api-key':'loopback-test-key-123'},body:JSON.stringify(body),signal});
test('stream header deadline includes fetch and composes caller signal',async()=>{
  const c=new AbortController();await assert.rejects(callOpenAI(provider(),{model:'hang-headers',stream:true},{signal:c.signal}),/no response/);await sleep(20);assert.ok(closed.has('hang-headers'));assert.equal(c.signal.aborted,false);
});
test('comment-only stream is aborted by first-record timeout',async()=>{
  await assert.rejects(callOpenAI(provider(),{model:'prime-stall',stream:true}),/no response/);await sleep(20);assert.ok(closed.has('prime-stall'));
});
test('hung JSON body is normalized as UpstreamError',async()=>{
  await assert.rejects(callOpenAI(provider(),{model:'body-stall',stream:false}),e=>e.constructor.name==='UpstreamError'&&e.status===0);
});
test('shared request budget bounds all fallbacks on both surfaces and modes',async()=>{
  const {clearCooldown}=await import('../src/state.js');
  for(const path of ['/v1/chat/completions','/v1/messages'])for(const stream of [false,true]){
    for(const m of ['hang-1','hang-2','hang-3','hang-4'])clearCooldown('mock',m);
    const t=Date.now(),before=seen.length;const res=await request(path,{model:'auto',stream,messages:[],max_tokens:10});
    assert.equal(res.status,504);assert.equal(res.headers.get('x-gateway-timeout'),'1');assert.match(await res.text(),/gateway_response_timeout/);assert.ok(Date.now()-t<500);assert.ok(seen.length-before<=3);
  }
});
test('heartbeat comments preserve both surfaces answer content',async()=>{
  for(const path of ['/v1/chat/completions','/v1/messages']){
    const res=await request(path,{model:'mock::pause',stream:true,messages:[],max_tokens:10});assert.equal(res.status,200);
    const text=await res.text();assert.match(text,/: connected/);assert.ok((text.match(/: keepalive/g)??[]).length>=2);assert.equal((text.match(/hello/g)??[]).length,1);
    assert.match(text,path.endsWith('messages')?/message_stop/:/\[DONE\]/);
  }
});
test('timed-out candidates release upstream and later candidate succeeds',async()=>{
  const {clearCooldown}=await import('../src/state.js');for(const m of ['hang-1','hang-2','hang-3','hang-4'])clearCooldown('mock',m);
  const old=config.requestTimeoutMs;config.requestTimeoutMs=600;
  try{const res=await request('/v1/messages',{model:'auto',stream:true,messages:[],max_tokens:10});assert.equal(res.status,200);assert.equal(res.headers.get('x-gateway-model'),'good');assert.match(await res.text(),/message_stop/);assert.ok(closed.has('hang-1'));}finally{config.requestTimeoutMs=old;}
});
test('accepted idle stream ends explicitly without fallback',async()=>{
  const before=seen.length;const res=await request('/v1/chat/completions',{model:'mock::idle',stream:true,messages:[]});assert.match(await res.text(),/stream idle/);assert.equal(seen.length,before+1);
});
test('client disconnect aborts wait for headers',async()=>{
  const c=new AbortController();const pending=request('/v1/messages',{model:'mock::hang-disconnect',stream:true,messages:[]},c.signal);await sleep(20);c.abort();await assert.rejects(pending);await sleep(25);assert.ok(closed.has('hang-disconnect'));
});
test('client disconnect aborts accepted stream',async()=>{
  const c=new AbortController();const res=await request('/v1/messages',{model:'mock::idle',stream:true,messages:[]},c.signal);await res.body.getReader().read();c.abort();await sleep(25);assert.ok(closed.has('idle'));
});
