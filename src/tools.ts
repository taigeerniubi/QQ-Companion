export const descriptions:Record<string,string>={
 qq_reply:'向当前绑定的QQ会话发送回复。parts 支持 text/voice(text), image(assetId), sticker(id), face(id), reply(id), at(id)。不能选择另一个收件人。',
 qq_stickers:'列出已导入的图片/表情包，以及QQ收藏表情的ID与说明。',
 memory_search:'检索当前范围的有效记忆；关联候选只返回短标题与关系，不含全文。',
 memory_candidates:'翻页查看已缓存的关联记忆目录。',memory_read:'按set_id和ids读取候选正文，受每轮累计预算限制。',
 memory_history:'仅在明确需要过去版本时读取历史；旧版本不能作为当前事实。',memory_submit:'提交记忆变更JSON，然后结束。'
};
const string={type:'string'},integer={type:'integer'};
export const schemas:Record<string,any>={
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
