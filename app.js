'use strict';
const KEY='somhouse-v1', empty=()=>({records:[],schedule:[],shopping:[]});
let data=empty(), page='home', editing=null, kind='', draftId='';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function valid(d){
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const fields=(x,required)=>object(x)&&Object.values(x).every(v=>typeof v==='string')&&required.every(k=>typeof x[k]==='string'&&x[k].length>0);
  if(!object(d)||!['records','schedule','shopping'].every(k=>Array.isArray(d[k])))return false;
  return d.records.every(x=>fields(x,['id','type','date',...(x?.type==='feeding'?['category','amount']:['hospital','reason'])])&&['feeding','hospital'].includes(x.type))
    &&d.schedule.every(x=>fields(x,['id','date','title']))
    &&d.shopping.every(x=>fields(x,['id','title','quantity'])&&(x.done===undefined||['yes','no'].includes(x.done)));
}
// The old device key is read only, and is automatically merged after login.
const shared=window.SomhouseShared?new window.SomhouseShared.Client():null;
let mode=shared?.token?'shared':'login', sharedReady=false, busy=false, refreshing=false, refreshTask=null, migratedRaw, legacyWarning='', needsRender=false;
let ai={config:null,checking:false,pending:false};
function message(text){$('#connection-status').textContent=text;}
function accountMessage(text){
 const status=$('#account-status');
 status.textContent=text;status.hidden=!text;
}
function connectionView(){
 const connected=mode==='shared'&&Boolean(shared?.token);
 $('#connection-title').textContent=connected?'가족 기록 · '+shared.username:'가족 로그인';
 $('#login-form').hidden=connected;$('#logout').hidden=!connected;$('#change-password').hidden=!connected;
 $('nav').hidden=!connected||!sharedReady;
 document.querySelectorAll('#connection button, #connection input').forEach(el=>el.disabled=busy);
 document.querySelectorAll('#password-form button, #password-form input').forEach(el=>el.disabled=busy);
 document.querySelectorAll('#content button[data-add], #content button[data-action]').forEach(el=>el.disabled=busy||!sharedReady);
 $('#ai-fields').disabled=!connected||busy||!ai.config?.enabled||ai.checking||ai.pending;
}
function showLogin(text){
 shared.clear();mode='login';sharedReady=false;data=empty();migratedRaw=undefined;
 ai={config:null,checking:false,pending:false};
 $('#ai-form').reset();$('#ai-scope-field').hidden=true;$('#ai-result').hidden=true;
 for(const selector of ['#ai-status','#ai-asked','#ai-answer'])$(selector).textContent='';
 for(const dialog of [$('#dialog'),$('#password-dialog')])if(dialog.open)dialog.close();
 accountMessage('');render();message(text);
}
function editingScreen(){return $('#dialog').open||$('#password-dialog').open||Boolean(document.activeElement?.closest?.('#filter-form'));}
async function loadFamilyData(){
 let raw, original;
 try{
  raw=localStorage.getItem(KEY);original=raw===null?empty():JSON.parse(raw);
  if(!valid(original))throw Error();
  legacyWarning='';
 }catch{
  legacyWarning=' 이 기기의 예전 기록을 확인하지 못했어요. 원본은 보존되어 있으니 관리자에게 알려주세요.';
  return shared.load();
 }
 if(raw!==migratedRaw){
  if(['records','schedule','shopping'].some(k=>original[k].length)){
   const result=await shared.merge(original);migratedRaw=raw;return result.data;
  }
  migratedRaw=raw;
 }
 return shared.load();
}
function refreshShared(force=false){
 if(!shared?.token||mode!=='shared'||busy)return Promise.resolve();
 if(refreshTask)return refreshTask;
 if(!force&&editingScreen())return Promise.resolve();
 const token=shared.token;
 refreshing=true;
 refreshTask=(async()=>{
  try{
   const next=await loadFamilyData();
   if(shared.token!==token)return;
   if(!valid(next))throw Error('기록을 확인하지 못했어요. 다시 연결하고 있습니다.');
   const changed=JSON.stringify(next)!==JSON.stringify(data),wasReady=sharedReady;
   data=next;sharedReady=true;if(changed)needsRender=true;
   message('기록은 자동으로 저장되고 가족과 함께 업데이트돼요.'+legacyWarning);
   if((needsRender||!wasReady)&&(!editingScreen()||!wasReady))render();else connectionView();
  }catch(error){
   if(shared.token!==token)return;
   if(error.status===401)showLogin(error.message);else message(error.message);
  }finally{refreshing=false;refreshTask=null;}
 })();
 return refreshTask;
}
async function sharedChange(operation){
 if(busy||mode!=='shared'||!shared?.token)return false;
 const token=shared.token;
 busy=true;connectionView();
 try{
  // An in-flight automatic read finishes before the write; it cannot overwrite the result.
  if(refreshTask)await refreshTask;
  if(!sharedReady||!shared.token){message('로그인 후 기록을 불러오고 있어요. 잠시 후 다시 시도해 주세요.');return false;}
  const next=await operation();
  if(shared.token!==token)return false;
  if(!valid(next))throw Error('저장 결과를 확인하지 못했어요. 입력을 유지하고 다시 연결해 주세요.');
  data=next;message('저장했어요. 가족의 기록에 반영됐어요.');return true;
 }catch(error){
  if(shared.token===token){
   if(error.status===401)showLogin(error.message);else message(error.message);
   alert(error.message);
  }
  return false;
 }finally{busy=false;connectionView();}
}
async function changeItem(k,x,remove=false){return sharedChange(()=>remove?shared.remove(k,x.id):shared.put(k,x));}
const schemas={feeding:[['date','날짜와 시간','datetime-local',1],['category','수유 종류','select',1],['amount','양 또는 시간','text',1],['memo','메모','textarea',0]],hospital:[['date','날짜와 시간','datetime-local',1],['hospital','병원','text',1],['reason','방문 이유','text',1],['memo','메모','textarea',0]],schedule:[['date','날짜와 시간','datetime-local',1],['title','일정 이름','text',1],['memo','메모','textarea',0]],shopping:[['title','품목','text',1],['quantity','수량','text',1],['memo','메모','textarea',0],['url','상품 링크 (선택)','url',0]]};
function link(url){try{let u=new URL(url);return ['http:','https:'].includes(u.protocol)?`<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">상품 링크 ↗</a>`:''}catch{return ''}}
function desc(x,k){if(k==='records')return x.type==='feeding'?`수유 · ${esc(x.category)} · ${esc(x.amount)}`:`병원 · ${esc(x.hospital)} · ${esc(x.reason)}`;return esc(x.title)+(k==='shopping'?` · ${esc(x.quantity)}`:'')}
function item(x,k,compact=false){return `<div class="item"><strong>${desc(x,k)}</strong> ${k==='shopping'?`<span class="badge">${x.done==='yes'?'구매 완료':'구매 예정'}</span>`:''}<p>${esc((x.date||'').replace('T',' '))}${x.memo?'<br>'+esc(x.memo):''}</p>${x.url?link(x.url):''}${compact?'':`<div class="actions">${k==='shopping'?`<button class="secondary" data-action="toggle" data-key="${k}" data-id="${esc(x.id)}">${x.done==='yes'?'다시 예정으로':'완료로 변경'}</button>`:''}<button class="secondary" data-action="edit" data-key="${k}" data-id="${esc(x.id)}">수정</button><button class="secondary" data-action="delete" data-key="${k}" data-id="${esc(x.id)}">삭제</button></div>`}</div>`}
function sorted(k){return [...data[k]].sort((a,b)=>(b.date||b.id).localeCompare(a.date||a.id))}
const pageTitles={home:'홈',records:'육아 기록',schedule:'일정',shopping:'구매 목록',ai:'AI 대화'};
const filters={records:{},schedule:{},shopping:{}};
function route(){const name=location.hash.slice(1);page=Object.hasOwn(pageTitles,name)?name:'home';render()}
function quickButtons(){return '<div class="quick"><button data-add="feeding">＋ 수유 기록</button><button class="secondary" data-add="hospital">병원 방문</button><button class="secondary" data-add="schedule">일정</button><button class="secondary" data-add="shopping">구매 물품</button></div>'}
function homeView(){
  const now=Somhouse.localDateTime();const stats=Somhouse.summary(data.records);
  const upcoming=[...data.schedule].filter(x=>x.date>=now).sort((a,b)=>a.date.localeCompare(b.date));
  return `<h1>우리 가족의 오늘</h1><p class="intro">${esc(now.slice(0,10))} · 작은 순간을 차곡차곡 남겨요.</p>${quickButtons()}
    <section class="card daily" aria-label="오늘의 수유 요약"><h2>오늘의 수유</h2><div class="summary-grid"><div><strong>${stats.count}회</strong><p>오늘 기록한 수유</p></div><div><strong>${stats.volume}ml</strong><p>용량이 명시된 기록 합계</p></div><div><strong>${stats.latest?esc(stats.latest.replace('T',' ')):'아직 없어요'}</strong><p>가장 최근 수유</p></div></div><p class="caption">용량 합계는 오늘 기록 중 ‘80ml’처럼 단위를 명시한 ${stats.measuredCount}건만 계산합니다. 직수 시간과 단위 없는 값은 합산하지 않습니다.</p></section>
    <div class="grid">${[['최근 육아 기록',sorted('records').slice(0,3),'records','첫 수유나 병원 방문을 기록해보세요.'],['다가오는 일정',upcoming.slice(0,3),'schedule','예정된 일정이 없어요.'],['구매 예정',data.shopping.filter(x=>x.done!=='yes').slice(0,3),'shopping','필요한 물품을 추가해보세요.']].map(([title,items,k,msg])=>`<section class="card"><h2>${title}</h2>${items.length?items.map(x=>item(x,k,true)).join(''):`<p class="empty">${msg}</p>`}<button class="plain" data-page="${k}">전체 보기 →</button></section>`).join('')}</div>`;
}
function filterView(k){const f=filters[k];return `<form id="filter-form" class="filters" aria-label="목록 검색"><label>검색<input name="query" type="search" placeholder="메모, 병원, 품목 검색" value="${esc(f.query||'')}"></label>${k==='records'?`<label>기록 종류<select name="type"><option value="">전체</option><option value="feeding" ${f.type==='feeding'?'selected':''}>수유</option><option value="hospital" ${f.type==='hospital'?'selected':''}>병원</option></select></label>`:''}${k==='shopping'?`<label>구매 상태<select name="status"><option value="">전체</option><option value="pending" ${f.status==='pending'?'selected':''}>구매 예정</option><option value="done" ${f.status==='done'?'selected':''}>구매 완료</option></select></label>`:`<label>시작 날짜<input name="from" type="date" value="${esc(f.from||'')}"></label><label>마지막 날짜<input name="to" type="date" value="${esc(f.to||'')}"></label>`}<button type="submit" class="secondary">검색</button><button type="button" class="plain" data-reset="${k}">초기화</button></form>`}
function listView(k){const names={records:'소중한 하루를 간단히 남겨보세요.',schedule:'병원 예약과 가족 일정을 관리해요.',shopping:'필요한 물품을 정리해요. 가격 검색과 구매는 아직 연결되지 않았어요.'};const items=Somhouse.filter(sorted(k),filters[k]);return `<h1>${pageTitles[k]}</h1><p>${names[k]}</p><div class="heading"><h2>기록 ${items.length}개</h2><div class="quick">${k==='records'?'<button data-add="feeding">수유 추가</button><button class="secondary" data-add="hospital">병원 추가</button>':`<button data-add="${k}">추가하기</button>`}</div></div>${filterView(k)}${items.map(x=>item(x,k)).join('')||`<div class="card empty">${data[k].length?'검색 조건에 맞는 기록이 없어요. 조건을 바꾸거나 초기화해보세요.':'아직 기록이 없어요. 추가 버튼으로 시작해보세요.'}</div>`}`}
async function checkAI(){
 const state=ai;
 if(state.checking||state.pending)return;
 state.checking=true;connectionView();
 $('#ai-status').textContent='Antigravity CLI 설정을 확인하고 있어요…';
 try{
  const config=await shared.aiStatus();
  if(ai!==state)return;
  state.config=config;
  $('#ai-scope-field').hidden=!config.recordSummaries;
  if(!config.recordSummaries)$('#ai-scope').value='none';
  $('#ai-status').textContent=config.enabled?'질문마다 새로 답해요.':'관리자가 맥미니에 Antigravity CLI를 연결하면 질문할 수 있어요.';
 }catch(error){
  if(ai!==state)return;
  state.config=null;
  if(error.status===401)showLogin(error.message);else $('#ai-status').textContent=error.message;
 }finally{state.checking=false;connectionView();}
}
async function askAI(e){
 e.preventDefault();
 const state=ai;
 if(busy||state.pending||state.checking||!state.config?.enabled||!shared.token)return;
 const values=new FormData(e.target);
 const question=values.get('question').trim(),scope=state.config.recordSummaries?values.get('scope'):'none';
 if(!question){$('#ai-status').textContent='질문을 입력해 주세요.';return;}
 state.pending=true;connectionView();
 $('#ai-status').textContent='AI 답변을 기다리고 있어요…';
 try{
  const result=await shared.askAI(question,scope);
  if(ai!==state)return;
  if(typeof result.answer!=='string'||!result.answer.trim())throw Error('답변을 확인하지 못했어요. 다시 시도해 주세요.');
  $('#ai-asked').textContent=question;
  $('#ai-answer').textContent=result.answer;
  $('#ai-result').hidden=false;
  $('#ai-question').value='';
  $('#ai-status').textContent=result.truncated?'답변이 길어 일부만 표시했어요.':'답변을 받았어요.';
 }catch(error){
  if(ai!==state)return;
  if(error.status===401)showLogin(error.message);else $('#ai-status').textContent=error.message;
 }finally{state.pending=false;connectionView();}
}
function render(){
 needsRender=false;
 document.querySelectorAll('nav button').forEach(b=>{const active=b.dataset.page===page;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
 document.title=`${pageTitles[page]} · 솜하우스`;
 const connected=mode==='shared'&&sharedReady,showAI=connected&&page==='ai';
 const aiPanel=$('#ai-panel'),openingAI=aiPanel.hidden&&showAI;
 aiPanel.hidden=!showAI;
 if(!connected||showAI){
  $('#content').innerHTML='';connectionView();
  if(openingAI)checkAI();
  return;
 }
 $('#content').innerHTML=page==='home'?homeView():listView(page);
 connectionView();
 const form=$('#filter-form');if(form)form.onsubmit=e=>{e.preventDefault();const next=Object.fromEntries(new FormData(form));if(next.from&&next.to&&next.from>next.to){alert('시작 날짜는 마지막 날짜보다 늦을 수 없어요.');return}filters[page]=next;render()};
}
function openForm(type,x){kind=type;editing=x||null;draftId=x?.id||(typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString()+'-'+Math.random().toString(36).slice(2));const values=x||{date:Somhouse.localDateTime()};$('#formtitle').textContent=(x?'수정 · ':'추가 · ')+({feeding:'수유 기록',hospital:'병원 방문',schedule:'일정',shopping:'구매 목록'}[type]);$('#fields').innerHTML=schemas[type].map(([name,label,t,required])=>`<label class="field">${label}${required?' *':''}${t==='select'?`<select name="${name}" required>${['모유','분유','혼합','기타'].map(v=>`<option ${x?.[name]===v?'selected':''}>${v}</option>`).join('')}</select>`:t==='textarea'?`<textarea name="${name}">${esc(values[name]||'')}</textarea>`:`<input name="${name}" type="${t}" value="${esc(values[name]||'')}" ${required?'required':''}>`}</label>`).join('');$('#dialog').showModal()}
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.page){location.hash=b.dataset.page;if(page===b.dataset.page)render();}
 if(b.dataset.reset){filters[b.dataset.reset]={};render();}
 if(busy||mode!=='shared'||!sharedReady)return;
 if(b.dataset.add){if(mode==='shared'&&!sharedReady)return;openForm(b.dataset.add);}
 if(b.dataset.action){
  const {action,key,id}=b.dataset,x=data[key].find(i=>i.id===id);if(!x)return;
  if(action==='edit')openForm(key==='records'?x.type:key,x);
  if(action==='delete'&&confirm('이 항목을 삭제할까요?')){if(await changeItem(key,x,true))render();}
  if(action==='toggle'){if(await changeItem(key,{...x,done:x.done==='yes'?'no':'yes'}))render();}
 }
});
$('#close').onclick=$('#cancel').onclick=()=>{if(!busy)$('#dialog').close();};
$('#dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('#form').onsubmit=async e=>{
 e.preventDefault();if(busy)return;
 const k=['feeding','hospital'].includes(kind)?'records':kind;
 const x={...(editing||{}),...Object.fromEntries(new FormData(e.target)),id:editing?.id||draftId};
 if(k==='records')x.type=kind;if(k==='shopping'&&!x.done)x.done='no';
 for(const field of schemas[kind])x[field[0]]=String(x[field[0]]||'').trim();
 if(schemas[kind].some(([name,,,required])=>required&&!x[name])){alert('필수 항목을 입력해 주세요.');return;}
 if(x.url&&!link(x.url)){alert('http 또는 https 상품 링크를 입력해 주세요.');return;}
 const submit=$('#form button[type="submit"]');submit.disabled=true;
 try{if(await changeItem(k,x)){$('#dialog').close();render();}}finally{submit.disabled=false;}
};
window.addEventListener('hashchange',route);
route();
if(shared){
 $('#ai-form').onsubmit=askAI;
 $('#login-form').onsubmit=async e=>{
  e.preventDefault();if(busy||refreshing)return;
  const form=e.target,values=new FormData(form);busy=true;connectionView();message('로그인하고 있어요…');
  try{
   await shared.login(shared.base,String(values.get('username')).trim(),String(values.get('password')));
   form.querySelector('[name="password"]').value='';mode='shared';sharedReady=false;data=empty();migratedRaw=undefined;render();
  }catch(error){message(error.message);}finally{busy=false;connectionView();}
  if(mode==='shared')await refreshShared(true);
 };
 $('#logout').onclick=async()=>{
  if(busy||!shared.token)return;busy=true;connectionView();
  accountMessage('로그아웃하고 있어요…');
  try{
   if(refreshTask)await refreshTask;
   if(!shared.token)return;
   await shared.logout();
   showLogin('로그아웃했어요. 가족 계정으로 다시 로그인할 수 있어요.');
  }catch{
   if(shared.token)accountMessage('로그아웃하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
  }finally{busy=false;connectionView();}
 };
 const passwordDialog=$('#password-dialog'),passwordForm=$('#password-form'),passwordStatus=$('#password-status');
 $('#change-password').onclick=()=>{
  if(busy||!shared.token)return;
  accountMessage('');
  passwordForm.reset();
  passwordForm.querySelector('[name="username"]').value=shared.username;
  passwordStatus.textContent='';
  passwordDialog.showModal();
 };
 $('#cancel-password').onclick=()=>{if(!busy)passwordDialog.close();};
 passwordDialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 passwordDialog.addEventListener('close',()=>{passwordForm.reset();passwordStatus.textContent='';refreshShared();});
 passwordForm.onsubmit=async e=>{
  e.preventDefault();if(busy||!shared.token)return;
  const values=new FormData(passwordForm);
  const currentPassword=values.get('currentPassword'),newPassword=values.get('newPassword');
  if(!newPassword.trim()||Array.from(newPassword).length<12){
   passwordStatus.textContent='새 비밀번호를 12자 이상 입력해 주세요.';return;
  }
  if(newPassword!==values.get('confirmPassword')){
   passwordStatus.textContent='새 비밀번호와 확인 입력이 서로 달라요.';return;
  }
  busy=true;connectionView();passwordStatus.textContent='비밀번호를 변경하고 있어요…';
  try{
   if(refreshTask)await refreshTask;
   if(!shared.token)return;
   await shared.changePassword(currentPassword,newPassword);
   if(!shared.token)return;
   passwordDialog.close();
   accountMessage('비밀번호를 변경했어요. 이 기기의 로그인은 유지돼요.');
  }catch(error){
   if(shared.token){
    if(error.status===401)showLogin(error.message);else passwordStatus.textContent=error.message;
   }
  }finally{busy=false;connectionView();}
 };
 window.addEventListener('focus',()=>refreshShared());
 window.addEventListener('online',()=>refreshShared());
 window.addEventListener('storage',e=>{
  if(shared.sessionEnded(e))showLogin('이 브라우저에서 로그아웃됐어요. 가족 계정으로 다시 로그인할 수 있어요.');
  else if(e.key===KEY||e.key===null)refreshShared();
 });
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshShared();});
 $('#dialog').addEventListener('close',()=>refreshShared());
 setInterval(()=>{if(!document.hidden)refreshShared();},2000);
 if(mode==='shared'){message('가족의 기록을 불러오고 있어요…');refreshShared(true);}
}else message('화면을 불러오지 못했어요. 잠시 후 다시 열어주세요.');
