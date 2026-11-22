import {spawn} from 'node:child_process';
import {existsSync,copyFileSync,readFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {managementBase} from './service-url.mjs';

const root=resolve(import.meta.dirname,'..'),entry=join(root,'dist/main.js'),configPath=join(root,'config.local.json');
if(!existsSync(entry))throw new Error('请先运行 npm run build。');
if(process.argv.slice(2).some(arg=>arg!=='--background'))throw new Error('Usage: node scripts/start.mjs [--background]');
if(!existsSync(configPath))copyFileSync(join(root,'config.example.json'),configPath);
const config=JSON.parse(readFileSync(configPath,'utf8')),base=managementBase(config);
const args=[`--env-file-if-exists=${join(root,'.env')}`,`--env-file-if-exists=${join(root,'.env.local')}`,entry,'--config',configPath];
const health=async()=>{
 const response=await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000),redirect:'error'});
 if(!response.ok)throw new Error('Service not ready');
 return response.json();
};
if(!process.argv.includes('--background')){
 const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
 child.on('error',error=>{console.error(error.message);process.exitCode=1;});
 child.on('exit',code=>{process.exitCode=code??1;});
}else{
 const existing=await health().catch(()=>null);
 if(existing?.service==='qq-companion')console.log(`服务已在运行：${base}/qq-companion/`);
 else{
  const logDir=join(root,'work/logs');mkdirSync(logDir,{recursive:true});
  const out=openSync(join(logDir,'service.out.log'),'a'),err=openSync(join(logDir,'service.err.log'),'a');
  let child;try{child=spawn(process.execPath,args,{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err]});}finally{closeSync(out);closeSync(err);}
  let spawnError;child.once('error',error=>{spawnError=error;});child.unref();
  let ready=false;
  for(let attempt=0;attempt<20;attempt++){
   if(spawnError)throw spawnError;
   if(child.exitCode!==null)throw new Error(`服务启动失败，请查看 ${logDir}。`);
   const result=await health().catch(()=>null);
   if(result?.service==='qq-companion'&&result.pid===child.pid){ready=true;break;}
   await delay(250);
  }
  if(!ready)throw new Error(`服务尚未就绪，请查看 ${logDir}。`);
  console.log(`服务已启动：${base}/qq-companion/（监听 ${config.listenHost??'0.0.0.0'}）`);
 }
}
