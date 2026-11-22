import { bytes, endpoint, postJson, type Fetcher } from '../http.ts';

export interface SongRequest { lyrics:string; style:string; duration_seconds?:number; requirements?:string; }
export interface SongAudio { audio:Buffer; extension:'mp3'|'wav'; capped:boolean; }
export function musicPrompt(request:SongRequest,seconds:number){
 // The engine drops words following a leading [tag]. Split them before its normalizer sees them.
 const lyrics=request.lyrics.replace(/\r\n?/g,'\n').replace(/\[([^\[\]\n]+)\]/g,(_tag,inner)=>'\n['+inner.trim().toLowerCase()+']\n').split('\n').map(line=>line.trim()).filter(Boolean).join('\n');
 const style=request.style.trim().replace(/\r\n?/g,'\n').replace(/^[ \t]*(?:#{1,3}[ \t]*)?(Global Metadata|Vocal Details|Arrangement)[ \t]*:?[ \t]*$/gim,'$1');
 const sections=style.match(/^Global Metadata\n([\s\S]+?)\nVocal Details\n([\s\S]+?)\nArrangement\n([\s\S]+)$/);
 if(!sections)throw new Error('style需用英文三段式描述，每个标题独占一行：Global Metadata、Vocal Details、Arrangement。歌词保留用户语言。');
 if(!lyrics.replace(/\[[^\]]+\]/g,'').trim())throw new Error('Singing requires actual lyric words');
 const beginsWithIntro=/^\[intro\]/i.test(lyrics);
 return {lyrics:/^\[/.test(lyrics)?lyrics:'[verse]\n'+lyrics,caption:
  'Global Metadata\n'+sections[1]!.trim()+`\nTarget duration: ${seconds} seconds, a compact vocal song with a resolved ending.\nExplicit user requirements (verbatim): `+(request.requirements??'Use the requested style and lyrics.')+
  '\nVocal Details\n'+sections[2]!.trim()+
  '\nArrangement\n'+sections[3]!.trim()+(beginsWithIntro?'':`\nThe first sung verse starts on the opening downbeat at 0:00. The lead voice carries the melody throughout the verse and chorus, accompanied by the instruments.`)+`\nThe last lyric resolves by ${Math.max(1,seconds-2)} seconds, followed by a short final cadence within the ${seconds}-second limit.`};
}
export class Music3 {
 readonly base:string;
 private fetcher:Fetcher;
 constructor(base:string, fetcher:Fetcher=fetch) {
  this.fetcher=fetcher;
  const url=endpoint(base,['http:']);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/')throw new Error('Music3 requires a loopback HTTP endpoint');
  this.base=base.replace(/\/$/,'');
 }
 async submit(request:SongRequest,seconds:number,signal?:AbortSignal):Promise<string> {
  if(typeof request.lyrics!=='string'||!request.lyrics.trim()||request.lyrics.length>500)throw new Error('Song lyrics require 1–500 characters');
  if(typeof request.style!=='string'||!request.style.trim()||request.style.length>1500)throw new Error('Song style requires 1–1500 characters');
  if(request.requirements!==undefined&&(typeof request.requirements!=='string'||request.requirements.length>2000))throw new Error('Invalid song requirements');
  const prompt=musicPrompt(request,seconds);
  const result=await postJson(this.fetcher,this.base+'/synth','',{
   ...prompt,
   duration:seconds,steps:30,lm_batch_size:1,synth_batch_size:1,output_format:'mp3',mp3_bitrate:128
  },signal,10000);
  if(typeof result.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(result.id))throw new Error('Music3 returned an invalid job ID');
  return result.id;
 }
 async status(id:string,signal:AbortSignal):Promise<string> {
  const response=await this.fetcher(this.base+'/job?id='+encodeURIComponent(id),{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),redirect:'error'});
  if(!response.ok)throw new Error(`Music3 status HTTP ${response.status}`);
  const body=JSON.parse((await bytes(response,10000)).toString('utf8'));
  if(!['queued','running','done','failed','cancelled'].includes(body.status))throw new Error('Invalid Music3 status');
  return body.status;
 }
 async result(id:string,seconds:number,signal:AbortSignal):Promise<SongAudio> {
  const response=await this.fetcher(this.base+`/job?id=${encodeURIComponent(id)}&result=1`,{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),redirect:'error'});
  if(!response.ok)throw new Error(`Music3 result HTTP ${response.status}`);
  const boundary=response.headers.get('content-type')?.match(/boundary="?([^";\s]+)/i)?.[1];
  if(!boundary||boundary.length>100)throw new Error('Music3 result has no valid boundary');
  const data=await bytes(response,24*1024*1024),delimiter=Buffer.from('--'+boundary);
  let cursor=0,audio:SongAudio|undefined,capped=false;
  for(;;){
   const start=data.indexOf(delimiter,cursor);if(start<0)break;
   const headersEnd=data.indexOf('\r\n\r\n',start+delimiter.length+2);if(headersEnd<0)break;
   const end=data.indexOf(delimiter,headersEnd+4);if(end<0)break;
   const headers=data.subarray(start+delimiter.length+2,headersEnd).toString('ascii');
   const body=data.subarray(headersEnd+4,end-2);cursor=end;
   if(/Content-Type:\s*application\/json/i.test(headers)){
    const replay=JSON.parse(body.toString('utf8'));
    if(typeof replay.audio_codes==='string')capped=replay.audio_codes.split(',').length/8>=Math.floor(seconds*25);
   }else if(/Content-Type:\s*audio\/(mpeg|wav)/i.test(headers)&&!audio){
    const extension=/audio\/wav/i.test(headers)?'wav':'mp3';
    const valid=extension==='wav'?body.toString('ascii',0,4)==='RIFF':body.toString('ascii',0,3)==='ID3'||body[0]===255&&((body[1]??0)&224)===224;
    if(!valid||body.length<12)throw new Error('Music3 returned invalid audio');
    audio={audio:Buffer.from(body),extension,capped:false};
   }
  }
  if(!audio)throw new Error('Music3 result contains no audio');
  return {...audio,capped};
 }
 async cancel(id:string):Promise<void> {
  await this.fetcher(this.base+`/job?id=${encodeURIComponent(id)}&cancel=1`,{method:'POST',signal:AbortSignal.timeout(3000),redirect:'error'}).catch(()=>{});
 }
}
