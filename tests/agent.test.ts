import {test} from 'node:test';import assert from 'node:assert/strict';
import {DeepSeekAgent} from '../src/agent.ts';import {MemoryStore} from '../src/memory/store.ts';import {defaults} from '../src/config.ts';
const signal=()=>new AbortController().signal;
const reply=(message:any,finish='stop')=>Response.json({choices:[{message:{role:'assistant',...message},finish_reason:finish}]});
test('standalone loop validates tools, stores history and isolates scopes across restarts',async()=>{
 const s=new MemoryStore(':memory:');const requests:any[]=[];let n=0;let sent=0;
 const fetcher=async(_url:any,init:any)=>{const p=JSON.parse(init.body);requests.push(p);n++;return n===1?reply({content:null,tool_calls:[{id:'c1',type:'function',function:{name:'qq_reply',arguments:JSON.stringify({parts:[{type:'text',text:'你好'}]})}}]},'tool_calls'):reply({content:'结束'});};
 const config=defaults();let a=new DeepSeekAgent(config,s,'key',fetcher);const input={scope:'1:private:2',turn:'t1',prompt:'USER_SCOPE_TWO',tools:{qq_reply:async()=>{sent++;return {sent:true};}},signal:signal()};
 await a.run(input);assert.equal(sent,1);assert.equal(requests[0].thinking.type,'disabled');assert.equal(requests[1].messages.at(-1).tool_call_id,'c1');await a.close();
 a=new DeepSeekAgent(config,s,'key',fetcher);await a.run({...input,turn:'t2',prompt:'新的消息'});assert(JSON.stringify(requests[2].messages).includes('USER_SCOPE_TWO'));
 await a.run({...input,scope:'1:private:3',turn:'t3',prompt:'第三个会话'});assert(!JSON.stringify(requests[3].messages).includes('USER_SCOPE_TWO'));await a.close();s.close();
});
test('malformed/unknown tool calls never execute and HTTP errors propagate',async()=>{
 const s=new MemoryStore(':memory:');let sent=0,n=0;const a=new DeepSeekAgent(defaults(),s,'key',async()=>++n===1?reply({content:null,tool_calls:[{id:'a',type:'function',function:{name:'qq_reply',arguments:'{"parts":[],"target":"other"}'}},{id:'b',type:'function',function:{name:'bash',arguments:'{}'}}]},'tool_calls'):reply({content:''}));
 await a.run({scope:'s',turn:'t',prompt:'hi',tools:{qq_reply:async()=>{sent++;return {};}},signal:signal()});assert.equal(sent,0);await a.close();
 const fail=new DeepSeekAgent(defaults(),s,'key',async()=>new Response('no',{status:401}));await assert.rejects(()=>fail.run({scope:'s',turn:'f',prompt:'hi',tools:{},signal:signal()}),/401/);assert.equal(s.db.prepare("SELECT status FROM agent_turns WHERE id='f'").get()?.status,'failed');await fail.close();s.close();
});
test('memory extraction has only memory_submit and no chat history',async()=>{
 const s=new MemoryStore(':memory:');const a=new DeepSeekAgent(defaults(),s,'key',async(_u,init)=>{const p=JSON.parse(String(init?.body));assert.equal(p.tools.length,1);assert.equal(p.tools[0].function.name,'memory_submit');assert.equal(p.messages.length,2);return reply({content:null,tool_calls:[{id:'s',type:'function',function:{name:'memory_submit',arguments:JSON.stringify({json:'{"operations":[],"edges":[]}'})}}]},'tool_calls');});assert.deepEqual(await a.extract('记忆原话'),{operations:[],edges:[]});await a.close();s.close();
});
test('cancel interrupts the provider request and retains a failed turn without dispatching tools',async()=>{
 const s=new MemoryStore(':memory:'),controller=new AbortController();let called!:()=>void;const started=new Promise<void>(r=>{called=r;});
 const a=new DeepSeekAgent(defaults(),s,'key',async(_u,init)=>{called();return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));});
 const task=a.run({scope:'s',turn:'cancel',prompt:'hi',tools:{},signal:controller.signal});await started;controller.abort();await assert.rejects(()=>task,/cancel/);assert.equal(s.db.prepare("SELECT status FROM agent_turns WHERE id='cancel'").get()?.status,'failed');await a.close();s.close();
});
test('repeated tool calls terminate at the per-turn step budget',async()=>{
 const s=new MemoryStore(':memory:');let calls=0;const a=new DeepSeekAgent(defaults(),s,'key',async()=>{calls++;return reply({content:null,tool_calls:[{id:'c'+calls,type:'function',function:{name:'memory_search',arguments:'{"query":"电影"}'}}]},'tool_calls');});
 await assert.rejects(()=>a.run({scope:'s',turn:'loop',prompt:'hi',tools:{memory_search:async()=>({seeds:[]})},signal:signal()}),/budget/);assert.equal(calls,8);await a.close();s.close();
});
