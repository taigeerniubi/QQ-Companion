export const descriptions:Record<string,string>={
 qq_sing:'仅在用户明确要求唱歌时调用。lyrics 填用户语言的原创短歌词，[verse]/[chorus]标签必须各自独占一行，歌词写在下一行；30秒以内只写短主歌和副歌，不写intro、solo、空outro或啦啦啦占位。每10秒约15–25个汉字，邻行长度接近，少写一点以留出收尾。style必须是英文三段式caption，标题Global Metadata、Vocal Details、Arrangement各自独占一行，正文写在标题下一行：分别写用户的曲风/情绪/语言、明确的主唱声音和唱法、按歌词段落的编曲进程。默认主唱在0:00第一拍直接唱词，以人声带旋律，伴奏随主唱进入；只在用户要求时加前奏/间奏。用户指定秒数时传duration_seconds，缺省用管理上限。用户要求原文由服务注入，不需要单独调用模型改写提示词。任务后台生成并自动发送，返回rendering只表示已提交；qq_reply简短文字告知正在创作后结束本轮，不循环查询状态、不等待歌曲完成，用户继续聊天时正常回复，不能说成已发送或用voice念歌词。',
 qq_song_status:'查询当前QQ会话最近歌曲任务的状态。sent才表示已发送；rendering表示仍在生成，ready表示等待发送；failed/interrupted/unknown需要说明错误，不得自动重新生成或重发。',
 qq_reply:'向当前绑定的QQ会话发送回复。parts 支持 text/voice(text), image(assetId), sticker(id), face(id), reply(id), at(id)。不能选择另一个收件人。',
 qq_stickers:'列出已导入的图片/表情包，以及QQ收藏表情的ID与说明。',
 memory_search:'检索当前范围的有效记忆；关联候选只返回短标题与关系，不含全文。',
 memory_candidates:'翻页查看已缓存的关联记忆目录。',memory_read:'按set_id和ids读取候选正文，受每轮累计预算限制。',
 memory_history:'仅在明确需要过去版本时读取历史；旧版本不能作为当前事实。',memory_submit:'提交记忆变更JSON，然后结束。'
};
const string={type:'string'},integer={type:'integer'};
export const schemas:Record<string,any>={
 qq_sing:{type:'object',properties:{lyrics:string,style:string,duration_seconds:integer},required:['lyrics','style'],additionalProperties:false},
 qq_song_status:{type:'object',properties:{},additionalProperties:false},
 qq_reply:{type:'object',properties:{parts:{type:'array',items:{type:'object',properties:{type:string,text:string,id:{oneOf:[string,integer]},assetId:string},required:['type'],additionalProperties:false}}},required:['parts'],additionalProperties:false},
 qq_stickers:{type:'object',properties:{},additionalProperties:false},
 memory_search:{type:'object',properties:{query:string},required:['query'],additionalProperties:false},
 memory_candidates:{type:'object',properties:{set_id:string,cursor:integer},required:['set_id'],additionalProperties:false},
 memory_read:{type:'object',properties:{set_id:string,ids:{type:'array',items:string}},required:['set_id','ids'],additionalProperties:false},
 memory_history:{type:'object',properties:{id:string,cursor:integer},required:['id'],additionalProperties:false},
 memory_submit:{type:'object',properties:{json:string},required:['json'],additionalProperties:false}
};
/** Validate the small JSON Schema subset used by our tools, before any side effect. */
export function validateArguments(schema:any,value:any,path='arguments'):void {
 if(schema.oneOf){let matches=0;for(const choice of schema.oneOf)try{validateArguments(choice,value,path);matches++;}catch{}if(matches!==1)throw new Error(`Invalid ${path}`);return;}
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Expected object: ${path}`);
  for(const key of schema.required??[])if(!(key in value))throw new Error(`Missing ${path}.${key}`);
  for(const [key,v]of Object.entries(value)){if(!Object.hasOwn(schema.properties??{},key))throw new Error(`Unknown ${path}.${key}`);validateArguments(schema.properties[key],v,`${path}.${key}`);}
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length>100)throw new Error(`Invalid array: ${path}`);for(const v of value)validateArguments(schema.items,v,path+'[]');
 }else if(schema.type==='integer'){if(!Number.isSafeInteger(value))throw new Error(`Invalid integer: ${path}`);}
 else if(schema.type==='string'){if(typeof value!=='string'||value.length>32000)throw new Error(`Invalid string: ${path}`);}
 else throw new Error('Unsupported tool schema');
}
