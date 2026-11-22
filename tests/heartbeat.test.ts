import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../src/memory/store.ts';
import {Heartbeat,type HeartbeatTopic} from '../src/heartbeat.ts';
import {validateConfig} from '../src/config.ts';

const scope='100:private:200',minute=60000,hour=60*minute;
const start=Date.parse('2026-11-14T08:00:00+08:00');
function fixture(){
 const store=new MemoryStore(':memory:');
 const config=validateConfig({enabled:true,selfId:'100',ownerId:'200',friends:['300']});
 const beat=new Heartbeat(store,config,()=>.5);
 user(store,start-hour,'今天想聊聊喜欢的科幻电影，还有最近的跑步计划');
 for(const text of ['科幻电影','跑步','吉他'])store.add({scope,title:text,text:'喜欢'+text,kind:'preference',sourceIds:['user']});
 return {store,config,beat};
}
function user(store:MemoryStore,at:number,text='我回来了，继续聊电影吧'){
 store.db.prepare("INSERT INTO messages(id,scope,role,body,at,state) VALUES(?,?,'user',?,?,'done')").run('u'+at,scope,JSON.stringify({normalizedText:text}),at);
}
function send(store:MemoryStore,at:number,status='sent',id='p'+at){
 store.db.prepare('INSERT INTO outbox(id,scope,turn_id,ordinal,body,status,at,proactive) VALUES(?,?,?,0,?,?,?,1)').run(id,scope,id,'[]',status,at);
}
function until(beat:Heartbeat,from:number,to:number){
 for(let at=from;at<=to;at+=minute){const topic=beat.plan(scope,at);if(topic)return {at,topic};}
}

test('local heartbeat builds interest gradually, persists it, and varies timing without fixed greetings',()=>{
 const {store,config,beat}=fixture();
 try{
  assert.equal(until(beat,start,start+hour),undefined);
  const view=beat.view(scope);assert(view.progress>0&&view.progress<100);
  const resumed=new Heartbeat(store,config,()=>.5);assert.deepEqual(resumed.view(scope),view);
  const ready=until(resumed,start+hour+minute,start+3*hour);assert(ready);assert(['共同兴趣','最近对话'].includes(ready.topic.kind));
  assert.equal(resumed.view(scope).attempts,1);
  assert.equal(resumed.plan(scope,ready.at),undefined); // Reserved before model dispatch.
  assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_model_calls').get()?.n,0);
 }finally{store.close();}
});

test('recent conversation, pending messages, quiet hours, pauses and long outages never accumulate a burst',()=>{
 const {store,beat}=fixture();
 try{
  until(beat,start,start+hour);user(store,start+hour);
  assert.equal(beat.plan(scope,start+hour),undefined);assert.equal(beat.view(scope).progress,0);
  until(beat,start+hour+minute,start+hour+19*minute);assert.equal(beat.view(scope).progress,0);
  assert.equal(beat.plan(scope,start+2*hour,'回复已暂停'),undefined);assert.equal(beat.view(scope).progress,0);
  const late=Date.parse('2026-11-14T23:30:00+08:00');assert.equal(beat.plan(scope,late),undefined);assert.equal(beat.view(scope).reason,'免打扰时段');
  assert.equal(beat.plan(scope,late+9*hour),undefined);assert.equal(beat.view(scope).progress,0);
  store.db.prepare("UPDATE messages SET state='pending' WHERE at=?").run(start+hour);
  assert.equal(beat.plan(scope,late+9*hour+minute),undefined);assert.equal(beat.view(scope).reason,'先处理你发来的消息');
 }finally{store.close();}
});

test('missing handoff still uses real recent conversation; disputed or inferred memories are not prompts',()=>{
 const store=new MemoryStore(':memory:'),config=validateConfig({enabled:true,selfId:'100',ownerId:'200'});
 const beat=new Heartbeat(store,config,()=>.5);
 try{
  user(store,start-hour,'我正在准备明天的面试，有点紧张');
  store.add({scope,title:'猜测秘密',text:'未经确认的事情',kind:'preference',sourceIds:['u'],certainty:'inferred'});
  const ready=until(beat,start,start+3*hour);assert(ready);assert.equal(ready.topic.kind,'最近对话');assert(ready.topic.text.includes('面试'));
  assert(!ready.topic.text.includes('未经确认'));
 }finally{store.close();}
});

test('one unanswered message slows down; two (including unknown receipts) wait for a user response across days',()=>{
 const {store,beat}=fixture();
 try{
  const first=until(beat,start,start+3*hour)!;assert(first);send(store,first.at);beat.finish(scope,first.at,true);
  assert.equal(until(beat,first.at+minute,first.at+4*hour),undefined);
  const second=until(beat,first.at+4*hour+minute,first.at+9*hour);assert(second);assert(second.at-first.at>=6*hour);
  send(store,second.at,'unknown');beat.finish(scope,second.at,true);
  assert.equal(until(beat,second.at+minute,start+DAY),undefined);
  assert.equal(beat.view(scope).reason,'连续两次没有回应，等待你回来');
  user(store,start+DAY+minute);
  assert.equal(beat.plan(scope,start+DAY+minute),undefined);assert.equal(beat.view(scope).unanswered,0);
 }finally{store.close();}
});
const DAY=24*hour;

test('daily cap and owner-only routing are enforced locally, including ambiguous sends',()=>{
 const {store,beat}=fixture();
 try{
  for(let i=0;i<3;i++)send(store,start+i*minute,i===2?'unknown':'sent');
  user(store,start+5*minute);
  assert.equal(beat.plan(scope,start+hour),undefined);assert.equal(beat.view(scope).reason,'今天主动消息已达上限');
  assert.equal(beat.view(scope).todaySent,3);
  assert.equal(beat.plan('100:private:300',start+hour),undefined);
  assert.equal(beat.view('100:private:300').reason,'仅对指定的私聊启用');
  assert.equal(beat.plan('100:group:200',start+hour),undefined);
 }finally{store.close();}
});

test('silence backs off and reserves the used topic, without asking the model every minute',()=>{
 const {store,beat}=fixture();
 try{
  const first=until(beat,start,start+3*hour)!;assert(first);beat.finish(scope,first.at,false);
  assert.equal(until(beat,first.at+minute,first.at+4*hour-minute),undefined);assert.equal(beat.view(scope).attempts,1);
  const second=until(beat,first.at+4*hour,first.at+7*hour);assert(second);assert.notEqual(second.topic.key,first.topic.key);
  beat.finish(scope,second.at,false);assert.equal(beat.view(scope).attempts,2);
 }finally{store.close();}
});
