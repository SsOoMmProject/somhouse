'use strict';
const KEY='somhouse-v1', empty=()=>({records:[],schedule:[],shopping:[]});
let data=empty(), storageBlocked=false, storedRaw=null;
try { const raw=localStorage.getItem(KEY); storedRaw=raw; if(raw!==null){data=JSON.parse(raw); if(!valid(data)) throw Error('invalid data');} }
catch { storageBlocked=true; data=empty(); }
let page='home', editing=null, kind='', draftId='';
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function valid(d){
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const fields=(x,required)=>object(x)&&Object.values(x).every(v=>typeof v==='string')&&required.every(k=>typeof x[k]==='string'&&x[k].length>0);
  if(!object(d)||!['records','schedule','shopping'].every(k=>Array.isArray(d[k])))return false;
  return d.records.every(x=>fields(x,['id','type','date',...(x?.type==='feeding'?['category','amount']:['hospital','reason'])])&&['feeding','hospital'].includes(x.type))
    &&d.schedule.every(x=>fields(x,['id','date','title']))
    &&d.shopping.every(x=>fields(x,['id','title','quantity'])&&(x.done===undefined||['yes','no'].includes(x.done)));
}
function save(next){
  if(storageBlocked){alert('저장된 데이터를 읽을 수 없어 변경이 잠겨 있습니다. 화면의 복구 안내를 확인해 주세요.');return false}
  try{
    if(localStorage.getItem(KEY)!==storedRaw){alert('다른 탭에서 기록이 변경됐습니다. 입력한 내용을 확인하고 새로고침한 뒤 다시 저장해 주세요.');return false}
    const raw=JSON.stringify(next);localStorage.setItem(KEY,raw);storedRaw=raw;data=next;return true
  }
  catch{alert('저장하지 못했습니다. 기존 기록은 유지됩니다. 브라우저 저장 공간과 설정을 확인한 뒤 다시 시도해 주세요.');return false}
}
// Device originals stay in somhouse-v1; shared records never overwrite that key.
const shared=window.SomhouseShared?new window.SomhouseShared.Client():null;
let deviceData=data, mode=shared?.token?'shared':'local', sharedReady=false, busy=false, refreshing=false;
if(mode==='shared')data=empty();
function message(text){if(shared)$('#connection-status').textContent=text;}
function deviceRecordCount(){
 try{const raw=localStorage.getItem(KEY),original=raw===null?empty():JSON.parse(raw);if(!valid(original))return null;return ['records','schedule','shopping'].reduce((n,k)=>n+original[k].length,0);}catch{return null;}
}
function connectionView(){
 if(!shared)return;
 const connected=mode==='shared';
 $('#connection-title').textContent=connected?(shared.token?'가족 공유 · '+shared.username:'가족 공유 · 다시 로그인해 주세요'):'가족 공유 로그인';
 $('#login-form').hidden=connected&&Boolean(shared.token);$('#shared-controls').hidden=!connected;
 $('#storage-title').textContent=connected?'맥미니에 함께 저장해요':'우리 기기에만 저장돼요';
 $('#storage-description').textContent=connected?'두 가족 계정이 같은 기록을 사용해요. 공유 기록은 화면을 다시 열거나 새로고침하면 갱신됩니다. 이 기기의 원본 기록은 별도로 남아 있어요.':'기록은 이 브라우저에만 저장돼요. 가족 공유에 로그인하면 맥미니의 공유 기록을 사용할 수 있어요.';
 $('#migrate-local').disabled=storageBlocked||busy||!sharedReady;
 const count=deviceRecordCount();
 $('#migrate-local').hidden=count===0;$('#export-device').hidden=count===0;
 $('#migrate-local').textContent=count===null?'이 기기 원본 확인 필요':'이 기기 원본 '+count+'개를 공유에 병합';
 $('#migration-help').textContent=count===0?'로그인 후 입력한 기록은 이미 공유 저장돼요. 별도로 옮길 필요 없이 다른 휴대폰에서도 로그인해 확인하세요.':count===null?'기기 원본을 읽지 못했어요. 원본은 변경하지 않았습니다. 복구 안내를 확인해 주세요.':'로그인 후 입력한 기록은 자동으로 공유 저장돼요. 이 기기에 남아 있는 기존 원본만 추가로 병합할 수 있어요. 같은 내용은 건너뛰고 원본은 유지합니다.';
 document.querySelectorAll('#connection button, #connection input').forEach(el=>{if(el.id!=='migrate-local')el.disabled=busy;});
 $('#import').disabled=busy;
 document.querySelectorAll('#content button[data-add], #content button[data-action]').forEach(el=>el.disabled=busy||(connected&&!sharedReady));
}
async function refreshShared(manual=false){
 if(!shared||mode!=='shared'||busy||refreshing)return;
 if(!manual&&$('#dialog').open)return;
 refreshing=true;
 try{const next=await shared.load();if(!valid(next))throw Error('공유 기록 형식이 올바르지 않아요.');data=next;sharedReady=true;message('맥미니 공유 기록을 보고 있어요. · '+new Date().toLocaleTimeString('ko-KR'));render();}
 catch(error){message(error.message);if(error.status===401){shared.clear();sharedReady=false;connectionView();}}
 finally{refreshing=false;}
}
async function sharedChange(operation){
 if(busy||refreshing){message('저장 또는 새로고침이 끝난 뒤 다시 시도해 주세요.');return false;}
 if(!sharedReady){message('공유 기록을 먼저 불러와 주세요.');return false;}
 busy=true;connectionView();
 try{const next=await operation();if(!valid(next))throw Error('저장 결과를 확인하지 못했어요. 새로고침해 주세요.');data=next;message('공유 저장 완료. 다른 휴대폰에서도 로그인하면 볼 수 있어요. 별도로 옮길 필요는 없습니다.');return true;}
 catch(error){message(error.message);if(error.status===401){shared.clear();sharedReady=false;}alert(error.message);return false;}
 finally{busy=false;connectionView();}
}
async function changeItem(k,x,remove=false){
 if(mode==='shared')return sharedChange(()=>remove?shared.remove(k,x.id):shared.put(k,x));
 const next=remove?data[k].filter(i=>i.id!==x.id):data[k].some(i=>i.id===x.id)?data[k].map(i=>i.id===x.id?x:i):[...data[k],x];
 const ok=save({...data,[k]:next});if(ok)deviceData=data;return ok;
}
function downloadBackup(value,prefix='somhouse-backup'){
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download=prefix+'-'+Somhouse.localDateTime().replace(/[:T]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function mergeShared(value,restore=false){
 let result;
 const ok=await sharedChange(async()=>{result=await shared.merge(value,restore);return result.data;});
 if(ok){render();message('공유 기록에 '+result.added+'개 추가했어요. 같은 내용 '+result.skipped+'개는 건너뛰었어요. 원본은 유지됩니다.');}
 return ok;
}
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
function render(){
 document.querySelectorAll('nav button').forEach(b=>{const active=b.dataset.page===page;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
 document.title=`${pageTitles[page]} · 솜하우스`;
 $('#content').innerHTML=page==='home'?homeView():page==='ai'?'<h1>AI 대화</h1><section class="card"><h2>AI 연결 준비 중</h2><p>실제 답변은 아직 받을 수 없어요. 단일 AI를 연결한 뒤 이곳에서 기록에 대해 질문할 수 있습니다.</p><textarea disabled placeholder="AI 연결 후 질문할 수 있어요" aria-label="질문 입력"></textarea><div class="actions"><button disabled>보내기</button></div></section>':listView(page);
 connectionView();
 const form=$('#filter-form');if(form)form.onsubmit=e=>{e.preventDefault();const next=Object.fromEntries(new FormData(form));if(next.from&&next.to&&next.from>next.to){alert('시작 날짜는 마지막 날짜보다 늦을 수 없어요.');return}filters[page]=next;render()};
}
function openForm(type,x){kind=type;editing=x||null;draftId=x?.id||(typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString()+'-'+Math.random().toString(36).slice(2));const values=x||{date:Somhouse.localDateTime()};$('#formtitle').textContent=(x?'수정 · ':'추가 · ')+({feeding:'수유 기록',hospital:'병원 방문',schedule:'일정',shopping:'구매 목록'}[type]);$('#fields').innerHTML=schemas[type].map(([name,label,t,required])=>`<label class="field">${label}${required?' *':''}${t==='select'?`<select name="${name}" required>${['모유','분유','혼합','기타'].map(v=>`<option ${x?.[name]===v?'selected':''}>${v}</option>`).join('')}</select>`:t==='textarea'?`<textarea name="${name}">${esc(values[name]||'')}</textarea>`:`<input name="${name}" type="${t}" value="${esc(values[name]||'')}" ${required?'required':''}>`}</label>`).join('');$('#dialog').showModal()}
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.page){location.hash=b.dataset.page;if(page===b.dataset.page)render();}
 if(b.dataset.reset){filters[b.dataset.reset]={};render();}
 if(busy)return;
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
$('#export').onclick=async()=>{
 if(mode==='shared'){
  if(busy||refreshing){message('저장 또는 새로고침이 끝난 뒤 백업해 주세요.');return;}
  try{const latest=await shared.load();if(!valid(latest))throw Error('공유 기록 형식이 올바르지 않아요.');downloadBackup(latest,'somhouse-backup-shared');}catch(error){message(error.message);alert(error.message);}return;
 }
 if(storageBlocked){alert('저장된 데이터를 읽을 수 없어 정상 백업을 만들 수 없습니다. 화면의 복구 안내를 확인해 주세요.');return;}
 downloadBackup(data);
};
$('#import').onchange=async e=>{
 const f=e.target.files[0];if(!f)return;
 try{
  if(busy)return;
  if(f.size>4*1024*1024)throw Error();
  const d=JSON.parse(await f.text());if(!valid(d))throw Error();
  if(mode==='shared'){if(confirm('백업의 기록을 공유 기록에 병합할까요? 삭제했던 기록도 복원하며, 현재 기록은 지우지 않고 같은 내용은 건너뛰어요.'))await mergeShared(d,true);return;}
  if(storageBlocked){alert('저장된 데이터를 읽을 수 없어 가져오기가 잠겨 있습니다. 화면의 복구 안내를 확인해 주세요.');return;}
  if(confirm('가져오면 이 브라우저의 기존 기록이 모두 덮어쓰여요. 계속할까요?')){if(save(d)){deviceData=data;render();}}
 }catch{alert('올바른 솜하우스 백업 파일이 아닙니다. 기존 기록은 유지됩니다.');}finally{e.target.value='';}
};
if(storageBlocked){const warning=document.createElement('section');warning.className='storage-warning';warning.setAttribute('role','alert');warning.innerHTML='<strong>저장된 기록을 읽지 못해 저장을 잠갔어요.</strong><p>기존 데이터는 변경하지 않았습니다. 이 화면의 빈 목록은 실제 기록이 아닙니다. 브라우저 데이터를 지우지 마세요. 브라우저 저장 공간과 접근 설정을 확인한 뒤 새로고침하세요. 데이터가 손상된 경우 개발자 도구에서 이 사이트의 localStorage에 있는 somhouse-v1 값을 먼저 안전한 곳에 복사해 보관하고, 원본을 보관하고 정상 백업이 있는 것을 확인한 후에는 개발자 도구에서 somhouse-v1 항목만 제거하고 새로고침한 뒤 JSON 가져오기로 백업을 복원할 수 있습니다. 원본 복구가 필요하면 도움을 받으세요.</p>';document.querySelector('main').prepend(warning)}
window.addEventListener('hashchange',route);
window.addEventListener('storage',e=>{if(e.key!==KEY&&e.key!==null)return;$('#notice').textContent='다른 탭에서 기록이 변경됐어요. 현재 입력 내용을 확인한 뒤 새로고침해 주세요.';$('#notice').classList.add('visible')});
route();

if(shared){
 $('#server-url').value=shared.base;
 $('#connection-toggle').onclick=()=>{const details=$('#connection-details');details.hidden=!details.hidden;$('#connection-toggle').setAttribute('aria-expanded',String(!details.hidden));};
 $('#login-form').onsubmit=async e=>{
  e.preventDefault();if(busy||refreshing)return;
  const form=e.target,values=new FormData(form);busy=true;connectionView();message('로그인하고 있어요…');
  try{
   await shared.login($('#server-url').value.trim(),String(values.get('username')).trim(),String(values.get('password')));
   form.querySelector('[name="password"]').value='';mode='shared';sharedReady=false;data=empty();render();
  }catch(error){message(error.message);}finally{busy=false;connectionView();}
  if(mode==='shared')await refreshShared(true);
 };
 $('#refresh-shared').onclick=()=>refreshShared(true);
 $('#migrate-local').onclick=async()=>{
  if(storageBlocked||busy||!sharedReady)return;
  try{
   const raw=localStorage.getItem(KEY);const original=raw===null?empty():JSON.parse(raw);if(!valid(original))throw Error();
   const count=['records','schedule','shopping'].reduce((n,k)=>n+original[k].length,0);
   if(!count){message('로그인 후 입력한 기록은 이미 공유 저장돼요. 별도로 옮길 필요 없이 다른 휴대폰에서도 로그인해 확인하세요.');return;}
   if(!confirm('이 기기 기록 '+count+'개를 공유 기록에 병합할까요? 원본 백업을 내려받고, 브라우저 원본도 그대로 남겨요.'))return;
   downloadBackup(original,'somhouse-backup-device-before-move');await mergeShared(original);
  }catch{message('기기 원본 기록을 읽지 못했어요. 원본은 변경하지 않았습니다.');}
 };
 $('#export-device').onclick=()=>{try{const raw=localStorage.getItem(KEY);const original=raw===null?empty():JSON.parse(raw);if(!valid(original))throw Error();downloadBackup(original,'somhouse-backup-device');}catch{message('기기 원본 기록을 읽지 못했어요. 원본은 변경하지 않았습니다.');}};
 $('#logout').onclick=async()=>{
  if(busy||refreshing)return;busy=true;connectionView();let failed=false;
  try{await shared.logout();}catch{failed=true;}finally{
   mode='local';sharedReady=false;busy=false;
   try{storedRaw=localStorage.getItem(KEY);deviceData=storedRaw===null?empty():JSON.parse(storedRaw);if(!valid(deviceData))throw Error();storageBlocked=false;}catch{storageBlocked=true;deviceData=empty();}
   data=deviceData;render();message(failed?'이 기기에서 로그아웃했어요. 맥미니 연결 실패로 서버 로그인은 만료 시 해제됩니다.':'로그아웃했어요. 이 브라우저의 원본 기록을 보고 있어요.');
  }
 };
 window.addEventListener('focus',()=>refreshShared());
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshShared();});
 setInterval(()=>{if(!document.hidden)refreshShared();},10000);
 if(mode==='shared'){message('공유 기록을 불러오고 있어요…');refreshShared(true);}
}
