import { randomUUID } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type MemoryStore } from './memory/store.ts';
import { OneBotError, type OneBot } from './qq/onebot.ts';
import { musicPrompt,type Music3,type SongRequest } from './models/music3.ts';

interface Job { id:string;scope:string;turn_id:string;remote_id:string|null;state:string;request:string;file:string|null;at:number;capped:number; }
interface Options {
 store:MemoryStore;bot:Pick<OneBot,'send'>;client:Music3;directory:string;selfId:string;
 seconds:number;timeoutMs:number;canSend:(scope:string)=>boolean;onError:(error:unknown)=>void;pollMs?:number;
}
export class MusicJobs {
 private tasks=new Map<string,Promise<void>>();
 private lifetime=new AbortController();
 private deliveries=new Set<AbortController>();
 private timer:ReturnType<typeof setInterval>;
 private options:Options;
 constructor(options:Options) {
  this.options=options;
  const db=options.store.db;
  db.prepare("UPDATE music_jobs SET state='interrupted',error='Submission interrupted; not automatically resubmitted' WHERE state='submitting'").run();
  db.prepare("UPDATE music_jobs SET state='unknown',error='Sending interrupted; check QQ before retrying' WHERE state='sending'").run();
  this.timer=setInterval(()=>this.resume(),options.pollMs??2000);this.timer.unref();
  this.resume();
 }
 private get(id:string){return this.options.store.db.prepare('SELECT * FROM music_jobs WHERE id=?').get(id) as unknown as Job;}
 latest(scope:string){
  return this.options.store.db.prepare("SELECT id,state,error,at,updated_at,capped,json_extract(request,'$.seconds') AS durationSeconds FROM music_jobs WHERE scope=? ORDER BY at DESC LIMIT 1").get(scope)??{state:'none'};
 }
 async submit(scope:string,turn:string,request:SongRequest,signal:AbortSignal) {
  signal.throwIfAborted();
  if(this.lifetime.signal.aborted||!this.options.canSend(scope))throw new Error('Singing is paused or disabled');
  const db=this.options.store.db;
  const existing=db.prepare('SELECT id,state FROM music_jobs WHERE turn_id=?').get(turn);
  if(existing)return {...existing,duplicate:true};
  if(db.prepare("SELECT scope FROM music_jobs WHERE state IN ('submitting','rendering','ready','sending')").all().some(row=>this.options.canSend(String(row.scope))))throw new Error('A song is already generating or waiting to send; use qq_song_status');
  // Validate before reserving a durable job; never let an invalid call occupy the queue.
  if(typeof request.lyrics!=='string'||!request.lyrics.trim()||request.lyrics.length>500||typeof request.style!=='string'||!request.style.trim()||request.style.length>1500)throw new Error('Use 1–500 lyric characters and 1–1500 style characters');
  const seconds=request.duration_seconds??this.options.seconds;
  if(!Number.isInteger(seconds)||seconds<15||seconds>this.options.seconds)throw new Error(`歌曲秒数需在15–${this.options.seconds}之间；超过当前上限需先调整管理配置。`);
  musicPrompt(request,seconds);
  const id=randomUUID(),at=Date.now(),payload={...request,seconds,base:this.options.client.base};
  db.prepare("INSERT INTO music_jobs(id,scope,turn_id,state,request,at,updated_at) VALUES(?,?,?,'submitting',?,?,?)").run(id,scope,turn,JSON.stringify(payload),at,at);
  try {
   const remote=await this.options.client.submit(request,seconds,AbortSignal.any([signal,this.lifetime.signal]));
   db.prepare("UPDATE music_jobs SET remote_id=?,state='rendering',updated_at=? WHERE id=?").run(remote,Date.now(),id);
   this.resume();
   return {id,state:'rendering',durationSeconds:seconds,maxSeconds:this.options.seconds,note:'歌曲正在后台生成，完成后自动发到当前会话；尚未发送歌曲，不要重复生成。'};
  }catch(error){
   db.prepare("UPDATE music_jobs SET state='interrupted',error=?,updated_at=? WHERE id=?").run('Submission failed or outcome unknown; not automatically resubmitted',Date.now(),id);
   throw error;
  }
 }
 resume(){
  if(this.lifetime.signal.aborted)return;
  const rows=this.options.store.db.prepare("SELECT * FROM music_jobs WHERE state IN ('rendering','ready') ORDER BY at").all() as unknown as Job[];
  for(const job of rows){
   if(!job.scope.startsWith(this.options.selfId+':')||this.tasks.has(job.id)||!this.options.canSend(job.scope))continue;
   const task=this.run(job).catch(error=>this.options.onError(error)).finally(()=>this.tasks.delete(job.id));
   this.tasks.set(job.id,task);
  }
 }
 private async run(job:Job){
  const {store,client}=this.options,db=store.db;
  try {
   const saved=JSON.parse(job.request);if(saved.base!==client.base)throw new Error('Music3 endpoint changed; old song was not resumed on another engine');
   if(job.state==='rendering'){
    const remaining=job.at+this.options.timeoutMs-Date.now();
    if(remaining<=0)throw new Error('Music3 generation timed out');
    const signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(remaining)]);
    let failures=0;
    for(;;){
     signal.throwIfAborted();
     let status:string;
     try {status=await client.status(job.remote_id!,signal);failures=0;}
     catch(error){if(signal.aborted||++failures>=4)throw error;await delay(this.options.pollMs??2000,undefined,{signal});continue;}
     if(status==='done')break;
     if(status==='failed'||status==='cancelled')throw new Error('Music3 generation '+status);
     await delay(this.options.pollMs??2000,undefined,{signal});
    }
    const request=JSON.parse(job.request),result=await client.result(job.remote_id!,request.seconds,signal);
    signal.throwIfAborted();mkdirSync(this.options.directory,{recursive:true});
    const file=join(this.options.directory,job.id+'.'+result.extension);
    writeFileSync(file+'.tmp',result.audio);renameSync(file+'.tmp',file);
    db.prepare("UPDATE music_jobs SET state='ready',file=?,capped=?,updated_at=? WHERE id=?").run(file,result.capped?1:0,Date.now(),job.id);
    job=this.get(job.id);
   }
   if(this.lifetime.signal.aborted||!this.options.canSend(job.scope))return;
   // Persist the intent before dispatch. A crash or ambiguous acknowledgement never replays a send.
   const prior=db.prepare('SELECT status FROM outbox WHERE id=?').get(job.id);
   if(prior){db.prepare('UPDATE music_jobs SET state=?,updated_at=? WHERE id=?').run(prior.status==='sent'?'sent':'unknown',Date.now(),job.id);return;}
   const parts=[{type:'record',data:{file:'base64://'+readFileSync(job.file!).toString('base64')}}];
   if(this.lifetime.signal.aborted||!this.options.canSend(job.scope))return;
   db.prepare("INSERT INTO outbox(id,scope,turn_id,ordinal,body,status,at,proactive) VALUES(?,?,?,?,?,'sending',?,0)").run(job.id,job.scope,'song:'+job.id,0,JSON.stringify(parts),Date.now());
   db.prepare("UPDATE music_jobs SET state='sending',updated_at=? WHERE id=?").run(Date.now(),job.id);
   try {
    const delivery=new AbortController();this.deliveries.add(delivery);
    let receipt;
    try {receipt=await this.options.bot.send(job.scope,parts,AbortSignal.any([this.lifetime.signal,delivery.signal]));}
    finally {this.deliveries.delete(delivery);}
    db.prepare("UPDATE outbox SET status='sent',receipt=? WHERE id=?").run(JSON.stringify(receipt),job.id);
    db.prepare("UPDATE music_jobs SET state='sent',updated_at=? WHERE id=?").run(Date.now(),job.id);
   }catch(error){
    const state=error instanceof OneBotError?'failed':'unknown';
    db.prepare('UPDATE outbox SET status=? WHERE id=?').run(state,job.id);
    db.prepare('UPDATE music_jobs SET state=?,error=?,updated_at=? WHERE id=?').run(state,'QQ song delivery failed; check outbox',Date.now(),job.id);
    throw error;
   }
  }catch(error){
   if(this.lifetime.signal.aborted)return; // Config changes/restarts resume the same remote job, not a new generation.
   const current=this.get(job.id);
   if(current.state==='rendering'||current.state==='ready'){
    db.prepare("UPDATE music_jobs SET state='failed',error=?,updated_at=? WHERE id=?").run(error instanceof Error?error.message.slice(0,200):'Song failed',Date.now(),job.id);
    if(current.state==='rendering'&&current.remote_id&&JSON.parse(current.request).base===client.base)await client.cancel(current.remote_id);
   }
   throw error;
  }
 }
 async idle(){await Promise.allSettled(this.tasks.values());}
 hold(){for(const delivery of this.deliveries)delivery.abort();}
 async close(){clearInterval(this.timer);this.lifetime.abort();await this.idle();}
}
