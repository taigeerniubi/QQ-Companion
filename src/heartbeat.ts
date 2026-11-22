import {createHash} from 'node:crypto';
import {type Config,allowed} from './config.ts';
import {type MemoryStore} from './memory/store.ts';

const MINUTE=60000,DAY=24*60*MINUTE;
export interface HeartbeatTopic {key:string;kind:string;text:string;weight:number}
interface HeartbeatState {
 version:1;at:number;drive:number;threshold:number;activity:number;userAt:number;
 nextAttempt:number;silences:number;day:string;attempts:number;used:Record<string,number>;
 reason:string;lastAttempt:number;todaySent:number;unanswered:number;
}
export interface HeartbeatView {reason:string;progress:number;todaySent:number;dailyLimit:number;attempts:number;unanswered:number;lastChecked:number;lastAttempt:number}
export function beijingDay(now:number){return new Date(now+8*60*MINUTE).toISOString().slice(0,10);}
const fingerprint=(text:string)=>createHash('sha256').update(text.normalize('NFKC').replace(/\s+/g,' ').trim()).digest('hex').slice(0,24);

// A local, persistent stochastic accumulator. Ticks never call a model.
// Threshold jitter spreads contact times; interest, availability and reciprocity change its rate.
export class Heartbeat {
 private store:MemoryStore;private config:Config;private random:()=>number;
 constructor(store:MemoryStore,config:Config,random:()=>number=Math.random){this.store=store;this.config=config;this.random=random;}
 private jitter(){return .8+this.random()*.4;}
 private read(scope:string):HeartbeatState|undefined {
  const row=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get('heartbeat:'+scope);
  if(!row)return;const state=JSON.parse(String(row.value));return state.version===1?state:undefined;
 }
 private save(scope:string,state:HeartbeatState){this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('heartbeat:'+scope,JSON.stringify(state));}
 private cap(scope:string){return scope===`${this.config.selfId}:private:${this.config.ownerId}`?this.config.ownerDaily:this.config.friendDaily;}
 private interval(scope:string){return Math.max(30,scope.endsWith(':private:'+this.config.ownerId)?this.config.ownerIntervalMinutes:1440)*MINUTE;}
 view(scope:string):HeartbeatView {
  const s=this.read(scope);return {reason:s?.reason??'等待下一次本地心跳',progress:s?Math.min(100,Math.round(s.drive/s.threshold*100)):0,todaySent:s?.todaySent??0,dailyLimit:this.cap(scope),attempts:s?.attempts??0,unanswered:s?.unanswered??0,lastChecked:s?.at??0,lastAttempt:s?.lastAttempt??0};
 }
 private topics(scope:string,now:number,state:HeartbeatState):HeartbeatTopic[]{
  const result:HeartbeatTopic[]=[];
  const add=(kind:string,text:string,weight:number)=>{
   if(!text.trim())return;const key=fingerprint(kind+':'+text);
   if(state.used[key]&&now-state.used[key]!<DAY)return;
   result.push({kind,text:text.slice(0,500),weight,key});
  };
  for(const node of this.store.list(scope).slice(0,80)){
   if(node.state!=='current'||node.certainty==='inferred')continue;
   const age=now-node.updatedAt;
   if(node.kind==='preference'&&age<90*DAY)add('共同兴趣',node.title+'：'+node.text,1.1);
   else if((node.kind==='event'||node.kind==='promise')&&node.eventTime){
    const date=node.eventTime.slice(0,10),distance=Date.parse(date+'T12:00:00+08:00')-now;
    if(distance>=-2*DAY&&distance<=DAY)add('近期安排',`${date} · ${node.title}：${node.text}`,1.8);
   }else if(node.kind==='emotion'&&age<DAY)add('近期心情',node.title+'：'+node.text,1.5);
   else if(['event','promise'].includes(node.kind)&&age<3*DAY)add('待续话题',node.title+'：'+node.text,1.3);
  }
  const handoff=this.store.db.prepare('SELECT text,updated_at FROM handoffs WHERE scope=?').get(scope);
  if(handoff&&now-Number(handoff.updated_at)<3*DAY)add('上次话题',String(handoff.text),1.2);
  // Work even when memory extraction chose not to create a handoff. Raw messages remain data.
  if(!result.length){
   const last=this.store.db.prepare("SELECT body,at FROM messages WHERE scope=? AND role='user' ORDER BY at DESC LIMIT 1").get(scope);
   if(last&&now-Number(last.at)<DAY){
    const body=JSON.parse(String(last.body));
    const text=body.normalizedText??(body.message??[]).filter((p:any)=>p.type==='text').map((p:any)=>String(p.data?.text??'')).join('\n');
    if(text.trim().length>=8)add('最近对话',text,1);
   }
  }
  return result.sort((a,b)=>b.weight-a.weight).slice(0,12);
 }
 private rhythm(scope:string,now:number){
  const rows=this.store.db.prepare("SELECT at FROM messages WHERE scope=? AND role='user' AND at>? ORDER BY at DESC LIMIT 120").all(scope,now-30*DAY);
  if(rows.length<8)return 1;
  const hours=Array<number>(24).fill(0),slots=new Set<string>();
  for(const row of rows){const d=new Date(Number(row.at)+8*60*MINUTE),hour=d.getUTCHours(),slot=d.toISOString().slice(0,13);if(!slots.has(slot)){slots.add(slot);hours[hour]!++;}}
  const smooth=hours.map((n,h)=>n+hours[(h+23)%24]!*.5+hours[(h+1)%24]!*.5);
  return .8+.4*smooth[new Date(now+8*60*MINUTE).getUTCHours()]!/Math.max(1,...smooth);
 }
 plan(scope:string,now:number,blocked?:string):HeartbeatTopic|undefined {
  const db=this.store.db,cfg=this.config,day=beijingDay(now),interval=this.interval(scope);
  const lastUser=Number(db.prepare("SELECT max(at) t FROM messages WHERE scope=? AND role='user'").get(scope)?.t??0);
  const activity=Math.max(lastUser,Number(db.prepare("SELECT max(at) t FROM outbox WHERE scope=? AND status IN ('sent','sending','unknown')").get(scope)?.t??0));
  const sends=db.prepare("SELECT max(at) at FROM outbox WHERE scope=? AND proactive=1 AND status IN ('sent','sending','unknown') GROUP BY turn_id ORDER BY at DESC").all(scope);
  const lastSend=Number(sends[0]?.at??0),unanswered=sends.filter(row=>Number(row.at)>=lastUser).length;
  const s=this.read(scope)??{version:1,at:now,drive:0,threshold:this.jitter(),activity,userAt:lastUser,nextAttempt:0,silences:0,day,attempts:0,used:{},reason:'正在等待合适时机',lastAttempt:0,todaySent:0,unanswered:0};
  const elapsed=Math.max(0,now-s.at);s.at=now;
  s.todaySent=sends.filter(row=>beijingDay(Number(row.at))===day).length;s.unanswered=unanswered;
  if(s.day!==day){s.day=day;s.attempts=0;}
  for(const [key,at]of Object.entries(s.used))if(now-at>7*DAY)delete s.used[key];
  if(activity!==s.activity){s.activity=activity;s.drive=0;s.threshold=this.jitter();}
  if(lastUser>s.userAt){s.userAt=lastUser;s.silences=0;s.nextAttempt=0;}
  if(elapsed>10*MINUTE){s.drive=0;s.nextAttempt=Math.max(s.nextAttempt,now+20*MINUTE);}
  const wait=(reason:string,reset=false)=>{s.reason=reason;if(reset)s.drive=0;this.save(scope,s);return undefined;};
  if(blocked)return wait(blocked,true);
  if(!cfg.enabled||!cfg.proactive)return wait('主动聊天已关闭',true);
  if(!allowed(cfg,scope)||!scope.includes(':private:')||cfg.proactiveOwnerOnly&&scope!==`${cfg.selfId}:private:${cfg.ownerId}`)return wait('仅对指定的私聊启用',true);
  const hour=new Date(now+8*60*MINUTE).getUTCHours(),start=cfg.quietStart,end=cfg.quietEnd;
  if(start<end?hour>=start&&hour<end:start!==end&&(hour>=start||hour<end))return wait('免打扰时段',true);
  if(!lastUser)return wait('等待首次聊天',true);
  if(s.todaySent>=this.cap(scope))return wait('今天主动消息已达上限',true);
  if(s.attempts>=this.cap(scope))return wait('今天已完成主动聊天判断',true);
  if(unanswered>=2)return wait('连续两次没有回应，等待你回来',true);
  if(db.prepare("SELECT 1 FROM messages WHERE scope=? AND state IN ('pending','processing')").get(scope))return wait('先处理你发来的消息',true);
  if(now-activity<20*MINUTE)return wait('刚聊过，留一点空间',true);
  if(lastSend&&now-lastSend<interval*(unanswered?2:1))return wait(unanswered?'上次还没回应，延长等待':'离上次主动聊天还太近');
  if(now<s.nextAttempt)return wait(s.silences?'暂时没有合适内容，稍后再想':'稍后再找合适时机');
  const topics=this.topics(scope,now,s);if(!topics.length)return wait('暂时没有新话题',true);
  // Never accumulate a night's or an outage's worth of missed ticks.
  s.drive+=Math.min(elapsed,2*MINUTE)/interval*this.rhythm(scope,now)*(1+(topics[0]!.weight-1)*.3)/(unanswered?2:1);
  if(s.drive<s.threshold)return wait(unanswered?'放慢节奏，等你有空':'正在等待自然的聊天时机');
  let draw=this.random()*topics.reduce((sum,t)=>sum+t.weight,0);let topic=topics[0]!;
  for(const item of topics){draw-=item.weight;if(draw<=0){topic=item;break;}}
  // Reserve the opportunity before any model call, so concurrent ticks or a restart cannot duplicate it.
  s.drive=0;s.threshold=this.jitter();s.attempts++;s.lastAttempt=now;s.nextAttempt=now+interval;
  s.used[topic.key]=now;s.reason='正在结合话题组织消息';this.save(scope,s);
  return topic;
 }
 finish(scope:string,now:number,sent:boolean){
  const s=this.read(scope);if(!s)return;
  s.drive=0;s.silences=sent?0:s.silences+1;
  s.nextAttempt=now+Math.min(DAY,this.interval(scope)*2**s.silences);
  s.reason=sent?'已主动联系，等你有空回应':'这次没有合适内容，降低打扰频率';
  if(sent){s.todaySent++;s.unanswered++;}
  this.save(scope,s);
 }
}
