export type Fetcher = (url:string|URL,init?:RequestInit)=>Promise<Response>;
export function endpoint(value:string,protocols=['https:','http:']):URL {
 const u=new URL(value);if(!protocols.includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Invalid endpoint; credentials belong in headers');return u;
}
export async function bytes(response:Response,limit=20*1024*1024):Promise<Buffer>{
 if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new Error('Response too large');}
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('Response too large');chunks.push(value);}}catch(e){await reader.cancel();throw e;}finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
export async function postJson(fetcher:Fetcher,url:string,token:string,body:unknown,signal?:AbortSignal,timeout=60000):Promise<any>{
 const res=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),redirect:'error'});
 if(!res.ok){await res.body?.cancel();throw new Error(`HTTP ${res.status}`);}return JSON.parse((await bytes(res,28*1024*1024)).toString('utf8'));
}
