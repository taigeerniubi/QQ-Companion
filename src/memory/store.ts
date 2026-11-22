import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type MemoryKind = 'fact'|'preference'|'event'|'emotion'|'promise'|'reflection';
export type MemoryState = 'current'|'disputed';
export interface MemoryInput {
 scope: string; title: string; text: string; kind: string; sourceIds: string[];
 eventTime?: string|null; certainty?: 'explicit'|'inferred';
}
export interface MemoryNode extends MemoryInput {
 id: string; version: number; state: MemoryState; createdAt: number; updatedAt: number; reads: number;
}
export interface MemoryVersion { version:number; title:string; text:string; kind:string; state:MemoryState; sourceIds:string[]; reason:string; at:number; eventTime:string|null;certainty?:'explicit'|'inferred' }
export interface Edge { from:string; to:string; relation:string; sourceIds:string[] }
const kinds=new Set(['fact','preference','event','emotion','promise','reflection']);
const relations=new Set(['same_event','follow_up','caused_by','supersedes','contradicts','person_reference']);
export function tokenize(text:string):string[] {
 const lower=text.normalize('NFKC').toLowerCase();const tokens:string[]=[...(lower.match(/[a-z0-9_]+/g)??[])];
 for(const segment of lower.match(/[\p{Script=Han}]+/gu)??[]) {
  if(segment.length===1) tokens.push(segment);
  else for(let i=0;i<segment.length-1;i++) tokens.push(segment.slice(i,i+2));
 }
 return [...new Set(tokens)].slice(0,128);
}
function parse<T>(value:unknown):T { return JSON.parse(String(value)) as T; }
export class MemoryStore {
 readonly db:DatabaseSync; private depth=0;
 constructor(path:string) {
  if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
  this.db=new DatabaseSync(path);this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const version=Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
  if(version>2) { this.db.close();throw new Error('Database schema is newer than this service'); }
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
   INSERT OR IGNORE INTO meta VALUES('revision',0);
   CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,reads INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS versions(id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(id,version),FOREIGN KEY(id) REFERENCES memories(id) ON DELETE CASCADE);
   CREATE TABLE IF NOT EXISTS edges(a TEXT NOT NULL,b TEXT NOT NULL,relation TEXT NOT NULL,sources TEXT NOT NULL,PRIMARY KEY(a,b,relation),FOREIGN KEY(a) REFERENCES memories(id) ON DELETE CASCADE,FOREIGN KEY(b) REFERENCES memories(id) ON DELETE CASCADE);
   CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED,tokens);
   CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,at INTEGER NOT NULL,scope TEXT,action TEXT NOT NULL,ids TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,scope TEXT NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',extracted INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,scope TEXT NOT NULL,turn_id TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,at INTEGER NOT NULL,proactive INTEGER NOT NULL DEFAULT 0,UNIQUE(turn_id,ordinal));
   CREATE TABLE IF NOT EXISTS sessions(scope TEXT PRIMARY KEY,session_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS handoffs(scope TEXT PRIMARY KEY,text TEXT NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS cloud_model_calls(model TEXT PRIMARY KEY,calls INTEGER NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_turns(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,scope TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,messages TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS music_jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,turn_id TEXT NOT NULL UNIQUE,remote_id TEXT,state TEXT NOT NULL,request TEXT NOT NULL,file TEXT,error TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL,updated_at INTEGER NOT NULL,capped INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS agent_turns_scope ON agent_turns(scope,seq);
   CREATE INDEX IF NOT EXISTS messages_scope ON messages(scope,at);
   CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope);
   PRAGMA user_version=2;
  `);
 }
 close(){this.db.close();}
 get revision():number {return Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()!.value);}
 batch<T>(fn:()=>T):T {
  if(this.depth) return fn();this.db.exec('BEGIN IMMEDIATE');this.depth++;
  try {const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.depth--;}
 }
 trace(scope:string,action:string,ids:string[]) {this.db.prepare('INSERT INTO audit(at,scope,action,ids) VALUES(?,?,?,?)').run(Date.now(),scope,action,JSON.stringify(ids));}
 private bump(){this.db.prepare("UPDATE meta SET value=value+1 WHERE key='revision'").run();}
 private validate(input:MemoryInput){
  if(!input.scope || input.scope.length>160 || !input.text?.trim() || input.text.length>4000 || !input.title?.trim() || input.title.length>80 || !kinds.has(input.kind)) throw new Error('Invalid memory');
  if(!Array.isArray(input.sourceIds)||!input.sourceIds.length||input.sourceIds.some(x=>typeof x!=='string'||x.length>200)) throw new Error('Memory requires source evidence');
  if(input.eventTime && (!/^\d{4}-\d\d-\d\d/.test(input.eventTime)||!Number.isFinite(Date.parse(input.eventTime))))throw new Error('Invalid eventTime');
 }
 private append(id:string,version:number,input:MemoryInput,state:MemoryState,reason:string,at=Date.now()){
  const data={...input,title:input.title.trim(),text:input.text.trim(),version,state,reason,at,eventTime:input.eventTime??null};
  this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(id,version,JSON.stringify(data));
  this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
  if(state==='current')this.db.prepare('INSERT INTO memory_fts(id,tokens) VALUES(?,?)').run(id,tokenize(input.title+' '+input.text).join(' '));
 }
 add(input:MemoryInput):MemoryNode {
  this.validate(input);return this.batch(()=>{
   const id='m'+randomUUID().replaceAll('-','').slice(0,12),now=Date.now();
   this.db.prepare('INSERT INTO memories(id,scope,version,state,created_at,updated_at) VALUES(?,?,1,?,?,?)').run(id,input.scope,'current',now,now);
   this.append(id,1,input,'current','created',now);this.bump();this.trace(input.scope,'create',[id]);return this.get(input.scope,id)!;
  });
 }
 get(scope:string,id:string):MemoryNode|null {
  const r=this.db.prepare('SELECT m.*,v.data FROM memories m JOIN versions v ON m.id=v.id AND m.version=v.version WHERE m.id=? AND m.scope=?').get(id,scope);
  return r?{...parse<MemoryInput>(r.data),id:String(r.id),scope:String(r.scope),version:Number(r.version),state:String(r.state) as MemoryState,createdAt:Number(r.created_at),updatedAt:Number(r.updated_at),reads:Number(r.reads)}:null;
 }
 list(scope?:string):MemoryNode[] {
  const rows=scope?this.db.prepare('SELECT id,scope FROM memories WHERE scope=? ORDER BY updated_at DESC').all(scope):this.db.prepare('SELECT id,scope FROM memories ORDER BY updated_at DESC').all();
  return rows.map(r=>this.get(String(r.scope),String(r.id))!);
 }
 history(scope:string,id:string):MemoryVersion[] {
  if(!this.get(scope,id))return [];
  return this.db.prepare('SELECT data FROM versions WHERE id=? ORDER BY version').all(id).map(r=>parse<MemoryVersion>(r.data));
 }
 revise(scope:string,id:string,patch:{text?:string;title?:string;sourceIds:string[];reason:string;eventTime?:string|null;state?:MemoryState;certainty?:'explicit'|'inferred'}):MemoryNode {
  const old=this.get(scope,id);if(!old)throw new Error('Memory not found in scope');
  const next={...old,...patch,sourceIds:[...new Set([...old.sourceIds,...patch.sourceIds])]};this.validate(next);
  if(!patch.reason?.trim())throw new Error('Revision requires a reason');
  return this.batch(()=>{const v=old.version+1,now=Date.now();const state=patch.state??'current';
   this.db.prepare('UPDATE memories SET version=?,state=?,updated_at=? WHERE id=?').run(v,state,now,id);
   this.append(id,v,next,state,patch.reason,now);this.bump();this.trace(scope,'revise',[id]);return this.get(scope,id)!;
  });
 }
 evidence(scope:string,id:string,sourceIds:string[]):MemoryNode {
  const old=this.get(scope,id);if(!old)throw new Error('Memory not found');
  const fresh=sourceIds.filter(x=>!old.sourceIds.includes(x));if(!fresh.length)return old;
  return this.revise(scope,id,{sourceIds:fresh,reason:'additional evidence',state:old.state});
 }
 conflict(scope:string,id:string,input:MemoryInput):MemoryNode {
  if(input.scope!==scope)throw new Error('Scope mismatch');return this.batch(()=>{
   this.revise(scope,id,{sourceIds:input.sourceIds,reason:'unresolved contradiction',state:'disputed'});
   const fresh=this.add(input);const next=this.revise(scope,fresh.id,{sourceIds:input.sourceIds,reason:'unresolved contradiction',state:'disputed'});
   this.link(scope,id,fresh.id,'contradicts',input.sourceIds);return next;
  });
 }
 link(scope:string,from:string,to:string,relation:string,sources:string[]) {
  if(from===to||!relations.has(relation)||!this.get(scope,from)||!this.get(scope,to)||!sources.length)throw new Error('Invalid or cross-scope edge');
  this.batch(()=>{this.db.prepare('INSERT OR IGNORE INTO edges VALUES(?,?,?,?)').run(from,to,relation,JSON.stringify(sources));this.bump();this.trace(scope,'link',[from,to]);});
 }
 edges(scope:string):Edge[]{return this.db.prepare('SELECT e.* FROM edges e JOIN memories a ON e.a=a.id JOIN memories b ON e.b=b.id WHERE a.scope=? AND b.scope=?').all(scope,scope).map(r=>({from:String(r.a),to:String(r.b),relation:String(r.relation),sourceIds:parse<string[]>(r.sources)}));}
 search(scope:string,query:string,limit=3):MemoryNode[] {
  const terms=tokenize(query);if(!terms.length)return [];
  const match=terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
  return this.db.prepare(`SELECT f.id FROM memory_fts f JOIN memories m ON m.id=f.id WHERE memory_fts MATCH ? AND m.scope=? AND m.state='current' ORDER BY bm25(memory_fts) LIMIT ?`).all(match,scope,Math.max(1,Math.min(limit,50))).map(r=>this.get(scope,String(r.id))!);
 }
 touch(scope:string,ids:string[]){for(const id of new Set(ids))this.db.prepare('UPDATE memories SET reads=reads+1 WHERE id=? AND scope=?').run(id,scope);this.trace(scope,'read',ids);}
 maintain(now=Date.now()){
  // Maintenance is observation only: durable nodes, versions and evidence never expire.
  const count=Number(this.db.prepare('SELECT count(*) n FROM versions').get()!.n);this.trace('system','maintenance',[]);return {at:now,retainedVersions:count,deleted:0};
 }
 forget(scope:string,id:string){
  if(!this.get(scope,id))throw new Error('Memory not found');this.batch(()=>{
   this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);this.db.prepare('DELETE FROM memories WHERE id=? AND scope=?').run(id,scope);this.bump();this.trace(scope,'explicit_forget',[id]);
  });
 }
}
