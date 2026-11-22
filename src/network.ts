import {hostname,networkInterfaces} from 'node:os';
import {isIP} from 'node:net';

export function urlHost(host:string){return isIP(host)===6?`[${host}]`:host;}
export function managementUrl(host:string,port:number){
 return `http://${urlHost(host==='0.0.0.0'||host==='::'?'127.0.0.1':host)}:${port}`;
}
// Accept this machine's current LAN/Tailscale addresses and explicit proxy/domain origins.
// Do not trust arbitrary Host or X-Forwarded-* headers (DNS rebinding protection).
export function allowedAdminHost(header:string|undefined,port:number,origins:readonly string[]):boolean {
 if(!header)return false;
 let authority:string;
 try{
  const parsed=new URL('http://'+header);
  if(/[\s/@?#\\]/.test(header)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)return false;
  authority=parsed.host.toLowerCase();
 }catch{return false;}
 const hosts=new Set(['localhost','127.0.0.1','::1',hostname()]);
 for(const entries of Object.values(networkInterfaces()))for(const entry of entries??[])if(!entry.address.includes('%'))hosts.add(entry.address);
 for(const host of hosts)if(new URL(`http://${urlHost(host)}:${port}`).host.toLowerCase()===authority)return true;
 return origins.some(origin=>{
  const url=new URL(origin);
  return url.host.toLowerCase()===authority||url.protocol==='https:'&&!url.port&&`${url.hostname}:443`.toLowerCase()===authority;
 });
}
