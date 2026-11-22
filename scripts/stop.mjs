import {existsSync,readFileSync} from 'node:fs';import {resolve,join} from 'node:path';
import {shutdownService} from './shutdown.mjs';
import {managementBase} from './service-url.mjs';
const root=resolve(import.meta.dirname,'..'),configPath=join(root,'config.local.json');
const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
const base=managementBase(config),envName=config.adminPasswordEnv??'QQ_ADMIN_PASSWORD',password=process.env[envName];
if(!password?.trim())throw new Error(`请在 .env 或 .env.local 中设置 ${envName}。`);
await shutdownService(base,password);
let stopped=false;for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,250));try{await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)});}catch{stopped=true;break;}}
if(!stopped)throw new Error('Shutdown requested, but the service has not stopped yet');console.log('QQ companion service stopped.');
