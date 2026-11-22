import {endpoint,postJson,bytes,type Fetcher} from '../http.ts';
export interface QwenOptions {apiBase:string;apiKey:string;asrModel:string;ttsModel:string;voice:string}
export class QwenSpeech {
 private options:QwenOptions;private fetcher:Fetcher;
 constructor(options:QwenOptions,fetcher:Fetcher=fetch){endpoint(options.apiBase);this.options=options;this.fetcher=fetcher;}
 get ready(){return Boolean(this.options.apiKey&&this.options.voice);}
 private call(path:string,body:unknown,signal?:AbortSignal){if(!this.options.apiKey)throw new Error('Qwen API key is not configured');return postJson(this.fetcher,this.options.apiBase.replace(/\/$/,'')+path,this.options.apiKey,body,signal);}
 async transcribe(audio:Buffer,signal?:AbortSignal):Promise<string>{
  if(!audio.length||audio.length>20*1024*1024)throw new Error('Audio size exceeds limit');
  const result=await this.call('/api/v1/services/aigc/multimodal-generation/generation',{model:this.options.asrModel,input:{messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'data:audio/wav;base64,'+audio.toString('base64')}}]}]}},signal);
  const content=result.output?.choices?.[0]?.message?.content;
  const text=typeof content==='string'?content:Array.isArray(content)?content.map((x:any)=>typeof x.text==='string'?x.text:'').join(''):'';
  if(!text.trim())throw new Error('Qwen ASR returned no transcript');return text.trim().slice(0,12000);
 }
 async synthesize(text:string,signal?:AbortSignal):Promise<Buffer>{
  if(!this.options.voice)throw new Error('Qwen voice is not configured');if(!text.trim()||text.length>2000)throw new Error('TTS requires 1–2000 characters');
  const result=await this.call('/api/v1/services/audio/tts/SpeechSynthesizer',{model:this.options.ttsModel,input:{text,voice:this.options.voice,format:'wav',sample_rate:24000,language_hints:['zh']}},signal);
  const url=new URL(result.output?.audio?.url??'');
  if(!url.hostname.endsWith('.aliyuncs.com')||url.username||url.password||!['https:','http:'].includes(url.protocol))throw new Error('Unexpected Qwen audio location');
  url.protocol='https:';const response=await this.fetcher(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw new Error(`Audio download HTTP ${response.status}`);const audio=await bytes(response,20*1024*1024);if(!audio.length)throw new Error('Empty Qwen audio');return audio;
 }
}
