import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startService} from '../src/service.ts';
test('standalone HTTP login, CSRF, persistence and single-instance lifecycle',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qq-service-'));let service:any;
 try{
  service=await startService({config:{dataDir:dir,enabled:false},configPath:join(dir,'config.json'),port:0,env:{}});const base=service.url;
  assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/qq-companion/api/state')).status,401);
  const token=readFileSync(join(dir,'admin-token'),'utf8').trim();assert(token.length>=32);
  const post=(path:string,value:any,cookie='',origin=base)=>fetch(base+'/qq-companion/api/'+path,{method:'POST',headers:{'content-type':'application/json','x-companion-admin':'1',origin,...(cookie?{cookie}:{})},body:JSON.stringify(value)});
  assert.equal((await post('login',{token:'wrong'})).status,401);assert.equal((await post('login',{token},'','https://evil.example')).status,403);
  const login=await post('login',{token});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];assert(login.headers.get('set-cookie')!.includes('HttpOnly'));
  const state=await (await fetch(base+'/qq-companion/api/state',{headers:{cookie}})).json();assert(!JSON.stringify(state).includes(token));assert.equal(state.config.enabled,false);
  assert.equal((await post('pause',{paused:true},cookie)).status,200);
  await assert.rejects(()=>startService({config:{dataDir:dir},configPath:join(dir,'other.json'),port:0,env:{}}),/already running/i);
  await service.close();service=await startService({config:{dataDir:dir},configPath:join(dir,'config.json'),port:0,env:{}});assert.equal(readFileSync(join(dir,'admin-token'),'utf8').trim(),token);assert.equal(service.store.db.prepare("SELECT value FROM settings WHERE key='paused'").get()?.value,'true');
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});
test('standalone service routes an incoming message through DeepSeek tools to QQ with mocked providers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qq-roundtrip-'));const sends:any[]=[];let chatCalls=0;let service:any;
 const fetcher=async(url:any,init:any)=>{
  const p=JSON.parse(init.body);
  if(String(url).includes('api.deepseek.com')){
   const extraction=p.tools.length===1&&p.tools[0].function.name==='memory_submit';
   const tool=extraction?{id:'memory',type:'function',function:{name:'memory_submit',arguments:'{"json":"{\\"operations\\":[],\\"edges\\":[]}"}'}}:{id:'send',type:'function',function:{name:'qq_reply',arguments:'{"parts":[{"type":"text","text":"你好呀"}]}'}};
   const call=extraction||++chatCalls===1;return Response.json({choices:[{message:{role:'assistant',content:call?null:'',...(call?{tool_calls:[tool]}:{})},finish_reason:call?'tool_calls':'stop'}]});
  }
  if(String(url).endsWith('/send_private_msg'))sends.push(p);
  return Response.json({status:'ok',retcode:0,data:String(url).endsWith('/get_login_info')?{user_id:100}:{message_id:-9}});
 };
 try{service=await startService({config:{dataDir:dir,enabled:true,selfId:'100',ownerId:'200',wsUrl:'ws://127.0.0.1:1',batchMs:0},configPath:join(dir,'config.json'),port:0,env:{DEEPSEEK_API_KEY:'offline-key'},fetcher});await service.ready;
  assert(service.runtime.accept({post_type:'message',self_id:100,user_id:200,message_type:'private',message_id:1,message:[{type:'text',data:{text:'你好'}}]}));await service.runtime.flush();
  assert.equal(sends.length,1);assert.equal(sends[0].user_id,200);assert.equal(sends[0].message[0].data.text,'你好呀');assert.equal(service.store.db.prepare('SELECT extracted FROM messages').get()?.extracted,1);assert.equal(service.store.db.prepare('SELECT status FROM outbox').get()?.status,'sent');
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});
