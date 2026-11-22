import {MemoryStore} from '../src/memory/store.ts';import {MemoryRetriever} from '../src/memory/retrieval.ts';
const store=new MemoryStore(':memory:'),scope='demo:private:owner';
const event=store.add({scope,title:'看电影的计划',text:'今天去看电影',kind:'event',sourceIds:['msg-1'],eventTime:'2026-11-12'});
store.revise(scope,event.id,{text:'改为后天去看电影',eventTime:'2026-11-14',sourceIds:['msg-2'],reason:'用户说：后天吧'});
const next=store.add({scope,title:'电影后的安排',text:'看完以后去附近吃火锅',kind:'event',sourceIds:['msg-3']});store.link(scope,event.id,next.id,'follow_up',['msg-3']);
const retrieval=new MemoryRetriever(store),found=retrieval.search(scope,'turn','看电影');
// Query directly targets the seed title; neighbor bodies remain internal unless they also match as seeds.
const isolated=store.add({scope,title:'同行人',text:'这次是和一位朋友一起',kind:'fact',sourceIds:['msg-4']});store.link(scope,event.id,isolated.id,'person_reference',['msg-4']);
retrieval.finish(scope,'turn');const recalled=retrieval.search(scope,'turn2','看电影');
console.log(JSON.stringify({history:store.history(scope,event.id),initialContext:recalled,bodyHidden:!JSON.stringify(recalled).includes('这次是和一位朋友一起'),explicitRead:retrieval.read(scope,'turn2',recalled.setId,[isolated.id]),maintenance:store.maintain(Date.now()+3650*86400000)},null,2));store.close();
