import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from '../src/memory/store.ts';
import {countedModels} from '../src/models/call-usage.ts';
import {validateConfig} from '../src/config.ts';

const call=(model:string)=>({method:'POST',body:JSON.stringify({model})});
test('cloud usage is counted but never capped, including after restart with more than ten calls',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'qq-model-budget-')),path=join(directory,'memory.db');
 let store=new MemoryStore(path),dispatched=0;
 const fake=async()=>{dispatched++;throw new Error('uncertain network result');};
 try{
  let guarded=countedModels(store,fake);
  const results=await Promise.allSettled(Array.from({length:15},()=>guarded('https://model.example/api',call('deepseek'))));
  assert.equal(dispatched,15);assert.equal(results.filter(r=>r.status==='rejected'&&String(r.reason).includes('network')).length,15);
  store.close();store=new MemoryStore(path);guarded=countedModels(store,fake);
  await assert.rejects(()=>guarded('https://another.example/api',call('deepseek')),/network/);assert.equal(dispatched,16);
  await assert.rejects(()=>guarded('https://model.example/api',call('qwen-tts')),/network/);assert.equal(dispatched,17);
  assert.equal(store.db.prepare('SELECT calls FROM cloud_model_calls WHERE model=?').get('deepseek')?.calls,16);
  assert.equal(store.db.prepare('SELECT calls FROM cloud_model_calls WHERE model=?').get('qwen-tts')?.calls,1);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test('local models, audio downloads and already-cancelled requests do not spend cloud calls',async()=>{
 const store=new MemoryStore(':memory:');let dispatched=0;
 const guarded=countedModels(store,async()=>{dispatched++;return Response.json({ok:true});});
 try{
  for(const url of ['http://127.0.0.1:8086/synth','http://localhost:1234/api','http://[::1]:8086/synth'])await guarded(url,call('local'));
  await guarded('https://audio.aliyuncs.com/file');
  const signal=AbortSignal.abort();await assert.rejects(()=>guarded('https://model.example/api',{...call('remote'),signal}));
  await assert.rejects(()=>guarded('https://model.example/api',{method:'POST',body:'{}'}),/model name/);
  assert.equal(dispatched,4);assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_model_calls').get()?.n,0);
  assert(!Object.hasOwn(validateConfig({cloudModelCallLimit:10} as any),'cloudModelCallLimit'));
 }finally{store.close();}
});
