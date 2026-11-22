import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,existsSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startService} from '../src/service.ts';
import {shutdownService} from '../scripts/shutdown.mjs';
const password='offline-test-password';const adminEnv={QQ_ADMIN_PASSWORD:password};
test('standalone HTTP login, CSRF, persistence and single-instance lifecycle',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qq-service-'));let service:any;
 try{
  service=await startService({config:{dataDir:dir,enabled:false},configPath:join(dir,'config.json'),port:0,env:adminEnv});const base=service.url;
  assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/qq-companion/api/state')).status,401);
  assert.equal(existsSync(join(dir,'admin-token')),false);
  const post=(path:string,value:any,cookie='',origin=base)=>fetch(base+'/qq-companion/api/'+path,{method:'POST',headers:{'content-type':'application/json','x-companion-admin':'1',origin,...(cookie?{cookie}:{})},body:JSON.stringify(value)});
  assert.equal((await post('login',{password:'wrong'})).status,401);assert.equal((await post('login',{password},'','https://evil.example')).status,403);
  const login=await post('login',{password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];assert(login.headers.get('set-cookie')!.includes('HttpOnly'));
  const state=await (await fetch(base+'/qq-companion/api/state',{headers:{cookie}})).json();assert(!JSON.stringify(state).includes(password));assert.equal(state.config.enabled,false);
  assert.equal((await post('pause',{paused:true},cookie)).status,200);
  await assert.rejects(()=>startService({config:{dataDir:dir},configPath:join(dir,'other.json'),port:0,env:adminEnv}),/already running/i);
  await service.close();service=await startService({config:{dataDir:dir},configPath:join(dir,'config.json'),port:0,env:adminEnv});assert.equal(existsSync(join(dir,'admin-token')),false);assert.equal(service.store.db.prepare("SELECT value FROM settings WHERE key='paused'").get()?.value,'true');
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
 try{service=await startService({config:{dataDir:dir,enabled:true,selfId:'100',ownerId:'200',wsUrl:'ws://127.0.0.1:1',batchMs:0},configPath:join(dir,'config.json'),port:0,env:{...adminEnv,DEEPSEEK_API_KEY:'offline-key'},fetcher});await service.ready;
  assert(service.runtime.accept({post_type:'message',self_id:100,user_id:200,message_type:'private',message_id:1,message:[{type:'text',data:{text:'你好'}}]}));await service.runtime.flush();
  assert.equal(sends.length,1);assert.equal(sends[0].user_id,200);assert.equal(sends[0].message[0].data.text,'你好呀');assert.equal(service.store.db.prepare('SELECT extracted FROM messages').get()?.extracted,1);assert.equal(service.store.db.prepare('SELECT status FROM outbox').get()?.status,'sent');
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});
test('password is mandatory even with an old token file, and a fresh data directory is created automatically',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qq-password-'));let service:any;
 try{
  writeFileSync(join(dir,'admin-token'),'old-token-value-that-must-not-be-used');
  await assert.rejects(async()=>{const unexpected=await startService({config:{dataDir:dir},configPath:join(dir,'config.json'),port:0,env:{}});await unexpected.close();},/QQ_ADMIN_PASSWORD/);
  const dataDir=join(dir,'new-machine','data');assert.equal(existsSync(dataDir),false);
  service=await startService({config:{dataDir},configPath:join(dir,'config.json'),port:0,env:adminEnv});assert(existsSync(join(dataDir,'memory.db')));assert.equal(existsSync(join(dataDir,'admin-token')),false);
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy config migrates, password rotation revokes old sessions, and stop uses password login',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qq-auth-migration-')),configPath=join(dir,'config.json');let service:any;
 const login=(base:string,p:string)=>fetch(base+'/qq-companion/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json','x-companion-admin':'1'},body:JSON.stringify({password:p})});
 try{
  writeFileSync(configPath,JSON.stringify({dataDir:dir,adminTokenEnv:'OLD_TOKEN_VAR'}));service=await startService({configPath,port:0,env:adminEnv});
  const first=await login(service.url,password);assert.equal(first.status,200);const cookie=first.headers.get('set-cookie')!.split(';')[0];await service.close();
  const next='another-offline-password';service=await startService({configPath,port:0,env:{QQ_ADMIN_PASSWORD:next}});
  assert.equal((await login(service.url,password)).status,401);assert.equal((await fetch(service.url+'/qq-companion/api/state',{headers:{cookie}})).status,401);
  assert.equal((await fetch(service.url+'/qq-companion/api/state',{headers:{authorization:'Bearer '+next}})).status,401);
  await shutdownService(service.url,next);await service.closed;
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});
