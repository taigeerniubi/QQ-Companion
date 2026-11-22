import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {networkInterfaces,tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {startService} from '../src/service.ts';
import {validateConfig} from '../src/config.ts';
import {allowedAdminHost} from '../src/network.ts';

const password='remote-offline-test-password';
// Node fetch normalizes/ignores Host overrides. Use real HTTP headers for proxy and rebinding tests.
function wire(url:string,init:RequestInit={}):Promise<{status:number;headers:Headers}>{
 return new Promise((resolve,reject)=>{
  const request=httpRequest(url,{method:init.method,headers:Object.fromEntries(new Headers(init.headers))},response=>{
   const headers=new Headers();for(const [name,value]of Object.entries(response.headers))for(const item of Array.isArray(value)?value:value===undefined?[]:[value])headers.append(name,item);
   response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode??0,headers}));response.resume();
  });request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('Test HTTP request timed out')));request.end(typeof init.body==='string'?init.body:undefined);
 });
}
test('network settings reject malformed origins and keep unconfigured hosts out',()=>{
 assert.deepEqual(validateConfig({adminOrigins:['https://Companion.example/','https://companion.example']}).adminOrigins,['https://companion.example']);
 for(const origin of ['https://*.example','https://example/path','https://u:p@example','https://example?key=x','file:///tmp'])assert.throws(()=>validateConfig({adminOrigins:[origin]}));
 for(const listenHost of ['example.com','http://0.0.0.0','127.0.0.1:3210','0.0.0.0; echo x'])assert.throws(()=>validateConfig({listenHost}));
 for(const host of ['evil.example:3210','localhost:3211','user@localhost:3210','localhost:3210/path','localhost:3210?x=1','localhost:3210\\evil'])assert(!allowedAdminHost(host,3210,[]));
 assert(allowedAdminHost('127.0.0.1:3210',3210,[]));assert(allowedAdminHost('[::1]:3210',3210,[]));
 assert(allowedAdminHost('localhost',80,[]));assert(allowedAdminHost('localhost:80',80,[]));
 assert(allowedAdminHost('companion.example',3210,['https://companion.example']));
 assert(allowedAdminHost('companion.example:443',3210,['https://companion.example']));
});

test('remote network access supports login and writes while keeping password, Host and CSRF checks',async t=>{
 const interfaces=Object.values(networkInterfaces()).flat().filter(e=>e?.family==='IPv4'&&!e.internal);
 const address=interfaces.find(e=>e!.address.startsWith('100.'))?.address??interfaces.find(e=>e!.address.startsWith('192.168.'))?.address??interfaces[0]?.address;
 if(!address){t.skip('No external IPv4 interface in this test environment');return;}
 const dir=mkdtempSync(join(tmpdir(),'qq-tailnet-'));let service:any;
 try{
  service=await startService({config:{dataDir:dir,enabled:false,listenHost:'0.0.0.0'},configPath:join(dir,'config.json'),port:0,env:{QQ_ADMIN_PASSWORD:password}});
  const base=`http://${address}:${new URL(service.url).port}`;
  assert.equal((await fetch(base+'/healthz')).status,200);
  assert.equal((await fetch(base+'/qq-companion/api/state')).status,401);
  const post=(path:string,value:any,cookie='',origin=base,headers={})=>fetch(base+'/qq-companion/api/'+path,{method:'POST',headers:{origin,'content-type':'application/json','x-companion-admin':'1',cookie,...headers},body:JSON.stringify(value)});
  assert.equal((await post('login',{password:'wrong'})).status,401);
  assert.equal((await post('login',{password},'','https://evil.example')).status,403);
  assert.equal((await post('login',{password},'','https://evil.example',{'x-forwarded-host':'evil.example','x-forwarded-proto':'https'})).status,403);
  assert.equal((await wire(base+'/healthz',{headers:{host:'evil.example'}})).status,403);
  const login=await post('login',{password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert(login.headers.get('set-cookie')!.includes('HttpOnly'));assert(!login.headers.get('set-cookie')!.includes('; Secure'));
  assert.equal((await fetch(base+'/qq-companion/api/state',{headers:{cookie}})).status,200);
  assert.equal((await post('pause',{paused:true},cookie,'https://evil.example')).status,403);
  assert.equal((await post('pause',{paused:true},cookie)).status,200);
  assert.equal((await post('shutdown',{})).status,401);
  assert.equal((await post('logout',{},cookie)).status,200);
  assert.equal((await fetch(base+'/qq-companion/api/state',{headers:{cookie}})).status,401);
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});

test('explicit HTTPS proxy origins work with preserved or rewritten Host and receive Secure cookies',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qq-proxy-'));let service:any;
 try{
  const origin='https://companion.example';
  service=await startService({config:{dataDir:dir,enabled:false,listenHost:'127.0.0.1',adminOrigins:[origin]},configPath:join(dir,'config.json'),port:0,env:{QQ_ADMIN_PASSWORD:password}});
  const post=(path:string,value:any,cookie='',host?:string)=>wire(service.url+'/qq-companion/api/'+path,{method:'POST',headers:{origin,'content-type':'application/json','x-companion-admin':'1',cookie,...(host?{host}:{})},body:JSON.stringify(value)});
  const login=await post('login',{password},'','companion.example');assert.equal(login.status,200);assert(login.headers.get('set-cookie')!.includes('; Secure'));
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post('pause',{paused:true},cookie)).status,200);
  assert.equal((await post('pause',{paused:false},cookie,'companion.example')).status,200);
  assert.equal((await post('pause',{paused:false},cookie,'unlisted.example')).status,403);
  const logout=await post('logout',{},cookie);assert.equal(logout.status,200);assert(logout.headers.get('set-cookie')!.includes('; Secure'));
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});

test('IPv6 wildcard binding remains accessible through both IPv4 and IPv6',async t=>{
 if(!Object.values(networkInterfaces()).flat().some(e=>e?.address==='::1')){t.skip('No IPv6 loopback');return;}
 const dir=mkdtempSync(join(tmpdir(),'qq-dual-stack-'));let service:any;
 try{
  service=await startService({config:{dataDir:dir,enabled:false,listenHost:'::'},configPath:join(dir,'config.json'),port:0,env:{QQ_ADMIN_PASSWORD:password}});
  assert.equal((await fetch(service.url+'/healthz')).status,200);
  const base=`http://[::1]:${new URL(service.url).port}`;
  assert.equal((await fetch(base+'/healthz')).status,200);
  const login=await fetch(base+'/qq-companion/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json','x-companion-admin':'1'},body:JSON.stringify({password})});
  assert.equal(login.status,200);
 }finally{await service?.close();rmSync(dir,{recursive:true,force:true});}
});
