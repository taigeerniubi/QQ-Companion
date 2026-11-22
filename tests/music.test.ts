import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Music3,musicPrompt} from '../src/models/music3.ts';
import {MusicJobs} from '../src/music-jobs.ts';
import {MemoryStore} from '../src/memory/store.ts';
import {validateConfig} from '../src/config.ts';
import {Companion} from '../src/runtime.ts';

const request={lyrics:'[verse]\n今天阳光真好\n我想对你微笑',style:'Global Metadata\nCheerful Mandarin acoustic pop, light and playful.\nVocal Details\nOne female lead, clear intelligible Mandarin melodic singing.\nArrangement\nVerse: voice enters with guitar; chorus: soft percussion joins the voice, ending in a short cadence.'};
const mp3=Buffer.concat([Buffer.from('ID3'),Buffer.from([0,1,2,13,10,0,255,3,4,5,6,7])]);
function multipart(codes='1,2,3,4,5,6,7,8'){
 const boundary='test-music-boundary';
 return new Response(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({audio_codes:codes})}\r\n--${boundary}\r\nContent-Type: audio/mpeg\r\n\r\n`),mp3,Buffer.from(`\r\n--${boundary}--\r\n`)]),{headers:{'content-type':`multipart/mixed; boundary=${boundary}`}});
}
async function until(fn:()=>boolean){for(let i=0;i<200&&!fn();i++)await delay(5);assert(fn(),'condition did not become true');}

test('Music3 bounds singing requests, validates HTTP endpoints, and decodes binary multipart without following URLs',async()=>{
 for(const base of ['file:///model','ftp://example.com','http://user:secret@127.0.0.1','http://127.0.0.1:8086/?token=x','http://example.com/#secret'])assert.throws(()=>new Music3(base));
 assert.equal(validateConfig({musicBase:'http://192.0.2.10:8086'}).musicBase,'http://192.0.2.10:8086');
 assert.throws(()=>validateConfig({musicMaxSeconds:500}));
 const seen:any[]=[];
 const client=new Music3('http://127.0.0.1:8086',async(url,init)=>{seen.push([String(url),init]);return String(url).endsWith('/synth')?Response.json({id:'job_1'}):String(url).includes('result=1')?multipart():Response.json({status:'done'});});
 assert.equal(await client.submit({...request,requirements:'唱30秒，摇滚女声，不要前奏'},30),'job_1');
 const body=JSON.parse(seen[0][1].body);assert.equal(body.duration,30);assert.equal(body.output_format,'mp3');assert.equal(body.lyrics,request.lyrics);assert(body.caption.startsWith('Global Metadata\n'));assert(body.caption.includes('\nVocal Details\n'));assert(body.caption.includes('\nArrangement\n'));assert(body.caption.includes('唱30秒，摇滚女声，不要前奏'));assert(body.caption.includes('30-second'));assert(body.caption.includes('0:00'));
 await assert.rejects(()=>client.submit({...request,lyrics:'x'.repeat(501)},60));assert.equal(seen.length,1);
 assert.equal(await client.status('job_1',new AbortController().signal),'done');
 const audio=await client.result('job_1',60,new AbortController().signal);assert.deepEqual(audio.audio,mp3);assert.equal(audio.capped,false);
 const capped=new Music3('http://localhost:8086',async()=>multipart(Array(15*25*8).fill('1').join(',')));
 assert.equal((await capped.result('x',15,new AbortController().signal)).capped,true);
});

test('Music3 supports a remote HTTPS path and sends optional authorization only to the configured engine',async()=>{
 const calls:any[]=[],signal=new AbortController().signal;
 const client=new Music3('https://gpu.example.test/music3/',async(url,init)=>{
  calls.push({url:String(url),init});
  return String(url).endsWith('/synth')?Response.json({id:'remote_1'}):String(url).includes('result=1')?multipart():Response.json({status:'done'});
 },'offline-music-token');
 assert.equal(client.base,'https://gpu.example.test/music3');
 await client.submit(request,20);await client.status('remote_1',signal);await client.result('remote_1',20,signal);await client.cancel('remote_1');
 assert.equal(calls.length,4);
 for(const {url,init}of calls){assert(url.startsWith('https://gpu.example.test/music3/'));assert.equal(new Headers(init.headers).get('authorization'),'Bearer offline-music-token');assert.equal(init.redirect,'error');}
 assert(!JSON.stringify(calls.map(c=>c.url)).includes('token'));
});

test('lyrics on tag lines are preserved before the native engine can discard them',()=>{
 const prompt=musicPrompt({...request,lyrics:'[Verse]今天阳光真好\r\n我想对你微笑\n[Chorus]快乐就在这一秒'},20);
 assert.equal(prompt.lyrics,'[verse]\n今天阳光真好\n我想对你微笑\n[chorus]\n快乐就在这一秒');
 assert(!prompt.lyrics.includes('[outro]'));
 assert.throws(()=>musicPrompt({...request,style:'Chinese pop, female voice'},20),/三段式/);
 const intro=musicPrompt({...request,lyrics:'[intro]\n[verse]\n今天阳光真好'},20);
 assert(!intro.caption.includes('0:00'),'an explicitly planned intro must not receive the instant-vocal default');
});

function fixture(options:{send?:any;status?:any;paused?:boolean}={}){
 const directory=mkdtempSync(join(tmpdir(),'qq-music-')),store=new MemoryStore(join(directory,'memory.db'));
 const sends:any[]=[],errors:any[]=[],submits:any[]=[],state={paused:options.paused??false,status:'done'};
 const client={base:'http://127.0.0.1:8086',submit:async(...a:any[])=>{submits.push(a);return 'remote-1';},status:options.status??(async()=>state.status),result:async()=>({audio:mp3,extension:'mp3',capped:false}),cancel:async()=>{}} as any;
 const params={store,directory:join(directory,'songs'),selfId:'100',seconds:60,timeoutMs:60000,pollMs:5,client,bot:{send:options.send??(async(...a:any[])=>{sends.push(a);return {message_id:-77};})},canSend:(scope:string)=>scope==='100:private:200'&&!state.paused,onError:(error:any)=>errors.push(error)};
 const jobs=new MusicJobs(params);
 return {directory,store,sends,errors,submits,state,client,params,jobs,cleanup:async()=>{await jobs.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('songs submit once per turn, save audio, bind the recipient, and send exactly once',async()=>{
 const f=fixture();try{
  const first=await f.jobs.submit('100:private:200','turn-1',request,new AbortController().signal);
  const repeated=await f.jobs.submit('100:private:200','turn-1',request,new AbortController().signal);
  assert.equal(first.id,repeated.id);assert.equal(f.submits.length,1);
  await f.jobs.idle();assert.equal(f.sends.length,1);assert.equal(f.sends[0][0],'100:private:200');assert.equal(f.sends[0][1][0].type,'record');
  const row=f.store.db.prepare('SELECT * FROM music_jobs').get()!;assert.equal(row.state,'sent');assert(existsSync(String(row.file)));
  assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'sent');
  f.jobs.resume();await f.jobs.idle();assert.equal(f.sends.length,1);
  await assert.rejects(()=>f.jobs.submit('100:private:999','other',request,new AbortController().signal),/paused|disabled/);
 }finally{await f.cleanup();}
});

test('pause holds a finished song and a restarted worker resumes the same job without another generation',async()=>{
 let finish!:()=>void;const done=new Promise<void>(r=>{finish=r;});
 const f=fixture({status:async()=>{await done;return 'done';}});let restarted:MusicJobs|undefined;
 try{
  await f.jobs.submit('100:private:200','turn-1',request,new AbortController().signal);
  f.state.paused=true;finish();await f.jobs.idle();assert.equal(f.sends.length,0);assert.equal(f.store.db.prepare('SELECT state FROM music_jobs').get()?.state,'ready');
  await f.jobs.close();f.state.paused=false;restarted=new MusicJobs(f.params);await restarted.idle();
  assert.equal(f.submits.length,1);assert.equal(f.sends.length,1);assert.equal(f.store.db.prepare('SELECT state FROM music_jobs').get()?.state,'sent');
 }finally{await restarted?.close();await f.cleanup();}
});

test('unknown QQ song delivery is durable and never resent after restart',async()=>{
 let sends=0;const f=fixture({send:async()=>{sends++;throw new Error('network timeout');}});let restarted:MusicJobs|undefined;
 try{
  await f.jobs.submit('100:private:200','turn-1',request,new AbortController().signal);await f.jobs.idle();
  assert.equal(sends,1);assert.equal(f.store.db.prepare('SELECT state FROM music_jobs').get()?.state,'unknown');assert.equal(f.store.db.prepare('SELECT status FROM outbox').get()?.status,'unknown');
  await f.jobs.close();restarted=new MusicJobs(f.params);await restarted.idle();assert.equal(sends,1);
 }finally{await restarted?.close();await f.cleanup();}
});

test('generation outlives the chat turn, resumes a rendering job after shutdown, and does not resubmit it',async()=>{
 const f=fixture({status:async(_id:string,signal:AbortSignal)=>{await delay(100000,undefined,{signal});return 'done';}});let restarted:MusicJobs|undefined;
 try{
  const turn=new AbortController();await f.jobs.submit('100:private:200','turn-1',request,turn.signal);turn.abort();
  assert.equal(f.store.db.prepare('SELECT state FROM music_jobs').get()?.state,'rendering');
  await f.jobs.close();f.client.status=async()=> 'done';restarted=new MusicJobs(f.params);await restarted.idle();
  assert.equal(f.submits.length,1);assert.equal(f.sends.length,1);
 }finally{await restarted?.close();await f.cleanup();}
});

test('pause cancels an in-flight identity check and uncertain delivery is not retried',async()=>{
 let entered=false;const f=fixture({send:async(_scope:string,_parts:any,signal:AbortSignal)=>{entered=true;await delay(100000,undefined,{signal});return {message_id:1};}});
 try{
  await f.jobs.submit('100:private:200','turn-1',request,new AbortController().signal);await until(()=>entered);
  f.state.paused=true;f.jobs.hold();await f.jobs.idle();assert.equal(f.store.db.prepare('SELECT state FROM music_jobs').get()?.state,'unknown');
 }finally{await f.cleanup();}
});

test('per-song duration is bounded before submission and is retained with the generated job',async()=>{
 const f=fixture();try{
  await assert.rejects(()=>f.jobs.submit('100:private:200','valid',{...request,style:'unstructured'},new AbortController().signal),/三段式/);
  for(const seconds of [0,14,61,20.5])await assert.rejects(()=>f.jobs.submit('100:private:200','invalid-'+seconds,{...request,duration_seconds:seconds},new AbortController().signal));
  assert.equal(f.submits.length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM music_jobs').get()?.n,0);
  const song=await f.jobs.submit('100:private:200','valid',{...request,duration_seconds:20},new AbortController().signal);
  assert.equal(song.durationSeconds,20);assert.equal(f.submits[0][1],20);await f.jobs.idle();
  assert.equal(f.jobs.latest('100:private:200').durationSeconds,20);
 }finally{await f.cleanup();}
});

test('a conversation continues during song rendering and audio is delivered automatically afterwards',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'qq-song-chat-')),store=new MemoryStore(join(directory,'memory.db'));
 const sends:any[]=[],turns:string[]=[];let finish!:()=>void;
 const done=new Promise<void>(resolve=>{finish=resolve;});
 const client={base:'http://127.0.0.1:8086',submit:async()=> 'background-song',status:async(_id:string,signal:AbortSignal)=>{await Promise.race([done,delay(10000,undefined,{signal})]);return 'done';},result:async()=>({audio:mp3,extension:'mp3',capped:false}),cancel:async()=>{}} as any;
 const bot={status:'connected',send:async(_scope:string,parts:any[])=>{sends.push(parts);return {message_id:-9};},close(){}} as any;
 const config=validateConfig({dataDir:directory,enabled:true,selfId:'100',ownerId:'200',batchMs:0,musicEnabled:true});
 const host={run:async(input:any)=>{turns.push(input.prompt);if(turns.length===1)await input.tools.qq_sing({...request,duration_seconds:20});await input.tools.qq_reply({parts:[{type:'text',text:turns.length===1?'歌曲在后台生成':'我还在，可以继续聊'}]});},extract:async()=>({operations:[],edges:[]}),close:async()=>{}};
 const runtime=new Companion(config,store,bot,host,undefined,client);
 const incoming=(id:number,text:string)=>({self_id:100,post_type:'message',message_type:'private',user_id:200,message_id:id,message:[{type:'text',data:{text}}]});
 try{
  runtime.accept(incoming(1,'唱20秒'));await runtime.flush();
  assert.equal(store.db.prepare('SELECT state FROM music_jobs').get()?.state,'rendering');
  runtime.accept(incoming(2,'歌先做着，我们继续聊今天的天气'));await runtime.flush();
  assert.equal(turns.length,2);assert.equal(sends.length,2);assert.equal(sends[1][0].data.text,'我还在，可以继续聊');
  assert.equal(store.db.prepare('SELECT state FROM music_jobs').get()?.state,'rendering');
  finish();await until(()=>sends.length===3);assert.equal(sends[2][0].type,'record');
  assert.equal(store.db.prepare('SELECT state FROM music_jobs').get()?.state,'sent');
 }finally{finish();await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('runtime injects the actual user requirements and song seconds, while keeping the QQ recipient bound',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'qq-song-runtime-')),store=new MemoryStore(join(directory,'memory.db'));
 const captured:any[]=[],sends:any[]=[];
 const client={base:'http://127.0.0.1:8086',submit:async(...args:any[])=>{captured.push(args);return 'remote-2';},status:async()=> 'done',result:async()=>({audio:mp3,extension:'mp3',capped:false}),cancel:async()=>{}} as any;
 const bot={status:'connected',send:async(...args:any[])=>{sends.push(args);return {message_id:-8};},close(){}} as any;
 const config=validateConfig({dataDir:directory,enabled:true,selfId:'100',ownerId:'200',batchMs:0,musicEnabled:true});
 const host={run:async(input:any)=>{const song=await input.tools.qq_sing({...request,duration_seconds:20,requirements:'forged model requirements'});assert.equal(song.state,'rendering');},extract:async()=>({operations:[],edges:[]}),close:async()=>{}};
 const runtime=new Companion(config,store,bot,host,undefined,client);
 try{
  runtime.accept({self_id:100,post_type:'message',message_type:'private',user_id:200,message_id:1,message:[{type:'text',data:{text:'唱20秒摇滚女声，歌词写快乐出发，不要前奏'}}]});
  await runtime.flush();await until(()=>sends.length===1);
  assert.equal(captured[0][1],20);assert(captured[0][0].requirements.includes('唱20秒摇滚女声，歌词写快乐出发，不要前奏'));assert(!captured[0][0].requirements.includes('forged'));
  assert.equal(sends[0][0],'100:private:200');assert.equal(sends[0][1][0].type,'record');
 }finally{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
