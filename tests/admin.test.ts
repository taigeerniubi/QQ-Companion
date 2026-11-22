import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {adminHandler} from '../src/admin.ts';import {MemoryStore} from '../src/memory/store.ts';import {defaults} from '../src/config.ts';
test('admin requires host auth, checks origin and retains revision history',async()=>{
 const store=new MemoryStore(':memory:');const n=store.add({scope:'1:private:2',title:'电影',text:'今天电影',kind:'event',sourceIds:['x']});let auth=false;
 const handler=adminHandler({authenticated:()=>auth,store,getConfig:()=>defaults(),status:()=>({paused:false}),saveConfig:async()=>{},pause:()=>{}});
 const server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{assert.equal((await fetch(base+'/qq-companion/api/state')).status,401);auth=true;
 assert.equal((await fetch(base+'/qq-companion/api/state')).status,200);
 const request=(origin:string)=>fetch(base+'/qq-companion/api/revise',{method:'POST',headers:{'content-type':'application/json','x-companion-admin':'1',origin},body:JSON.stringify({scope:n.scope,id:n.id,text:'后天电影',reason:'手动更正'})});
 assert.equal((await request('https://evil.example')).status,403);assert.equal((await request(base)).status,200);assert.equal(store.history(n.scope,n.id).length,2);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
