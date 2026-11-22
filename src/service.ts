import {createServer as httpServer,type IncomingMessage,type ServerResponse} from 'node:http';import {createServer as netServer} from 'node:net';
import {createHash} from 'node:crypto';import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,realpathSync} from 'node:fs';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {validateConfig,type Config} from './config.ts';import {MemoryStore} from './memory/store.ts';import {DeepSeekAgent} from './agent.ts';import {Companion} from './runtime.ts';import {OneBot} from './qq/onebot.ts';import {QwenSpeech} from './models/qwen.ts';import {adminHandler} from './admin.ts';import {AdminAuth,json,sameOrigin,smallBody} from './auth.ts';import {type Fetcher} from './http.ts';
export interface ServiceOptions {configPath?:string;config?:Partial<Config>;port?:number;env?:Record<string,string|undefined>;fetcher?:Fetcher}
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
async function instanceLock(dataDir:string){
 let canonical=realpathSync(dataDir);if(process.platform==='win32')canonical=canonical.toLowerCase();const hash=createHash('sha256').update(canonical).digest('hex').slice(0,32);
 const address=process.platform==='win32'?`\\\\.\\pipe\\qq-companion-${hash}`:process.platform==='linux'?`\0qq-companion-${hash}`:null;
 if(!address)throw new Error('Standalone service currently supports Windows and Linux');
 const lock=netServer(socket=>socket.destroy());
 await new Promise<void>((ok,fail)=>{const error=()=>fail(new Error('A companion service is already running for this data directory'));lock.once('error',error);lock.listen(address,()=>{lock.off('error',error);ok();});});return lock;
}
export async function startService(options:ServiceOptions={}){
 const path=resolve(options.configPath??join(projectRoot,'config.local.json')),env=options.env??process.env;
 let config=validateConfig({...options.config,...(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{})});mkdirSync(config.dataDir,{recursive:true});
 const lock=await instanceLock(config.dataDir);let store:MemoryStore;let auth:AdminAuth;
 try{store=new MemoryStore(join(config.dataDir,'memory.db'));auth=new AdminAuth(config.dataDir,env[config.adminTokenEnv]);}catch(e){try{store!.close();}catch{}await new Promise<void>(r=>lock.close(()=>r()));throw e;}
 store.db.prepare("UPDATE agent_turns SET status='interrupted' WHERE status='running'").run();
 let runtime:Companion|undefined,closing=false,updating=false,error='',timer:ReturnType<typeof setInterval>|undefined;
 let lifecycle=Promise.resolve(),background:Promise<void>|undefined,closePromise:Promise<void>|undefined;let resolveClosed!:()=>void;
 const closed=new Promise<void>(r=>{resolveClosed=r;});
 const queue=(fn:()=>Promise<void>)=>{const task=lifecycle.then(fn);lifecycle=task.catch(()=>{});return task;};
 const launch=async()=>{
  if(closing||!config.enabled)return;
  if(!env[config.deepseekKeyEnv])throw new Error('DeepSeek API key is not configured');
  const bot=new OneBot({httpUrl:config.httpUrl,wsUrl:config.wsUrl,selfId:config.selfId,token:env[config.onebotTokenEnv]??''},options.fetcher);
  const speech=new QwenSpeech({apiBase:config.qwenBase,apiKey:env[config.qwenKeyEnv]??'',asrModel:config.asrModel,ttsModel:config.ttsModel,voice:config.voice},options.fetcher);
  const instance=new Companion(config,store,bot,new DeepSeekAgent(config,store,env[config.deepseekKeyEnv]??'',options.fetcher),speech);runtime=instance;
  await bot.connect(e=>instance.accept(e),e=>{if(runtime===instance&&!closing)error=e.message;});
  if(!closing)await instance.flush();
 };
 const saveConfig=async(next:Config)=>{
  if(closing||updating)throw new Error('Service is stopping or updating');
  if(resolve(next.dataDir)!==resolve(config.dataDir)||next.port!==config.port||next.adminTokenEnv!==config.adminTokenEnv)throw new Error('Stop the service and edit config.local.json to change dataDir/port/adminTokenEnv');
  if(next.enabled&&!env[next.deepseekKeyEnv])throw new Error('Set the DeepSeek API key before enabling');
  updating=true;try{await queue(async()=>{if(closing)throw new Error('Service is stopping');
   await runtime?.close();runtime=undefined;await background;
   mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(next,null,2)+'\n');renameSync(path+'.tmp',path);config=next;error='';await launch();
  });}finally{updating=false;}
 };
 const admin=adminHandler({authenticated:req=>auth.authenticated(req),store,getConfig:()=>config,status:()=>({...runtime?.status(),service:'standalone',enabled:config.enabled,paused:store.db.prepare("SELECT value FROM settings WHERE key='paused'").get()?.value==='true',error,updating}),saveConfig,pause:value=>{if(runtime)runtime.pause(value);else store.db.prepare("INSERT INTO settings VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value));if(!value)void runtime?.flush().catch(e=>{error=e.message;});}});
 const staticFile=(res:ServerResponse,file:string,type:string)=>{res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(readFileSync(join(projectRoot,'public',file)));};
 let actualPort=0;
 const handle=async(req:IncomingMessage,res:ServerResponse)=>{
  if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(req.headers.host??''))return json(res,403,{error:'Host rejected'});
  if(closing)return json(res,503,{error:'Service is stopping'});
  const p=new URL(req.url??'/','http://localhost').pathname;
  if(req.method==='GET'&&p==='/healthz')return json(res,200,{ok:true,service:'qq-companion',pid:process.pid});
  if(req.method==='GET'&&(p==='/'||p==='/qq-companion')){res.writeHead(302,{location:'/qq-companion/'});return res.end();}
  if(req.method==='GET'&&p==='/qq-companion/login')return staticFile(res,'login.html','text/html');
  if(req.method==='GET'&&p==='/qq-companion/login.js')return staticFile(res,'login.js','text/javascript');
  if(req.method==='GET'&&p==='/qq-companion/style.css')return staticFile(res,'style.css','text/css');
  if(req.method==='POST'&&['/qq-companion/api/login','/qq-companion/api/logout','/qq-companion/api/shutdown'].includes(p)){
   if(!sameOrigin(req))return json(res,403,{error:'Origin rejected'});
   if(p.endsWith('/login'))return auth.login((await smallBody(req)).token,res);
   if(!auth.authenticated(req))return json(res,401,{error:'请先登录管理页。'});
   if(p.endsWith('/logout'))return auth.logout(req,res);
   json(res,200,{stopping:true});setImmediate(()=>void close());return;
  }
  if(req.method==='GET'&&p==='/qq-companion/'&&!auth.authenticated(req)){res.writeHead(302,{location:'/qq-companion/login'});return res.end();}
  if(!p.startsWith('/qq-companion/'))return json(res,404,{error:'Not found'});
  await admin(req,res);
 };
 const server=httpServer((req,res)=>{void handle(req,res).catch(e=>{if(res.headersSent)res.end();else json(res,400,{error:e instanceof Error?e.message.slice(0,240):'Request failed'});});});server.requestTimeout=15000;server.headersTimeout=10000;
 const close=():Promise<void>=>{
  if(closePromise)return closePromise;closing=true;if(timer)clearInterval(timer);
  const early=runtime?.close();const httpClosed=new Promise<void>(r=>server.close(()=>r()));const force=setTimeout(()=>server.closeAllConnections(),5000);force.unref();
  closePromise=(async()=>{try{await early;await lifecycle;await background;await runtime?.close();await httpClosed;}finally{clearTimeout(force);auth.close();store.close();await new Promise<void>(r=>lock.close(()=>r()));resolveClosed();}})();return closePromise;
 };
 try{await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(options.port??config.port,'127.0.0.1',()=>{server.off('error',fail);ok();});});}catch(e){await close();throw e;}
 actualPort=(server.address() as {port:number}).port;
 const ready=queue(launch).catch(e=>{if(!closing)error=e instanceof Error?e.message:'Start failed';});
 timer=setInterval(()=>{if(closing||updating||background||!runtime)return;const instance=runtime;background=(async()=>{await instance.retryExtraction();if(!closing&&!updating)await instance.tick();})().catch(e=>{if(!closing)error=e instanceof Error?e.message:'Background work failed';}).finally(()=>{background=undefined;});},60000);timer.unref();
 return {url:`http://127.0.0.1:${actualPort}`,store,ready,closed,close,get runtime(){return runtime;}};
}
