'use strict';
/* AI help outside the AI tab, using the AI picked there (own key or the Mac).
   The AI only proposes: a sentence or a photo becomes records or schedule entries shown as cards,
   and nothing is saved until a person checks them. The weekly summary is written from numbers this
   app computes; record text is never sent. Loaded before app.js and only called after it has run. */
const aiHelp={loading:false,records:null,schedule:null,stats:null,scope:''};
function aiHelpReset(){
 aiHelp.loading=false;aiHelp.scope='';aiHelp.guesses=new Map();aiHelp.guessing=false;aiHelp.autoCount=0;
 aiHelp.records={text:'',items:null,status:'',working:false};
 aiHelp.schedule={text:'',image:null,items:null,status:'',working:false};
 aiHelp.stats={summary:'',by:'',at:'',status:'',working:false};
}
aiHelpReset();

// The AI list is loaded once in the background, so the cards only appear when an AI can answer.
async function aiHelpConfig(){
 if(ai.config||aiHelp.loading||!shared?.token||shared.readOnly)return;
 const state=ai;aiHelp.loading=true;
 try{
  const config=await shared.aiStatus();
  if(ai!==state||ai.config)return;
  ai.config={...config,providers:Array.isArray(config.providers)?config.providers:[]};
 }catch{return;/* the AI tab explains a failure */}
 finally{if(ai===state)aiHelp.loading=false;}
 if(['records','schedule','stats','review'].includes(page)&&!editingScreen())render();
}
function aiHelpOption(){
 if(!ai.config||!shared?.token||shared.readOnly)return null;
 const options=aiOptions();let remembered='';try{remembered=localStorage.getItem(AI_PICK)||'';}catch{}
 return options.find(o=>o.value===(ai.selected||remembered))||options.find(o=>o.value==='key:antigravity')||options[0]||null;
}
async function aiHelpAsk(picked,question,image=null){
 if(image&&picked.mode!=='key')throw Error('사진은 AI 탭에서 내 API 키로 연결한 AI만 읽을 수 있어요. 문장으로 적어 주세요.');
 const result=picked.mode==='plan'?await shared.request('/api/chatgpt/ask','POST',{question,scope:'none',model:ai.config.chatgptPlan.model},shared.base,shared.token,55000)
  :picked.mode==='mac'?await shared.askAI(question,'none',picked.p.id)
  :await aiDirect.ask(picked.p.id,picked.key,question,null,[],image);
 if(typeof result?.answer!=='string'||!result.answer.trim())throw Error('AI 답변을 확인하지 못했어요. 다시 시도해 주세요.');
 return result.answer;
}
// The AI is asked for one JSON object; code fences or a sentence around it are ignored.
function aiJSON(text){
 const s=String(text).replace(/```(?:json)?/gi,''),a=s.indexOf('{'),b=s.lastIndexOf('}');
 try{if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));}catch{}
 throw Error('AI가 정리한 결과를 읽지 못했어요. 문장을 조금 바꿔 다시 시도해 주세요.');
}
function aiNowLine(now){const d=new Date(now+':00');return `${now.replace('T',' ')} (${weekdays[d.getDay()]}요일)`;}
function aiLater(now,minutes){return Somhouse.localDateTime(new Date(new Date(now+':00').getTime()+minutes*60000));}
function aiStamp(v){
 const s=String(v||'').trim().replace(' ','T').slice(0,16);
 return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)&&!Number.isNaN(new Date(s+':00').getTime())?s:'';
}
function aiText(v,max=200){return typeof v==='string'?v.trim().slice(0,max):'';}
const AI_INPUT_MAX=500;

// ① A sentence becomes records. Kept short enough for the Mac's 2,000-character question limit.
function aiRecordPrompt(now,text){
 return `아래 문장을 육아 기록으로 바꿔 JSON 하나만 답하세요. 설명과 코드 블록 없이 {"items":[...]} 형식입니다.
지금은 ${aiNowLine(now)}입니다. 날짜가 없으면 지금 이전의 가장 가까운 시각으로 정하고, 시각은 24시간제 YYYY-MM-DDTHH:MM으로 쓰세요.
항목 종류:
{"type":"feeding","date":"","category":"모유|분유|혼합|기타","amount":"분유·혼합은 120ml, 모유는 15분처럼","memo":""}
{"type":"sleep","date":"잠든 시각","end":"깬 시각, 모르면 빈 문자열","category":"낮잠|밤잠","memo":""}
{"type":"diaper","date":"","category":"소변|대변|둘 다","memo":""}
{"type":"hospital","date":"","hospital":"병원 이름","reason":"방문 이유","memo":""}
문장에 없는 값은 지어내지 말고 빈 문자열로 두세요. 기록할 내용이 없으면 {"items":[]}로 답하세요.
문장: ${text}`;
}
// Only well-formed records can be saved straight away; anything unsure must be fixed in the form first.
function aiRecordItems(json,now){
 const list=Array.isArray(json?.items)?json.items.slice(0,10):[];
 return list.map(x=>{
  const type=['feeding','sleep','diaper','hospital'].includes(x?.type)?x.type:'';
  if(!type)return null;
  const record={type,date:aiStamp(x.date),memo:aiText(x.memo)},problems=[];
  if(!record.date){record.date=now;problems.push('시각을 확인해 주세요');}
  else if(record.date>aiLater(now,10))problems.push('지금보다 늦은 시각이에요');
  if(type==='feeding'){
   record.category=choices.category.includes(x.category)?x.category:'기타';
   let amount=aiText(x.amount,40);
   if(units[record.category]&&/^\d+(\.\d+)?$/.test(amount))amount+=units[record.category][0];
   record.amount=amount;if(!amount)problems.push('양을 입력해 주세요');
  }
  if(type==='sleep'){
   const hour=Number(record.date.slice(11,13));
   record.category=choices['sleep.category'].includes(x.category)?x.category:hour>=7&&hour<19?'낮잠':'밤잠';
   record.end=aiStamp(x.end);if(record.end&&record.end<=record.date)record.end='';
   if(record.end>aiLater(now,10))problems.push('깬 시각이 지금보다 늦어요');
  }
  if(type==='diaper'){record.category=choices['diaper.category'].includes(x.category)?x.category:'';if(!record.category)problems.push('종류를 골라 주세요');}
  if(type==='hospital'){record.hospital=aiText(x.hospital,100);record.reason=aiText(x.reason,100);if(!record.hospital||!record.reason)problems.push('병원과 방문 이유를 채워 주세요');}
  return {record,problems,notes:[]};
 }).filter(Boolean);
}

// ③ A sentence or a photo (an appointment card, a text message) becomes schedule entries.
function aiSchedulePrompt(now,text,photo){
 return `아래 ${photo?'사진과 문장':'문장'}에서 가족 일정을 찾아 JSON 하나만 답하세요. 설명과 코드 블록 없이 {"items":[...]} 형식입니다.
지금은 ${aiNowLine(now)}입니다. "다음 주 화요일" 같은 날짜는 지금 기준으로 계산하고, 시각은 24시간제 YYYY-MM-DDTHH:MM으로 쓰세요. 시각을 모르면 09:00으로 쓰고 "time_unknown":true로 표시하세요.
항목: {"date":"","title":"일정 이름","place":"장소, 없으면 빈 문자열","who":"${whoChoices().join('|')} 중 하나, 모르면 빈 문자열","memo":"준비물 등, 없으면 빈 문자열","time_unknown":false}
내용에 없는 값은 지어내지 마세요. 일정이 없으면 {"items":[]}로 답하세요.
문장: ${text||'(사진만 보냈어요)'}`;
}
function aiScheduleItems(json,now){
 const list=Array.isArray(json?.items)?json.items.slice(0,10):[];
 return list.map(x=>{
  if(!x||typeof x!=='object')return null;
  const who=whoChoices().includes(x.who)?x.who:'가족';
  const record={date:aiStamp(x.date),title:aiText(x.title,100),place:aiText(x.place,100),who,memo:aiText(x.memo)},problems=[],notes=[];
  if(!record.date){problems.push('날짜와 시각을 확인해 주세요');record.date='';}
  if(!record.title)problems.push('일정 이름을 입력해 주세요');
  if(x.time_unknown===true)notes.push('시각을 몰라 09:00으로 넣었어요');
  if(record.date&&record.date<now)notes.push('이미 지난 날짜예요');
  return {record,problems,notes};
 }).filter(Boolean);
}

async function aiHelpRun(k){
 const draft=aiHelp[k],picked=aiHelpOption(),state=ai;
 if(!picked||draft.working)return;
 const text=draft.text.trim().slice(0,AI_INPUT_MAX),image=k==='schedule'?draft.image:null;
 if(!text&&!image){draft.status=k==='schedule'?'일정 내용을 적거나 사진을 골라 주세요.':'기록할 내용을 적어 주세요.';render();return;}
 const now=Somhouse.localDateTime();
 draft.working=true;draft.status=`${aiName(picked)}가 정리하고 있어요…`;draft.items=null;render();
 try{
  const answer=await aiHelpAsk(picked,k==='records'?aiRecordPrompt(now,text):aiSchedulePrompt(now,text,Boolean(image)),image);
  if(ai!==state)return;
  const items=k==='records'?aiRecordItems(aiJSON(answer),now):aiScheduleItems(aiJSON(answer),now);
  draft.items=items.length?items:null;
  draft.status=items.length?'내용을 확인하고 저장해 주세요. 표시가 있는 항목은 고쳐서 저장해요.':`${k==='records'?'기록':'일정'}으로 바꿀 내용을 찾지 못했어요. 조금 더 자세히 적어 주세요.`;
 }catch(error){
  if(ai!==state)return;
  if(error.status===401&&picked.mode!=='key'){showLogin(error.message);return;}
  draft.status=error.message;
 }finally{if(ai===state){draft.working=false;if(!editingScreen())render();}}
}
async function aiHelpSave(k){
 const draft=aiHelp[k],ready=(draft.items||[]).filter(x=>!x.problems.length);
 let saved=0;
 for(const x of ready){
  if(!await changeItem(k,{id:newId(),...x.record}))break;
  saved++;draft.items=draft.items.filter(y=>y!==x);
 }
 if(saved){draft.status=`${saved}건 저장했어요.${draft.items.length?' 남은 항목은 고쳐서 저장해 주세요.':''}`;if(!draft.items.length){draft.items=null;draft.text='';draft.image=null;}}
 render();
}
// The form opens with the proposal filled in; the card leaves the list because the form now holds it.
function aiHelpEdit(k,index){
 const draft=aiHelp[k],x=draft.items?.[index];if(!x)return;
 draft.items=draft.items.filter(y=>y!==x);if(!draft.items.length)draft.items=null;
 openForm(k==='records'?x.record.type:'schedule',null,{...x.record});
}
function aiHelpDrop(k,index){
 const draft=aiHelp[k];if(!draft.items?.[index])return;
 draft.items=draft.items.filter((_,i)=>i!==index);if(!draft.items.length)draft.items=null;render();
}

// ② Voice or Calendar input the rules could not read: the AI suggests a reading, the form opens to check it.
// Opening the review page reads up to 5 items in the background (5 in all until logout, so the AI's limits are
// not used up); each reading is kept until logout. The rest wait for their button.
const REVIEW_AUTO=5;
async function aiGuess(picked,entry){
 const now=aiStamp(entry.when)||Somhouse.localDateTime();
 const answer=await aiHelpAsk(picked,aiRecordPrompt(now,String(entry.title||'').slice(0,AI_INPUT_MAX)));
 return aiRecordItems(aiJSON(answer),now).find(x=>['feeding','sleep'].includes(x.record.type))||null;
}
function aiGuessForm(entry,found){
 openForm(found.record.type,null,{...found.record,memo:found.record.memo||(entry.title?'음성 원문: '+entry.title:'')},entry.key);
}
async function aiReviewAuto(){
 const picked=aiHelpOption(),state=ai;
 if(!picked||aiHelp.guessing)return;
 const todo=reviewItems().filter(x=>x.status!=='웹 기록 유지'&&!aiHelp.guesses.has(x.key)).slice(0,REVIEW_AUTO-aiHelp.autoCount);
 if(!todo.length)return;
 aiHelp.guessing=true;
 try{
  for(const entry of todo){
   if(ai!==state||page!=='review')break;
   aiHelp.autoCount++;aiHelp.guesses.set(entry.key,{state:'working'});if(!editingScreen())render();
   try{const found=await aiGuess(picked,entry);if(ai!==state)return;aiHelp.guesses.set(entry.key,found?{state:'done',found}:{state:'none'});}
   catch(error){
    if(ai!==state)return;
    aiHelp.guesses.set(entry.key,{state:'error',message:error.message});
    if(error.status===401&&picked.mode!=='key'){showLogin(error.message);return;}
    break; // a limit or a network problem: leave the rest for the button
   }
   if(!editingScreen())render();
  }
 }finally{if(ai===state){aiHelp.guessing=false;if(page==='review'&&!editingScreen())render();}}
}
async function aiHelpReview(key){
 const entry=reviewItems().find(x=>x.key===key),picked=aiHelpOption(),state=ai,cached=aiHelp.guesses.get(key);
 if(!entry||!picked)return;
 if(cached?.state==='done'){aiGuessForm(entry,cached.found);return;}
 if(aiHelp.records.working||cached?.state==='working')return;
 aiHelp.records.working=true;aiHelp.guesses.set(key,{state:'working'});message(`${aiName(picked)}가 ‘${entry.title||'입력'}’을 해석하고 있어요…`);render();
 try{
  const found=await aiGuess(picked,entry);
  if(ai!==state)return;
  aiHelp.guesses.set(key,found?{state:'done',found}:{state:'none'});
  if(!found){message('AI도 이 입력을 수유나 수면으로 확실히 읽지 못했어요. 직접 확인해 주세요.');return;}
  message(`${aiName(picked)}가 해석한 내용이에요. 확인하고 저장해 주세요.`);
  aiGuessForm(entry,found);
 }catch(error){
  if(ai!==state)return;
  aiHelp.guesses.set(key,{state:'error',message:error.message});
  if(error.status===401&&picked.mode!=='key')showLogin(error.message);else message(error.message);
 }finally{if(ai===state){aiHelp.records.working=false;connectionView();if(!$('#dialog').open)render();}}
}

function aiHelpCard(k){
 const picked=aiHelpOption();if(!picked)return '';
 const draft=aiHelp[k],records=k==='records';
 const title=records?'✨ 한 줄로 기록하기':'✨ 문장이나 사진으로 일정 만들기';
 const example=records?'예: 새벽 3시 분유 120 먹고 4시에 잠':'예: 다음 주 화요일 10시 반 소아과 예방접종 · 예약 문자나 안내문 사진도 돼요';
 const photo=!records?(picked.mode==='key'?`<label class="ai-photo">사진 고르기<input type="file" accept="image/*" data-ai-image="schedule"></label>${draft.image?` <span class="badge">${esc(draft.image.name)}</span> <button type="button" class="plain small" data-ai-photo-clear="1">사진 빼기</button>`:''}`:'<span class="caption">사진은 내 API 키로 연결한 AI만 읽을 수 있어요.</span>'):'';
 const list=(draft.items||[]).map((x,i)=>{
  const r=x.record,line=records?(r.type==='diaper'&&!r.category?'🧷 기저귀':desc(r,'records')):`${r.who?`<span class="who who-${whoClass(r.who)}">${esc(r.who)}</span> `:''}${esc(r.title)}${r.place?` · ${esc(r.place)}`:''}`;
  const flags=[...x.problems.map(p=>`<span class="badge warn">${esc(p)}</span>`),...x.notes.map(n=>`<span class="badge">${esc(n)}</span>`)].join(' ');
  return `<div class="ai-proposal"><p><strong>${line}</strong><br><span class="caption">${esc((r.date||'날짜 없음').replace('T',' '))}${r.memo?` · ${esc(r.memo)}`:''}</span>${flags?`<br>${flags}`:''}</p><div class="actions"><button type="button" class="secondary small" data-ai-edit="${k}:${i}">${x.problems.length?'고쳐서 저장':'고치기'}</button><button type="button" class="plain small" data-ai-drop="${k}:${i}">빼기</button></div></div>`;
 }).join('');
 const ready=(draft.items||[]).filter(x=>!x.problems.length).length;
 const save=draft.items?`<div class="actions">${ready?`<button type="button" data-ai-save="${k}">${ready}건 저장</button>`:''}<button type="button" class="plain" data-ai-cancel="${k}">모두 취소</button></div>`:'';
 return `<section class="card ai-help" aria-label="${title.slice(2)}"><h2>${title}</h2><p class="caption">${example} · ${esc(aiName(picked))}가 정리하면 확인하고 저장해요.</p><textarea data-ai-input="${k}" maxlength="${AI_INPUT_MAX}" placeholder="${records?'있었던 일을 편하게 적어 주세요':'일정 내용을 적어 주세요'}">${esc(draft.text)}</textarea><div class="actions ai-help-actions">${photo}<button type="button" data-ai-run="${k}"${draft.working?' disabled':''}>${draft.working?'정리하는 중…':'AI로 정리'}</button></div>${draft.status?`<p class="caption" role="status">${esc(draft.status)}</p>`:''}${list}${save}</section>`;
}
function aiReviewButton(x){
 if(!aiHelpOption()||x.status==='웹 기록 유지')return '';
 const g=aiHelp.guesses.get(x.key);
 if(g?.state==='done')return `<button data-ai-review="${esc(x.key)}">✨ AI 추정대로 확인</button>`;
 if(g?.state==='working')return '<button class="secondary" disabled>✨ 해석하는 중…</button>';
 if(g?.state==='none')return '';
 return `<button class="secondary" data-ai-review="${esc(x.key)}">✨ AI로 해석</button>`;
}
function aiReviewGuess(x){
 const g=aiHelp.guesses.get(x.key);
 if(g?.state==='done'){const r=g.found.record;return `<p class="ai-guess">✨ AI 추정: ${desc(r,'records')} · ${esc(r.date.replace('T',' '))}${g.found.problems.length?` <span class="badge warn">${esc(g.found.problems[0])}</span>`:''}</p>`;}
 if(g?.state==='none')return '<p class="ai-guess caption">✨ AI도 수유나 수면으로 확실히 읽지 못했어요.</p>';
 if(g?.state==='error')return `<p class="ai-guess caption">✨ ${esc(g.message)}</p>`;
 return '';
}

// ④ The week in three lines. The app computes the numbers (complete days only: the 7 days up to
// yesterday against the 7 before); the AI only puts them into words.
function aiWeekNumbers(now=new Date()){
 const yesterday=Somhouse.addDays(Somhouse.localDateTime(now).slice(0,10),-1),tenth=v=>Math.round(v*10)/10;
 const week=(from,to)=>{
  const s=Somhouse.rangeSummary(data.records,from,to,now);
  const days=new Set(data.records.filter(x=>['feeding','sleep','diaper'].includes(x.type)&&x.date.slice(0,10)>=from&&x.date.slice(0,10)<=to).map(x=>x.date.slice(0,10))).size;
  return {from,to,days_with_records:days,feedings_per_day:tenth(s.count/7),measured_ml_per_day:s.measuredCount?tenth(s.volume/7):null,
   breastfeeding_minutes_per_day:s.timedCount?tenth(s.minutes/7):null,sleep_hours_per_day:tenth(s.sleepMinutes/7/60),
   diapers_per_day:tenth(s.diaperCount/7),poo_per_day:tenth(s.pooCount/7)};
 };
 return {this_week:week(Somhouse.addDays(yesterday,-6),yesterday),last_week:week(Somhouse.addDays(yesterday,-13),Somhouse.addDays(yesterday,-7))};
}
function aiSummaryPrompt(numbers){
 return `아래는 아기 기록을 앱이 계산한 하루 평균 숫자예요. this_week는 어제까지 최근 7일, last_week는 그 전 7일이고 null은 그 종류의 기록이 없다는 뜻이에요.
세 줄 이내로 한국어로 요약하세요. 첫 줄은 수유, 둘째 줄은 수면, 셋째 줄은 기저귀이고, 지난주와 비교해 늘었는지 줄었는지 숫자와 함께 말하세요.
숫자에 없는 내용은 추측하지 마세요. days_with_records가 7보다 적으면 기록이 빠진 날이 있을 수 있다고 알려 주세요.
의료 판단은 하지 말고, 걱정되는 변화가 있으면 소아과 상담을 권하세요.
숫자: ${JSON.stringify(numbers)}`;
}
async function aiHelpSummary(){
 const draft=aiHelp.stats,picked=aiHelpOption(),state=ai;
 if(!picked||draft.working)return;
 const numbers=aiWeekNumbers();
 if(!numbers.this_week.days_with_records&&!numbers.last_week.days_with_records){draft.status='요약할 기록이 아직 없어요. 며칠 기록한 뒤 다시 눌러 주세요.';render();return;}
 draft.working=true;draft.status=`${aiName(picked)}가 요약하고 있어요…`;render();
 try{
  const answer=await aiHelpAsk(picked,aiSummaryPrompt(numbers));
  if(ai!==state)return;
  Object.assign(draft,{summary:answer.trim().slice(0,1000),by:aiName(picked),at:Somhouse.localDateTime(),status:''});
 }catch(error){
  if(ai!==state)return;
  if(error.status===401&&picked.mode!=='key'){showLogin(error.message);return;}
  draft.status=error.message;
 }finally{if(ai===state){draft.working=false;if(!editingScreen())render();}}
}
function aiSummaryCard(){
 const picked=aiHelpOption();if(!picked)return '';
 const draft=aiHelp.stats;
 return `<section class="card ai-help ai-summary" aria-label="AI 주간 요약"><h2>✨ AI 주간 요약</h2><p class="caption">어제까지 7일을 그 전 7일과 비교해요. 기록 원문은 보내지 않고 앱이 계산한 하루 평균 숫자만 ${esc(aiName(picked))}에게 보내요.</p>${draft.summary?`<p class="ai-summary-text">${esc(draft.summary)}</p><p class="caption">${esc(draft.by)} · ${esc(draft.at.replace('T',' '))}</p>`:''}<div class="actions"><button type="button" data-ai-summary="1"${draft.working?' disabled':''}>${draft.working?'요약하는 중…':draft.summary?'다시 요약':'요약 받기'}</button></div>${draft.status?`<p class="caption" role="status">${esc(draft.status)}</p>`:''}${picked.summaries?`<p class="caption ai-ask-more">더 궁금하면 집계를 붙여 AI 탭에서 물어보세요.</p><div class="quick">${[['feeding','🍼 수유'],['sleep','😴 수면'],['diaper','🧷 기저귀']].map(([scope,label])=>`<button type="button" class="secondary small" data-ai-ask-scope="${scope}">${label} 기록으로 묻기</button>`).join('')}</div>`:''}</section>`;
}

// Called from the app's click handler; true when the click was ours.
async function aiHelpClick(b){
 const d=b.dataset||{};
 const pick=v=>{const [k,i]=String(v).split(':');return ['records','schedule'].includes(k)?[k,Number(i)]:[null,-1];};
 if(['records','schedule'].includes(d.aiRun)){await aiHelpRun(d.aiRun);return true;}
 if(['records','schedule'].includes(d.aiSave)){await aiHelpSave(d.aiSave);return true;}
 if(['records','schedule'].includes(d.aiCancel)){const draft=aiHelp[d.aiCancel];draft.items=null;draft.status='';render();return true;}
 if(d.aiEdit){const [k,i]=pick(d.aiEdit);if(k)aiHelpEdit(k,i);return true;}
 if(d.aiDrop){const [k,i]=pick(d.aiDrop);if(k)aiHelpDrop(k,i);return true;}
 if(d.aiPhotoClear){aiHelp.schedule.image=null;render();return true;}
 if(d.aiReview){await aiHelpReview(d.aiReview);return true;}
 if(d.aiSummary){await aiHelpSummary();return true;}
 // Opens the AI tab with that week's numbers chosen; the AI tab applies it once the AI list loads.
 if(['feeding','sleep','diaper'].includes(d.aiAskScope)){aiHelp.scope=d.aiAskScope;location.hash='ai';return true;}
 return false;
}
// Typing is kept in memory so a refresh from another phone does not wipe it.
document.addEventListener('input',e=>{const k=e.target?.dataset?.aiInput;if(aiHelp[k]&&'text' in aiHelp[k])aiHelp[k].text=String(e.target.value||'').slice(0,AI_INPUT_MAX);});
document.addEventListener('change',e=>{if(e.target?.dataset?.aiImage==='schedule')aiHelpPhoto(e.target.files?.[0]);});
// Photos are shrunk on the device (long side 1600px, JPEG) before going to the AI company.
async function aiHelpPhoto(file){
 if(!file)return;
 if(!/^image\//.test(file.type||'')){aiHelp.schedule.status='사진 파일만 고를 수 있어요.';render();return;}
 try{
  let blob=file;
  // A format the browser cannot draw (some HEIC photos) is sent as it is, within the size limit.
  if(typeof createImageBitmap==='function')try{
   const bitmap=await createImageBitmap(file),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
   const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
   canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
   blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.85))||file;
  }catch{blob=file;}
  if(blob.size>4*1024*1024)throw Error('사진이 너무 커요. 더 작은 사진을 골라 주세요.');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(Error('사진을 읽지 못했어요.'));reader.readAsDataURL(blob);});
  aiHelp.schedule.image={mime:blob.type||'image/jpeg',data,name:file.name||'사진'};aiHelp.schedule.status='';
 }catch(error){aiHelp.schedule.image=null;aiHelp.schedule.status=error.message||'사진을 읽지 못했어요.';}
 render();
}
