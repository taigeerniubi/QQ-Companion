import {test} from 'node:test';import assert from 'node:assert/strict';
import {MemoryStore} from '../src/memory/store.ts';import {Companion} from '../src/runtime.ts';import {defaults,validateConfig} from '../src/config.ts';
import {OneBot} from '../src/qq/onebot.ts';
const conf=()=>validateConfig({...defaults(),enabled:true,selfId:'100',ownerId:'200',groups:['300'],batchMs:0});
const event=(id=1,extra={})=>({self_id:100,post_type:'message',message_type:'private',user_id:200,message_id:id,time:1794470400,message:[{type:'text',data:{text:'你好'}}],...extra});
function fixture(behavior?:any){const store=new MemoryStore(':memory:');const calls:any[]=[];const prompts:any[]=[];
 const bot={status:'connected',send:async(...args:any[])=>{calls.push(args);return {message_id:-10};},call:async()=>({base64:'AQI='}),close(){}};
 const host={run:async(input:any)=>{prompts.push(input);await (behavior??(async(i:any)=>i.tools.qq_reply({parts:[{type:'text',text:'你好呀'}]})))(input);},extract:async()=>({operations:[],edges:[],handoff:''}),close:async()=>{}};
 return {store,calls,prompts,bot,host,runtime:new Companion(conf(),store,bot as any,host,undefined,undefined,{heartbeatRandom:()=>.5})};
}
test('same input is processed once and wrong accounts/self/disabled targets ignored',async()=>{
 const f=fixture();assert.equal(f.runtime.accept(event()),true);assert.equal(f.runtime.accept(event()),false);
 assert.equal(f.runtime.accept(event(2,{self_id:999})),false);assert.equal(f.runtime.accept(event(3,{user_id:100})),false);assert.equal(f.runtime.accept(event(4,{user_id:999})),false);
 await f.runtime.flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'100:private:200');await f.runtime.close();f.store.close();
});
test('pause prevents a tool dispatch even after turn preparation and group target stays bound',async()=>{
 const f=fixture(async(i:any)=>{f.runtime.pause(true);await assert.rejects(()=>i.tools.qq_reply({parts:[{type:'text',text:'不得发出'}],target:'other'}),/paused/);});
 f.runtime.accept(event(1,{message_type:'group',group_id:300}));await f.runtime.flush();assert.equal(f.calls.length,0);await f.runtime.close();f.store.close();
});
test('unknown sends are recorded and not retried on duplicate event or restart',async()=>{
 const f=fixture();f.bot.send=async(...args:any[])=>{f.calls.push(args);throw new Error('network timeout');};f.runtime.accept(event());await f.runtime.flush();
 assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'unknown');assert.equal(f.calls.length,1);
 f.runtime.accept(event());await f.runtime.flush();assert.equal(f.calls.length,1);await f.runtime.close();f.store.close();
});
test('only seed and catalog reach host until explicit read, no candidate full-body leakage',async()=>{
 const f=fixture(async(i:any)=>{assert(!JSON.stringify(i.prompt).includes('UNREAD_SECRET'));});
 const s='100:private:200',a=f.store.add({scope:s,title:'电影',text:'电影计划',kind:'event',sourceIds:['s']}),b=f.store.add({scope:s,title:'后续',text:'UNREAD_SECRET',kind:'event',sourceIds:['s']});f.store.link(s,a.id,b.id,'follow_up',['s']);
 f.runtime.accept(event(1,{message:[{type:'text',data:{text:'电影'}}]}));await f.runtime.flush();assert.equal(f.prompts.length,1);assert.equal(f.store.get(s,b.id)?.reads,0);await f.runtime.close();f.store.close();
});
test('heartbeat calls host only after a real opportunity, sends at most once and does not call during quiet hours',async()=>{
 const f=fixture(async(i:any)=>{assert(i.prompt.includes('本地心跳'));assert(i.prompt.includes('电影'));await i.tools.qq_reply({parts:[{type:'text',text:'上次说的电影，你看了没？'}]});await assert.rejects(()=>i.tools.qq_reply({parts:[{type:'text',text:'再来一句'}]}),/one proactive/);});
 const scope='100:private:200',start=Date.parse('2026-11-14T08:00:00+08:00');
 f.store.db.prepare("INSERT INTO messages(id,scope,role,body,at,state,extracted) VALUES('seed',?,'user',?,?,'done',1)").run(scope,JSON.stringify({normalizedText:'最近想去看科幻电影，等我想好了告诉你'}),start-3600000);
 await f.runtime.tick(Date.parse('2026-11-13T23:30:00+08:00'));assert.equal(f.calls.length,0);
 for(let t=start;t<start+4*3600000;t+=60000)await f.runtime.tick(t);
 assert.equal(f.calls.length,1);assert.equal(f.prompts.length,1);
 assert.equal(f.runtime.status().heartbeat.todaySent,1);await f.runtime.close();f.store.close();
});

test('an incoming message cancels a prepared proactive send and is answered normally',async()=>{
 let interrupted=false;
 const f=fixture(async(i:any)=>{
  if(i.prompt.includes('本地心跳')){
   interrupted=true;f.runtime.accept(event(40,{time:Date.parse('2026-11-14T10:00:00+08:00')/1000}));
   await assert.rejects(()=>i.tools.qq_reply({parts:[{type:'text',text:'过时的主动消息'}]}),/paused|disabled/);
  }else await i.tools.qq_reply({parts:[{type:'text',text:'回复刚收到的消息'}]});
 });
 const start=Date.parse('2026-11-14T08:00:00+08:00');
 f.store.db.prepare("INSERT INTO messages(id,scope,role,body,at,state,extracted) VALUES('seed','100:private:200','user',?,?,'done',1)").run(JSON.stringify({normalizedText:'想聊聊明天看电影的计划'}),start-3600000);
 for(let t=start;t<start+4*3600000&&!interrupted;t+=60000)await f.runtime.tick(t);
 await f.runtime.flush();assert(interrupted);assert.equal(f.calls.length,1);assert.equal(f.calls[0][1][0].data.text,'回复刚收到的消息');
 assert.equal(f.store.db.prepare('SELECT proactive FROM outbox').get()?.proactive,0);
 await f.runtime.close();f.store.close();
});
test('unknown outcome blocks another send attempt within the same turn',async()=>{
 const f=fixture(async(i:any)=>{for(let n=0;n<2;n++)try{await i.tools.qq_reply({parts:[{type:'text',text:'hello'}]});}catch{}});
 f.bot.send=async(...a:any[])=>{f.calls.push(a);throw new Error('timeout');};f.runtime.accept(event());await f.runtime.flush();assert.equal(f.calls.length,1);await f.runtime.close();f.store.close();
});
test('QQ favorite stickers resolve only IDs from trusted gateway catalog',async()=>{
 const f=fixture(async(i:any)=>{const catalog=await i.tools.qq_stickers({});assert.equal(catalog.favorites[0].id,'abc');await i.tools.qq_reply({parts:[{type:'sticker',id:'abc'}]});});
 f.bot.call=async()=>[{emoji_id:'abc',url:'https://example.com/face.png',desc:'开心'}] as any;
 f.runtime.accept(event());await f.runtime.flush();assert.equal(f.calls[0]?.[1]?.[0]?.type,'image');await f.runtime.close();f.store.close();
});
test('malformed or async gateway send acknowledgements are unknown and block retries',async()=>{
 for(const response of [{},{status:'async',retcode:1,data:{ticket:1}},{status:'failed',retcode:0}]){
  let sends=0;const f=fixture(async(i:any)=>{for(let n=0;n<2;n++)try{await i.tools.qq_reply({parts:[{type:'text',text:'hello'}]});}catch{}});
  const bot=new OneBot({selfId:'100',httpUrl:'http://localhost',wsUrl:'ws://localhost',token:''},async url=>{if(String(url).endsWith('get_login_info'))return Response.json({status:'ok',retcode:0,data:{user_id:100}});sends++;return Response.json(response);});
  f.bot.send=async(scope:any,parts:any,signal:any)=>bot.send(scope,parts,signal);f.runtime.accept(event());await f.runtime.flush();assert.equal(sends,1);assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'unknown');await f.runtime.close();bot.close();f.store.close();
 }
});
