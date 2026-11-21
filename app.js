'use strict';
const KEY='somhouse-v1', READ_ONLY='게스트 계정은 볼 수만 있어요. 추가·수정·삭제는 가족 계정에서 할 수 있어요.', empty=()=>({records:[],schedule:[],shopping:[]});
let data=empty(), page='home', editing=null, kind='', draftId='';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function valid(d){
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const fields=(x,required)=>object(x)&&Object.values(x).every(v=>typeof v==='string')&&required.every(k=>typeof x[k]==='string'&&x[k].length>0);
  if(!object(d)||!['records','schedule','shopping'].every(k=>Array.isArray(d[k])))return false;
  const need={feeding:['category','amount'],sleep:['category'],diaper:['category'],hospital:['hospital','reason']};
  return d.records.every(x=>Object.hasOwn(need,x?.type)&&fields(x,['id','type','date',...need[x.type]]))
    &&d.schedule.every(x=>fields(x,['id','date','title']))
    &&d.shopping.every(x=>fields(x,['id','title','quantity'])&&(x.done===undefined||['yes','no'].includes(x.done)));
}
// The old device key is read only, and is automatically merged after login.
const shared=window.SomhouseShared?new window.SomhouseShared.Client():null;
let mode=shared?.token?'shared':'login', sharedReady=false, busy=false, refreshing=false, refreshTask=null, migratedRaw, legacyWarning='', needsRender=false;
let ai={config:null,checking:false,pending:false,selected:''}, googleStatusHtml='', dashboardHtml='', missedPolls=0, googleFooter='';
function message(text){$('#connection-status').textContent=text;}
function accountMessage(text){
 const status=$('#account-status');
 status.textContent=text;status.hidden=!text;
}
function calendarLinked(sources){return /^https:\/\/calendar\.google\.com\/calendar\/(?:r(?:\?authuser=[A-Za-z0-9._%+@-]+)?)?$/.test(sources?.calendar||'');}
function showSources(connected){
 const element=$('#raw-sources'), sources=connected&&sharedReady?shared.sources:null;
 const links=[];
 // Only Google's own pages, optionally with ?authuser=<connected account> so the right account opens.
 const account='(?:\\?authuser=[A-Za-z0-9._%+@-]+)?$';
 if(new RegExp('^https://docs\\.google\\.com/spreadsheets/d/[A-Za-z0-9_-]+/edit'+account).test(sources?.sheet||'')){
  links.push(`<a href="${esc(sources.sheet)}" target="_blank" rel="noopener noreferrer">원본 시트</a>`);
 }
 if(new RegExp('^https://tasks\\.google\\.com/'+account).test(sources?.tasks||'')){
  links.push(`<a href="${esc(sources.tasks)}" target="_blank" rel="noopener noreferrer">Google Tasks</a>`);
 }
 if(calendarLinked(sources)){
  links.push(`<a href="${esc(sources.calendar)}" target="_blank" rel="noopener noreferrer">Google 캘린더</a>`);
 }
 const html=links.join(' · ');
 if(element.innerHTML!==html)element.innerHTML=html;
 element.hidden=!html;
}
function connectionView(){
 const connected=mode==='shared'&&Boolean(shared?.token);
 $('#connection-title').textContent=connected?(shared.readOnly?'게스트 보기 · 예시 기록':(shared.family.home?'가족 기록':shared.family.name||'우리 가족')+' · '+shared.username):'가족 로그인';
 $('#connection').classList.toggle('compact',connected);
 const canLogIn=!connected&&Boolean(shared?.base);
 $('#login-form').hidden=!canLogIn;$('#password-login').hidden=!canLogIn;
 $('#google-login-box').hidden=!canLogIn||window.SOMHOUSE_LOCAL_TRIAL===true;$('#logout').hidden=!connected;
 // A Google sign-in has no Somhouse password to change.
 $('#change-password').hidden=!connected||shared.readOnly||shared.username==='family'||shared.username.includes('@');
 $('#manage-family').hidden=!connected||shared.readOnly;
 $('nav').hidden=!connected||!sharedReady;
 showSources(connected);
 showGoogleStatus(connected);
 document.querySelectorAll('#connection button, #connection input').forEach(el=>el.disabled=busy);
 document.querySelectorAll('#password-form button, #password-form input').forEach(el=>el.disabled=busy);
 document.querySelectorAll('#content button[data-add], #content button[data-action]').forEach(el=>el.disabled=busy||!sharedReady);
 const aiLocked=!connected||busy||ai.checking||ai.pending;
 $('#ai-fields').disabled=aiLocked||!aiOption(ai.selected);
 document.querySelectorAll('#ai-providers input, #ai-providers select, #ai-providers button').forEach(el=>el.disabled=aiLocked);
}
function showGoogleStatus(connected){
 const element=$('#google-status'), status=connected&&sharedReady?shared.googleStatus:null;
 element.hidden=!status;
 if(!status){element.innerHTML='';googleStatusHtml='';googleFooter='';return;}
 const services={sheets:'원본 시트',tasks:'Tasks 사본',calendar:'수유 캘린더',shopping:'장보기'};
 const rows=Object.entries(status.services||{}).map(([key,value])=>`<li>${esc(services[key]||key)}: 미전송 ${esc(value.pending)}건 · 재시도 ${esc(value.retrying)}건 · 실패 ${esc(value.failed)}건 · 마지막 전송 ${esc(value.last_success?.replace('T',' ')||'없음')}</li>`).join('');
 const reconnect=shared.readOnly?'':'<button type="button" class="secondary" data-google-connect="1">Google 다시 연결</button>';
 const warning=status.auth_state==='reconnect_required'?'Google 재연결이 필요해요. 외부 전송을 멈췄어요. 아래 ‘Google 다시 연결’을 눌러 주세요.':status.auth_state==='configuration_error'?'Google 연결 설정을 읽지 못했어요. 관리자에게 알려주세요.':'Google 연동 상태';
 const values=Object.values(status.services||{});
 const waiting=values.reduce((sum,x)=>sum+(Number(x.pending)||0)+(Number(x.retrying)||0),0);
 const failed=values.reduce((sum,x)=>sum+(Number(x.failed)||0),0);
 const latest=values.map(x=>x.last_success||'').sort().at(-1)||'';
 // Inputs waiting for a person are shown in the home 'check' box, so they do not make the connection look broken.
 const healthy=status.auth_state==='ready'&&!failed&&!status.errors?.length;
 const note='<p class="caption">웹 기록은 맥미니에 저장됩니다. 음성으로 만든 원본 Task·일정은 웹에서 수정하거나 삭제해도 바뀌지 않아요. 수정 이력은 원본 시트에 남습니다.</p>';
 googleFooter=healthy?`<details class="google-footer"><summary>🟢 Google 연동 정상 · ${waiting?`전송 대기 ${esc(waiting)}건`:'모두 반영됨'}${latest?` · 마지막 전송 ${esc(latest.slice(11,16))}`:''}</summary><ul>${rows}</ul>${note}${reconnect}</details>`:'';
 if(healthy){element.hidden=true;element.innerHTML='';googleStatusHtml='';return;}
 // Another family can remake a deleted sheet, Tasks list or calendar by reconnecting, so offer it on errors too.
 const repair=!shared.family.home&&status.auth_state!=='reconnect_required'&&(failed||status.errors?.length);
 const html=`<strong>${warning}</strong>${status.auth_state==='reconnect_required'?reconnect:''}<ul>${rows}</ul>${status.errors?.length?'<p>일부 연동을 확인하지 못했어요. 잠시 후 다시 시도합니다.</p>':''}${repair?`<p>원본 시트·Tasks 목록·수유 캘린더를 지웠다면 ‘Google 다시 연결’을 누르면 새로 만들고 기록을 다시 보내요.</p>${reconnect}`:''}${status.review?`<p>음성·캘린더 입력 ${esc(status.review)}건은 확인이 필요해요.</p><button type="button" class="secondary" data-page="review">확인 필요 ${esc(status.review)}건 정리하기</button>`:''}${note}`;
 // Rewriting on every poll would close an opened <details>; the browser adds `open` to innerHTML, so compare our own copy.
 if(googleStatusHtml!==html){element.innerHTML=html;googleStatusHtml=html;}
}
function showLogin(text){
 shared.clear();mode='login';sharedReady=false;data=empty();migratedRaw=undefined;
 ai={config:null,checking:false,pending:false,selected:''};aiHelpReset();reportReset();
 $('#ai-form').reset();$('#ai-scope-field').hidden=true;$('#ai-providers').innerHTML='';
 $('#ai-status').textContent='';aiLogView();
 for(const dialog of [$('#dialog'),$('#password-dialog'),$('#family-dialog')])if(dialog.open)dialog.close();
 accountMessage('');render();message(text);
}
function editingScreen(){return $('#dialog').open||$('#password-dialog').open||$('#family-dialog').open||Boolean(document.activeElement?.closest?.('#filter-form,.ai-help,.stock-form'));}
async function loadFamilyData(){
 let raw, original;
 // The guest sees made-up records only; this device's old family records are never sent with a guest login.
 if(shared.readOnly)return shared.load();
 // Old device records belong to the original family only; another family never receives them.
 if(!shared.family.home)return shared.load();
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
   const reviewBefore=JSON.stringify(reviewItems()),statusBefore=JSON.stringify(shared.googleStatus);
   const next=await loadFamilyData();
   if(shared.token!==token)return;
   if(!valid(next))throw Error('기록을 확인하지 못했어요. 다시 연결하고 있습니다.');
   const changed=JSON.stringify(next)!==JSON.stringify(data)||(['review','home'].includes(page)&&JSON.stringify(shared.googleStatus)!==statusBefore)||(page==='review'&&JSON.stringify(reviewItems())!==reviewBefore),wasReady=sharedReady;
   data=next;sharedReady=true;missedPolls=0;lastSync=Date.now();if(changed)needsRender=true;
   message(shared.readOnly?'게스트 보기예요. 실제 가족 기록이 아닌 예시 기록이에요. 입력창은 열어 볼 수 있지만 저장·수정·삭제는 되지 않아요.':'기록은 자동으로 저장되고 가족과 함께 업데이트돼요.'+legacyWarning);
   if((needsRender||!wasReady)&&(!editingScreen()||!wasReady))render();else connectionView();
   if(quickPending)setTimeout(runQuick,0);
  }catch(error){
   if(shared.token!==token)return;
   // A slow relay often recovers by the next poll: keep the screen and only warn after repeated misses.
   if(error.status===401)showLogin(error.message);
   else if(sharedReady&&!error.status&&++missedPolls<3)message('연결이 잠시 느려요. 기록은 그대로 두고 자동으로 다시 확인하고 있어요.');
   else message(error.message);
  }finally{refreshing=false;refreshTask=null;}
 })();
 return refreshTask;
}
async function sharedChange(operation){
 if(busy||mode!=='shared'||!shared?.token)return false;
 if(shared.readOnly){alert(READ_ONLY);return false;}
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
const schemas={diaper:[['date','시각','datetime-local',1],['category','종류','select',1],['memo','메모','textarea',0]],sleep:[['date','잠든 시각','datetime-local',1],['end','깬 시각 (선택)','datetime-local',0],['category','종류','select',1],['memo','메모','textarea',0]],feeding:[['date','날짜와 시간','datetime-local',1],['category','수유 종류','select',1],['amount','양','text',1],['memo','메모','textarea',0]],hospital:[['date','날짜와 시간','datetime-local',1],['hospital','병원','text',1],['reason','방문 이유','text',1],['memo','메모','textarea',0]],schedule:[['date','날짜와 시간','datetime-local',1],['who','누구 일정','select',0],['title','일정 이름','text',1],['place','장소 (선택)','text',0],['memo','메모','textarea',0]],shopping:[['title','품목','text',1],['quantity','수량','text',1],['date','구매 예정일 (선택)','date',0],['memo','메모','textarea',0],['url','상품 링크 (선택)','url',0]]};
const choices={category:['모유','분유','혼합','기타'],'sleep.category':['낮잠','밤잠'],'diaper.category':['소변','대변','둘 다']};
const diaperIcons={소변:'💧',대변:'💩','둘 다':'💧💩'};
// '누구 일정': family, parents and each registered child; '아기' only until a name is registered (or on old items).
function children(){return Array.isArray(shared?.settings?.children)?shared.settings.children:[];}
function whoChoices(current){const list=['가족','엄마','아빠',...children()];if(!children().length)list.push('아기');if(current&&!list.includes(current))list.push(current);return list;}
function whoClass(w){return ['가족','엄마','아빠'].includes(w)?w:'아기';}
const ADD_CHILD='__add_child__';
function link(url){try{let u=new URL(url);return ['http:','https:'].includes(u.protocol)?`<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">상품 링크 ↗</a>`:''}catch{return ''}}
function sleepText(x){const m=Somhouse.sleepMinutes(x);return `${x.date.slice(11)}${x.end?`~${x.end.slice(x.end.slice(0,10)===x.date.slice(0,10)?11:5).replace('T',' ')}`:''}${m!==null?` (${Somhouse.duration(m)})`:' · 깬 시각 미입력'}`;}
const icons={분유:'🍼',혼합:'🍼',모유:'🤱',기타:'🍼'};
function desc(x,k){if(k==='records'&&x.type==='diaper')return `${diaperIcons[x.category]||'🧷'} 기저귀 · ${esc(x.category)}`;if(k==='records'&&x.type==='sleep')return `😴 수면 · ${esc(x.category)} · ${esc(sleepText(x))}`;if(k==='records')return x.type==='feeding'?`${icons[x.category]||'🍼'} ${esc(x.category)} · ${esc(x.amount)}`:`🏥 ${esc(x.hospital)} · ${esc(x.reason)}`;return (k==='schedule'&&x.who?`<span class="who who-${whoClass(x.who)}">${esc(x.who)}</span> `:'')+esc(x.title)+(k==='shopping'?` · ${esc(x.quantity)}`:'')}
// The whole card opens the edit form (delete is inside it); only shopping keeps a one-tap done button.
function dday(date){
 const today=Somhouse.localDateTime().slice(0,10),n=Math.round((new Date(date.slice(0,10)+'T12:00')-new Date(today+'T12:00'))/86400000);
 return n<0?'':`<span class="badge dday${n<=1?' soon':''}">${n===0?'오늘':n===1?'내일':'D-'+n}</span>`;
}
function item(x,k,compact=false,timeOnly=false){
 const when=timeOnly?(x.date||'').slice(11):(x.date||'').replace('T',' ');
 const badges=`${k==='schedule'&&x.date?dday(x.date):''}${x.confirm==='category'?'<span class="badge warn">종류 확인 필요</span>':''}`;
 // A feeding that came from the primary Calendar can push a web correction back to its original event (PR #15).
 // Only when the Calendar title would actually change; while waiting, a label instead of a second button.
 const gs=shared?.googleStatus,writeback=compact||k!=='records'?'':(gs?.writeback_pending||[]).includes(x.id)?'<span class="badge gcal done-toggle">📆 캘린더 반영 중</span>':(gs?.writeback_ready||[]).includes(x.id)?`<button class="secondary done-toggle" data-writeback="${esc(x.id)}">캘린더에도 반영</button>`:'';
 const toggle=k==='shopping'&&!compact?`<button class="${x.done==='yes'?'plain':'secondary'} done-toggle" data-action="toggle" data-key="${k}" data-id="${esc(x.id)}">${x.done==='yes'?'다시 사기':'✓ 샀어요'}</button>`:'';
 const body=`<strong>${desc(x,k)}</strong> ${badges}${k==='shopping'?shoppingStockBadge(x):''}<p>${esc(when)}${x.place?` · 📍 ${esc(x.place)}`:''}${x.memo?'<br>'+esc(x.memo):''}</p>${x.url?link(x.url):''}`;
 return `<div class="item${compact?'':' tappable'}${k==='shopping'&&x.done==='yes'?' done':''}"${compact?'':` data-action="edit" data-key="${k}" data-id="${esc(x.id)}" role="button" tabindex="0" aria-label="눌러서 수정"`}>${toggle}${writeback}${body}</div>`;
}
// A mirrored Google Calendar event: read-only, opened in Google to edit.
function googleItem(x){
 const when=x.allDay?`${x.date} 종일`:x.date.replace('T',' ');
 const open=/^https:\/\/www\.google\.com\/calendar\//.test(x.link||'')?`<a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">Google에서 열기 ↗</a>`:'';
 return `<div class="item"><strong>${esc(x.title)}</strong> <span class="badge gcal">📆 Google</span><p>${esc(when)}</p>${open}</div>`;
}
function sorted(k){return [...data[k]].sort((a,b)=>(b.date||b.id).localeCompare(a.date||a.id))}
const pageTitles={home:'홈',records:'육아 기록',stats:'통계',schedule:'일정',shopping:'구매 목록',ai:'AI 대화',review:'확인 필요',report:'소아과용 요약'};
let reviewKey='',schedulePastOpen=false;
function reviewItems(){return Array.isArray(shared?.googleStatus?.review_items)?shared.googleStatus.review_items:[];}
// Inputs that were not saved automatically, or that differ from a web edit. The Google Task or event is never changed here.
function reviewCard(x){
 const conflict=x.status==='웹 기록 유지',guess=[x.suggest?.category&&x.suggest.category!=='기타'?x.suggest.category:'',x.suggest?.amount||''].filter(Boolean).join(' ');
 const why=conflict?'웹에서 고친 기록과 캘린더 일정의 내용이 서로 달라요. 지금 기록은 웹에서 고친 그대로예요.':x.suggest?.amount?'내용을 확실히 알 수 없어 저장하지 않았어요.':'양이 없어서 저장하지 않았어요. 양을 입력해 주세요.';
 const buttons=conflict?['캘린더 내용으로 고치기','지금 기록 그대로 두기']:['내용 확인하고 저장','기록하지 않음'];
 return `<div class="item"><strong>${esc(x.title||'(제목 없음)')}</strong> <span class="badge">${esc(x.source)}</span><p>${esc((x.when||'').replace('T',' ')||'시각 정보 없음')}${guess?` · 추정 ${esc(guess)}`:''}<br>${why}</p>${aiReviewGuess(x)}<div class="actions">${aiReviewButton(x)}<button data-review-key="${esc(x.key)}" data-review-action="save">${buttons[0]}</button><button class="secondary" data-review-key="${esc(x.key)}" data-review-action="dismiss">${buttons[1]}</button></div></div>`;
}
function reviewView(){
 const cards=reviewItems().map(reviewCard).join('');
 return `<h1>확인 필요</h1><p>음성이나 캘린더로 남겼지만 그대로 저장하지 못한 입력이에요. 첫 번째 버튼을 누르면 종류·양·시각을 고칠 수 있는 입력창이 열려요. Google의 원본 Task·일정은 바뀌지 않고, 처리 이력은 원본 시트에 남아요.</p>${cards&&aiHelpOption()?'<p class="caption">‘✨ AI로 해석’을 누른 입력의 원문만 고른 AI로 보내요. 무료 Gemini 키는 보낸 내용이 Google 서비스 개선에 쓰이고 사람이 검토할 수 있어요.</p>':''}${cards||'<div class="card empty">확인할 입력이 없어요.</div>'}<button class="plain" data-page="home">← 홈으로</button>`;
}

const filters={records:{},schedule:{},shopping:{}};
function route(){const name=location.hash.slice(1);page=Object.hasOwn(pageTitles,name)?name:'home';render()}
function quickButtons(){return '<div class="quick"><button class="secondary" data-add="feeding">수유 기록</button><button class="secondary" data-add="sleep">수면</button><button class="secondary" data-add="hospital">병원 방문</button><button class="secondary" data-add="schedule">일정</button><button class="secondary" data-add="shopping">구매 물품</button></div>'}
const feedingKinds=['분유','모유','혼합','기타'],sleepKinds=['낮잠','밤잠'];
function unconfirmed(){return data.records.filter(x=>['feeding','sleep'].includes(x.type)&&x.confirm==='category').sort((a,b)=>b.date.localeCompare(a.date));}
// Feedings saved from an unclear voice or Calendar input: one tap settles the kind.
function confirmBox(){
 const items=unconfirmed();
 if(!items.length)return '';
 const rows=items.slice(0,5).map(x=>x.type==='sleep'?`<div class="confirm-row"><p><strong>😴 ${esc(x.date.slice(0,10))} ${esc(sleepText(x))}</strong> · 시각으로 추정: ${esc(x.category)}${x.memo?`<br><span class="caption">${esc(x.memo)}</span>`:''}</p><div class="quick">${sleepKinds.map(kind=>`<button class="secondary" data-confirm-id="${esc(x.id)}" data-confirm-category="${kind}">${kind}</button>`).join('')}</div></div>`:`<div class="confirm-row"><p><strong>${esc(x.date.replace('T',' '))} · ${esc(x.amount)}</strong>${x.heard?` · 들린 말 ‘${esc(x.heard)}’`:''}${x.memo?`<br><span class="caption">${esc(x.memo)}</span>`:''}</p><div class="quick">${feedingKinds.map(kind=>`<button class="${kind==='기타'?'plain':'secondary'}" data-confirm-id="${esc(x.id)}" data-confirm-category="${kind}">${kind==='기타'?'기타로 두기':kind}</button>`).join('')}</div></div>`).join('');
 return `<h3>종류만 골라 주세요 · ${items.length}건</h3><p class="caption">이미 저장된 기록이에요. 분유·모유 또는 낮잠·밤잠만 눌러 주세요.</p>${rows}${items.length>5?`<p class="caption">나머지 ${items.length-5}건은 위 기록을 고르면 이어서 보여요.</p>`:''}`;
}
// Everything that waits for a person, in one place: kinds to pick and voice/Calendar inputs that were not saved.
function checkBox(){
 const kinds=confirmBox(),reviews=reviewItems(),count=unconfirmed().length+reviews.length;
 if(!count)return '';
 const fix=reviews.length?`<h3>저장하지 못한 음성·캘린더 입력 · ${reviews.length}건</h3>${reviews.slice(0,3).map(reviewCard).join('')}${reviews.length>3?`<button class="plain" data-page="review">나머지 ${reviews.length-3}건 보기 →</button>`:''}`:'';
 return `<section class="card confirm-box" aria-label="확인할 것"><h2>⚠️ 확인할 것 ${count}건</h2>${kinds}${fix}</section>`;
}
function aliasList(){
 const entries=Object.entries(shared?.aliases||{});
 if(!entries.length)return '';
 return `<li><strong>기억한 말:</strong> ${entries.map(([word,kind])=>`‘${esc(word)}’→${esc(kind)} <button class="plain" data-forget="${esc(word)}">잊기</button>`).join(' ')}</li>`;
}
// Shown only when the Google Calendar intake is connected. Static text, no user data.
function voiceHelp(){
 if(!calendarLinked(shared?.sources)&&!shared?.readOnly)return '';
 return `<details class="voice-help"><summary>ⓘ 음성·캘린더 입력 도움말 <span class="caption">기억한 말 관리</span></summary><ul><li><strong>말로:</strong> 네스트 허브·휴대폰·태블릿에서 “헤이 구글, 100미리 수유 캘린더에 업데이트”</li><li><strong>수면:</strong> “낮잠 40분”, “밤잠 2시간”처럼 말하거나 적어요. ‘수면’·‘잠’만 있으면 시각으로 낮잠·밤잠을 추정해 홈에서 한 번 확인해요. 길이를 말하지 않으면 캘린더 일정의 끝 시각을 써요.</li><li><strong>직접 입력:</strong> Google 캘린더 앱에서 새 일정 제목에 <strong>수유 100ml</strong>, <strong>분유 120미리</strong>, <strong>모유 15분</strong>처럼 적고 저장</li><li>제목에는 <strong>수유·분유·모유</strong>와 <strong>단위가 붙은 양</strong>(ml·미리·cc, 직수는 분)이 있어야 해요.</li><li>시각은 따로 고치지 않아도 돼요. 일정 시각이 입력한 때부터 2시간 안이거나 종일 일정이면 입력한 시각으로 저장해요. 지난 수유는 일정의 시작 시각을 실제 시각으로 맞춰 주세요.</li><li>같은 Google 계정의 기본 캘린더만 읽고, 약 30초 뒤 여기에 나타나요. 반복 일정과 2시간보다 먼 미래 일정은 저장하지 않아요.</li><li>‘수유 100ml’처럼 종류를 말하지 않았거나 ‘부유’처럼 비슷하게 들린 말은 일단 저장하고, 홈에서 분유·모유를 고르게 해요. 고른 말은 기억해서 다음부터 자동으로 구분해요.</li>${aliasList()}<li>양을 빼고 ‘분유’만 적었거나 알아듣기 어려운 입력은 위쪽 ‘확인 필요’에 모여요. 거기서 양과 종류를 넣어 저장해요.</li></ul></details>`;
}
function repeatButtons(){
 const recent=Somhouse.recentFeedings(data.records);
 if(!recent.length)return '';
 return `<section class="repeat" aria-labelledby="repeat-title"><h2 id="repeat-title">최근 수유 다시 기록 <span class="caption">누르면 지금 시각으로 바로 저장돼요</span></h2><div class="quick">${recent.map(x=>`<button class="secondary" data-repeat-category="${esc(x.category)}" data-repeat-amount="${esc(x.amount)}">${esc(x.category)} ${esc(x.amount)}</button>`).join('')}</div></section>`;
}
// "3시간 5분 전" from two local "YYYY-MM-DDTHH:MM" stamps.
function ago(from,now){
 const minutes=Somhouse.sleepMinutes({date:from,end:now});
 return minutes===null?'방금':minutes<1?'방금':Somhouse.duration(minutes)+' 전';
}
// The first thing a parent needs: when the baby last ate and slept.
// Same rule as the server (sleep_wake.py): the latest sleep without a wake time, started at or before `at`, within 16 hours.
function openSleep(at=Somhouse.localDateTime(),inclusive=true){
 return data.records.filter(x=>x.type==='sleep'&&!x.end&&x.date&&(inclusive?x.date<=at:x.date<at)&&(Somhouse.sleepMinutes({date:x.date,end:at})??0)<=16*60)
  .sort((a,b)=>b.date.localeCompare(a.date))[0]||null;
}
function newId(){return typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString()+'-'+Math.random().toString(36).slice(2);}
// The shared direct-breastfeeding timer: seconds per side, the running segment counted up to now.
function timerState(){
 const t=shared?.settings?.timer;if(!t||!Array.isArray(t.segments)||!t.segments.length)return null;
 const at=v=>{const [d,c]=v.split('T'),[y,m,dd]=d.split('-').map(Number),[h,mi,se]=c.split(':').map(Number);return new Date(y,m-1,dd,h,mi,se||0).getTime();};
 const sides={좌:0,우:0},nowMs=Date.now();
 for(const x of t.segments)sides[x.side]=(sides[x.side]||0)+Math.max(0,((x.end?at(x.end):nowMs)-at(x.start))/1000);
 return {side:t.segments[t.segments.length-1].side,sides,total:sides.좌+sides.우,by:t.by};
}
function clock(seconds){const s=Math.floor(seconds),m=Math.floor(s/60);return `${m}:${String(s%60).padStart(2,'0')}`;}
// The last timed breastfeeding within a day: which side it started and ended on, and the other side to start now.
function nextSide(now=Somhouse.localDateTime()){
 const last=data.records.filter(x=>x.type==='feeding'&&['좌','우'].includes(x.firstSide)&&x.date<=now).sort((a,b)=>b.date.localeCompare(a.date))[0];
 if(!last||(Somhouse.sleepMinutes({date:last.date,end:now})??0)>24*60)return null;
 return {last,start:last.firstSide==='좌'?'우':'좌'};
}
function timerHtml(){
 const t=timerState();
 if(!t){
  const next=nextSide(),name=s=>s==='좌'?'왼쪽':'오른쪽',order=next?.start==='우'?['우','좌']:['좌','우'];
  const hint=next?`<span class="guess">지난 직수 ${esc(next.last.date.slice(11))} · ${esc(name(next.last.firstSide))}${next.last.lastSide&&next.last.lastSide!==next.last.firstSide?`→${esc(name(next.last.lastSide))}`:''} · 이번엔 <b>${name(next.start)}</b>부터</span>`:'';
  return `${hint}<div class="tile-actions">${order.map((side,i)=>`<button class="${next&&i===0?'small':'secondary small'}" data-timer="start" data-side="${side}">${i===0?'🤱 ':''}${name(side)}부터</button>`).join('')}</div>`;
 }
 const other=t.side==='좌'?'우':'좌';
 return `<div class="timer-box"><p class="timer-head">🤱 직수 중 · <b>${esc(t.side)}</b> <b data-timer-clock="total">${clock(t.total)}</b></p><p class="caption" data-timer-clock="sides">좌 ${clock(t.sides.좌)} · 우 ${clock(t.sides.우)}</p><div class="tile-actions"><button class="secondary small" data-timer="switch">⇄ ${other==='좌'?'왼쪽':'오른쪽'}으로</button><button class="small" data-timer="finish">끝내기</button><button class="plain small" data-timer="cancel">취소</button></div></div>`;
}
function shortName(name){return !name?'':name==='family'?'가족':name.includes('@')?name.split('@')[0]:name;}
let lastSync=0;
// For the next caregiver: the nearest plan within a day, the family's one-line note and how fresh the screen is.
function handoffStrip(){
 const now=Somhouse.localDateTime(),soon=Somhouse.addDays(now.slice(0,10),1)+now.slice(10);
 const next=[...data.schedule.filter(x=>x.date>=now&&x.date<=soon).map(x=>({date:x.date,title:x.title})),...googleEvents().filter(x=>!x.allDay&&x.date>=now&&x.date<=soon).map(x=>({date:x.date,title:x.title}))].sort((a,b)=>a.date.localeCompare(b.date))[0];
 const note=shared?.settings?.handoff,ro=shared?.readOnly;
 const age=lastSync?Math.floor((Date.now()-lastSync)/60000):0;
 const plan=next?`<p>📅 다음 일정 <b>${esc(next.date.slice(0,10)===now.slice(0,10)?next.date.slice(11):'내일 '+next.date.slice(11))}</b> ${esc(next.title)}</p>`:'';
 const memo=note?.text?`<p class="memo">📝 ${esc(note.text)} <span class="caption">— ${esc(shortName(note.by))} ${esc(note.at.slice(11))}</span>${ro?'':' <button class="plain small" data-handoff="edit">수정</button><button class="plain small" data-handoff="clear">지우기</button>'}</p>`:ro?'':'<p><button class="plain small" data-handoff="edit">＋ 다음 사람에게 전달 메모</button></p>';
 return `<section class="handoff" aria-label="교대 메모">${plan}${memo}<p class="caption">🔄 ${age<1?'방금':age+'분 전'} 업데이트</p></section>`;
}
function nowCard(){
 const now=Somhouse.localDateTime(),past=x=>x.date<=now;
 const feed=data.records.filter(x=>x.type==='feeding'&&past(x)).sort((a,b)=>b.date.localeCompare(a.date))[0];
 const sleep=data.records.filter(x=>x.type==='sleep'&&past(x)).sort((a,b)=>b.date.localeCompare(a.date))[0];
 const day=v=>v.slice(0,10)===now.slice(0,10)?v.slice(11):v.slice(5).replace('-','/').replace('T',' ');
 const alarm=shared?.googleStatus?.feeding_alarm,guess=Somhouse.nextFeeding(data.records),diaper=data.records.filter(x=>x.type==='diaper'&&past(x)).sort((a,b)=>b.date.localeCompare(a.date))[0];
 const feedHtml=(feed?`<strong>${esc(ago(feed.date,now))}</strong><span>${esc(day(feed.date))} · ${esc(feed.category)} ${esc(feed.amount)}</span>`:'<strong>기록 없음</strong><span>수유를 기록해 보세요</span>')
  +(guess?`<span class="guess">다음 예상 ${esc(day(guess.at))} 무렵 · 평균 ${esc(Somhouse.duration(guess.gap))} 간격</span>`:'')
  +(alarm?.enabled&&alarm.next?`<span class="guess">⏰ 밥 알람 ${esc(day(alarm.next))} (평소 ${esc(alarm.usual)})</span>`:'');
 const diaperHtml=(diaper?`<strong>${esc(ago(diaper.date,now))}</strong><span>${esc(day(diaper.date))} · ${esc(diaperIcons[diaper.category]||'')} ${esc(diaper.category)}</span>`:'<strong>기록 없음</strong><span>갈 때 바로 눌러 주세요</span>')+stockLine();
 let sleepHtml='<strong>기록 없음</strong><span>수면을 기록해 보세요</span>';
 const open=openSleep(now);
 if(open)sleepHtml=`<strong>자는 중 · ${esc(ago(open.date,now).replace(' 전','째'))}</strong><span>${esc(day(open.date))}부터 · ${esc(open.category)}</span>`;
 else if(sleep){
  const m=Somhouse.sleepMinutes(sleep),awake=sleep.end&&sleep.end<=now?ago(sleep.end,now):'';
  const head=awake?(awake==='방금'?'방금 깸':`깬 지 ${awake.replace(' 전','')}`):'깬 시각 미입력';
  sleepHtml=`<strong>${esc(head)}</strong><span>${esc(sleep.category)}${m!==null?` ${esc(Somhouse.duration(m))}`:''} · ${esc(day(sleep.date))}${sleep.end?`~${esc(day(sleep.end))}`:''}</span>`;
  const nap=shared?.googleStatus?.nap_alarm;
  if(nap?.enabled&&nap.next)sleepHtml+=`<span class="guess">⏰ 낮잠 알람 ${esc(day(nap.next))} (보통 깬 지 ${esc(Somhouse.duration(nap.usual_minutes))})</span>`;
 }
 return `<section class="now-card" aria-label="지금 아기 상태"><div><p>🍼 마지막 수유</p>${feedHtml}${timerHtml()}</div><div><p>😴 마지막 수면</p>${sleepHtml}${open?`<button class="sleep-toggle wake" data-sleep-end="${esc(open.id)}">☀️ 수면 종료</button>`:'<button class="sleep-toggle" data-sleep-start="1">😴 수면 시작</button>'}</div><div class="diaper-tile"><p>🧷 마지막 기저귀</p>${diaperHtml}<div class="tile-actions">${['소변','대변','둘 다'].map(c=>`<button class="secondary small" data-diaper="${c}">${diaperIcons[c]} ${c}</button>`).join('')}</div></div></section>${handoffStrip()}`;
}
function homeView(){
  const now=Somhouse.localDateTime();
  const upcoming=[...data.schedule.filter(x=>x.date>=now).map(x=>({...x,source:'web'})),...googleEvents().filter(x=>(x.allDay?x.date>=now.slice(0,10):x.date>=now)).map(x=>({...x,source:'google'}))].sort((a,b)=>a.date.localeCompare(b.date));
  return `<h1>우리 가족의 오늘</h1><p class="intro">${esc(now.slice(0,10))} · 작은 순간을 차곡차곡 남겨요.</p>${nowCard()}${quickButtons()}${repeatButtons()}${checkBox()}
    <div class="grid">${[['다가오는 일정',upcoming.slice(0,3),'schedule','예정된 일정이 없어요.'],['구매 예정',shoppingOrder(data.shopping.filter(x=>x.done!=='yes')).slice(0,3),'shopping','필요한 물품을 추가해보세요.'],['최근 육아 기록',sorted('records').slice(0,3),'records','첫 수유나 병원 방문을 기록해보세요.']].map(([title,items,k,msg])=>`<section class="card"><h2>${title}</h2>${items.length?items.map(x=>x.source==='google'?googleItem(x):item(x,k,true)).join(''):`<p class="empty">${msg}</p>`}<button class="plain" data-page="${k}">전체 보기 →</button></section>`).join('')}</div>
    <h2 class="section-head">기간별 요약</h2>${summaryCards()}<p class="caption">용량은 ‘80ml’처럼 단위가 있는 기록만, 직수는 ‘15분’처럼 분으로 적은 기록만 합산해요. 주 단위는 하루 평균도 함께 보여요.</p>${googleFooter}`;
}
let statsDays=7,calendarMonth='',calendarDay='';
function totals(x){
 const parts=[`${x.count}회`];
 if(x.measuredCount)parts.push(`${x.volume.toLocaleString('ko-KR')}ml`);
 if(x.timedCount)parts.push(`직수 ${x.minutes}분`);
 return parts.join(' · ');
}
function sleepTotals(x){
 return x.sleepCount?`😴 ${x.sleepCount}회${x.sleepTimed?` · ${Somhouse.duration(x.sleepMinutes)}`:''}`:'';
}
function diaperTotals(x){
 return x.diaperCount?`🧷 기저귀 ${x.diaperCount}회 (소변 ${x.peeCount} · 대변 ${x.pooCount})`:'';
}
function summaryCards(){
 const days=x=>Math.round((new Date(x.to+'T12:00')-new Date(x.from+'T12:00'))/86400000)+1;
 const average=x=>{const n=days(x);if(n<2||!x.count)return '';const parts=[`${(x.count/n).toFixed(1)}회`];if(x.measuredCount)parts.push(`${Math.round(x.volume/n).toLocaleString('ko-KR')}ml`);return `<span class="average">하루 평균 ${parts.join(' · ')} (${n}일)</span>`;};
 return `<div class="summary-cards">${Somhouse.periodSummaries(data.records).map(x=>`<div class="summary-card"><p>${x.label}<span class="caption"> ${esc(x.from.slice(5).replace('-','/'))}${x.from!==x.to?`~${esc(x.to.slice(5).replace('-','/'))}`:''}</span></p><strong>${x.count?esc(totals(x)):x.sleepCount||x.diaperCount?'':'기록 없음'}</strong>${average(x)}${x.sleepCount?`<span class="sleep-line">${esc(sleepTotals(x))}</span>`:''}${x.diaperCount?`<span class="sleep-line">${esc(diaperTotals(x))}</span>`:''}</div>`).join('')}</div>`;
}
function holidayOn(day){return (Array.isArray(shared?.holidays)?shared.holidays:[]).find(x=>x.date===day);}
function holidayName(h){return h.substitute?`대체공휴일(${h.name})`:h.name;}
function googleEvents(){return Array.isArray(shared?.calendarEvents)?shared.calendarEvents:[];}
function dayItems(day){
 const on=x=>(x.date||'').slice(0,10)===day,byTime=(a,b)=>(a.date||'').localeCompare(b.date||'');
 return {feeding:data.records.filter(x=>x.type==='feeding'&&on(x)).sort(byTime),hospital:data.records.filter(x=>x.type==='hospital'&&on(x)).sort(byTime),sleep:data.records.filter(x=>x.type==='sleep'&&on(x)).sort(byTime),
  schedule:data.schedule.filter(on).sort(byTime),shopping:data.shopping.filter(on),
  google:googleEvents().filter(x=>x.date.slice(0,10)<=day&&(x.end||x.date).slice(0,10)>=day)};
}
// The family dashboard calendar: feedings, schedules (with whose they are) and dated shopping on one month.
function calendarView(){
 const today=Somhouse.localDateTime().slice(0,10),month=calendarMonth||today.slice(0,7);
 const [year,mon]=month.split('-').map(Number);
 const shift=n=>{const d=new Date(year,mon-1+n,1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;};
 const cells=Somhouse.monthGrid(data.records,year,mon,new Date(),data.schedule,data.shopping,googleEvents()).map(c=>{
  if(!c)return '<span class="cal-day empty"></span>';
  const marks=[c.count?`<span class="mark feed">🍼${c.count}${c.measuredCount?` ${c.volume}`:''}</span>`:'',c.schedule?`<span class="mark plan">📅${c.schedule}</span>`:'',c.sleepCount?`<span class="mark sleep">😴${c.sleepTimed?Somhouse.duration(c.sleepMinutes).replace('시간','h').replace(/ ?(\d+)분/,' $1m'):c.sleepCount}</span>`:'',c.shopping?`<span class="mark shop">🛒${c.shopping}</span>`:'',c.google?`<span class="mark gcal">📆${c.google}</span>`:''].join('');
  const label=`${c.date} 수유 ${c.count}회 일정 ${c.schedule}건 구매 ${c.shopping}건 구글 ${c.google}건`;
  const holiday=holidayOn(c.date),weekday=new Date(year,mon-1,c.day).getDay();
  return `<button class="cal-day${holiday||weekday===0?' red':''}${c.date===today?' today':''}${c.date===calendarDay?' selected':''}${marks?' has':''}" data-cal-day="${c.date}" aria-label="${label}${holiday?' '+esc(holidayName(holiday)):''}"><span class="num">${c.day}</span>${holiday?`<span class="holiday">${esc(holidayName(holiday))}</span>`:''}${marks}</button>`;
 }).join('');
 const head=['일','월','화','수','목','금','토'].map(d=>`<span class="cal-head">${d}</span>`).join('');
 let detail='';
 if(calendarDay){
  const day=dayItems(calendarDay),sum=Somhouse.rangeSummary(data.records,calendarDay,calendarDay);
  const group=(title,items,k,line)=>items.length?`<h4>${title}</h4>${items.map(x=>`<p>${line(x)}${x.memo?` <span class="caption">${esc(x.memo)}</span>`:''} <button class="plain small" data-action="edit" data-key="${k}" data-id="${esc(x.id)}">수정</button></p>`).join('')}`:'';
  const body=group(`📅 일정 ${day.schedule.length}건`,day.schedule,'schedule',x=>`${esc(x.date.slice(11))} · ${desc(x,'schedule')}`)
   +group(`🍼 수유 ${sum.count?esc(totals(sum)):''}`,day.feeding,'records',x=>`${esc(x.date.slice(11))} · ${esc(x.category)} ${esc(x.amount)}`)
   +group(`😴 수면 ${day.sleep.length}회`,day.sleep,'records',x=>`${esc(x.category)} · ${esc(sleepText(x))}`)
   +group(`🏥 병원 ${day.hospital.length}건`,day.hospital,'records',x=>`${esc(x.date.slice(11))} · ${esc(x.hospital)} · ${esc(x.reason)}`)
   +group(`🛒 구매 예정 ${day.shopping.length}건`,day.shopping,'shopping',x=>`${desc(x,'shopping')}${x.done==='yes'?' (완료)':''}`)
   +(day.google.length?`<h4>📆 Google 캘린더 ${day.google.length}건</h4>${day.google.map(x=>`<p>${x.allDay?'종일':esc(x.date.slice(11))} · ${esc(x.title)}${/^https:\/\/www\.google\.com\/calendar\//.test(x.link||'')?` <a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">열기</a>`:''}</p>`).join('')}`:'');
  const holiday=holidayOn(calendarDay);
  detail=`<div class="cal-detail"><h3>${esc(calendarDay)}${holiday?` · <span class="holiday-name">${esc(holidayName(holiday))}</span>`:''}</h3>${body||'<p class="empty">이 날의 기록이 없어요.</p>'}<div class="quick"><button class="secondary" data-add-on="schedule">이 날 일정 추가</button><button class="secondary" data-add-on="shopping">이 날 구매 추가</button></div></div>`;
 }
 return `<section class="card dashboard-calendar" aria-label="가족 달력"><div class="cal-nav"><button class="plain" data-cal-month="${shift(-1)}" aria-label="이전 달">‹</button><h2>${year}년 ${mon}월</h2><button class="plain" data-cal-month="${shift(1)}" aria-label="다음 달">›</button></div><p class="caption legend">🍼 수유 횟수·ml · 📅 솜하우스 일정 · 📆 Google 캘린더 · 🛒 구매 예정 — 날짜를 누르면 자세히 보여요.</p><div class="cal-grid">${head}${cells}</div>${month!==today.slice(0,7)?`<button class="plain" data-cal-month="${today.slice(0,7)}">이번 달로</button>`:''}${detail}</section>`;
}
// The last 7 days on a 0-24h line: sleep as bars (a sleep across midnight on both days), feedings and diapers as dots.
function patternView(){
 const now=new Date(),today=Somhouse.localDateTime(now).slice(0,10),pct=m=>(m/1440*100).toFixed(2);
 const label=day=>day===today?'오늘':day===Somhouse.addDays(today,-1)?'어제':`${Number(day.slice(5,7))}/${Number(day.slice(8))} ${weekdays[new Date(day+'T12:00').getDay()]}`;
 const hm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
 const rows=Array.from({length:7},(_,i)=>Somhouse.addDays(today,-i)).map(day=>{
  const s=Somhouse.daySegments(data.records,day,now);
  const mark=(cls,style,x,text)=>`<button class="${cls}" style="${style}" data-action="edit" data-key="records" data-id="${esc(x.id)}" title="${esc(text)}" aria-label="${esc(text)}"></button>`;
  const bars=s.sleeps.map(x=>mark('pt-sleep'+(x.open?' open':''),`left:${pct(x.from)}%;width:${Math.max(0.8,(x.to-x.from)/14.4).toFixed(2)}%`,x,`${x.category} ${hm(x.from)}~${x.open?'자는 중':hm(Math.min(x.to,1439))}`)).join('');
  const dots=[...s.feedings.map(x=>mark('pt-feed',`left:${pct(x.at)}%`,x,`수유 ${hm(x.at)} ${x.category} ${x.amount}`)),...s.diapers.map(x=>mark('pt-diaper',`left:${pct(x.at)}%`,x,`기저귀 ${hm(x.at)} ${x.category}`))].join('');
  return `<div class="pt-row"><span class="pt-day">${esc(label(day))}</span><div class="pt-track">${bars||dots?bars+dots:'<span class="pt-empty">기록 없음</span>'}</div></div>`;
 }).join('');
 const axis=[0,6,12,18,24].map(h=>`<span style="left:${(h/24*100).toFixed(2)}%">${h}</span>`).join('');
 return `<section class="card pattern"><h2>최근 7일 하루 흐름</h2><p class="caption"><span class="lg sleep"></span>수면 <span class="lg feed"></span>수유 <span class="lg diaper"></span>기저귀 · 표시를 누르면 그 기록을 열어요. 자정을 넘긴 수면은 두 날에 나눠 그려요.</p><div class="pt-rows">${rows}</div><div class="pt-axis">${axis}</div></section>`;
}
// Calendar alarms (computed on the Mac): usual feeding times, the usual daytime wake window, and their switches.
// Folded to one line until opened (kept open across refreshes).
const alarmUi={open:false};
function alarmView(){
 const alarm=shared?.googleStatus?.feeding_alarm,nap=shared?.googleStatus?.nap_alarm;if(!alarm||shared.readOnly)return '';
 const head=`<button type="button" class="alarm-head" data-alarm-open="1" aria-expanded="${alarmUi.open}"><strong>⏰ 알람</strong><span class="caption">밥 ${alarm.enabled?'켜짐':'꺼짐'}${nap?` · 낮잠 ${nap.enabled?'켜짐':'꺼짐'}`:''}</span><span aria-hidden="true">${alarmUi.open?'▾':'▸'}</span></button>`;
 if(!alarmUi.open)return `<section class="card alarm-card folded">${head}</section>`;
 const slots=Array.isArray(alarm.slots)?alarm.slots:[];
 const times=slots.length?`<div class="alarm-times">${slots.map(x=>`<span class="badge">${esc(x.time)} <small>${esc(x.days)}일</small></span>`).join(' ')}</div>`
  :'<p class="caption">아직 뚜렷한 수유 시간대가 없어요. 최근 7일 중 3일 이상, 비슷한 시간에 먹은 기록이 쌓이면 보여요.</p>';
 const state=alarm.enabled?(alarm.next?`다음 알람: <strong>${esc(alarm.next.replace('T',' '))}</strong> (평소 ${esc(alarm.usual)}에 먹는데 기록이 없으면)`:'수유 시간대가 생기면 알람을 맞춰요.'):'꺼져 있어요.';
 const toggle=(kind,on,label)=>`<div class="actions"><button type="button" class="${on?'secondary':''}" data-alarm-kind="${kind}" data-alarm="${on?'off':'on'}">${label} ${on?'끄기':'켜기'}</button></div>`;
 let napHtml='';
 if(nap){
  const usual=nap.usual_minutes?Somhouse.duration(nap.usual_minutes):'';
  const napState=!usual?`아직 기록이 부족해요. 낮에 깬 뒤 다시 잠든 기록이 ${esc(5-(nap.samples||0))}번 더 있으면 알 수 있어요.`
   :`최근 7일 낮에는 깬 뒤 보통 <strong>${esc(usual)}</strong> 지나 잠들었어요 (${esc(nap.samples)}번).${nap.enabled?nap.next?` 다음 알람: <strong>${esc(nap.next.replace('T',' '))}</strong>`:' 깨면 알람을 맞춰요.':''}`;
  napHtml=`<h3>😴 낮잠 알람</h3><p>${napState}${nap.enabled?'':' 꺼져 있어요.'}</p><p class="caption">낮(7시~20시)에 깬 뒤 평소만큼 지나도 수면 기록이 없으면 알림이 와요. 수면을 기록하면 사라져요.</p>${toggle('nap',nap.enabled,'낮잠 알람')}`;
 }
 return `<section class="card alarm-card">${head}<h3>🍼 밥 알람</h3><p class="caption">최근 7일 동안 자주 먹은 시간대예요 (숫자는 그 시간대에 먹은 날 수).</p>${times}<p>${state}</p><p class="caption">평소 시간이 30분 지나도록 그 전후 수유 기록이 없으면 알림이 와요. 수유를 기록하면 알림은 다음 시간대로 옮겨져요.</p>${toggle('feeding',alarm.enabled,'밥 알람')}${napHtml}<p class="caption">알림은 Google 캘린더 ‘솜하우스 수유’에서 와요. 휴대폰 Google 캘린더 앱에서 이 캘린더가 보이고 알림이 켜져 있어야 해요.</p></section>`;
}
async function alarmSwitch(kind,on){
 if(busy||!shared?.token||shared.readOnly)return;
 const token=shared.token,name=kind==='nap'?'낮잠 알람':'밥 알람';busy=true;connectionView();
 try{
  const result=await shared.request('/api/feeding-alarm','POST',{kind,enabled:on});
  if(shared.token!==token)return;
  if(valid(result.data))data=result.data;
  if(result.settings)shared.settings={...shared.settings,...result.settings};
  if('google_status' in result){shared.sources=result.sources||shared.sources;shared.googleStatus=result.google_status||null;}
  message(on?`${name}을 켰어요. 알람 시각이 되면 Google 캘린더 알림이 와요.`:`${name}을 껐어요. 캘린더의 알람 일정도 곧 지워져요.`);
 }catch(error){if(shared.token===token){if(error.status===401)showLogin(error.message);else{message(error.message);alert(error.message);}}}
 finally{busy=false;connectionView();render();}
}
function statsView(){
 const rows=Somhouse.dailyFeeding(data.records,statsDays);
 const max=Math.max(1,...rows.map(row=>row.volume).filter(Number.isFinite));
 const periods=[7,30].map(days=>`<button data-stats-days="${days}" class="secondary" aria-pressed="${days===statsDays}">${days}일</button>`).join('');
 const table=rows.map(({date,count,volume,measuredCount})=>{
  const recorded=measuredCount>0&&Number.isFinite(volume), percent=recorded?Math.min(100,volume/max*100):0;
  return `<tr><th scope="row"><time datetime="${date}">${date.slice(5)}</time></th><td>${count}회</td><td>${recorded?`${volume.toLocaleString('ko-KR')} ml`:'—'}</td><td aria-hidden="true"><div class="stats-bar"><span style="width:${percent}%"></span></div></td></tr>`;
 }).join('');
 // What the home page does not show: daily averages and the usual gap between feedings for the chosen period.
 const now=Somhouse.localDateTime(),from=rows[0]?.date||now.slice(0,10);
 const feeds=data.records.filter(x=>x.type==='feeding'&&x.date<=now&&x.date.slice(0,10)>=from).sort((a,b)=>a.date.localeCompare(b.date));
 const gaps=feeds.slice(1).map((x,i)=>Somhouse.sleepMinutes({date:feeds[i].date,end:x.date})).filter(m=>m!==null&&m<=8*60);
 const count=rows.reduce((s,r)=>s+r.count,0),measured=rows.filter(r=>r.measuredCount&&Number.isFinite(r.volume)),volume=measured.reduce((s,r)=>s+r.volume,0);
 const cards=[['하루 평균 횟수',`${(count/statsDays).toFixed(1)}회`],['하루 평균 용량',measured.length?`${Math.round(volume/statsDays).toLocaleString('ko-KR')}ml`:'—'],['평균 수유 간격',gaps.length?Somhouse.duration(Math.round(gaps.reduce((s,m)=>s+m,0)/gaps.length)):'—'],[`${statsDays}일 합계`,`${count}회${measured.length?` · ${volume.toLocaleString('ko-KR')}ml`:''}`]];
 return `<h1>통계</h1><div class="actions report-link"><button type="button" class="secondary" data-page="report">🩺 소아과용 2주 요약 보기</button></div>${aiSummaryCard()}${alarmView()}${patternView()}<h2 class="section-head">수유</h2><div class="quick stats-period" aria-label="조회 기간">${periods}</div><div class="summary-cards stats-cards">${cards.map(([label,value])=>`<div class="summary-card"><p>${label}</p><strong>${esc(value)}</strong></div>`).join('')}</div><p class="caption">평균 간격은 연속된 두 수유 사이가 8시간 이하인 경우만 계산해요.</p><section class="card"><h2>최근 ${statsDays}일</h2><p class="caption">횟수에는 모든 수유를, 용량에는 ml·cc·밀리리터·미리·씨씨 단위가 있는 기록만 집계해요. 직수 시간과 단위 없는 값은 용량에 합산하지 않아요.</p><table class="stats-table"><thead><tr><th scope="col">날짜</th><th scope="col">수유 횟수</th><th scope="col">합계 용량</th><th scope="col">용량 비교</th></tr></thead><tbody>${table}</tbody></table></section>${amountTrendView()}${sleepStatsView(rows.map(r=>r.date))}${diaperStatsView(rows.map(r=>r.date))}`;
}
// Sleep for the chosen period: averages over the days that have sleep records, so a forgotten day does not drag them down.
function sleepStatsView(dates){
 const days=dates.map(day=>Somhouse.sleepDay(data.records,day)),seen=days.filter(x=>x.recorded),avg=f=>seen.length?seen.reduce((s,x)=>s+f(x),0)/seen.length:null;
 const longest=Math.max(0,...days.map(x=>x.longest)),stretch=seen.filter(x=>x.longest);
 const hm=m=>m===null?'—':Somhouse.duration(Math.round(m));
 const cards=[['하루 평균 수면',hm(avg(x=>x.total))],['하루 평균 낮잠',seen.length?`${avg(x=>x.naps).toFixed(1)}회 · ${hm(avg(x=>x.nap))}`:'—'],['평균 가장 긴 잠',stretch.length?hm(stretch.reduce((s,x)=>s+x.longest,0)/stretch.length):'—'],[`${statsDays}일 중 가장 긴 잠`,longest?hm(longest):'—']];
 const rows=[...days].reverse().map(x=>`<tr><th scope="row"><time datetime="${x.day}">${x.day.slice(5)}</time></th><td>${x.recorded?hm(x.total):'—'}</td><td>${x.naps?`${x.naps}회 · ${hm(x.nap)}`:x.recorded?'0회':'—'}</td><td>${x.longest?hm(x.longest):'—'}</td></tr>`).join('');
 return `<h2 class="section-head">수면</h2><div class="summary-cards stats-cards">${cards.map(([label,value])=>`<div class="summary-card"><p>${label}</p><strong>${esc(value)}</strong></div>`).join('')}</div><p class="caption">평균은 수면 기록이 있는 날만 계산해요. 자정을 넘긴 잠은 날짜별로 나눠 더하고, ‘가장 긴 잠’은 그날 잠들어 깬 시각까지 기록된 한 번의 잠이에요.</p><section class="card"><h2>최근 ${statsDays}일 수면</h2><table class="stats-table"><thead><tr><th scope="col">날짜</th><th scope="col">총 수면</th><th scope="col">낮잠</th><th scope="col">가장 긴 잠</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
function diaperStatsView(dates){
 const days=dates.map(day=>Somhouse.diaperDay(data.records,day)),seen=days.filter(x=>x.count),now=Somhouse.localDateTime(),poo=Somhouse.lastPoo(data.records);
 const avg=f=>seen.length?(seen.reduce((s,x)=>s+f(x),0)/seen.length).toFixed(1)+'회':'—';
 const cards=[['하루 평균 기저귀',avg(x=>x.count)],['하루 평균 대변',avg(x=>x.poo)],['마지막 대변',poo?ago(poo.date,now):'기록 없음']];
 const rows=[...days].reverse().map(x=>`<tr><th scope="row"><time datetime="${x.day}">${x.day.slice(5)}</time></th><td>${x.count?`${x.count}회`:'—'}</td><td>${x.count?x.pee:'—'}</td><td>${x.count?x.poo:'—'}</td></tr>`).join('');
 return `<h2 class="section-head">기저귀</h2><div class="summary-cards stats-cards">${cards.map(([label,value])=>`<div class="summary-card"><p>${label}</p><strong>${esc(value)}</strong></div>`).join('')}</div><p class="caption">평균은 기저귀 기록이 있는 날만 계산해요. ‘둘 다’는 소변과 대변에 모두 세요.</p><section class="card"><h2>최근 ${statsDays}일 기저귀</h2><table class="stats-table"><thead><tr><th scope="col">날짜</th><th scope="col">전체</th><th scope="col">소변</th><th scope="col">대변</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
function filterView(k){const f=filters[k];return `<form id="filter-form" class="filters" aria-label="목록 검색"><label>검색<input name="query" type="search" placeholder="메모, 병원, 품목 검색" value="${esc(f.query||'')}"></label>${k==='records'?`<label>기록 종류<select name="type"><option value="">전체</option><option value="feeding" ${f.type==='feeding'?'selected':''}>수유</option><option value="sleep" ${f.type==='sleep'?'selected':''}>수면</option><option value="diaper" ${f.type==='diaper'?'selected':''}>기저귀</option><option value="hospital" ${f.type==='hospital'?'selected':''}>병원</option></select></label>`:''}${k==='shopping'?`<label>구매 상태<select name="status"><option value="">전체</option><option value="pending" ${f.status==='pending'?'selected':''}>구매 예정</option><option value="done" ${f.status==='done'?'selected':''}>구매 완료</option></select></label>`:`<label>시작 날짜<input name="from" type="date" value="${esc(f.from||'')}"></label><label>마지막 날짜<input name="to" type="date" value="${esc(f.to||'')}"></label>`}<button type="submit" class="secondary">검색</button><button type="button" class="plain" data-reset="${k}">초기화</button></form>`}
function shoppingOrder(items){
 // Soonest planned date first, undated after them; the newest first within each group.
 return [...items].sort((a,b)=>(a.date?0:1)-(b.date?0:1)||(a.date&&b.date?a.date.localeCompare(b.date):0)||b.id.localeCompare(a.id));
}
let recordDays=3;
const weekdays=['일','월','화','수','목','금','토'];
function dayLabel(day){const [y,m,d]=day.split('-').map(Number);return `${m}월 ${d}일 (${weekdays[new Date(y,m-1,d).getDay()]})`;}
// Records grouped by day with a per-day total; by default only the last few days.
function recordGroups(items){
 const filtered=Object.values(filters.records).some(Boolean),today=Somhouse.localDateTime().slice(0,10);
 const days=[...new Set(items.map(x=>(x.date||'').slice(0,10)))].sort().reverse();
 const shown=filtered?days:days.filter(day=>day>Somhouse.addDays(today,-recordDays));
 const groups=shown.map(day=>{
  const list=items.filter(x=>(x.date||'').slice(0,10)===day),sum=Somhouse.rangeSummary(list,day,day);
  const parts=[sum.count?`🍼 ${totals(sum)}`:'',sum.sleepCount?sleepTotals(sum):'',sum.diaperCount?diaperTotals(sum):'',list.some(x=>x.type==='hospital')?`🏥 ${list.filter(x=>x.type==='hospital').length}건`:''].filter(Boolean).join(' · ');
  return `<section class="day-group"><h3 class="day-head">${esc(dayLabel(day))}${parts?`<span>${esc(parts)}</span>`:''}</h3>${list.map(x=>item(x,'records',false,true)).join('')}</section>`;
 }).join('');
 const hidden=days.length-shown.length;
 return groups+(hidden?`<button class="secondary more" data-more-days="7">이전 기록 더 보기 (${hidden}일 남음)</button>`:'');
}
function listView(k){
 const names={records:'기록을 누르면 고치거나 지울 수 있어요.',schedule:'병원 예약과 가족 일정을 관리해요. 일정을 누르면 고치거나 지울 수 있어요.',shopping:'‘✓ 샀어요’로 바로 완료하고, 항목을 누르면 고치거나 지울 수 있어요. Google 음성 장보기는 관리자가 상품 규격과 가격 검색을 설정한 경우에만 가격 비교 링크를 남겨요.'};
 const items=Somhouse.filter(sorted(k),filters[k]),now=Somhouse.localDateTime();
 const head=k==='schedule'?`다가오는 ${items.filter(x=>x.date>=now).length} · 지난 ${items.filter(x=>x.date<now).length}`:k==='shopping'?`살 것 ${items.filter(x=>x.done!=='yes').length} · 산 것 ${items.filter(x=>x.done==='yes').length}`:`기록 ${items.length}개`;
  const kids=k==='schedule'?`<p class="caption kids">👶 아기: ${children().map(esc).join(', ')||'아직 등록하지 않았어요'} <button class="plain small" data-manage-children="1">${children().length?'아기 이름 관리':'＋ 아기 등록'}</button></p>`:'';
 const add=k==='records'?'<button data-add="feeding">수유 추가</button><button class="secondary" data-add="sleep">수면 추가</button><button class="secondary" data-add="diaper">기저귀 추가</button><button class="secondary" data-add="hospital">병원 추가</button>':`<button data-add="${k}">추가하기</button>`;
 const body=k==='schedule'?scheduleItems(items):k==='shopping'?shoppingItems(items):items.length?recordGroups(items):'';
 return `<h1>${pageTitles[k]}</h1><p>${names[k]}</p>${kids}${k==='shopping'?stockCard()+rebuyCard():aiHelpCard(k)}${k==='records'?checksCard():''}<div class="heading"><h2>${head}</h2><div class="quick">${add}</div></div>${filterView(k)}${body||`<div class="card empty">${data[k].length?'검색 조건에 맞는 기록이 없어요. 조건을 바꾸거나 초기화해보세요.':'아직 기록이 없어요. 추가 버튼으로 시작해보세요.'}</div>`}${k==='records'?voiceHelp():''}`;
}
function shoppingItems(items){
 if(!items.length)return '';
 // A bought 기저귀 item that is being counted as stock (A안) stays in view above the folded bought list.
 const counting=shoppingStock()?.latest.id,pending=shoppingOrder(items.filter(x=>x.done!=='yes')),done=items.filter(x=>x.done==='yes'&&x.id!==counting),stocked=items.filter(x=>x.done==='yes'&&x.id===counting);
 return `${pending.map(x=>item(x,'shopping')).join('')||'<p class="empty">살 것이 없어요.</p>'}${stocked.length?`<p class="caption">재고로 세는 중</p>${stocked.map(x=>item(x,'shopping')).join('')}`:''}${done.length?`<details class="past"><summary>산 것 ${done.length}개</summary>${done.map(x=>item(x,'shopping')).join('')}</details>`:''}`;
}
function scheduleItems(items){
 const now=Somhouse.localDateTime(),upcoming=items.filter(x=>x.date>=now).reverse(),past=items.filter(x=>x.date<now);
 if(!items.length)return '';
 return `${upcoming.map(x=>item(x,'schedule')).join('')||'<p class="empty">다가오는 일정이 없어요.</p>'}${past.length?`<details class="past"${schedulePastOpen?' open':''}><summary>지난 일정 ${past.length}개</summary>${past.map(x=>item(x,'schedule')).join('')}</details>`:''}`;
}
// Register a child's name (shared by every phone). With no names yet, schedules saved as '아기' can follow.
async function addChild(){
 if(shared.readOnly){alert(READ_ONLY);return '';}
 const name=(prompt('아기 이름을 입력해 주세요. 예: 솜이')||'').trim();
 if(!name)return '';
 const first=!children().length,old=data.schedule.filter(x=>x.who==='아기').length;
 const rename=first&&old&&confirm(`‘아기’로 저장된 일정 ${old}개를 ‘${name}’ 일정으로 바꿀까요?`)?{'아기':name}:undefined;
 return await saveChildren([...children(),name],rename)?name:'';
}
async function saveChildren(list,rename){
 if(busy)return false;busy=true;connectionView();
 try{const result=await shared.saveSettings(list,rename);data=result.data;message(`아기 이름을 저장했어요: ${children().join(', ')||'없음'}${result.moved?` · 일정 ${result.moved}개를 옮겼어요`:''}`);return true;}
 catch(error){alert(error.message);return false;}
 finally{busy=false;connectionView();}
}
// One line to rename, add or remove: '솜이, 하늘'. Same count keeps positions, so a changed name is a rename.
async function manageChildren(){
 if(shared.readOnly){alert(READ_ONLY);return;}
 const before=children(),text=prompt('아기 이름을 쉼표(,)로 구분해 적어 주세요. 이름을 바꾸면 그 아기의 일정도 함께 바뀌어요.',before.join(', '));
 if(text===null)return;
 const after=text.split(',').map(x=>x.trim()).filter(Boolean),rename={};
 if(after.length===before.length)before.forEach((old,i)=>{if(old!==after[i])rename[old]=after[i];});
 if(await saveChildren(after,Object.keys(rename).length?rename:undefined))render();
}
const AI_PICK='somhouse-ai-provider',AI_KEYS='somhouse-ai-keys-v1',AI_LOG='somhouse-ai-log-v1',AI_LOG_MAX=50,AI_FOLLOW='somhouse-ai-follow',aiDirect=typeof SomhouseAI!=='undefined'?SomhouseAI:null;
// API keys stay in this browser, per signed-in account, and are never sent to the Mac.
function aiAccount(){return shared?`${shared.base}|${shared.username}`:'';}
function aiKeyStore(){try{const all=JSON.parse(localStorage.getItem(AI_KEYS)||'{}');return all&&typeof all==='object'?all:{};}catch{return {};}}
function aiKeys(){const mine=aiKeyStore()[aiAccount()];return mine&&typeof mine==='object'?mine:{};}
function saveAIKey(id,value){
 try{
  const all=aiKeyStore(),mine={...aiKeys()};
  if(value)mine[id]=value;else delete mine[id];
  if(Object.keys(mine).length)all[aiAccount()]=mine;else delete all[aiAccount()];
  localStorage.setItem(AI_KEYS,JSON.stringify(all));return true;
 }catch{return false;}
}
// Past questions and answers, per account on this device, like a chat. Each question is still asked on its own.
function aiLogStore(){try{const all=JSON.parse(localStorage.getItem(AI_LOG)||'{}');return all&&typeof all==='object'?all:{};}catch{return {};}}
function aiLog(account=aiAccount()){const mine=account&&aiLogStore()[account];return Array.isArray(mine)?mine:[];}
function saveAILog(account,entries){
 try{
  const all=aiLogStore();
  if(entries.length)all[account]=entries.slice(-AI_LOG_MAX);else delete all[account];
  if(Object.keys(all).length)localStorage.setItem(AI_LOG,JSON.stringify(all));else localStorage.removeItem(AI_LOG);
 }catch{}
}
function aiLogView(waiting){
 const box=$('#ai-log'),entries=shared?.token?aiLog():[];
 const time=at=>{const d=new Date(at);return Number.isNaN(d.getTime())?'':`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
 const bubble=(cls,text,who='')=>`<div class="ai-msg ${cls}">${who?`<span class="ai-who">${esc(who)}</span>`:''}${esc(text)}</div>`;
 box.innerHTML=entries.map(x=>bubble('me',x.q)+bubble('bot',x.a,[x.ai,time(x.at)].filter(Boolean).join(' · '))).join('')
  +(waiting?bubble('me',waiting.q)+bubble('bot wait',`${waiting.ai} 답변을 기다리고 있어요…`,waiting.ai):'');
 box.scrollTop=box.scrollHeight;
 $('#ai-clear').hidden=!entries.length;
}
// Follow-ups are on unless this device turned them off. Only own-key AIs get earlier turns.
function aiFollow(){try{return localStorage.getItem(AI_FOLLOW)!=='0';}catch{return true;}}
function setAIFollow(on){try{if(on)localStorage.removeItem(AI_FOLLOW);else localStorage.setItem(AI_FOLLOW,'0');}catch{}if(ai.config)$('#ai-status').textContent=aiStatusText();}
function clearAILog(){
 if(!aiLog().length||ai.pending)return;
 if(typeof confirm==='function'&&!confirm('이 기기에 남은 AI 대화를 모두 지울까요?'))return;
 saveAILog(aiAccount(),[]);aiLogView();$('#ai-status').textContent='대화를 지웠어요.';
}
// Each way to ask: the Mac's CLI (original family only) or this device's own key.
function aiOptions(){
 const config=ai.config,keys=aiKeys(),list=[];
 if(!config)return list;
 if(config.chatgptPlan?.connected&&config.chatgptPlan.model&&!config.readOnly)list.push({value:'plan:chatgpt',mode:'plan',p:{id:'chatgpt',name:'ChatGPT'},summaries:false});
 for(const p of config.providers){
  if(p.enabled&&config.enabled)list.push({value:'mac:'+p.id,mode:'mac',p,summaries:p.recordSummaries===true});
  const key=keys[p.id];
  if(key?.key&&key.model&&!config.readOnly&&aiDirect?.PROVIDERS[p.id])list.push({value:'key:'+p.id,mode:'key',p,key:aiShortlist(p.id,key),summaries:true});
 }
 return list;
}
// Keys saved before the free shortlist keep working: show only the shortlist and fall back to its first model.
function aiShortlist(id,key){
 if(id!=='antigravity'||!aiDirect?.geminiShortlist)return key;
 const models=aiDirect.geminiShortlist(Array.isArray(key.models)&&key.models.length?key.models:[key.model]);
 return {...key,models,model:models.includes(key.model)?key.model:models[0]||key.model};
}
function aiOption(value){return value?aiOptions().find(x=>x.value===value)||null:null;}
// A key for Google's card is a Gemini API key, so it answers as Gemini; the Mac runs the Antigravity CLI.
function aiName(o){return o.mode==='key'&&o.p.id==='antigravity'?'Gemini':o.p.name;}
// Until Somhouse can ask them from the web without a paid key, these open their own apps.
const AI_APPS={codex:{name:'ChatGPT',url:'https://chatgpt.com/'},claude:{name:'Claude',url:'https://claude.ai/'}};
// Gemini comes first and open: its key can start free. The others fold to a link to their app
// unless this family already asks them here.
function aiProvidersView(){
 const config=ai.config,options=aiOptions(),usable=p=>options.some(o=>o.p.id===p.id);
 const radio=(o,text,caption)=>`<label class="ai-pick"><input type="radio" name="provider" value="${esc(o.value)}"${ai.selected===o.value?' checked':''}> ${text}</label><p class="caption">${caption}</p>`;
 const plan=config.chatgptPlan,personal=options.find(o=>o.mode==='plan');
 let planCard='';
 // Without a server sign-in (waiting for OpenAI's approval) the ChatGPT app link lives in the OpenAI card.
 if(plan&&!config.readOnly){
  const models=plan.models||(plan.model?[{slug:plan.model,name:plan.model}]:[]);
  const controls=plan.connected
   ?(personal?radio(personal,'내 ChatGPT 구독으로 질문하기',esc(plan.email||'')):'')
     +(models.length?`<label class="field ai-model">ChatGPT 모델<select data-ai-model="chatgpt">${models.map(m=>`<option value="${esc(m.slug)}"${m.slug===plan.model?' selected':''}>${esc(m.name)}</option>`).join('')}</select></label>`:'<p>이 계정에서 선택할 수 있는 모델이 없어요.</p>')
     +'<button type="button" class="secondary" data-plan="models">모델 목록 새로고침</button>'
     +'<p><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">사용량 관리</a></p>'
     +'<button type="button" class="secondary" data-plan="start" data-oai-siwc-button>다시 연결</button> <button type="button" class="plain" data-plan="disconnect">구독 연결 해제</button>'
   :'<p>본인의 ChatGPT 플랜 사용을 허용하면 구독 한도에서 답해요. 입력한 질문만 OpenAI로 보내요.</p><button type="button" data-plan="start" data-oai-siwc-button>ChatGPT로 계속하기</button>';
  planCard=`<details class="ai-provider" data-provider="chatgpt" open><summary><strong>내 ChatGPT 구독</strong><span class="badge${plan.connected?'':' off'}">${plan.connected?'연결됨':'연결하기'}</span></summary><div class="body">${controls}</div></details>`;
 }
 const rank=p=>p.id==='antigravity'?2:Number(usable(p));
 const cardsHTML=[...config.providers].sort((a,b)=>rank(b)-rank(a)).map(p=>{
  const id=esc(p.id),name=esc(p.name),info=aiDirect?.PROVIDERS[p.id],gemini=p.id==='antigravity',app=AI_APPS[p.id];
  const mac=options.find(o=>o.value==='mac:'+p.id),own=options.find(o=>o.value==='key:'+p.id);
  let body='';
  if(mac)body+=radio(mac,`맥미니 ${name}로 질문하기`,`관리자 계정으로 답해요 · 모델: ${esc(p.model||'CLI 기본값')} · ${p.recordSummaries?'가족 기록 집계를 함께 보낼 수 있어요.':'질문만 보내요.'}`);
  if(own){
   const models=Array.isArray(own.key.models)&&own.key.models.length?own.key.models:[own.key.model];
   body+=radio(own,`내 ${esc(info.keyName)}로 질문하기`,gemini?'이 기기에서 바로 Google로 보내요. 무료 한도를 넘으면 결제를 연결한 키 주인에게 요금이 청구돼요.':'이 기기에서 바로 AI 회사로 보내요. 사용한 만큼 키 주인에게 요금이 청구돼요.')
    +`<label class="field ai-model">모델<select data-ai-model="${id}">${models.map(m=>`<option value="${esc(m)}"${m===own.key.model?' selected':''}>${gemini&&aiDirect.GEMINI_TIER?.[m]?esc(aiDirect.GEMINI_TIER[m])+' · ':''}${esc(m)}</option>`).join('')}</select></label>`
    +`<div class="actions"><button type="button" class="secondary" data-ai-disconnect="${id}">키 연결 해제</button></div>`;
  }else if(info&&!config.readOnly){
   const form=`<label class="field">${esc(info.keyName)}로 연결<input type="password" id="ai-key-${id}" autocomplete="off" spellcheck="false" placeholder="키를 붙여 넣어 주세요"></label>`
    +`<div class="actions"><button type="button" data-ai-connect="${id}">연결</button></div>`
    +(gemini?'<p class="caption">Google AI Studio에서 무료로 키를 받아 시작할 수 있어요. 무료 등급에서는 질문이 Google 서비스 개선에 쓰일 수 있어요. 결제를 연결하면 무료 한도를 넘은 만큼 요금이 청구돼요.</p>':'')
    +`<p class="caption">키는 이 기기에만 저장되고 솜하우스 서버로는 보내지 않아요.${gemini?'':' 구독과 별개로 사용한 만큼 AI 회사가 키 주인에게 요금을 청구해요.'} 공용 기기에서는 연결하지 마세요. <a href="${esc(info.keyPage)}" target="_blank" rel="noopener">키 발급받기</a></p>`;
   // With the Mac already answering, a key is optional: keep its form folded. Paid-only keys stay folded behind the app link.
   body+=mac?`<details class="ai-admin"><summary>내 ${esc(info.keyName)}로도 연결하기</summary>${form}</details>`
    :gemini?form:`<details class="ai-admin"><summary>${esc(info.keyName)}로 연결하기 (유료)</summary>${form}</details>`;
  }
  if(app&&!mac&&!own&&!config.readOnly)body=`<p><a class="button secondary" href="${app.url}" target="_blank" rel="noopener noreferrer">${app.name} 앱에서 질문하기 ↗</a></p>`
   +`<p class="caption">${p.id==='codex'?'솜하우스 안에서 ChatGPT 구독으로 질문하는 연결은 OpenAI 승인 후 열려요.':'솜하우스 안에서 구독으로 질문하는 공식 연결이 아직 없어요.'} 지금은 ${app.name} 앱이나 웹에서 질문해 주세요.</p>`+body;
  if(!mac&&!own&&!p.enabled&&!config.homeOnly&&!config.readOnly)body+=`<details class="ai-admin"><summary>맥미니에 연결하기 (관리자)</summary><p class="caption">관리자가 맥미니에서 ${name} CLI에 로그인한 뒤 아래 명령을 실행하면 키 없이 쓸 수 있어요.</p><p class="caption"><code>python3 server.py ai-config --provider ${id}</code></p></details>`;
  if(!body)body='<p class="caption">게스트 보기에서는 연결할 수 없어요.</p>';
  const connected=Boolean(mac||own),open=connected||(gemini&&!config.readOnly);
  const badge=mac&&own?'연결됨':mac?'맥미니 연결됨':own?'내 키 연결됨':app&&!config.readOnly?'앱에서 질문':gemini&&!config.readOnly?'무료로 시작':'연결 안 됨';
  const title=mac?name:gemini?'Gemini':p.id==='codex'?'ChatGPT':name;
  return `<details class="ai-provider" data-provider="${id}"${open?' open':''}><summary><strong>${title}</strong><span class="caption">${esc(p.company)}</span><span class="badge${connected?'':' off'}">${badge}</span></summary><div class="body">${body}</div></details>`;
 });
 // Gemini first, then a ChatGPT plan the server can sign in to, then the rest.
 const first=config.providers.some(p=>p.id==='antigravity')?1:0;
 return cardsHTML.slice(0,first).join('')+planCard+cardsHTML.slice(first).join('');
}
function aiStatusText(){
 const config=ai.config,picked=aiOption(ai.selected);
 if(config.readOnly)return '게스트 보기에서는 질문할 수 없어요. 가족 계정으로 로그인하면 질문을 보낼 수 있어요.';
 if(picked?.mode==='plan')return '내 ChatGPT 플랜을 사용해요. 입력한 질문만 보내요.';
 if(picked)return `${picked.mode==='mac'?'맥미니 ':'내 키로 '}${aiName(picked)}에게 질문해요. ${picked.mode==='key'&&aiFollow()?'최근 대화를 이어서 답해요.':'질문마다 새로 답해요.'}`;
 if(!aiOptions().length&&config.chatgptPlan&&!config.chatgptPlan.connected)return '내 ChatGPT 구독을 연결하면 여기에서 질문할 수 있어요.';
 if(!aiOptions().length)return '아직 연결된 AI가 없어요. Gemini API 키를 연결하면 여기에서 바로 질문할 수 있어요.';
 return '질문할 AI를 골라 주세요.';
}
function pickAI(value){
 const picked=aiOption(value);
 ai.selected=picked?picked.value:'';
 if(picked)try{localStorage.setItem(AI_PICK,picked.value);}catch{}
 $('#ai-scope-field').hidden=!picked?.summaries;
 $('#ai-follow-field').hidden=picked?.mode!=='key';$('#ai-follow').checked=aiFollow();
 if(!picked?.summaries)$('#ai-scope').value='none';
 else if(aiHelp.scope){$('#ai-scope').value=aiHelp.scope;aiHelp.scope='';}
 if(ai.config)$('#ai-status').textContent=aiStatusText();
 connectionView();
}
function chooseAI(preferred){
 let remembered='';try{remembered=localStorage.getItem(AI_PICK)||'';}catch{}
 const options=aiOptions(),choice=[preferred,ai.selected,remembered].find(v=>v&&options.some(o=>o.value===v))||options[0]?.value||'';
 ai.selected=choice;
 $('#ai-providers').innerHTML=aiProvidersView();
 pickAI(choice);
}
async function checkAI(){
 const state=ai;
 if(state.checking||state.pending)return;
 state.checking=true;connectionView();
 $('#ai-status').textContent='연결된 AI를 확인하고 있어요…';
 try{
  const config=await shared.aiStatus();
  if(ai!==state)return;
  state.config={...config,providers:Array.isArray(config.providers)?config.providers:[]};
  let catalogError='';
  if(config.chatgptPlan?.connected&&!Array.isArray(config.chatgptPlan.models)){
   // Connections made before the model picker only stored a single model.
   try{state.config.chatgptPlan=await shared.request('/api/chatgpt/models','POST',{});}
   catch(error){if(error.status===401)throw error;catalogError=error.message;}
   if(ai!==state)return;
  }
  chooseAI(state.planConnected?'plan:chatgpt':null);
  if(state.planNotice){$('#ai-status').textContent=state.planNotice;state.planNotice='';}
  if(catalogError)$('#ai-status').textContent=catalogError;
  state.planConnected=false;
 }catch(error){
  if(ai!==state)return;
  state.config=null;
  if(error.status===401)showLogin(error.message);else $('#ai-status').textContent=error.message;
 }finally{state.checking=false;connectionView();}
}
async function connectAIKey(id){
 const state=ai,info=aiDirect?.PROVIDERS[id];
 if(!info||!state.config||state.config.readOnly||state.pending||state.checking||busy)return;
 const input=$('#ai-key-'+id);
 state.pending=true;connectionView();
 $('#ai-status').textContent=`${info.keyName}를 확인하고 있어요…`;
 try{
  const saved=await aiDirect.connect(id,input?.value);
  if(ai!==state)return;
  if(!saveAIKey(id,saved))throw Error('이 기기에 키를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
  state.pending=false;
  chooseAI('key:'+id);
  $('#ai-status').textContent=`${info.keyName}를 연결했어요. 모델: ${saved.model}`;
 }catch(error){if(ai===state)$('#ai-status').textContent=error.message;}
 finally{if(ai===state){state.pending=false;connectionView();}}
}
function disconnectAIKey(id){
 const info=aiDirect?.PROVIDERS[id];
 if(!info||ai.pending||!confirm(`이 기기에 저장한 ${info.keyName}를 지울까요?`))return;
 saveAIKey(id,null);chooseAI();
 $('#ai-status').textContent=`${info.keyName}를 이 기기에서 지웠어요. 키 자체를 없애려면 AI 회사 사이트에서 삭제해 주세요.`;
}
function chooseAIModel(id,model){
 if(id==='chatgpt'){
  const plan=ai.config?.chatgptPlan;
  if(plan?.models?.some(m=>m.slug===model)){
   plan.model=model;
   chooseAI('plan:chatgpt');
  }
  return;
 }
 const key=aiKeys()[id];
 if(key?.models?.includes(model)&&saveAIKey(id,{...key,model}))$('#ai-status').textContent=`모델을 ${model}(으)로 바꿨어요.`;
}
async function planAction(action){
 const state=ai;
 if(!state.config?.chatgptPlan||state.config.readOnly||busy||state.checking||state.pending)return;
 if(action==='disconnect'&&!confirm('이 기기의 ChatGPT 구독 연결을 해제할까요?'))return;
 state.pending=true;connectionView();
 try{
  const result=await shared.request('/api/chatgpt/'+action,'POST',{});
  if(ai!==state)return;
  if(action==='start'){
   const url=new URL(result.url);
   if(url.origin!=='https://auth.openai.com')throw Error('OpenAI 로그인 주소를 확인하지 못했어요.');
   location.assign(url.href);
  }else if(action==='models'){
   state.config.chatgptPlan=result;
   chooseAI(result.model?'plan:chatgpt':null);
   $('#ai-status').textContent='ChatGPT 모델 목록을 새로고침했어요.';
  }else{
   state.config.chatgptPlan={connected:false};chooseAI();
   $('#ai-status').textContent=result.revoked?'ChatGPT 구독 연결을 해제했어요.':'이 기기의 연결을 해제했어요. ChatGPT 설정에서 앱 권한 해제도 확인해 주세요.';
  }
 }catch(error){if(ai===state)$('#ai-status').textContent=error.message;}
 finally{if(ai===state){state.pending=false;connectionView();}}
}
async function askAI(e){
 e.preventDefault();
 const state=ai,picked=aiOption(state.selected);
 if(busy||state.pending||state.checking||!picked||!shared.token||shared.readOnly)return;
 const values=new FormData(e.target);
 const question=String(values.get('question')||'').trim(),scope=picked.summaries?values.get('scope')||'none':'none';
 if(!question){$('#ai-status').textContent='질문을 입력해 주세요.';return;}
 const account=aiAccount(),name=aiName(picked),earlier=picked.mode==='key'&&aiFollow()?aiDirect.history(aiLog(account)):[];
 state.pending=true;connectionView();
 $('#ai-status').textContent=`${name} 답변을 기다리고 있어요…`;
 aiLogView({q:question,ai:name});
 try{
  const result=picked.mode==='plan'?await shared.request('/api/chatgpt/ask','POST',{question,scope:'none',model:state.config.chatgptPlan.model},shared.base,shared.token,55000)
   :picked.mode==='mac'?await shared.askAI(question,scope,picked.p.id)
   :await aiDirect.ask(picked.p.id,picked.key,question,scope==='none'?null:{scope,summary:aiDirect.summarize(scope,data,Somhouse.localDateTime().slice(0,10))},earlier);
  if(ai!==state||aiAccount()!==account)return;
  if(typeof result.answer!=='string'||!result.answer.trim())throw Error('답변을 확인하지 못했어요. 다시 시도해 주세요.');
  saveAILog(account,[...aiLog(account),{q:question,a:result.answer,ai:name,at:new Date().toISOString()}]);
  aiLogView();
  $('#ai-question').value='';
  $('#ai-status').textContent=result.truncated?'답변이 길어 일부만 표시했어요.':`${name} 답변을 받았어요.`;
 }catch(error){
  if(ai!==state)return;
  aiLogView();
  if(error.status===401&&picked.mode!=='key')showLogin(error.message);else $('#ai-status').textContent=error.message;
 }finally{state.pending=false;connectionView();}
}
function render(){
 needsRender=false;
 document.querySelectorAll('nav button').forEach(b=>{const active=b.dataset.page===page;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
 document.title=`${pageTitles[page]} · 솜하우스`;
 const connected=mode==='shared'&&sharedReady,showAI=connected&&page==='ai';
 const aiPanel=$('#ai-panel'),openingAI=aiPanel.hidden&&showAI;
 aiPanel.hidden=!showAI;
 if(!connected){$('#dashboard').hidden=true;$('#dashboard').innerHTML='';dashboardHtml='';}
 if(!connected||showAI){
  $('#content').innerHTML='';connectionView();
  if(openingAI){aiLogView();checkAI();}
  return;
 }
 if(!ai.config&&!aiHelp.loading&&!shared.readOnly)aiHelpConfig();
 const dashboard=$('#dashboard');
 if(page==='schedule'){const board=calendarView();if(dashboardHtml!==board){dashboard.innerHTML=board;dashboardHtml=board;}dashboard.hidden=false;}
 else{dashboard.hidden=true;if(dashboardHtml){dashboard.innerHTML='';dashboardHtml='';}}
 const past=document.querySelector('details.past');if(past)schedulePastOpen=past.open;
 showGoogleStatus(true);
 $('#content').innerHTML=page==='home'?homeView():page==='stats'?statsView():page==='review'?reviewView():page==='report'?reportView():listView(page);
 connectionView();
 const form=$('#filter-form');if(form){const apply=e=>{e?.preventDefault?.();const next=Object.fromEntries(new FormData(form));if(next.from&&next.to&&next.from>next.to){alert('시작 날짜는 마지막 날짜보다 늦을 수 없어요.');return}filters[page]=next;render()};form.onsubmit=apply;form.onchange=apply;}
}
// Feeding amounts: 분유·혼합 in ml, 모유 in minutes, typed as a number with ± buttons; 기타 stays free text.
const units={분유:['ml',10],혼합:['ml',10],모유:['분',5]};
function lastAmount(category){
 const unit=units[category]?.[0],x=data.records.filter(r=>r.type==='feeding'&&r.category===category&&new RegExp('^\\d+\\s*'+unit+'$').test(r.amount||'')).sort((a,b)=>b.date.localeCompare(a.date))[0];
 return x?x.amount.replace(/\D+$/,'').trim():{분유:'120',혼합:'100',모유:'15'}[category]||'';
}
function amountParts(category,amount){
 const unit=units[category]?.[0],m=String(amount||'').trim().match(/^(\d+(?:\.\d+)?)\s*(ml|분)$/i);
 return unit&&m&&m[2].toLowerCase()===unit?m[1]:String(amount||'');
}
function amountField(category,amount){
 const unit=units[category];
 return `<div class="amount-row"><button type="button" class="secondary step" data-step="-1" aria-label="줄이기"${unit?'':' hidden'}>−${unit?unit[1]:''}</button><input name="amount" type="text" inputmode="${unit?'decimal':'text'}" value="${esc(amountParts(category,amount))}" required placeholder="${unit?'':'예: 120ml 또는 15분'}"><span class="unit">${unit?unit[0]:''}</span><button type="button" class="secondary step" data-step="1" aria-label="늘리기"${unit?'':' hidden'}>+${unit?unit[1]:''}</button></div>`;
}
function openForm(type,x,preset={},review=''){reviewKey=review;kind=type;editing=x||null;draftId=x?.id||newId();const values=x||{...preset,date:preset.date||(type==='shopping'?'':Somhouse.localDateTime()),...(type==='shopping'&&!preset.quantity?{quantity:'1'}:{}),...(type==='feeding'?{category:preset.category||'분유',amount:preset.amount||(review?'':lastAmount(preset.category||'분유'))}:{})};$('#delete-item').hidden=!x||Boolean(review);$('#formtitle').textContent=(review?'확인 필요 정정 · ':x?'수정 · ':'추가 · ')+({feeding:'수유 기록',sleep:'수면 기록',diaper:'기저귀',hospital:'병원 방문',schedule:'일정',shopping:'구매 목록'}[type]);$('#fields').innerHTML=schemas[type].map(([name,label,t,required])=>`<label class="field">${label}${required?' *':''}${t==='select'?`<select name="${name}" required>${(name==='who'?whoChoices(values.who):choices[type+'.'+name]||choices[name]).map(v=>`<option ${values[name]===v?'selected':''}>${esc(v)}</option>`).join('')}${name==='who'?`<option value="${ADD_CHILD}">＋ 아기 추가…</option>`:''}</select>`:t==='textarea'?`<textarea name="${name}">${esc(values[name]||'')}</textarea>`:type==='feeding'&&name==='amount'?amountField(values.category,values.amount):`<input name="${name}" type="${t}" value="${esc(values[name]||'')}" ${required?'required':''}${name==='amount'?' placeholder="예: 120ml 또는 15분"':''}>`}</label>`).join('');
 if(type==='schedule'){
  const select=document.querySelector('#fields select[name="who"]');
  if(select){let last=select.value;select.onchange=async()=>{
   if(select.value!==ADD_CHILD){last=select.value;return;}
   const name=await addChild();
   select.innerHTML=whoChoices(name||last).map(v=>`<option ${v===(name||last)?'selected':''}>${esc(v)}</option>`).join('')+`<option value="${ADD_CHILD}">＋ 아기 추가…</option>`;
   select.value=name||last;last=select.value;
  };}
 }
 if(type==='feeding'){
  const select=document.querySelector('#fields select[name="category"]');
  if(select)select.onchange=()=>{
   const unit=units[select.value],input=document.querySelector('#fields input[name="amount"]');
   document.querySelector('#fields .unit').textContent=unit?unit[0]:'';
   document.querySelectorAll('#fields .step').forEach(b=>{b.hidden=!unit;if(unit)b.textContent=(b.dataset.step==='1'?'+':'−')+unit[1];});
   input.inputMode=unit?'decimal':'text';
   if(unit&&!/^\d+(\.\d+)?$/.test(input.value.trim()))input.value=lastAmount(select.value);
   else if(unit&&!editing)input.value=lastAmount(select.value);
  };
 }
 $('#dialog').showModal()}
document.addEventListener('click',async e=>{
 if(e.target.closest?.('a')?.tagName==='A')return; // a link inside a card opens the link, not the edit form
 const b=e.target.closest('button,[data-action]');if(!b)return;
 if(b.dataset.toast!==undefined){const action=toastActions[Number(b.dataset.toast)];hideToast();if(action)await action.run();return;}
 if(b.dataset.page){location.hash=b.dataset.page;if(page===b.dataset.page)render();}
 if(b.dataset.reset){filters[b.dataset.reset]={};render();}
 if(busy||mode!=='shared'||!sharedReady)return;
 if(await aiHelpClick(b)||await insightsClick(b))return;
 if(b.dataset.alarmOpen){alarmUi.open=!alarmUi.open;render();return;}
 if(['on','off'].includes(b.dataset.alarm)&&['feeding','nap'].includes(b.dataset.alarmKind)){await alarmSwitch(b.dataset.alarmKind,b.dataset.alarm==='on');return;}
 if(b.dataset.step){
  const input=document.querySelector('#fields input[name="amount"]'),category=document.querySelector('#fields select[name="category"]')?.value,unit=units[category];
  if(!input||!unit)return;
  const value=Math.max(0,(parseFloat(input.value)||0)+Number(b.dataset.step)*unit[1]);input.value=String(Math.round(value*10)/10);return;
 }
 if(b.dataset.googleConnect&&!shared.readOnly){
  busy=true;connectionView();message('Google로 이동하고 있어요…');
  try{location.href=await shared.googleStart('connect',location.origin+location.pathname);}catch(error){message(error.message);}finally{busy=false;connectionView();}
  return;
 }
 if(b.dataset.manageChildren){await manageChildren();return;}
 if(b.dataset.moreDays){recordDays+=Number(b.dataset.moreDays);render();return;}
 if(['7','30'].includes(b.dataset.statsDays)){statsDays=Number(b.dataset.statsDays);render();return;}
 if(['schedule','shopping'].includes(b.dataset.addOn)&&calendarDay){openForm(b.dataset.addOn,null,{date:b.dataset.addOn==='schedule'?calendarDay+'T09:00':calendarDay});return;}
 if(/^\d{4}-\d{2}$/.test(b.dataset.calMonth||'')){calendarMonth=b.dataset.calMonth;calendarDay='';render();return;}
 if(/^\d{4}-\d{2}-\d{2}$/.test(b.dataset.calDay||'')){calendarDay=calendarDay===b.dataset.calDay?'':b.dataset.calDay;render();if(calendarDay)document.querySelector('.cal-detail')?.scrollIntoView?.({block:'nearest',behavior:'smooth'});return;}
 if(b.dataset.sleepStart){
  const now=Somhouse.localDateTime(),hour=Number(now.slice(11,13)),category=hour>=7&&hour<19?'낮잠':'밤잠';
  if(await changeItem('records',{id:newId(),type:'sleep',date:now,end:'',category,memo:''})){message(`${now.slice(11)}에 ${category}을 시작했어요. 깨면 ‘수면 종료’를 누르거나 수유를 기록하면 끝나요.`);render();}
  return;
 }
 if(b.dataset.sleepEnd){
  const entry=data.records.find(x=>x.id===b.dataset.sleepEnd),now=Somhouse.localDateTime();if(!entry)return;
  if(now<=entry.date){alert('잠든 지 1분이 지난 뒤에 눌러 주세요.');return;}
  if(await changeItem('records',{...entry,end:now})){message(`${entry.category} ${Somhouse.duration(Somhouse.sleepMinutes({date:entry.date,end:now}))}을 기록했어요.`);render();}
  return;
 }
 if(b.dataset.add){if(mode==='shared'&&!sharedReady)return;openForm(b.dataset.add);}
 if(b.dataset.repeatCategory&&b.dataset.repeatAmount){await quickSave({id:newId(),type:'feeding',date:Somhouse.localDateTime(),category:b.dataset.repeatCategory,amount:b.dataset.repeatAmount,memo:''},`🍼 ${b.dataset.repeatCategory} ${b.dataset.repeatAmount}`);return;}
 if(b.dataset.diaper&&choices['diaper.category'].includes(b.dataset.diaper)){await quickSave({id:newId(),type:'diaper',date:Somhouse.localDateTime(),category:b.dataset.diaper,memo:''},`${diaperIcons[b.dataset.diaper]} 기저귀 ${b.dataset.diaper}`);return;}
 if(b.dataset.timer){await timerAction(b.dataset.timer,b.dataset.side);return;}
 if(b.dataset.handoff){await handoffAction(b.dataset.handoff);return;}
 if(b.dataset.confirmId&&[...feedingKinds,...sleepKinds].includes(b.dataset.confirmCategory)){
  const entry=data.records.find(x=>x.id===b.dataset.confirmId),kind=b.dataset.confirmCategory;if(!entry)return;
  if(await sharedChange(()=>shared.confirm({id:entry.id,category:kind}))){
   if(entry.heard&&kind!=='기타'&&shared.aliases?.[entry.heard]===kind)message(`저장했어요. 앞으로 ‘${entry.heard}’는 ${kind}로 기억할게요.`);
   render();
  }
  return;
 }
 if(b.dataset.writeback){
  const entry=data.records.find(x=>x.id===b.dataset.writeback);if(!entry)return;
  const kind=['분유','모유','혼합'].includes(entry.category)?entry.category:'수유';
  if(!confirm(`기본 캘린더의 원래 일정 제목을 ‘${kind} ${entry.amount}’로 바꿀까요?\n원래 제목은 일정 설명에 남고, 시각은 바꾸지 않아요.`))return;
  let next;
  if(await sharedChange(async()=>{next=await shared.calendarWriteback(entry.id);return next.data;})){message(`캘린더 반영을 요청했어요. Google 캘린더에는 30초쯤 뒤 ‘${next.title}’로 바뀌고, 휴대폰 캘린더 앱에는 동기화되는 몇 분 뒤 보여요.`);render();}
  return;
 }
 if(b.dataset.forget){
  if(confirm(`‘${b.dataset.forget}’를 기억에서 지울까요? 이미 저장한 기록은 바뀌지 않아요.`)&&await sharedChange(()=>shared.confirm({forget:b.dataset.forget})))render();
  return;
 }
 if(b.dataset.reviewKey){
  const entry=reviewItems().find(x=>x.key===b.dataset.reviewKey);if(!entry)return;
  if(b.dataset.reviewAction==='save'&&entry.suggest?.type==='sleep'){openForm('sleep',null,{category:entry.suggest.category||'낮잠',date:entry.when||'',memo:entry.title?'음성 원문: '+entry.title:''},entry.key);return;}
  if(b.dataset.reviewAction==='save'){openForm('feeding',null,{category:entry.suggest?.category||'기타',amount:entry.suggest?.amount||'',date:entry.when||'',memo:entry.title?'음성 원문: '+entry.title:''},entry.key);return;}
  if(b.dataset.reviewAction==='dismiss'&&confirm(entry.status==='웹 기록 유지'?'지금 기록을 그대로 두고 목록에서 뺄까요?':'이 입력을 기록하지 않고 목록에서 뺄까요?\nGoogle의 원본은 그대로 남아요.')){if(await sharedChange(()=>shared.resolveReview(entry.key,'dismiss')))render();}
  return;
 }
 if(b.dataset.action){
  const {action,key,id}=b.dataset,x=data[key].find(i=>i.id===id);if(!x)return;
  if(action==='edit')openForm(key==='records'?x.type:key,x);
  if(action==='delete'&&confirm('이 항목을 삭제할까요?')){if(await changeItem(key,x,true))render();}
  if(action==='toggle'){const bought=x.done!=='yes';if(await changeItem(key,bought?{...x,done:'yes',boughtAt:boughtWith(x)}:{...x,done:'no'})){render();if(bought)await stockBought(x);}}
 }
});
$('#close').onclick=$('#cancel').onclick=()=>{if(!busy)$('#dialog').close();};
$('#delete-item').onclick=async()=>{
 if(busy||!editing)return;
 const k=['feeding','hospital','sleep','diaper'].includes(kind)?'records':kind;
 if(confirm('이 항목을 삭제할까요?')&&await changeItem(k,editing,true)){$('#dialog').close();render();}
};
$('#dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('#form').onsubmit=async e=>{
 e.preventDefault();if(busy)return;
 const k=['feeding','hospital','sleep','diaper'].includes(kind)?'records':kind;
 const x={...(editing||{}),...Object.fromEntries(new FormData(e.target)),id:editing?.id||draftId};
 if(k==='records'){x.type=kind;delete x.confirm;}if(k==='shopping'&&!x.done)x.done='no';
 for(const field of schemas[kind])x[field[0]]=String(x[field[0]]||'').trim();
 if(kind==='feeding'&&units[x.category]&&/^\d+(\.\d+)?$/.test(x.amount))x.amount+=units[x.category][0];
 if(schemas[kind].some(([name,,,required])=>required&&!x[name])){alert('필수 항목을 입력해 주세요.');return;}
 if(x.url&&!link(x.url)){alert('http 또는 https 상품 링크를 입력해 주세요.');return;}
 if(kind==='feeding'&&!Somhouse.hasFeedingUnit(x.amount)&&!confirm('양에 단위가 없어요. 120ml이나 15분처럼 단위를 붙이면 통계와 빠른 기록에 쓰여요.\n이대로 저장할까요?'))return;
 const submit=$('#form button[type="submit"]');submit.disabled=true;
 const review=reviewKey,remembered=JSON.stringify(shared.aliases||{}),asleep=kind==='feeding'?openSleep(x.date):null;
 try{if(await (review?sharedChange(()=>shared.resolveReview(review,'save',k,x)):changeItem(k,x))){$('#dialog').close();const word=Object.keys(shared.aliases||{}).find(w=>shared.aliases[w]===x.category&&JSON.parse(remembered)[w]!==x.category);if(word)message(`저장했어요. 앞으로 ‘${word}’는 ${x.category}로 기억할게요.`);const woke=asleep&&data.records.find(r=>r.id===asleep.id&&r.end);if(woke)message(`수유를 기록해서 ${woke.category}을 ${woke.end.slice(11)}에 끝냈어요 (${Somhouse.duration(Somhouse.sleepMinutes(woke))}).`);render();}}finally{submit.disabled=false;}
};
// One tap saves at once; a toast offers undo (which also reopens a sleep the feeding ended) and edit.
let toastTimer=null,toastActions=[];
function showToast(text,actions=[]){
 const el=$('#toast');if(!el)return;
 toastActions=actions;clearTimeout(toastTimer);
 el.innerHTML=`<span>${esc(text)}</span>${actions.map((a,i)=>`<button type="button" class="plain small" data-toast="${i}">${esc(a.label)}</button>`).join('')}`;
 el.hidden=false;toastTimer=setTimeout(()=>{el.hidden=true;toastActions=[];},8000);
}
function hideToast(){const el=$('#toast');if(el)el.hidden=true;toastActions=[];clearTimeout(toastTimer);}
function undoActions(record,woke){
 return [{label:'되돌리기',run:async()=>{
   if(!await changeItem('records',record,true))return;
   if(woke){const back=data.records.find(r=>r.id===woke.id);if(back)await changeItem('records',{...back,end:''});}
   message('되돌렸어요.');render();
  }},{label:'수정',run:()=>{const x=data.records.find(r=>r.id===record.id);if(x)openForm(x.type,x);}}];
}
async function quickSave(record,label){
 const asleep=record.type==='feeding'?openSleep(record.date):null;
 if(!await changeItem('records',record))return;
 const woke=asleep&&data.records.find(r=>r.id===asleep.id&&r.end);
 render();
 showToast(`${record.date.slice(11)} ${label} 저장했어요${woke?` · ${woke.category} 끝냄`:''}`,undoActions(record,woke));
}
async function timerAction(action,side){
 if(action==='cancel'&&!confirm('직수 타이머를 기록 없이 취소할까요?'))return;
 const asleep=action==='finish'?openSleep(Somhouse.localDateTime()):null;
 let saved=null,wokeAtStart=null;
 if(!await sharedChange(async()=>{const r=await shared.timer(action,side);saved=r.saved||null;wokeAtStart=r.woke||null;return r.data;}))return;
 render();
 if(saved){
  const woke=asleep&&data.records.find(r=>r.id===asleep.id&&r.end);
  showToast(`🤱 직수 ${saved.amount} 저장했어요${saved.memo.includes('·')?` (${saved.memo.split('· ').slice(1).join('· ')})`:''}`,undoActions(saved,woke));
 }else if(action==='start'){
  const slept=wokeAtStart&&data.records.find(r=>r.id===wokeAtStart.id);
  message(`${side==='우'?'오른쪽':'왼쪽'}부터 직수 타이머를 시작했어요.${slept?` ${slept.category}은 ${slept.end.slice(11)}에 끝냈어요(취소하면 다시 이어져요).`:''} 다른 휴대폰에서도 보이고 이어서 끝낼 수 있어요.`);
 }
}
async function handoffAction(action){
 const current=shared?.settings?.handoff?.text||'';
 const text=action==='clear'?'':prompt('다음 보호자에게 남길 한 줄 (200자까지)',current);
 if(text===null||(action==='clear'&&!confirm('전달 메모를 지울까요?')))return;
 if(await sharedChange(async()=>(await shared.handoff(text)).data)){message(text.trim()?'전달 메모를 남겼어요.':'전달 메모를 지웠어요.');render();}
}
// Home-screen shortcuts (manifest.webmanifest) open ./?quick=…: a diaper, the latest feeding again, or the timer.
let quickPending=new URLSearchParams(location.search).get('quick')||'';
async function runQuick(){
 if(!quickPending||!sharedReady||busy||shared?.readOnly)return;
 const q=quickPending;quickPending='';
 try{history.replaceState(null,'',location.pathname+location.hash);}catch{}
 const diaper={pee:'소변',poo:'대변',both:'둘 다'}[q];
 if(diaper)return quickSave({id:newId(),type:'diaper',date:Somhouse.localDateTime(),category:diaper,memo:''},`${diaperIcons[diaper]} 기저귀 ${diaper}`);
 if(q==='repeat'){const r=Somhouse.recentFeedings(data.records,1)[0];if(r)return quickSave({id:newId(),type:'feeding',date:Somhouse.localDateTime(),category:r.category,amount:r.amount,memo:''},`🍼 ${r.category} ${r.amount}`);return openForm('feeding');}
 if(q==='timer'&&!timerState())return timerAction('start','좌');
}
// Family management: members, addresses registered in advance, and a 7-day invite link.
const INVITE='somhouse-invite';
let familyInfo=null, familyLink='';
function savedInvite(){try{return sessionStorage.getItem(INVITE)||'';}catch{return '';}}
function forgetInvite(){try{sessionStorage.removeItem(INVITE);}catch{}}
// An invite link opens the app with #invite=<code>; keep the code until the Google sign-in uses it.
function takeInvite(){
 const code=new URLSearchParams(location.hash.slice(1)).get('invite');
 if(!code)return false;
 try{sessionStorage.setItem(INVITE,code.slice(0,100));}catch{}
 try{history.replaceState(null,'',location.pathname+location.search);}catch{}
 message(shared?.token?'가족 초대 링크예요. 이 가족에 들어가려면 로그아웃한 뒤 ‘Google로 로그인’을 눌러 주세요.':'가족 초대 링크예요. ‘Google로 로그인’을 누르면 초대한 가족과 같은 기록을 보게 돼요.');
 return true;
}
function familyView(){
 const f=familyInfo;
 if(!f){$('#family-body').innerHTML='<p>불러오고 있어요…</p>';return;}
 $('#family-title').textContent='가족 관리 · '+(f.name||'우리 가족');
 const members=f.members.map(m=>`<li><span>${esc(m.email)}${m.you?' <span class="badge">나</span>':''}${m.anchor?' <span class="badge">연결 계정</span>':''}</span>${m.anchor?'':`<button type="button" class="secondary" data-family-remove="${esc(m.email)}">${m.you?'나가기':'내보내기'}</button>`}</li>`).join('');
 const emails=f.emails.map(e=>`<li><span>${esc(e)} <span class="badge">로그인 대기</span></span><button type="button" class="secondary" data-family-unregister="${esc(e)}">취소</button></li>`).join('');
 const link=familyLink?`<div class="invite-link"><input readonly value="${esc(familyLink)}" aria-label="초대 링크"><button type="button" data-family-share="1">${navigator.share?'공유':'복사'}</button></div>`:'';
 $('#family-body').innerHTML=`<p class="caption">같은 가족은 같은 기록을 봐요. 다른 가족의 기록은 서로 보이지 않아요.</p>${f.home?'':googleSection(f.google||{})}
  <h3>구성원</h3><ul>${members||'<li>아직 없어요</li>'}</ul>
  <h3>이메일로 미리 등록</h3><p class="caption">등록한 Google 계정으로 로그인하면 바로 이 가족이 돼요.</p>
  ${emails?`<ul>${emails}</ul>`:''}<form id="family-email-form"><label class="field" style="flex:1;margin:0">Google 계정 이메일<input name="email" type="email" required maxlength="254" placeholder="name@gmail.com" autocomplete="off"></label><button type="submit">등록</button></form>
  <h3>초대 링크</h3><p class="caption">${f.invite?`초대 링크가 켜져 있어요 (${esc(f.invite.expires.replace('T',' '))}까지). 링크를 연 사람은 Google로 로그인하면 이 가족이 돼요.`:'링크를 받은 사람은 Google로 로그인하면 이 가족이 돼요. 7일 동안 쓸 수 있어요.'}</p>
  <div class="actions" style="justify-content:flex-start;margin-top:8px"><button type="button" class="secondary" data-family-invite="1">${f.invite?'새 링크 만들기':'초대 링크 만들기'}</button>${f.invite?'<button type="button" class="plain" data-family-stop="1">링크 끄기</button>':''}</div>${link}
  <p class="caption">앱을 정식 게시하기 전에는 새 Google 계정을 관리자가 Google Cloud 테스트 사용자로 추가해야 로그인할 수 있어요.</p>`;
}
// Another family connects its own Google account: its Tasks list, source sheet and feeding calendar are made there.
function googleSection(g){
 if(g.connected)return `<h3>Google 연동</h3><p class="caption">🟢 ${esc(g.email||'이 가족의 Google 계정')}에 연결돼 있어요. 그 계정의 음성 입력을 가져오고, 웹 기록을 그 계정의 원본 시트·Tasks${g.calendar?'·수유 캘린더':''}에 남겨요.${g.calendar?'':' 수유 캘린더도 쓰려면 다시 연결하면서 캘린더 권한에 체크해 주세요.'} 원본 시트·Tasks 목록·수유 캘린더를 지웠다면 다시 연결할 때 새로 만들고 기록을 다시 보내요.</p><div class="actions" style="justify-content:flex-start;margin-top:8px"><button type="button" class="secondary" data-family-google="1">다시 연결</button></div>`;
 return `<h3>Google 연동</h3><p class="caption">연결하기 전에는 웹 기록만 저장돼요. 이 가족이 네스트·휴대폰에서 쓰는 Google 계정으로 연결하면 그 계정에 ‘솜하우스 원본 기록’ 시트, ‘솜하우스 웹 기록’ Tasks 목록, 수유 캘린더를 만들고 그 계정의 음성 입력을 가져와요. 승인 화면에서 모든 권한에 체크해 주세요.</p><div class="actions" style="justify-content:flex-start;margin-top:8px"><button type="button" data-family-google="1">Google 연결하기</button></div>`;
}
async function familyChange(body,done){
 if(busy)return;busy=true;$('#family-status').textContent='저장하고 있어요…';
 try{
  const result=await shared.familyChange(body);
  if(result.signed_out){$('#family-dialog').close();showLogin('가족에서 나갔어요. 다시 로그인하면 새 가족으로 시작해요.');return;}
  if(result.code)familyLink=location.origin+location.pathname+'#invite='+encodeURIComponent(result.code);
  familyInfo=result;familyView();$('#family-status').textContent=done;
 }catch(error){if(error.status===401){$('#family-dialog').close();showLogin(error.message);}else $('#family-status').textContent=error.message;}
 finally{busy=false;connectionView();}
}
window.addEventListener('hashchange',()=>{if(!takeInvite())route();});
takeInvite();
route();
if(shared?.base){
 if(window.SOMHOUSE_LOCAL_TRIAL===true&&!shared.token)$('#password-login').open=true;
 $('#ai-form').onsubmit=askAI;$('#ai-clear').onclick=clearAILog;$('#ai-follow').onchange=e=>setAIFollow(e.target.checked);
 const aiBox=$('#ai-providers');
 aiBox.onchange=e=>{const t=e.target;if(t?.name==='provider')pickAI(t.value);else if(t?.dataset?.aiModel)chooseAIModel(t.dataset.aiModel,t.value);};
 aiBox.onclick=e=>{const b=e.target?.closest?.('button');if(b?.dataset.plan)return planAction(b.dataset.plan);if(b?.dataset.aiConnect)connectAIKey(b.dataset.aiConnect);else if(b?.dataset.aiDisconnect)disconnectAIKey(b.dataset.aiDisconnect);};
 // Enter in a key field connects that key instead of sending the question form.
 aiBox.onkeydown=e=>{if(e.key==='Enter'&&e.target?.id?.startsWith('ai-key-')){e.preventDefault();connectAIKey(e.target.id.slice(7));}};
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
   const account=aiAccount();
   const result=await shared.logout();
   saveAILog(account,[]);
   showLogin(result?.chatgptRevoked===false?'로그아웃했어요. ChatGPT 설정에서 앱 권한 해제도 확인해 주세요.':'로그아웃했어요. 가족 계정으로 다시 로그인할 수 있어요.');
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
 $('#dialog').addEventListener('close',()=>{reviewKey='';refreshShared();});
 setInterval(()=>{if(!document.hidden)refreshShared();},2000);
 setInterval(()=>{if(!document.hidden&&page==='home'&&mode==='shared'&&sharedReady&&!editingScreen())render();},60000);
 // The running timer ticks every second without re-rendering the page.
 setInterval(()=>{const t=page==='home'&&timerState();if(!t)return;const total=document.querySelector('[data-timer-clock="total"]'),sides=document.querySelector('[data-timer-clock="sides"]');if(total)total.textContent=clock(t.total);if(sides)sides.textContent=`좌 ${clock(t.sides.좌)} · 우 ${clock(t.sides.우)}`;},1000);
 $('#manage-family').onclick=async()=>{
  if(busy||!shared.token)return;
  familyInfo=null;familyLink='';$('#family-status').textContent='';familyView();$('#family-dialog').showModal();
  try{familyInfo=await shared.familyView();familyView();}
  catch(error){if(error.status===401){$('#family-dialog').close();showLogin(error.message);}else $('#family-status').textContent=error.message;}
 };
 $('#close-family').onclick=()=>{if(!busy)$('#family-dialog').close();};
 $('#family-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('#family-dialog').addEventListener('close',()=>refreshShared());
 $('#family-body').addEventListener('submit',e=>{
  if(e.target.id!=='family-email-form')return;
  e.preventDefault();
  const email=String(new FormData(e.target).get('email')).trim();
  familyChange({action:'add_email',email},`${email}을 등록했어요. 이 계정으로 Google 로그인하면 같은 기록을 봐요.`);
 });
 $('#family-body').addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||busy)return;
  if(b.dataset.familyRemove){
   const you=familyInfo?.members.find(m=>m.email===b.dataset.familyRemove)?.you;
   if(!confirm(you?'이 가족에서 나갈까요? 이 기기는 로그아웃돼요.':`${b.dataset.familyRemove}을 가족에서 내보낼까요? 그 계정은 바로 로그아웃돼요.`))return;
   familyChange({action:'remove_member',email:b.dataset.familyRemove},'가족 구성원을 바꿨어요.');
  }else if(b.dataset.familyUnregister)familyChange({action:'remove_email',email:b.dataset.familyUnregister},'등록을 취소했어요.');
  else if(b.dataset.familyInvite)familyChange({action:'invite'},'초대 링크를 만들었어요. 이전 링크는 더 이상 쓸 수 없어요.');
  else if(b.dataset.familyGoogle){
   busy=true;$('#family-status').textContent='Google로 이동하고 있어요…';
   try{location.href=await shared.googleStart('connect',location.origin+location.pathname);}
   catch(error){$('#family-status').textContent=error.message;busy=false;}
  }
  else if(b.dataset.familyStop){familyLink='';familyChange({action:'stop_invite'},'초대 링크를 껐어요.');}
  else if(b.dataset.familyShare){
   try{
    if(navigator.share)await navigator.share({title:'솜하우스 가족 초대',text:'솜하우스에서 같은 가족 기록을 함께 봐요. 링크를 열고 Google로 로그인해 주세요.',url:familyLink});
    else{await navigator.clipboard.writeText(familyLink);$('#family-status').textContent='초대 링크를 복사했어요.';}
   }catch(error){if(error?.name!=='AbortError')$('#family-status').textContent='링크를 길게 눌러 직접 복사해 주세요.';}
  }
 });
 $('#google-login').onclick=async()=>{
  if(busy)return;busy=true;connectionView();message('Google로 이동하고 있어요…');
  try{location.href=await shared.googleStart('login',location.origin+location.pathname,savedInvite());}catch(error){message(error.message);busy=false;connectionView();}
 };
 // Coming back from Google: #google=<one-time code>, #google-error=<message> or #google-connected=1.
 const returned=new URLSearchParams(location.hash.slice(1));
 const clearHash=()=>{try{history.replaceState(null,'',location.pathname+location.search);}catch{}};
 if(returned.has('chatgpt')||returned.has('chatgpt-error')){
  const state=ai;
  try{history.replaceState(null,'',location.pathname+location.search+'#ai');}catch{}
  page='ai';
  if(mode==='shared'){
   busy=true;connectionView();
   (async()=>{
    try{
     if(returned.has('chatgpt-error'))throw Error(returned.get('chatgpt-error')==='cancelled'?'ChatGPT 연결을 취소했어요.':'ChatGPT 연결을 다시 시작해 주세요.');
     await shared.request('/api/chatgpt/finish','POST',{receipt:returned.get('chatgpt')});
     state.planConnected=true;state.planNotice='내 ChatGPT 구독을 연결했어요. 질문을 입력해 주세요.';
    }catch(error){state.planNotice=error.message;}
    finally{busy=false;connectionView();}
    if(ai===state)await refreshShared(true);
   })();
  }else message('ChatGPT 연결을 시작한 솜하우스 계정으로 다시 로그인해 주세요.');
 }else if(returned.has('google')){
  clearHash();forgetInvite();busy=true;connectionView();message('Google 계정으로 로그인하고 있어요…');
  (async()=>{
   try{
    const outcome=await shared.googleLogin(returned.get('google'));mode='shared';sharedReady=false;data=empty();migratedRaw=undefined;render();
    const name=shared.family.name||'가족';
    if(outcome==='created')accountMessage(`새 가족(${name})을 만들었어요. 다른 가족은 이 기록을 볼 수 없어요. 함께 볼 가족은 위의 ‘가족 관리’에서 초대해 주세요.`);
    else if(outcome==='joined'||outcome==='moved')accountMessage(`${name}에 들어왔어요. 이제 같은 기록을 함께 봐요.`);
   }
   catch(error){message(error.message);}finally{busy=false;connectionView();}
   if(mode==='shared')await refreshShared(true);
  })();
 }else{
  if(returned.has('google-error')){clearHash();forgetInvite();message(returned.get('google-error'));}
  if(returned.has('google-connected')){
   const first=returned.get('google-connected');clearHash();
   const names={sheet:'원본 시트',tasks:'Tasks 목록',calendar:'수유 캘린더'},made=first.split(',').filter(x=>names[x]);
   accountMessage(first==='new'?'Google을 연결했어요. 원본 시트·Tasks 목록·수유 캘린더를 만들었고, 이 계정의 음성 입력을 가져오기 시작해요. 연결 전에 저장한 기록도 함께 보내요.':first==='new-no-calendar'?'Google을 연결했어요. 캘린더 권한이 없어 원본 시트와 Tasks만 써요. 캘린더도 쓰려면 가족 관리에서 다시 연결하고 캘린더 권한에 체크해 주세요.':made.length?`Google을 다시 연결하고 ${made.map(x=>names[x]).join('·')}을 새로 만들었어요. 기록을 그쪽으로 다시 보내고 있어요.`:'Google을 다시 연결했어요. 멈춰 있던 전송을 이어서 진행해요.');
  }
  if(mode==='shared'){if(!returned.has('google-error'))message('가족의 기록을 불러오고 있어요…');refreshShared(true);}
 }
}else if(window.SOMHOUSE_LOCAL_TRIAL===true){
 $('#connection-title').textContent='Mac에서 시험판 열기';
 message('지금 화면에서는 시험 계정으로 로그인할 수 없어요. 미리보기를 닫고 시험판을 실행한 Mac의 Safari에서 열어 주세요. 휴대폰으로 Mac 화면을 원격 조작해도 돼요.');
}else message('솜하우스 서버 주소를 확인할 수 없어요. 솜하우스를 원래 주소에서 다시 열어 주세요.');
