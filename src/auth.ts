import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {type IncomingMessage,type ServerResponse} from 'node:http';
export function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
export function sameOrigin(req:IncomingMessage):boolean{return req.headers.origin===`http://${req.headers.host}`&&req.headers['x-companion-admin']==='1'&&Boolean(req.headers['content-type']?.startsWith('application/json'));}
export async function smallBody(req:IncomingMessage){const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)throw new Error('Login request too large');chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export class AdminAuth {
 private digest:Buffer;private sessions=new Map<string,number>();private failures=0;private window=Date.now();
 constructor(password:string|undefined,envName='QQ_ADMIN_PASSWORD'){
  if(!password?.trim())throw new Error(`请在 .env 或 .env.local 中设置 ${envName} 后再启动服务。`);
  if(password.length<8||password.length>512)throw new Error(`${envName} 必须为 8–512 个字符。`);
  this.digest=createHash('sha256').update(password).digest();
 }
 private matches(password:unknown){return typeof password==='string'&&password.length<=512&&timingSafeEqual(this.digest,createHash('sha256').update(password).digest());}
 private cookie(req:IncomingMessage){return req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('qq_session='))?.slice(11);}
 authenticated(req:IncomingMessage){
  const id=this.cookie(req),expires=id?this.sessions.get(id):0;if(expires&&expires>Date.now())return true;if(id)this.sessions.delete(id);return false;
 }
 login(password:unknown,res:ServerResponse){
  const now=Date.now();if(now-this.window>300000){this.failures=0;this.window=now;}
  if(this.failures>=10)return json(res,429,{error:'尝试次数过多，请 5 分钟后重试。'});
  if(!this.matches(password)){this.failures++;return json(res,401,{error:'登录密码不正确。'});}
  for(const [id,expires]of this.sessions)if(expires<=now)this.sessions.delete(id);
  if(this.sessions.size>=128)return json(res,429,{error:'登录会话过多，请稍后再试。'});
  const id=randomBytes(32).toString('base64url');this.sessions.set(id,now+43200000);this.failures=0;
  res.setHeader('set-cookie',`qq_session=${id}; HttpOnly; SameSite=Strict; Path=/qq-companion; Max-Age=43200`);json(res,200,{authenticated:true});
 }
 logout(req:IncomingMessage,res:ServerResponse){const id=this.cookie(req);if(id)this.sessions.delete(id);res.setHeader('set-cookie','qq_session=; HttpOnly; SameSite=Strict; Path=/qq-companion; Max-Age=0');json(res,200,{authenticated:false});}
 close(){this.sessions.clear();this.digest.fill(0);}
}
