const $=id=>document.getElementById(id);let state,selected;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=x=>new Date(Number(x)).toLocaleString('zh-CN');
function notice(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':'';}
async function api(path,value){const response=await fetch('/qq-companion/api/'+path,{method:value===undefined?'GET':'POST',headers:value===undefined?{}:{'content-type':'application/json','x-companion-admin':'1'},body:value===undefined?undefined:JSON.stringify(value)});const data=await response.json();if(response.status===401)location.replace('/qq-companion/login');if(!response.ok)throw new Error(data.error||'请求失败');return data;}
async function action(fn){try{await fn();}catch(e){notice(e.message,true);}}
const labels={port:'管理端口（重启生效）',adminPasswordEnv:'登录密码变量名（重启生效）',deepseekBase:'DeepSeek API 地址',deepseekKeyEnv:'DeepSeek Key 环境变量名',enabled:'启用 QQ 伙伴',selfId:'伙伴号 QQ',ownerId:'你的 QQ',friends:'启用的好友 QQ（逗号分隔）',groups:'启用的群号（逗号分隔）',httpUrl:'OneBot HTTP 地址',wsUrl:'OneBot WS 地址',onebotTokenEnv:'OneBot Token 环境变量名',dataDir:'数据目录（停机修改）',provider:'模型提供方',model:'DeepSeek 模型',persona:'伙伴性格',batchMs:'消息合并等待 / 毫秒',turnTimeoutMs:'单轮超时 / 毫秒',qwenBase:'Qwen API 地址',qwenKeyEnv:'Qwen Key 环境变量名',asrModel:'语音识别模型',ttsModel:'语音合成模型',voice:'Qwen 音色',proactive:'允许主动聊天',quietStart:'免打扰开始 / 时',quietEnd:'免打扰结束 / 时',ownerDaily:'每天主动找你 / 次',ownerIntervalMinutes:'主动找你的最短间隔 / 分钟',friendDaily:'每天主动找好友 / 次',groupCooldownSeconds:'群回复冷却 / 秒'};
const voicePresets=[
 {id:'longanxiaoxin',name:'龙安小昕 · 亲切活泼女声',model:'qwen-audio-3.0-tts-flash'},
 {id:'longpaopao_v3.6',name:'龙泡泡 · 软糯可爱女童声',model:'qwen-audio-3.0-tts-flash'}
];
Object.assign(labels,{musicEnabled:'启用本地唱歌',musicBase:'Music 3 本机地址',musicMaxSeconds:'歌曲时长上限 / 秒',musicTimeoutMs:'歌曲等待上限 / 毫秒',proactiveOwnerOnly:'只主动找你（其他好友不主动联系）'});
const songStates={submitting:'正在提交',rendering:'正在谱曲演唱',ready:'等待发送',sending:'发送中',sent:'已发送',failed:'失败',interrupted:'提交未确认',unknown:'发送待核对'};
function renderSongs(){
 const songs=state.songs??[];$('songs-panel').hidden=!state.config.musicEnabled&&!songs.length;
 $('songs').innerHTML=songs.map(song=>`<div class="row">${esc(song.scope)}<span class="pill">${esc(songStates[song.state]??song.state)}</span><br><small>${time(song.at)} · ${esc(song.durationSeconds)}秒${song.capped?' · 达到时长上限，结尾可能截断':''}</small>${song.error?`<p>${esc(song.error)}</p>`:''}</div>`).join('')||'<p class="empty">收到唱歌请求后，歌曲会在后台生成并发送。</p>';
 $('model-call-note').textContent='仅统计累计请求次数，不限制日常运行。失败请求也计数，本地 Music3 不计数。';
 const counts=new Map((state.modelCalls??[]).map(row=>[row.model,row.calls]));
 for(const model of [state.config.model,state.config.asrModel,state.config.ttsModel])if(!counts.has(model))counts.set(model,0);
 $('model-calls').innerHTML=[...counts].map(([model,calls])=>`<div class="row">${esc(model)}<span class="pill">${esc(calls)} 次</span></div>`).join('');
 const h=state.status.heartbeat;
 const reason=state.status.paused?'回复已暂停':!state.config.enabled||!state.config.proactive?'主动聊天已关闭':h?.reason??'等待服务启动';
 $('heartbeat').innerHTML=`<div class="row"><b>${esc(reason)}</b><span class="pill">今天 ${esc(h?.todaySent??0)} / ${esc(state.config.ownerDaily)} 次</span><br><small>${h?.lastChecked?'最近检查：'+time(h.lastChecked):'等待首次检查'}${h?.lastAttempt?' · 上次主动判断：'+time(h.lastAttempt):''}</small></div>`;
}
function voiceField(label,value){
 const select=document.createElement('select');select.name='voicePreset';select.setAttribute('aria-label','Qwen 音色');
 for(const [id,name]of [['','不启用语音回复'],...voicePresets.map(p=>[p.id,p.name]),['__custom','自定义音色']]){const option=document.createElement('option');option.value=id;option.textContent=name;select.append(option);}
 const custom=document.createElement('input');custom.name='voice';custom.value=value;custom.placeholder='填写该模型支持的音色 ID';custom.setAttribute('aria-label','自定义音色 ID');
 select.value=!value?'':voicePresets.some(p=>p.id===value)?value:'__custom';
 custom.hidden=select.value!=='__custom';custom.required=select.value==='__custom';
 select.onchange=()=>{
  const preset=voicePresets.find(p=>p.id===select.value);custom.hidden=select.value!=='__custom';custom.required=select.value==='__custom';custom.value=preset?.id??'';
  const model=$('config-form').elements.namedItem('ttsModel');model.readOnly=Boolean(preset);if(preset)model.value=preset.model;
  if(!custom.hidden)custom.focus();
 };
 label.append(select,custom);
}
function configForm(){
 const fragment=document.createDocumentFragment();
 for(const [key,value]of Object.entries(state.config)){
  const label=document.createElement('label');label.textContent=labels[key]||key;if(key==='persona')label.className='wide';
  if(key==='voice'){voiceField(label,value);fragment.append(label);continue;}
  const input=document.createElement(key==='persona'?'textarea':'input');input.name=key;
  if(typeof value==='boolean'){input.type='checkbox';input.checked=value;}else{input.type=typeof value==='number'?'number':'text';input.value=Array.isArray(value)?value.join(','):value;}
  if(['dataDir','port','adminPasswordEnv','provider'].includes(key))input.readOnly=true;
  if(key==='ttsModel')input.readOnly=voicePresets.some(p=>p.id===state.config.voice);
  label.append(input);fragment.append(label);
 }
 $('config-fields').replaceChildren(fragment);
}
function renderMemories(){const q=$('search').value.toLowerCase();$('memory-count').textContent=`${state.totalMemories} 条记忆 · 展示最近 ${state.memories.length} 条`;$('memories').innerHTML=state.memories.filter(n=>[n.title,n.scope,n.preview].join(' ').toLowerCase().includes(q)).map(n=>`<button class="memory-item ${selected===n.id?'active':''}" data-id="${esc(n.id)}"><b>${esc(n.title)}<span class="pill">${n.state==='disputed'?'待澄清':'当前'} · v${n.version}</span></b><span>${esc(n.preview)}</span><br><small>${esc(n.scope)}</small></button>`).join('')||'<p class="empty">还没有记忆。聊天后会自动提取。</p>';}
async function refresh(){state=await api('state');const s=state.status;$('pause').textContent=s.paused?'恢复回复':'暂停回复';$('stats').innerHTML=[['连接',s.enabled?(s.connection||'连接中'):'未启用'],['记忆',state.totalMemories],['进行中的对话',s.activeTurns||0],['发送待核对',s.unknownSends||0]].map(([k,v])=>`<div class="stat"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');$('outbox').innerHTML=state.outbox.slice(0,12).map(x=>`<div class="row">${esc(x.scope)}<span class="pill">${esc(x.status)}</span><br><small>${time(x.at)}</small></div>`).join('')||'<p class="empty">暂无发送记录</p>';$('audit').innerHTML=state.audit.slice(0,12).map(x=>`<div class="row">${esc(x.action)} <small>${esc(x.scope)}</small><br><small>${time(x.at)}</small></div>`).join('')||'<p class="empty">暂无记忆活动</p>';$('asset-list').innerHTML=state.assets.map(a=>`<div class="row">${esc(a.title)} <small>${esc(a.tags)}</small></div>`).join('');renderMemories();renderSongs();configForm();if(s.error)notice(s.error,true);else if(s.errors?.length)notice(s.errors.at(-1),true);}
async function detail(id){selected=id;renderMemories();const n=state.memories.find(n=>n.id===id);const data=await api(`memory?scope=${encodeURIComponent(n.scope)}&id=${encodeURIComponent(id)}`);$('detail').innerHTML=`<h2>${esc(n.title)}</h2><p class="muted">${esc(n.scope)} · 当前 v${data.memory.version} · ${data.memory.certainty==='inferred'?'待确认推测':'原话依据'} · 已读取 ${data.memory.reads} 次</p><form id="revise-form" class="form"><label>当前内容<textarea name="text" required>${esc(data.memory.text)}</textarea></label><label>事件日期（留空表示未定）<input type="date" name="eventTime" value="${esc((data.memory.eventTime??'').slice(0,10))}"></label><label>修订原因<input name="reason" required placeholder="例如：用户明确改为后天"></label><button class="primary">保留旧版并修订${n.state==='disputed'?' / 确认为有效':''}</button></form><h2 class="row">版本历史</h2>${data.versions.slice().reverse().map(v=>`<div class="version"><b>v${v.version} · ${esc(v.state)}</b> <small>${time(v.at)}</small><p>${esc(v.text)}</p><small>${esc(v.reason)}${v.eventTime?' · '+esc(v.eventTime):''}<br>依据：${esc(v.sourceIds.join(', '))}</small></div>`).join('')}<h2>关联关系</h2>${data.edges.map(e=>`<div class="row">${esc(e.from)} → ${esc(e.relation)} → ${esc(e.to)}</div>`).join('')||'<p class="muted">暂无关联</p>'}<p class="muted">删除只影响该记忆节点及其版本和边；原始聊天归档及服务会话记录仍保留。</p><button id="forget" class="danger">明确删除这条记忆</button>`;
 $('revise-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=new FormData(e.target);await api('revise',{scope:n.scope,id,text:f.get('text'),eventTime:f.get('eventTime')||null,reason:f.get('reason')});notice('新版本已保存，旧版本仍在。');await refresh();await detail(id);});};$('forget').onclick=()=>action(async()=>{if(prompt(`永久删除该记忆的全部版本和关系。请输入 DELETE ${id}`)!==`DELETE ${id}`)return;await api('forget',{scope:n.scope,id,confirm:`DELETE ${id}`});selected=null;$('detail').textContent='已删除。';await refresh();});}
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.hidden=x.id!==button.dataset.tab);document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('selected',x===button));$('heading').textContent=button.textContent;};
$('refresh').onclick=()=>action(refresh);$('pause').onclick=()=>action(async()=>{await api('pause',{paused:!state.status.paused});await refresh();notice(state.status.paused?'已暂停新的回复。':'已恢复回复。');});$('search').oninput=renderMemories;$('memories').onclick=e=>{const b=e.target.closest('[data-id]');if(b)action(()=>detail(b.dataset.id));};
$('config-form').onsubmit=e=>{e.preventDefault();action(async()=>{const next={...state.config};for(const [key,old]of Object.entries(next)){const el=e.target.elements.namedItem(key);next[key]=typeof old==='boolean'?el.checked:typeof old==='number'?Number(el.value):Array.isArray(old)?el.value.split(/[,，\s]+/).filter(Boolean):el.value;}const preset=voicePresets.find(p=>p.id===next.voice);if(preset)next.ttsModel=preset.model;await api('config',next);await refresh();notice('配置已保存。');});};
$('asset-form').onsubmit=e=>{e.preventDefault();action(async()=>{const f=new FormData(e.target),file=f.get('image');if(file.size>10*1024*1024)throw new Error('图片超过 10 MB');const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});await api('asset',{title:f.get('title'),tags:f.get('tags'),base64});e.target.reset();await refresh();notice('素材已导入。');});};
action(refresh);

document.querySelector('#logout').onclick=()=>action(async()=>{await api('logout',{});location.replace('/qq-companion/login');});
