import {readFileSync} from 'node:fs';import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),config=JSON.parse(readFileSync(join(root,'config.local.json'),'utf8'));
const base=`http://127.0.0.1:${config.port??3210}`,token=process.env[config.adminTokenEnv??'QQ_ADMIN_TOKEN']||readFileSync(join(config.dataDir||join(root,'data'),'admin-token'),'utf8').trim();
const response=await fetch(base+'/qq-companion/api/shutdown',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-companion-admin':'1',origin:base},body:'{}',signal:AbortSignal.timeout(10000)});
if(!response.ok)throw new Error(`Stop rejected: HTTP ${response.status}`);
let stopped=false;for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,250));try{await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)});}catch{stopped=true;break;}}
if(!stopped)throw new Error('Shutdown requested, but the service has not stopped yet');console.log('QQ companion service stopped.');
