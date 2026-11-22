import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory/store.ts';
import { MemoryRetriever } from '../src/memory/retrieval.ts';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';

const scope = '100:private:200';
function fixture() { return new MemoryStore(':memory:'); }
function input(text: string, extra = {}) { return { scope, title: text.slice(0,24), text, kind:'event', sourceIds:['msg1'], ...extra }; }

test('revision preserves original and every past version even after maintenance', () => {
 const s = fixture(); const a = s.add(input('周五去看电影')); s.revise(scope,a.id,{text:'周日去看电影',sourceIds:['msg2'],reason:'明确改期'});
 assert.equal(s.get(scope,a.id)?.text,'周日去看电影');
 assert.deepEqual(s.history(scope,a.id).map(x=>x.text),['周五去看电影','周日去看电影']);
 s.maintain(Date.now()+3650*86400000);
 assert.equal(s.history(scope,a.id).length,2); assert.equal(s.list(scope).length,1); s.close();
});
test('ambiguous contradiction preserves both as disputed rather than newest wins', () => {
 const s=fixture();const a=s.add(input('住在上海',{kind:'fact'}));const b=s.conflict(scope,a.id,input('住在北京',{kind:'fact'}));
 assert.equal(s.get(scope,a.id)?.state,'disputed'); assert.equal(s.get(scope,b.id)?.state,'disputed');
 assert.equal(s.search(scope,'住在').length,0);assert.equal(s.history(scope,a.id)[0]?.text,'住在上海');s.close();
});
test('graph cache hides body and scope and does not strengthen prefetched nodes', () => {
 const s=fixture();const a=s.add(input('星河公司面试'));const b=s.add(input('已拿到 offer SECRET_BODY',{title:'面试结果'}));
 const privateNode=s.add(input('PRIVATE_NEIGHBOR',{scope:'100:private:999'}));
 s.link(scope,a.id,b.id,'follow_up',['msg1']);assert.throws(()=>s.link(scope,a.id,privateNode.id,'same_event',['msg1']));
 const r=new MemoryRetriever(s);const found=r.search(scope,'turn1','星河公司');
 assert.equal(found.candidates.length,1);assert(!JSON.stringify(found).includes('SECRET_BODY'));
 assert(!JSON.stringify(found).includes('PRIVATE_NEIGHBOR')); assert.equal(s.get(scope,b.id)?.reads,0);
 assert.equal(r.read(scope,'turn1',found.setId,[b.id]).items[0]?.text,'已拿到 offer SECRET_BODY');
 assert.equal(s.get(scope,b.id)?.reads,1);assert.throws(()=>r.read('100:private:999','turn1',found.setId,[b.id]));s.close();
});
test('revision invalidates prefetch and old versions require explicit history read',()=>{
 const s=fixture();const a=s.add(input('星河面试'));const b=s.add(input('后续旧结果'));s.link(scope,a.id,b.id,'follow_up',['msg1']);
 const r=new MemoryRetriever(s);const result=r.search(scope,'t','星河');s.revise(scope,b.id,{text:'后续新结果',sourceIds:['msg2'],reason:'纠正'});
 assert.throws(()=>r.read(scope,'t',result.setId,[b.id]),/stale/);assert.equal(s.history(scope,b.id).length,2);s.close();
});
test('read budget survives repeated searches and cache handles expire',()=>{
 let now=100;const s=fixture();const a=s.add(input('电影主题'));
 const ids=Array.from({length:8},(_,i)=>s.add(input(`关联${i} ${'长'.repeat(300)}`,{title:`条目${i}`})).id);
 for(const id of ids)s.link(scope,a.id,id,'same_event',['msg1']);
 const r=new MemoryRetriever(s,()=>now);let found=r.search(scope,'t','电影');
 r.read(scope,'t',found.setId,ids.slice(0,3));found=r.search(scope,'t','电影');r.read(scope,'t',found.setId,ids.slice(3,6));
 assert.throws(()=>r.read(scope,'t',found.setId,[ids[6]!]),/budget/);
 now+=600001;assert.throws(()=>r.list(scope,'t',found.setId,0),/expired/);s.close();
});
test('explicit delete removes content and invalidates handles, never runs automatically',()=>{
 const s=fixture();const a=s.add(input('电影'));const b=s.add(input('待删除内容'));s.link(scope,a.id,b.id,'follow_up',['msg1']);
 const r=new MemoryRetriever(s);const found=r.search(scope,'t','电影');s.forget(scope,b.id);
 assert.equal(s.get(scope,b.id),null);assert.deepEqual(s.history(scope,b.id),[]);assert.throws(()=>r.read(scope,'t',found.setId,[b.id]));s.close();
});
test('inferred memories remain labelled when recalled into model context',()=>{
 const s=fixture();const a=s.add(input('电影兴趣推测',{certainty:'inferred'}));const r=new MemoryRetriever(s);const result=r.search(scope,'t','电影');assert.equal(result.seeds[0]?.certainty,'inferred');assert.equal(result.seeds[0]?.id,a.id);s.close();
});
test('service database upgrade retains old memory versions and relationships',()=>{
 const dir=mkdtempSync(join(tmpdir(),'qq-migration-')),path=join(dir,'memory.db');let s=new MemoryStore(path);const a=s.add(input('今天电影')),b=s.add(input('后来火锅'));s.revise(scope,a.id,{text:'后天电影',reason:'改期',sourceIds:['2']});s.link(scope,a.id,b.id,'follow_up',['2']);s.db.exec('PRAGMA user_version=1');s.close();
 try{s=new MemoryStore(path);assert.equal(s.history(scope,a.id).length,2);assert.equal(s.edges(scope).length,1);assert.equal(s.db.prepare('PRAGMA user_version').get()?.user_version,2);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
