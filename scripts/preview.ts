// Real service with isolated offline fixture data and a public test-only password.
import {startService} from '../src/service.ts';import {resolve} from 'node:path';
const service=await startService({config:{enabled:false,dataDir:resolve('work/browser-fixture'),port:43821},configPath:resolve('work/browser-fixture/config.json'),env:{QQ_ADMIN_TOKEN:'offline-browser-fixture-password-0001'}});
if(!service.store.list().length){const scope='demo:private:owner';const n=service.store.add({scope,title:'电影计划',text:'今天去看电影',kind:'event',sourceIds:['demo1'],eventTime:'2026-11-12'});service.store.revise(scope,n.id,{text:'后天去看电影',eventTime:'2026-11-14',reason:'用户明确改期',sourceIds:['demo2']});}
console.log('Offline service fixture: '+service.url);process.once('SIGINT',()=>void service.close());await service.closed;
