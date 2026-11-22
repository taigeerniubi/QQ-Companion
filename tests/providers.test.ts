import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OneBot,OneBotError} from '../src/qq/onebot.ts';
import {QwenSpeech} from '../src/models/qwen.ts';
import {extractMemories} from '../src/models/extraction.ts';
import {MemoryStore} from '../src/memory/store.ts';

test('OneBot checks identity and retcode, preserves negative message IDs',async()=>{
 const seen:any[]=[];const bot=new OneBot({httpUrl:'http://127.0.0.1:3000',wsUrl:'ws://127.0.0.1:3001',selfId:'123',token:'secret'},async(url,init)=>{seen.push([url,init]);return Response.json({status:'ok',retcode:0,data:String(url).endsWith('get_login_info')?{user_id:123}:{message_id:-25}});});
 await bot.probe();assert.equal((await bot.send('123:private:456',[{type:'text',data:{text:'你好'}}])).message_id,-25);
 assert.equal(seen[0][1].headers.Authorization,'Bearer secret');assert.throws(()=>new OneBot({httpUrl:'https://example.com?a=secret',wsUrl:'ws://localhost',selfId:'1',token:''}));
 const wrong=new OneBot({httpUrl:'http://localhost',wsUrl:'ws://localhost',selfId:'123',token:''},async()=>Response.json({status:'ok',retcode:0,data:{user_id:999}}));await assert.rejects(()=>wrong.probe(),/identity/);
 const fail=new OneBot({httpUrl:'http://localhost',wsUrl:'ws://localhost',selfId:'123',token:''},async()=>Response.json({status:'failed',retcode:1400,message:'denied'}));await assert.rejects(()=>fail.call('get_status'),OneBotError);
});
test('every send rechecks the account before dispatch after a gateway account change',async()=>{
 let actual=123;const actions:string[]=[];const bot=new OneBot({httpUrl:'http://localhost',wsUrl:'ws://localhost',selfId:'123',token:''},async(url)=>{const action=new URL(String(url)).pathname;actions.push(action);return Response.json({status:'ok',retcode:0,data:action==='/get_login_info'?{user_id:actual}:{message_id:1}});});await bot.probe();actual=999;await assert.rejects(()=>bot.send('123:private:456',[{type:'text',data:{text:'hello'}}]),/identity/);assert(!actions.includes('/send_private_msg'));
});
test('Qwen sends native ASR/TTS payloads and reads audio without credential forwarding',async()=>{
 const calls:any[]=[];const voice=new QwenSpeech({apiBase:'https://workspace.cn-beijing.maas.aliyuncs.com',apiKey:'key',asrModel:'qwen-audio-3.0-asr-flash',ttsModel:'qwen-audio-3.1-tts-flash',voice:'voice'},async(url,init)=>{
  calls.push([String(url),init]);if(String(url).includes('multimodal-generation'))return Response.json({output:{choices:[{message:{content:[{text:'后天去看电影'}]}}]}});
  if(String(url).includes('SpeechSynthesizer'))return Response.json({output:{audio:{url:'https://result.oss-cn-beijing.aliyuncs.com/voice.wav'}}});
  return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/wav'}});
 });
 assert.equal(await voice.transcribe(Buffer.from([1,2])),'后天去看电影');assert.equal((await voice.synthesize('好呀')).length,3);
 const payload=JSON.parse(calls[0][1].body);assert(payload.input.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'));
 assert.equal(JSON.parse(calls[1][1].body).input.voice,'voice');assert.equal(calls[2][1].headers,undefined);
});
test('extraction revises same event with evidence and rejects ungrounded/foreign references atomically',async()=>{
 const s=new MemoryStore(':memory:');const scope='1:private:2';const a=s.add({scope,title:'看电影',text:'周五去看电影',kind:'event',sourceIds:['old']});
 const messages=[{id:'new',role:'user',text:'改到周日吧',at:Date.parse('2026-11-12T12:00:00+08:00')}];
 let prompt='';const model=async(p:string)=>{prompt=p;return {operations:[{op:'revise',id:a.id,text:'周日去看电影',title:'看电影',reason:'用户明确改期',sourceIds:['new'],evidence:[{sourceId:'new',quote:'改到周日吧'}],eventTime:'2026-11-15'}],edges:[],handoff:'周日看电影'};};
 await extractMemories(model,s,scope,messages);assert.equal(s.history(scope,a.id).length,2);assert(prompt.includes('2026-11-12'));assert(prompt.includes('周五去看电影'));
 await assert.rejects(()=>extractMemories(async()=>({operations:[{op:'revise',id:a.id,text:'凭空编造',sourceIds:['new'],evidence:[{sourceId:'new',quote:'原话不存在'}],reason:'guess'}],edges:[]}),s,scope,messages),/evidence/);
 assert.equal(s.history(scope,a.id).length,2);s.close();
});
test('full user batch is retained in extraction when assistant replies are appended',async()=>{
 const s=new MemoryStore(':memory:');const messages=[...Array.from({length:20},(_,i)=>({id:`u${i}`,role:'user',text:`第${i}条新事实`,at:1})),...Array.from({length:3},(_,i)=>({id:`a${i}`,role:'assistant',text:'好',at:2}))];let prompt='';await extractMemories(async p=>{prompt=p;return {operations:[],edges:[]};},s,'1:private:2',messages);for(let i=0;i<20;i++)assert(prompt.includes(`"id":"u${i}"`),`missing user ${i}`);s.close();
});
test('a stale extraction proposal cannot overwrite a manual memory revision',async()=>{
 const s=new MemoryStore(':memory:'),scope='1:private:2';const a=s.add({scope,title:'电影',text:'周五电影',kind:'event',sourceIds:['old']});
 await assert.rejects(()=>extractMemories(async()=>{s.revise(scope,a.id,{text:'电影已取消',sourceIds:['owner'],reason:'手动核对'});return {operations:[{op:'revise',id:a.id,text:'周日电影',title:'电影',reason:'改期',sourceIds:['new'],evidence:[{sourceId:'new',quote:'周日吧'}]}],edges:[]};},s,scope,[{id:'new',role:'user',text:'周日吧',at:1}]),/stale/i);assert.equal(s.get(scope,a.id)?.text,'电影已取消');assert.equal(s.history(scope,a.id).length,2);s.close();
});
