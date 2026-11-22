import {type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {type Config,validateConfig} from './config.ts';import {MemoryStore} from './memory/store.ts';
export interface AdminServices {
 authenticated(req:IncomingMessage):boolean|Promise<boolean>;store:MemoryStore;getConfig():Config;status():unknown;
 saveConfig(config:Config):Promise<void>;pause(value:boolean):void;
}
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];let size=0;for await(const c of req){size+=c.length;if(size>15*1024*1024)throw new Error('Request too large');chunks.push(Buffer.from(c));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function adminHandler(s:AdminServices){return async(req:IncomingMessage,res:ServerResponse)=>{
 try{
  if(!await s.authenticated(req))return json(res,401,{error:'请先登录伙伴服务管理页。'});
  const path=new URL(req.url??'/', 'http://localhost').pathname.replace(/^\/qq-companion/,'')||'/';
  const method=req.method??'GET';
  if(method==='POST'){
   const origin=`${(req.socket as any).encrypted?'https':'http'}://${req.headers.host}`;
   if(req.headers.origin!==origin||req.headers['x-companion-admin']!=='1'||!req.headers['content-type']?.startsWith('application/json'))return json(res,403,{error:'Origin or admin request header rejected'});
  }
  if(method==='GET'&&['/','/admin.js','/style.css'].includes(path)){
   const file=path==='/'?'admin.html':path.slice(1);res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"});return res.end(readFileSync(join(publicDir,file)));
  }
  if(method==='GET'&&path==='/api/state'){
   const nodes=s.store.list().slice(0,500);return json(res,200,{config:s.getConfig(),status:s.status(),memories:nodes.map(({text,sourceIds,...n})=>({...n,preview:text.slice(0,120)})),totalMemories:Number(s.store.db.prepare('SELECT count(*) n FROM memories').get()!.n),assets:JSON.parse(String(s.store.db.prepare("SELECT value FROM settings WHERE key='assets'").get()?.value??'[]')).map(({file,...a}:any)=>a),audit:s.store.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT 100').all(),outbox:s.store.db.prepare('SELECT id,scope,status,at,receipt FROM outbox ORDER BY at DESC LIMIT 100').all()});
  }
  if(method==='GET'&&path==='/api/memory'){
   const u=new URL(req.url!,'http://localhost'),scope=u.searchParams.get('scope')??'',id=u.searchParams.get('id')??'';
   const memory=s.store.get(scope,id);if(!memory)return json(res,404,{error:'Memory not found'});
   return json(res,200,{memory,versions:s.store.history(scope,id),edges:s.store.edges(scope).filter(e=>e.from===id||e.to===id)});
  }
  if(method!=='POST')return json(res,404,{error:'Not found'});const a=await body(req);
  if(path==='/api/config'){await s.saveConfig(validateConfig(a));return json(res,200,{saved:true});}
  if(path==='/api/pause'){if(typeof a.paused!=='boolean')throw new Error('Invalid pause value');s.pause(a.paused);return json(res,200,{paused:a.paused});}
  if(path==='/api/revise'){
   if(typeof a.reason!=='string'||!a.reason.trim()||a.reason.length>500||typeof a.text!=='string')throw new Error('Text and revision reason required');
   const n=s.store.revise(a.scope,a.id,{text:a.text,sourceIds:['owner:'+randomUUID()],reason:a.reason,...(a.eventTime!==undefined?{eventTime:a.eventTime}:{})});return json(res,200,n);
  }
  if(path==='/api/forget'){
   if(a.confirm!==`DELETE ${a.id}`)throw new Error('Explicit memory deletion confirmation required');s.store.forget(a.scope,a.id);return json(res,200,{deleted:true});
  }
  if(path==='/api/asset'){
   if(typeof a.base64!=='string'||a.base64.length>14*1024*1024||typeof a.title!=='string'||!a.title.trim()||a.title.length>80)throw new Error('Invalid image upload');
   const data=Buffer.from(a.base64,'base64');let ext='';if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))ext='png';else if(data.subarray(0,3).equals(Buffer.from([255,216,255])))ext='jpg';else if(/^GIF8[79]a/.test(data.subarray(0,6).toString()))ext='gif';else if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')ext='webp';
   if(!ext||data.length>10*1024*1024)throw new Error('Upload PNG/JPEG/GIF/WebP up to 10 MB');
   const assets=JSON.parse(String(s.store.db.prepare("SELECT value FROM settings WHERE key='assets'").get()?.value??'[]'));if(assets.length>=50)throw new Error('Maximum 50 local assets');
   const id=randomUUID(),file=`${id}.${ext}`,dir=join(s.getConfig().dataDir,'assets');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,file),data,{flag:'wx'});
   assets.push({id,file,title:a.title,tags:String(a.tags??'').slice(0,200)});s.store.db.prepare("INSERT INTO settings VALUES('assets',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(assets));return json(res,200,{id,title:a.title});
  }
  return json(res,404,{error:'Not found'});
 }catch(e){return json(res,400,{error:e instanceof Error?e.message.slice(0,250):'Request failed'});}
};}
