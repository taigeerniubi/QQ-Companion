import {type MemoryStore} from '../memory/store.ts';
import {type Fetcher} from '../http.ts';

// Observability only: daily operation has no cumulative request cap.
// Count before dispatch so failed/ambiguous requests remain visible across restarts.
export function countedModels(store:MemoryStore,fetcher:Fetcher=fetch):Fetcher {
 return async(url,init)=>{
  init?.signal?.throwIfAborted();
  const hostname=new URL(url).hostname;
  if(!['127.0.0.1','localhost','[::1]'].includes(hostname)&&init?.method==='POST'){
   const body=typeof init.body==='string'?JSON.parse(init.body):undefined;
   if(typeof body?.model!=='string'||!body.model.trim())throw new Error('Cloud model request requires a model name for call accounting');
   const now=Date.now();
   store.db.prepare(`INSERT INTO cloud_model_calls(model,calls,first_at,last_at) VALUES(?,1,?,?)
    ON CONFLICT(model) DO UPDATE SET calls=calls+1,last_at=excluded.last_at`).run(body.model,now,now);
  }
  return fetcher(url,init);
 };
}
