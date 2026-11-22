import { randomUUID } from 'node:crypto';
import { MemoryStore, type MemoryNode } from './store.ts';

interface Candidate {node:MemoryNode;relation:string;from:string}
interface Cache {scope:string;turn:string;revision:number;expires:number;items:Candidate[]}
interface Quota {count:number;chars:number;seedChars:number;seedIds:Set<string>;readIds:Set<string>}
export class MemoryRetriever {
 private store:MemoryStore;private now:()=>number;private sets=new Map<string,Cache>();private quotas=new Map<string,Quota>();
 constructor(store:MemoryStore,now:()=>number=Date.now){this.store=store;this.now=now;}
 private key(scope:string,turn:string){return JSON.stringify([scope,turn]);}
 private quota(scope:string,turn:string){const key=this.key(scope,turn);let q=this.quotas.get(key);if(!q){q={count:0,chars:0,seedChars:0,seedIds:new Set(),readIds:new Set()};this.quotas.set(key,q);}return q;}
 finish(scope:string,turn:string){this.quotas.delete(this.key(scope,turn));for(const [id,c]of this.sets)if(c.scope===scope&&c.turn===turn)this.sets.delete(id);}
 private cache(scope:string,turn:string,id:string):Cache{
  const c=this.sets.get(id);if(!c||c.scope!==scope||c.turn!==turn)throw new Error('Unknown candidate set or scope');
  if(c.expires<=this.now()){this.sets.delete(id);throw new Error('Candidate set expired; search again');}
  if(c.revision!==this.store.revision){this.sets.delete(id);throw new Error('Candidate set stale; search again');}return c;
 }
 search(scope:string,turn:string,query:string){
  if(!turn||!query.trim()||query.length>1000)throw new Error('Invalid memory query');
  for(const [id,c]of this.sets)if(c.expires<=this.now())this.sets.delete(id);
  if(this.sets.size>=256)throw new Error('Candidate cache capacity reached');
  const q=this.quota(scope,turn);const hits=this.store.search(scope,query,3);const seeds=[];
  for(const n of hits){if(q.seedIds.has(n.id))continue;const remaining=1000-q.seedChars;if(remaining<=0)break;
   const text=n.text.slice(0,remaining);seeds.push({id:n.id,title:n.title,text,version:n.version,certainty:n.certainty??'explicit',eventTime:n.eventTime??null,updatedAt:n.updatedAt,truncated:text.length<n.text.length});q.seedChars+=text.length;q.seedIds.add(n.id);
  }
  this.store.touch(scope,seeds.map(n=>n.id));
  const seedIds=new Set(hits.map(n=>n.id));const seen=new Set(seedIds);const candidates:Candidate[]=[];
  for(const e of this.store.edges(scope)){
   if(['contradicts','supersedes'].includes(e.relation))continue;
   const from=seedIds.has(e.from)?e.from:seedIds.has(e.to)?e.to:null;if(!from)continue;
   const id=from===e.from?e.to:e.from;if(seen.has(id))continue;
   const n=this.store.get(scope,id);if(!n||n.state!=='current')continue;
   seen.add(id);candidates.push({node:n,relation:e.relation,from});if(candidates.length===30)break;
  }
  const id=randomUUID();this.sets.set(id,{scope,turn,revision:this.store.revision,expires:this.now()+600000,items:candidates});
  this.store.trace(scope,'prefetch',candidates.map(c=>c.node.id));
  return {seeds,...this.list(scope,turn,id,0)};
 }
 list(scope:string,turn:string,setId:string,cursor=0){
  const c=this.cache(scope,turn,setId);if(!Number.isSafeInteger(cursor)||cursor<0||cursor>c.items.length)throw new Error('Invalid cursor');
  const candidates=[];let chars=0,i=cursor;
  for(;i<c.items.length&&candidates.length<8;i++){
   const item=c.items[i]!;const row={id:item.node.id,title:item.node.title.slice(0,24),relation:item.relation,from:item.from};
   const size=Object.values(row).join('').length;if(chars+size>400)break;chars+=size;candidates.push(row);
  }
  return {setId,candidates,nextCursor:i<c.items.length?i:null,total:c.items.length};
 }
 read(scope:string,turn:string,setId:string,ids:string[]){
  const c=this.cache(scope,turn,setId);const q=this.quota(scope,turn);
  if(!Array.isArray(ids)||!ids.length||ids.length>3||new Set(ids).size!==ids.length)throw new Error('Read needs 1–3 unique IDs');
  const nodes=ids.map(id=>{const n=c.items.find(i=>i.node.id===id)?.node;if(!n||!this.store.get(scope,id))throw new Error('ID not in candidate set');return n;});
  const fresh=nodes.filter(n=>!q.readIds.has(n.id));if(q.count+fresh.length>6||q.chars>=2000)throw new Error('Per-turn memory budget exhausted');
  let available=Math.min(1000,2000-q.chars);const items=[];
  for(const n of nodes){if(available<=0)break;const text=n.text.slice(0,available);available-=text.length;q.chars+=text.length;
   if(!q.readIds.has(n.id)){q.count++;q.readIds.add(n.id);}items.push({id:n.id,version:n.version,text,certainty:n.certainty??'explicit',truncated:text.length<n.text.length,sourceIds:n.sourceIds.slice(-8),sourceCount:n.sourceIds.length,eventTime:n.eventTime??null});
  }
  this.store.touch(scope,items.map(i=>i.id));return {items,remainingChars:2000-q.chars,remainingItems:6-q.count};
 }
 history(scope:string,turn:string,id:string,cursor=0){
  const q=this.quota(scope,turn);const rows=this.store.history(scope,id);if(!rows.length)throw new Error('Memory not found');
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>=rows.length)throw new Error('Invalid history cursor');
  if(q.count>=6||q.chars>=2000)throw new Error('Per-turn memory budget exhausted');let remaining=Math.min(1000,2000-q.chars);
  const versions=[];for(const row of rows.slice(cursor)){if(!remaining)break;const text=row.text.slice(0,remaining);remaining-=text.length;q.chars+=text.length;versions.push({version:row.version,text,certainty:row.certainty??'explicit',state:row.state,reason:row.reason,eventTime:row.eventTime,at:row.at,truncated:text.length<row.text.length});}
  q.count++;this.store.trace(scope,'history',[id]);return {id,versions,totalVersions:rows.length,nextCursor:cursor+versions.length<rows.length?cursor+versions.length:null};
 }
}
