import { endpoint,postJson,type Fetcher } from '../http.ts';
export interface Segment {type:string;data:Record<string,unknown>}
export interface OneBotOptions {httpUrl:string;wsUrl:string;selfId:string;token:string;timeoutMs?:number}
export class OneBotError extends Error { code:number;constructor(code:number){super(`OneBot rejected action (${code})`);this.code=code;this.name='OneBotError';} }
export class OneBot {
 readonly options:OneBotOptions;private fetcher:Fetcher;private socket:WebSocket|null=null;private retry:ReturnType<typeof setTimeout>|null=null;private stopped=true;private delay=1000;
 status='disconnected';lastError='';
 private lifetime=new AbortController();
 constructor(options:OneBotOptions,fetcher:Fetcher=fetch){endpoint(options.httpUrl);endpoint(options.wsUrl,['ws:','wss:']);if(!/^\d+$/.test(options.selfId))throw new Error('selfId required');this.options=options;this.fetcher=fetcher;}
 async call(action:string,params:unknown={},signal?:AbortSignal):Promise<any>{
  if(!/^[a-z_]+$/.test(action))throw new Error('Invalid action');
  const combined=signal?AbortSignal.any([signal,this.lifetime.signal]):this.lifetime.signal;
  const result=await postJson(this.fetcher,this.options.httpUrl.replace(/\/$/,'')+'/'+action,this.options.token,params,combined,this.options.timeoutMs??30000);
  if(result?.retcode===0&&result?.status==='ok')return result.data;
  // Only a definite failure acknowledgement is retryable. An async or malformed
  // acknowledgement may follow a successful external side effect.
  if(result?.status==='failed'&&Number.isSafeInteger(result.retcode)&&result.retcode>1)throw new OneBotError(result.retcode);
  throw new Error('OneBot outcome is unknown: incomplete or asynchronous acknowledgement');
 }
 async probe(signal?:AbortSignal){const info=await this.call('get_login_info',{},signal);if(String(info?.user_id)!==this.options.selfId){this.status='identity_mismatch';throw new Error('QQ identity mismatch');}return info;}
 async send(scope:string,parts:Segment[],signal?:AbortSignal):Promise<{message_id:number}>{
  const [self,type,id]=scope.split(':');if(self!==this.options.selfId||!/^\d+$/.test(id??'')||!['private','group'].includes(type??''))throw new Error('Invalid conversation scope');
  await this.probe(signal);
  const result=await this.call(type==='group'?'send_group_msg':'send_private_msg',{[type==='group'?'group_id':'user_id']:Number(id),message:parts},signal);
  if(!Number.isSafeInteger(result?.message_id)||result.message_id===0)throw new Error('Send acknowledged without a usable receipt');return result;
 }
 async connect(onEvent:(event:unknown)=>void,onError:(error:Error)=>void=()=>{}){
  this.stopped=false;
  const open=async()=>{
   if(this.stopped)return;try{await this.probe();if(this.stopped)return;
    const url=new URL(this.options.wsUrl);if(this.options.token)url.searchParams.set('access_token',this.options.token);
    const ws=new WebSocket(url);this.socket=ws;this.status='connecting';
    ws.addEventListener('open',()=>{this.delay=1000;this.status='connected';this.lastError='';});
    ws.addEventListener('message',e=>{
     try{if(typeof e.data!=='string'||e.data.length>4*1024*1024)return;const event=JSON.parse(e.data);
      if(event.self_id!==undefined&&String(event.self_id)!==this.options.selfId){this.stopped=true;this.status='identity_mismatch';ws.close();throw new Error('QQ event identity mismatch');}
      if(String(event.self_id)===this.options.selfId)onEvent(event);
     }catch{onError(new Error('Invalid QQ event or account identity'));}
    });
    ws.addEventListener('error',()=>{this.lastError='WebSocket transport error';onError(new Error(this.lastError));});
    ws.addEventListener('close',()=>{if(!this.stopped){this.status='disconnected';schedule();}});
   }catch(e){this.lastError=e instanceof Error?e.message:'Connection failed';onError(new Error(this.lastError));if(this.status==='identity_mismatch'){this.stopped=true;return;}schedule();}
  };
  const schedule=()=>{if(this.stopped||this.retry)return;this.retry=setTimeout(()=>{this.retry=null;void open();},this.delay);this.retry.unref();this.delay=Math.min(30000,this.delay*2);};
  await open();
 }
 close(){this.stopped=true;this.lifetime.abort();if(this.retry)clearTimeout(this.retry);this.retry=null;this.socket?.close();this.socket=null;this.status='disconnected';}
}
