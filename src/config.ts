import { join,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpoint } from './http.ts';
export interface Config {
 enabled:boolean;selfId:string;ownerId:string;friends:string[];groups:string[];httpUrl:string;wsUrl:string;onebotTokenEnv:string;
 dataDir:string;provider:string;model:string;persona:string;batchMs:number;turnTimeoutMs:number;
 qwenBase:string;qwenKeyEnv:string;asrModel:string;ttsModel:string;voice:string;
 proactive:boolean;quietStart:number;quietEnd:number;ownerDaily:number;ownerIntervalMinutes:number;friendDaily:number;groupCooldownSeconds:number;
 port:number;adminPasswordEnv:string;deepseekBase:string;deepseekKeyEnv:string;
}
export function defaults():Config{return {
 enabled:false,selfId:'',ownerId:'',friends:[],groups:[],httpUrl:'http://127.0.0.1:3000',wsUrl:'ws://127.0.0.1:3001',onebotTokenEnv:'ONEBOT_TOKEN',
 dataDir:fileURLToPath(new URL('../data',import.meta.url)),provider:'deepseek',model:'deepseek-flash',
 port:3210,adminPasswordEnv:'QQ_ADMIN_PASSWORD',deepseekBase:'https://api.deepseek.com',deepseekKeyEnv:'DEEPSEEK_API_KEY',
 persona:'你是通过 QQ 交流的 AI 伙伴。用自然、简短的中文交流，有自己的判断，尊重对方的作息。承认不确定，不编造共同经历。',batchMs:1500,turnTimeoutMs:120000,
 qwenBase:'https://dashscope.aliyuncs.com',qwenKeyEnv:'DASHSCOPE_API_KEY',asrModel:'qwen-audio-3.0-asr-flash',ttsModel:'qwen-audio-3.1-tts-flash',voice:'',
 proactive:true,quietStart:23,quietEnd:8,ownerDaily:3,ownerIntervalMinutes:120,friendDaily:1,groupCooldownSeconds:60
};}
export function validateConfig(input:Partial<Config>):Config{
 // Older configs may name a token variable. Password auth deliberately ignores it.
 const {adminTokenEnv:legacyTokenEnv,...current}=input as Partial<Config>&{adminTokenEnv?:unknown};input=current;
 const cfg={...defaults(),...input};
 for(const key of Object.keys(input))if(!(key in defaults()))throw new Error(`Unknown config field: ${key}`);
 for(const key of ['enabled','proactive'] as const)if(typeof cfg[key]!=='boolean')throw new Error(`Invalid ${key}`);
 for(const key of ['selfId','ownerId'] as const)if(typeof cfg[key]!=='string'||(cfg[key]&&!/^\d{1,16}$/.test(cfg[key])))throw new Error(`Invalid ${key}`);
 if(cfg.enabled&&(!cfg.selfId||!cfg.ownerId||cfg.selfId===cfg.ownerId))throw new Error('Set distinct companion and owner QQ IDs before enabling');
 for(const key of ['friends','groups'] as const)if(!Array.isArray(cfg[key])||cfg[key].length>100||cfg[key].some(x=>typeof x!=='string'||!/^\d{1,16}$/.test(x)))throw new Error(`Invalid ${key}`);
 for(const key of ['onebotTokenEnv','qwenKeyEnv','deepseekKeyEnv','adminPasswordEnv'] as const)if(!/^[A-Z][A-Z0-9_]{0,80}$/.test(cfg[key]))throw new Error(`Invalid ${key}`);
 for(const key of ['dataDir','provider','model','persona','qwenBase','asrModel','ttsModel','voice'] as const)if(typeof cfg[key]!=='string'||cfg[key].length>8000)throw new Error(`Invalid ${key}`);
 if(!cfg.dataDir||!cfg.provider||!cfg.model)throw new Error('dataDir/provider/model required');
 if(!isAbsolute(cfg.dataDir))throw new Error('dataDir must be absolute');
 endpoint(cfg.httpUrl);endpoint(cfg.wsUrl,['ws:','wss:']);endpoint(cfg.qwenBase,['https:']);
 endpoint(cfg.deepseekBase,['https:']);if(cfg.provider!=='deepseek')throw new Error('This service supports the DeepSeek provider');
 if(!Number.isInteger(cfg.port)||cfg.port<1||cfg.port>65535)throw new Error('Invalid port');
 for(const [key,max]of Object.entries({batchMs:10000,turnTimeoutMs:600000,quietStart:23,quietEnd:23,ownerDaily:20,ownerIntervalMinutes:1440,friendDaily:10,groupCooldownSeconds:3600})){
  const n=(cfg as any)[key];if(!Number.isInteger(n)||n<0||n>max)throw new Error(`Invalid ${key}`);
 }if(cfg.turnTimeoutMs<1000)throw new Error('turnTimeoutMs too small');
 return cfg;
}
export function allowed(cfg:Config,scope:string):boolean{
 const [self,kind,id]=scope.split(':');return self===cfg.selfId&&Boolean(id)&&(kind==='private'?(id===cfg.ownerId||cfg.friends.includes(id!)):kind==='group'&&cfg.groups.includes(id!));
}
