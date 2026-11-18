'use strict';
const KEY='somhouse-v1', READ_ONLY='게스트 계정은 볼 수만 있어요. 추가·수정·삭제는 가족 계정에서 할 수 있어요.', empty=()=>({records:[],schedule:[],shopping:[]});
let data=empty(), page='home', editing=null, kind='', draftId='';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function valid(d){
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const fields=(x,required)=>object(x)&&Object.values(x).every(v=>typeof v==='string')&&required.every(k=>typeof x[k]==='string'&&x[k].length>0);
  if(!object(d)||!['records','schedule','shopping'].every(k=>Array.isArray(d[k])))return false;
  const need={feeding:['category','amount'],sleep:['category'],hospital:['hospital','reason']};
  return d.records.every(x=>Object.hasOwn(need,x?.type)&&fields(x,['id','type','date',...need[x.type]]))
    &&d.schedule.every(x=>fields(x,['id','date','title']))
    &&d.shopping.every(x=>fields(x,['id','title','quantity'])&&(x.done===undefined||['yes','no'].includes(x.done)));
}
// The old device key is read only, and is automatically merged after login.
const shared=window.SomhouseShared?new window.SomhouseShared.Client():null;
let mode=shared?.token?'shared':'login', sharedReady=false, busy=false, refreshing=false, refreshTask=null, migratedRaw, legacyWarning='', needsRender=false;
let ai={config:null,checking:false,pending:false}, googleStatusHtml='', dashboardHtml='';
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
 $('#connection-title').textContent=connected?(shared.readOnly?'게스트 보기 · 예시 기록':'가족 기록 · '+shared.username):'가족 로그인';
 $('#login-form').hidden=connected;$('#logout').hidden=!connected;$('#change-password').hidden=!connected||shared.readOnly;
 $('nav').hidden=!connected||!sharedReady;
 showSources(connected);
 showGoogleStatus(connected);
 document.querySelectorAll('#connection button, #connection input').forEach(el=>el.disabled=busy);
 document.querySelectorAll('#password-form button, #password-form input').forEach(el=>el.disabled=busy);
 document.querySelectorAll('#content button[data-add], #content button[data-action]').forEach(el=>el.disabled=busy||!sharedReady);
 $('#ai-fields').disabled=!connected||busy||!ai.config?.enabled||ai.checking||ai.pending;
}
function showGoogleStatus(connected){
 const element=$('#google-status'), status=connected&&sharedReady?shared.googleStatus:null;
 element.hidden=!status;
 if(!status){element.innerHTML='';googleStatusHtml='';return;}
 const services={sheets:'원본 시트',tasks:'Tasks 사본',calendar:'수유 캘린더',shopping:'장보기'};
 const rows=Object.entries(status.services||{}).map(([key,value])=>`<li>${esc(services[key]||key)}: 미전송 ${esc(value.pending)}건 · 재시도 ${esc(value.retrying)}건 · 실패 ${esc(value.failed)}건 · 마지막 전송 ${esc(value.last_success?.replace('T',' ')||'없음')}</li>`).join('');
 const warning=status.auth_state==='reconnect_required'?'Google 재연결이 필요해요. 외부 전송을 멈췄어요. 관리자에게 알려주세요.':status.auth_state==='configuration_error'?'Google 연결 설정을 읽지 못했어요. 관리자에게 알려주세요.':'Google 연동 상태';
 const values=Object.values(status.services||{});
 const waiting=values.reduce((sum,x)=>sum+(Number(x.pending)||0)+(Number(x.retrying)||0),0);
 const failed=values.reduce((sum,x)=>sum+(Number(x.failed)||0),0);
 const latest=values.map(x=>x.last_success||'').sort().at(-1)||'';
 const healthy=status.auth_state==='ready'&&!failed&&!status.review&&!status.errors?.length;
 // Healthy: one line, details folded. Any problem keeps the full list visible.
 const headline=healthy?`<strong>Google 연동 정상</strong> · ${waiting?`전송 대기 ${esc(waiting)}건`:'모두 반영됨'}${latest?` · 마지막 전송 ${esc(latest.replace('T',' ').slice(0,16))}`:''}`:`<strong>${warning}</strong>`;
 const list=healthy?`<details><summary>자세히 보기</summary><ul>${rows}</ul></details>`:`<ul>${rows}</ul>`;
 const html=`${headline}${list}${status.errors?.length?'<p>일부 연동을 확인하지 못했어요. 잠시 후 다시 시도합니다.</p>':''}${status.review?`<p>음성·캘린더 입력 ${esc(status.review)}건은 확인이 필요해요. 웹에서 바로 고쳐 저장하거나 뺄 수 있어요.</p><button type="button" class="secondary" data-page="review">확인 필요 ${esc(status.review)}건 정리하기</button>`:''}<p class="caption">웹 기록은 맥미니에 저장됩니다. 음성으로 만든 원본 Task·일정은 웹에서 수정하거나 삭제해도 바뀌지 않아요. 수정 이력은 원본 시트에 남습니다.</p>`;
 // Rewriting on every poll would close an opened <details>; the browser adds `open` to innerHTML, so compare our own copy.
 if(googleStatusHtml!==html){element.innerHTML=html;googleStatusHtml=html;}
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
 // The guest sees made-up records only; this device's old family records are never sent with a guest login.
 if(shared.readOnly)return shared.load();
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
   const reviewBefore=JSON.stringify(reviewItems());
   const next=await loadFamilyData();
   if(shared.token!==token)return;
   if(!valid(next))throw Error('기록을 확인하지 못했어요. 다시 연결하고 있습니다.');
   const changed=JSON.stringify(next)!==JSON.stringify(data)||(page==='review'&&JSON.stringify(reviewItems())!==reviewBefore),wasReady=sharedReady;
   data=next;sharedReady=true;if(changed)needsRender=true;
   message(shared.readOnly?'게스트 보기예요. 실제 가족 기록이 아닌 예시 기록이에요. 입력창은 열어 볼 수 있지만 저장·수정·삭제는 되지 않아요.':'기록은 자동으로 저장되고 가족과 함께 업데이트돼요.'+legacyWarning);
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
const schemas={sleep:[['date','잠든 시각','datetime-local',1],['end','깬 시각 (선택)','datetime-local',0],['category','종류','select',1],['memo','메모','textarea',0]],feeding:[['date','날짜와 시간','datetime-local',1],['category','수유 종류','select',1],['amount','양 또는 시간','text',1],['memo','메모','textarea',0]],hospital:[['date','날짜와 시간','datetime-local',1],['hospital','병원','text',1],['reason','방문 이유','text',1],['memo','메모','textarea',0]],schedule:[['date','날짜와 시간','datetime-local',1],['who','누구 일정','select',0],['title','일정 이름','text',1],['memo','메모','textarea',0]],shopping:[['title','품목','text',1],['quantity','수량','text',1],['date','구매 예정일 (선택)','date',0],['memo','메모','textarea',0],['url','상품 링크 (선택)','url',0]]};
const choices={category:['모유','분유','혼합','기타'],'sleep.category':['낮잠','밤잠'],who:['가족','엄마','아빠','아기']};
function link(url){try{let u=new URL(url);return ['http:','https:'].includes(u.protocol)?`<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">상품 링크 ↗</a>`:''}catch{return ''}}
function sleepText(x){const m=Somhouse.sleepMinutes(x);return `${x.date.slice(11)}${x.end?`~${x.end.slice(x.end.slice(0,10)===x.date.slice(0,10)?11:5).replace('T',' ')}`:''}${m!==null?` (${Somhouse.duration(m)})`:' · 깬 시각 미입력'}`;}
function desc(x,k){if(k==='records'&&x.type==='sleep')return `수면 · ${esc(x.category)} · ${esc(sleepText(x))}`;if(k==='records')return x.type==='feeding'?`수유 · ${esc(x.category)} · ${esc(x.amount)}`:`병원 · ${esc(x.hospital)} · ${esc(x.reason)}`;return (k==='schedule'&&x.who?`<span class="who who-${esc(x.who)}">${esc(x.who)}</span> `:'')+esc(x.title)+(k==='shopping'?` · ${esc(x.quantity)}`:'')}
function item(x,k,compact=false){return `<div class="item"><strong>${desc(x,k)}</strong> ${k==='shopping'?`<span class="badge">${x.done==='yes'?'구매 완료':'구매 예정'}</span>`:''}${x.confirm==='category'?'<span class="badge warn">종류 확인 필요</span>':''}<p>${esc((x.date||'').replace('T',' '))}${x.memo?'<br>'+esc(x.memo):''}</p>${x.url?link(x.url):''}${compact?'':`<div class="actions">${k==='shopping'?`<button class="secondary" data-action="toggle" data-key="${k}" data-id="${esc(x.id)}">${x.done==='yes'?'다시 예정으로':'완료로 변경'}</button>`:''}<button class="secondary" data-action="edit" data-key="${k}" data-id="${esc(x.id)}">수정</button><button class="secondary" data-action="delete" data-key="${k}" data-id="${esc(x.id)}">삭제</button></div>`}</div>`}
// A mirrored Google Calendar event: read-only, opened in Google to edit.
function googleItem(x){
 const when=x.allDay?`${x.date} 종일`:x.date.replace('T',' ');
 const open=/^https:\/\/www\.google\.com\/calendar\//.test(x.link||'')?`<a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">Google에서 열기 ↗</a>`:'';
 return `<div class="item"><strong>${esc(x.title)}</strong> <span class="badge gcal">📆 Google</span><p>${esc(when)}</p>${open}</div>`;
}
function sorted(k){return [...data[k]].sort((a,b)=>(b.date||b.id).localeCompare(a.date||a.id))}
const pageTitles={home:'홈',records:'육아 기록',stats:'수유 통계',schedule:'일정',shopping:'구매 목록',ai:'AI 대화',review:'확인 필요'};
let reviewKey='',schedulePastOpen=false;
function reviewItems(){return Array.isArray(shared?.googleStatus?.review_items)?shared.googleStatus.review_items:[];}
// Inputs that were not saved automatically, or that differ from a web edit. The Google Task or event is never changed here.
function reviewCard(x){
 const conflict=x.status==='웹 기록 유지',guess=[x.suggest?.category&&x.suggest.category!=='기타'?x.suggest.category:'',x.suggest?.amount||''].filter(Boolean).join(' ');
 const why=conflict?'웹에서 고친 기록과 캘린더 일정의 내용이 서로 달라요. 지금 기록은 웹에서 고친 그대로예요.':x.suggest?.amount?'내용을 확실히 알 수 없어 저장하지 않았어요.':'양이 없어서 저장하지 않았어요. 양을 입력해 주세요.';
 const buttons=conflict?['캘린더 내용으로 고치기','지금 기록 그대로 두기']:['내용 확인하고 저장','기록하지 않음'];
 return `<div class="item"><strong>${esc(x.title||'(제목 없음)')}</strong> <span class="badge">${esc(x.source)}</span><p>${esc((x.when||'').replace('T',' ')||'시각 정보 없음')}${guess?` · 추정 ${esc(guess)}`:''}<br>${why}</p><div class="actions"><button data-review-key="${esc(x.key)}" data-review-action="save">${buttons[0]}</button><button class="secondary" data-review-key="${esc(x.key)}" data-review-action="dismiss">${buttons[1]}</button></div></div>`;
}
function reviewView(){
 const cards=reviewItems().map(reviewCard).join('');
 return `<h1>확인 필요</h1><p>음성이나 캘린더로 남겼지만 그대로 저장하지 못한 입력이에요. 첫 번째 버튼을 누르면 종류·양·시각을 고칠 수 있는 입력창이 열려요. Google의 원본 Task·일정은 바뀌지 않고, 처리 이력은 원본 시트에 남아요.</p>${cards||'<div class="card empty">확인할 입력이 없어요.</div>'}<button class="plain" data-page="home">← 홈으로</button>`;
}

const filters={records:{},schedule:{},shopping:{}};
function route(){const name=location.hash.slice(1);page=Object.hasOwn(pageTitles,name)?name:'home';render()}
function quickButtons(){return '<div class="quick"><button class="secondary" data-add="feeding">수유 기록</button><button class="secondary" data-add="sleep">수면</button><button class="secondary" data-add="hospital">병원 방문</button><button class="secondary" data-add="schedule">일정</button><button class="secondary" data-add="shopping">구매 물품</button></div>'}
// Opens a prefilled form only; nothing is saved until the family member taps 저장하기.
const feedingKinds=['분유','모유','혼합','기타'],sleepKinds=['낮잠','밤잠'];
function unconfirmed(){return data.records.filter(x=>['feeding','sleep'].includes(x.type)&&x.confirm==='category').sort((a,b)=>b.date.localeCompare(a.date));}
// Feedings saved from an unclear voice or Calendar input: one tap settles the kind.
function confirmBox(){
 const items=unconfirmed();
 if(!items.length)return '';
 const rows=items.slice(0,5).map(x=>x.type==='sleep'?`<div class="confirm-row"><p><strong>😴 ${esc(x.date.slice(0,10))} ${esc(sleepText(x))}</strong> · 시각으로 추정: ${esc(x.category)}${x.memo?`<br><span class="caption">${esc(x.memo)}</span>`:''}</p><div class="quick">${sleepKinds.map(kind=>`<button class="secondary" data-confirm-id="${esc(x.id)}" data-confirm-category="${kind}">${kind}</button>`).join('')}</div></div>`:`<div class="confirm-row"><p><strong>${esc(x.date.replace('T',' '))} · ${esc(x.amount)}</strong>${x.heard?` · 들린 말 ‘${esc(x.heard)}’`:''}${x.memo?`<br><span class="caption">${esc(x.memo)}</span>`:''}</p><div class="quick">${feedingKinds.map(kind=>`<button class="${kind==='기타'?'plain':'secondary'}" data-confirm-id="${esc(x.id)}" data-confirm-category="${kind}">${kind==='기타'?'기타로 두기':kind}</button>`).join('')}</div></div>`).join('');
 return `<section class="card confirm-box" aria-label="수유 종류 확인"><h2>종류를 골라 주세요 · ${items.length}건</h2><p class="caption">음성이나 캘린더 입력에서 분유·모유 또는 낮잠·밤잠을 구분하지 못한 기록이에요. 이미 저장돼 있고, 종류만 눌러 주시면 돼요.</p>${rows}${items.length>5?`<p class="caption">나머지 ${items.length-5}건은 위 기록을 고르면 이어서 보여요.</p>`:''}</section>`;
}
function aliasList(){
 const entries=Object.entries(shared?.aliases||{});
 if(!entries.length)return '';
 return `<li><strong>기억한 말:</strong> ${entries.map(([word,kind])=>`‘${esc(word)}’→${esc(kind)} <button class="plain" data-forget="${esc(word)}">잊기</button>`).join(' ')}</li>`;
}
// Shown only when the Google Calendar intake is connected. Static text, no user data.
function voiceHelp(){
 if(!calendarLinked(shared?.sources))return '';
 return `<details class="voice-help"><summary>ⓘ 음성·캘린더 입력 도움말 <span class="caption">기억한 말 관리</span></summary><ul><li><strong>말로:</strong> 네스트 허브·휴대폰·태블릿에서 “헤이 구글, 100미리 수유 캘린더에 업데이트”</li><li><strong>수면:</strong> “낮잠 40분”, “밤잠 2시간”처럼 말하거나 적어요. ‘수면’·‘잠’만 있으면 시각으로 낮잠·밤잠을 추정해 홈에서 한 번 확인해요. 길이를 말하지 않으면 캘린더 일정의 끝 시각을 써요.</li><li><strong>직접 입력:</strong> Google 캘린더 앱에서 새 일정 제목에 <strong>수유 100ml</strong>, <strong>분유 120미리</strong>, <strong>모유 15분</strong>처럼 적고 저장</li><li>제목에는 <strong>수유·분유·모유</strong>와 <strong>단위가 붙은 양</strong>(ml·미리·cc, 직수는 분)이 있어야 해요.</li><li>시각은 따로 고치지 않아도 돼요. 일정 시각이 입력한 때부터 2시간 안이거나 종일 일정이면 입력한 시각으로 저장해요. 지난 수유는 일정의 시작 시각을 실제 시각으로 맞춰 주세요.</li><li>같은 Google 계정의 기본 캘린더만 읽고, 약 30초 뒤 여기에 나타나요. 반복 일정과 2시간보다 먼 미래 일정은 저장하지 않아요.</li><li>‘수유 100ml’처럼 종류를 말하지 않았거나 ‘부유’처럼 비슷하게 들린 말은 일단 저장하고, 홈에서 분유·모유를 고르게 해요. 고른 말은 기억해서 다음부터 자동으로 구분해요.</li>${aliasList()}<li>양을 빼고 ‘분유’만 적었거나 알아듣기 어려운 입력은 위쪽 ‘확인 필요’에 모여요. 거기서 양과 종류를 넣어 저장해요.</li></ul></details>`;
}
function repeatButtons(){
 const recent=Somhouse.recentFeedings(data.records);
 if(!recent.length)return '';
 return `<section class="repeat" aria-labelledby="repeat-title"><h2 id="repeat-title">최근 수유 다시 기록</h2><div class="quick">${recent.map(x=>`<button class="secondary" data-repeat-category="${esc(x.category)}" data-repeat-amount="${esc(x.amount)}">${esc(x.category)} ${esc(x.amount)}</button>`).join('')}</div></section>`;
}
// "3시간 5분 전" from two local "YYYY-MM-DDTHH:MM" stamps.
function ago(from,now){
 const minutes=Somhouse.sleepMinutes({date:from,end:now});
 return minutes===null?'방금':minutes<1?'방금':Somhouse.duration(minutes)+' 전';
}
// The first thing a parent needs: when the baby last ate and slept.
// Same rule as the server (sleep_wake.py): the latest sleep without a wake time, started before `at`, within 16 hours.
function openSleep(at=Somhouse.localDateTime(),inclusive=true){
 return data.records.filter(x=>x.type==='sleep'&&!x.end&&x.date&&(inclusive?x.date<=at:x.date<at)&&(Somhouse.sleepMinutes({date:x.date,end:at})??0)<=16*60)
  .sort((a,b)=>b.date.localeCompare(a.date))[0]||null;
}
function newId(){return typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString()+'-'+Math.random().toString(36).slice(2);}
function nowCard(){
 const now=Somhouse.localDateTime(),past=x=>x.date<=now;
 const feed=data.records.filter(x=>x.type==='feeding'&&past(x)).sort((a,b)=>b.date.localeCompare(a.date))[0];
 const sleep=data.records.filter(x=>x.type==='sleep'&&past(x)).sort((a,b)=>b.date.localeCompare(a.date))[0];
 const day=v=>v.slice(0,10)===now.slice(0,10)?v.slice(11):v.slice(5).replace('-','/').replace('T',' ');
 const feedHtml=feed?`<strong>${esc(ago(feed.date,now))}</strong><span>${esc(day(feed.date))} · ${esc(feed.category)} ${esc(feed.amount)}</span>`:'<strong>기록 없음</strong><span>수유를 기록해 보세요</span>';
 let sleepHtml='<strong>기록 없음</strong><span>수면을 기록해 보세요</span>';
 const open=openSleep(now);
 if(open)sleepHtml=`<strong>자는 중 · ${esc(ago(open.date,now).replace(' 전','째'))}</strong><span>${esc(day(open.date))}부터 · ${esc(open.category)}</span>`;
 else if(sleep){const m=Somhouse.sleepMinutes(sleep);sleepHtml=`<strong>${m!==null?esc(Somhouse.duration(m)):'깬 시각 미입력'}</strong><span>${esc(day(sleep.date))}${sleep.end?`~${esc(day(sleep.end))}`:''} · ${esc(sleep.category)}${sleep.end&&sleep.end<=now?` · ${ago(sleep.end,now)==='방금'?'방금 깸':`깬 지 ${esc(ago(sleep.end,now).replace(' 전',''))}`}`:''}</span>`;}
 return `<section class="now-card" aria-label="지금 아기 상태"><div><p>🍼 마지막 수유</p>${feedHtml}</div><div><p>😴 마지막 수면</p>${sleepHtml}${open?`<button class="sleep-toggle wake" data-sleep-end="${esc(open.id)}">☀️ 수면 종료</button>`:'<button class="sleep-toggle" data-sleep-start="1">😴 수면 시작</button>'}</div></section>`;
}
function homeView(){
  const now=Somhouse.localDateTime();
  const upcoming=[...data.schedule.filter(x=>x.date>=now).map(x=>({...x,source:'web'})),...googleEvents().filter(x=>(x.allDay?x.date>=now.slice(0,10):x.date>=now)).map(x=>({...x,source:'google'}))].sort((a,b)=>a.date.localeCompare(b.date));
  return `<h1>우리 가족의 오늘</h1><p class="intro">${esc(now.slice(0,10))} · 작은 순간을 차곡차곡 남겨요.</p>${nowCard()}${quickButtons()}${repeatButtons()}${confirmBox()}
    ${summaryCards()}<p class="caption">용량은 ‘80ml’처럼 단위가 있는 기록만, 직수는 ‘15분’처럼 분으로 적은 기록만 합산해요.</p>${voiceHelp()}
    <div class="grid">${[['최근 육아 기록',sorted('records').slice(0,3),'records','첫 수유나 병원 방문을 기록해보세요.'],['다가오는 일정',upcoming.slice(0,3),'schedule','예정된 일정이 없어요.'],['구매 예정',data.shopping.filter(x=>x.done!=='yes').slice(0,3),'shopping','필요한 물품을 추가해보세요.']].map(([title,items,k,msg])=>`<section class="card"><h2>${title}</h2>${items.length?items.map(x=>x.source==='google'?googleItem(x):item(x,k,true)).join(''):`<p class="empty">${msg}</p>`}<button class="plain" data-page="${k}">전체 보기 →</button></section>`).join('')}</div>`;
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
function summaryCards(){
 return `<div class="summary-cards">${Somhouse.periodSummaries(data.records).map(x=>`<div class="summary-card"><p>${x.label}<span class="caption"> ${esc(x.from.slice(5).replace('-','/'))}${x.from!==x.to?`~${esc(x.to.slice(5).replace('-','/'))}`:''}</span></p><strong>${x.count?esc(totals(x)):x.sleepCount?'':'기록 없음'}</strong>${x.sleepCount?`<span class="sleep-line">${esc(sleepTotals(x))}</span>`:''}</div>`).join('')}</div>`;
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
function statsView(){
 const rows=Somhouse.dailyFeeding(data.records,statsDays);
 const max=Math.max(1,...rows.map(row=>row.volume).filter(Number.isFinite));
 const periods=[7,30].map(days=>`<button data-stats-days="${days}" class="secondary" aria-pressed="${days===statsDays}">${days}일</button>`).join('');
 const table=rows.map(({date,count,volume,measuredCount})=>{
  const recorded=measuredCount>0&&Number.isFinite(volume), percent=recorded?Math.min(100,volume/max*100):0;
  return `<tr><th scope="row"><time datetime="${date}">${date.slice(5)}</time></th><td>${count}회</td><td>${recorded?`${volume.toLocaleString('ko-KR')} ml`:'—'}</td><td aria-hidden="true"><div class="stats-bar"><span style="width:${percent}%"></span></div></td></tr>`;
 }).join('');
 return `<h1>수유 통계</h1>${summaryCards()}<div class="quick stats-period" aria-label="조회 기간">${periods}</div><section class="card"><h2>최근 ${statsDays}일</h2><p class="caption">횟수에는 모든 수유를, 용량에는 ml·cc·밀리리터·미리·씨씨 단위가 있는 기록만 집계해요. 직수 시간과 단위 없는 값은 용량에 합산하지 않아요.</p><table class="stats-table"><thead><tr><th scope="col">날짜</th><th scope="col">수유 횟수</th><th scope="col">합계 용량</th><th scope="col">용량 비교</th></tr></thead><tbody>${table}</tbody></table></section>`;
}
function filterView(k){const f=filters[k];return `<form id="filter-form" class="filters" aria-label="목록 검색"><label>검색<input name="query" type="search" placeholder="메모, 병원, 품목 검색" value="${esc(f.query||'')}"></label>${k==='records'?`<label>기록 종류<select name="type"><option value="">전체</option><option value="feeding" ${f.type==='feeding'?'selected':''}>수유</option><option value="sleep" ${f.type==='sleep'?'selected':''}>수면</option><option value="hospital" ${f.type==='hospital'?'selected':''}>병원</option></select></label>`:''}${k==='shopping'?`<label>구매 상태<select name="status"><option value="">전체</option><option value="pending" ${f.status==='pending'?'selected':''}>구매 예정</option><option value="done" ${f.status==='done'?'selected':''}>구매 완료</option></select></label>`:`<label>시작 날짜<input name="from" type="date" value="${esc(f.from||'')}"></label><label>마지막 날짜<input name="to" type="date" value="${esc(f.to||'')}"></label>`}<button type="submit" class="secondary">검색</button><button type="button" class="plain" data-reset="${k}">초기화</button></form>`}
function listView(k){const names={records:'소중한 하루를 간단히 남겨보세요.',schedule:'병원 예약과 가족 일정을 관리해요.',shopping:'필요한 물품을 정리해요. Google 음성 장보기는 관리자가 상품 규격과 가격 검색을 설정한 경우에만 가격 비교 링크를 남겨요. 구매는 링크에서 직접 진행해 주세요.'};const items=Somhouse.filter(sorted(k),filters[k]);return `<h1>${pageTitles[k]}</h1><p>${names[k]}</p><div class="heading"><h2>${k==='schedule'?'일정':'기록'} ${items.length}개</h2><div class="quick">${k==='records'?'<button data-add="feeding">수유 추가</button><button class="secondary" data-add="hospital">병원 추가</button>':`<button data-add="${k}">추가하기</button>`}</div></div>${filterView(k)}${(k==='schedule'?scheduleItems(items):items.map(x=>item(x,k)).join(''))||`<div class="card empty">${data[k].length?'검색 조건에 맞는 기록이 없어요. 조건을 바꾸거나 초기화해보세요.':'아직 기록이 없어요. 추가 버튼으로 시작해보세요.'}</div>`}`}
function scheduleItems(items){
 const now=Somhouse.localDateTime(),upcoming=items.filter(x=>x.date>=now).reverse(),past=items.filter(x=>x.date<now);
 if(!items.length)return '';
 return `<h3 class="list-head">다가오는 일정 ${upcoming.length}개</h3>${upcoming.map(x=>item(x,'schedule')).join('')||'<p class="empty">다가오는 일정이 없어요.</p>'}${past.length?`<details class="past"${schedulePastOpen?' open':''}><summary>지난 일정 ${past.length}개</summary>${past.map(x=>item(x,'schedule')).join('')}</details>`:''}`;
}
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
  $('#ai-status').textContent=config.readOnly?'게스트 보기에서는 질문할 수 없어요. 가족 계정으로 로그인하면 질문을 보낼 수 있어요.':config.enabled?'질문마다 새로 답해요.':'관리자가 맥미니에 Antigravity CLI를 연결하면 질문할 수 있어요.';
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
 if(!connected){$('#dashboard').hidden=true;$('#dashboard').innerHTML='';dashboardHtml='';}
 if(!connected||showAI){
  $('#content').innerHTML='';connectionView();
  if(openingAI)checkAI();
  return;
 }
 const dashboard=$('#dashboard');
 if(page==='schedule'){const board=calendarView();if(dashboardHtml!==board){dashboard.innerHTML=board;dashboardHtml=board;}dashboard.hidden=false;}
 else{dashboard.hidden=true;if(dashboardHtml){dashboard.innerHTML='';dashboardHtml='';}}
 const past=document.querySelector('details.past');if(past)schedulePastOpen=past.open;
 $('#content').innerHTML=page==='home'?homeView():page==='stats'?statsView():page==='review'?reviewView():listView(page);
 connectionView();
 const form=$('#filter-form');if(form)form.onsubmit=e=>{e.preventDefault();const next=Object.fromEntries(new FormData(form));if(next.from&&next.to&&next.from>next.to){alert('시작 날짜는 마지막 날짜보다 늦을 수 없어요.');return}filters[page]=next;render()};
}
function openForm(type,x,preset={},review=''){reviewKey=review;kind=type;editing=x||null;draftId=x?.id||(typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString()+'-'+Math.random().toString(36).slice(2));const values=x||{...preset,date:preset.date||(type==='shopping'?'':Somhouse.localDateTime())};$('#formtitle').textContent=(review?'확인 필요 정정 · ':x?'수정 · ':'추가 · ')+({feeding:'수유 기록',sleep:'수면 기록',hospital:'병원 방문',schedule:'일정',shopping:'구매 목록'}[type]);$('#fields').innerHTML=schemas[type].map(([name,label,t,required])=>`<label class="field">${label}${required?' *':''}${t==='select'?`<select name="${name}" required>${(choices[type+'.'+name]||choices[name]).map(v=>`<option ${values[name]===v?'selected':''}>${v}</option>`).join('')}</select>`:t==='textarea'?`<textarea name="${name}">${esc(values[name]||'')}</textarea>`:`<input name="${name}" type="${t}" value="${esc(values[name]||'')}" ${required?'required':''}${name==='amount'?' placeholder="예: 120ml 또는 15분"':''}>`}</label>`).join('');$('#dialog').showModal()}
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.page){location.hash=b.dataset.page;if(page===b.dataset.page)render();}
 if(b.dataset.reset){filters[b.dataset.reset]={};render();}
 if(busy||mode!=='shared'||!sharedReady)return;
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
 if(b.dataset.repeatCategory&&b.dataset.repeatAmount){openForm('feeding',null,{category:b.dataset.repeatCategory,amount:b.dataset.repeatAmount});return;}
 if(b.dataset.confirmId&&[...feedingKinds,...sleepKinds].includes(b.dataset.confirmCategory)){
  const entry=data.records.find(x=>x.id===b.dataset.confirmId),kind=b.dataset.confirmCategory;if(!entry)return;
  if(await sharedChange(()=>shared.confirm({id:entry.id,category:kind}))){
   if(entry.heard&&kind!=='기타'&&shared.aliases?.[entry.heard]===kind)message(`저장했어요. 앞으로 ‘${entry.heard}’는 ${kind}로 기억할게요.`);
   render();
  }
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
  if(action==='toggle'){if(await changeItem(key,{...x,done:x.done==='yes'?'no':'yes'}))render();}
 }
});
$('#close').onclick=$('#cancel').onclick=()=>{if(!busy)$('#dialog').close();};
$('#dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('#form').onsubmit=async e=>{
 e.preventDefault();if(busy)return;
 const k=['feeding','hospital','sleep'].includes(kind)?'records':kind;
 const x={...(editing||{}),...Object.fromEntries(new FormData(e.target)),id:editing?.id||draftId};
 if(k==='records'){x.type=kind;delete x.confirm;}if(k==='shopping'&&!x.done)x.done='no';
 for(const field of schemas[kind])x[field[0]]=String(x[field[0]]||'').trim();
 if(schemas[kind].some(([name,,,required])=>required&&!x[name])){alert('필수 항목을 입력해 주세요.');return;}
 if(x.url&&!link(x.url)){alert('http 또는 https 상품 링크를 입력해 주세요.');return;}
 if(kind==='feeding'&&!Somhouse.hasFeedingUnit(x.amount)&&!confirm('양에 단위가 없어요. 120ml이나 15분처럼 단위를 붙이면 통계와 빠른 기록에 쓰여요.\n이대로 저장할까요?'))return;
 const submit=$('#form button[type="submit"]');submit.disabled=true;
 const review=reviewKey,remembered=JSON.stringify(shared.aliases||{}),asleep=kind==='feeding'?openSleep(x.date,false):null;
 try{if(await (review?sharedChange(()=>shared.resolveReview(review,'save',k,x)):changeItem(k,x))){$('#dialog').close();const word=Object.keys(shared.aliases||{}).find(w=>shared.aliases[w]===x.category&&JSON.parse(remembered)[w]!==x.category);if(word)message(`저장했어요. 앞으로 ‘${word}’는 ${x.category}로 기억할게요.`);const woke=asleep&&data.records.find(r=>r.id===asleep.id&&r.end);if(woke)message(`수유를 기록해서 ${woke.category}을 ${woke.end.slice(11)}에 끝냈어요 (${Somhouse.duration(Somhouse.sleepMinutes(woke))}).`);render();}}finally{submit.disabled=false;}
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
 $('#dialog').addEventListener('close',()=>{reviewKey='';refreshShared();});
 setInterval(()=>{if(!document.hidden)refreshShared();},2000);
 setInterval(()=>{if(!document.hidden&&page==='home'&&mode==='shared'&&sharedReady&&!editingScreen())render();},60000);
 if(mode==='shared'){message('가족의 기록을 불러오고 있어요…');refreshShared(true);}
}else message('화면을 불러오지 못했어요. 잠시 후 다시 열어주세요.');
