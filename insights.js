'use strict';
/* Things worked out from the family's own records, no AI needed: records to double-check, things to buy
   again soon, the feeding-amount trend and a two-week summary for the pediatrician.
   Loaded before app.js and only called after it has run. */
const CHECK_DISMISSED='somhouse-check-dismissed-v1';

// ④ Possible double entries (the same kind within 5 minutes, e.g. by voice and on the web) and long stretches
// with no record at all in the last 3 days. Each can be dismissed on this device.
function dismissedChecks(){try{const all=JSON.parse(localStorage.getItem(CHECK_DISMISSED)||'{}');return Array.isArray(all[aiAccount()])?all[aiAccount()]:[];}catch{return [];}}
function dismissCheck(key){
 try{const all=JSON.parse(localStorage.getItem(CHECK_DISMISSED)||'{}'),mine=new Set(Array.isArray(all[aiAccount()])?all[aiAccount()]:[]);mine.add(key);all[aiAccount()]=[...mine].slice(-200);localStorage.setItem(CHECK_DISMISSED,JSON.stringify(all));}catch{}
}
const GAP_HOURS=6,CHECK_DAYS=3,TWIN_MINUTES=5;
function minutesBetween(a,b){return Somhouse.sleepMinutes({date:a,end:b})??0;}
function recordChecks(now=Somhouse.localDateTime()){
 const since=Somhouse.addDays(now.slice(0,10),-CHECK_DAYS)+now.slice(10),dismissed=new Set(dismissedChecks()),checks=[];
 const recent=data.records.filter(x=>['feeding','sleep','diaper'].includes(x.type)&&x.date>=since&&x.date<=now).sort((a,b)=>a.date.localeCompare(b.date));
 const same=(a,b)=>a.type===b.type&&a.category===b.category&&(a.type!=='feeding'||a.amount===b.amount);
 for(let i=0;i<recent.length;i++)for(let j=i+1;j<recent.length&&minutesBetween(recent[i].date,recent[j].date)<=TWIN_MINUTES;j++){
  const a=recent[i],b=recent[j],key='twin:'+[a.id,b.id].sort().join('|');
  if(same(a,b)&&!dismissed.has(key))checks.push({kind:'twin',key,a,b});
 }
 // Covered time: feedings and diapers as moments, finished sleeps as stretches; an open sleep covers until now.
 const spans=recent.map(x=>[x.date,x.type==='sleep'?(x.end&&x.end>x.date?x.end:(x.end?x.date:now)):x.date]).sort((a,b)=>a[0].localeCompare(b[0]));
 let reach=null;
 for(const [from,to] of spans){
  if(reach&&minutesBetween(reach,from)>=GAP_HOURS*60){
   // Keyed by where the gap ends, so removing a duplicate at its start does not bring it back.
   const key='gap:'+from;
   if(!dismissed.has(key))checks.push({kind:'gap',key,from:reach,to:from});
  }
  if(!reach||to>reach)reach=to;
 }
 return checks;
}
function checksCard(){
 if(shared?.readOnly)return '';
 const checks=recordChecks();if(!checks.length)return '';
 const when=v=>v.slice(5).replace('-','/').replace('T',' ');
 const rows=checks.map(x=>x.kind==='twin'
  ?`<div class="check-row"><p><strong>같은 기록이 두 번 있어요</strong><br>${desc(x.a,'records')} · ${esc(when(x.a.date))}<br>${desc(x.b,'records')} · ${esc(when(x.b.date))}</p><div class="actions"><button type="button" class="secondary small" data-check-remove="${esc(x.b.id)}" data-check-key="${esc(x.key)}">나중 것 지우기</button><button type="button" class="plain small" data-check-ok="${esc(x.key)}">둘 다 맞아요</button></div></div>`
  :`<div class="check-row"><p><strong>${esc(Somhouse.duration(minutesBetween(x.from,x.to)))} 동안 기록이 없어요</strong><br>${esc(when(x.from))} ~ ${esc(when(x.to))} · 수유·수면·기저귀 중 빠진 기록이 있는지 확인해 보세요.</p><div class="actions"><button type="button" class="secondary small" data-check-add="${esc(x.from)}|${esc(x.to)}">빠진 기록 추가</button><button type="button" class="plain small" data-check-ok="${esc(x.key)}">괜찮아요</button></div></div>`).join('');
 return `<section class="card checks-card" aria-label="확인해 볼 기록"><h2>🔎 확인해 볼 기록</h2><p class="caption">최근 ${CHECK_DAYS}일 기록에서 ${TWIN_MINUTES}분 안에 같은 기록이 두 번 있거나, ${GAP_HOURS}시간 넘게 아무 기록이 없는 때를 찾았어요. 맞다면 ‘괜찮아요’를 누르면 이 기기에서 다시 보이지 않아요.</p>${rows}</section>`;
}

// ⑤ Buying again: each ✓ adds the day to the item's purchase days (kept in `boughtAt`, newest 10). Items with
// the same name (spaces and case ignored) share a history; once bought twice, the usual gap says when it is due.
const REBUY_SOON=2;
function boughtDays(x){return String(x.boughtAt||'').split(',').filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v));}
function boughtWith(x,today=Somhouse.localDateTime().slice(0,10)){return [...new Set([...boughtDays(x),today])].sort().slice(-10).join(',');}
function itemName(title){return String(title||'').replace(/\s+/g,'').toLowerCase();}
function rebuyList(today=Somhouse.localDateTime().slice(0,10)){
 const groups=new Map(),dismissed=new Set(dismissedChecks());
 for(const x of data.shopping){const k=itemName(x.title);if(!k)continue;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x);}
 const out=[];
 for(const items of groups.values()){
  if(items.some(x=>x.done!=='yes'))continue; // already on the list
  if(items.some(x=>isDiaper(x.title))&&diaperStockNow())continue; // the stock handles diapers
  const days=[...new Set(items.flatMap(boughtDays))].sort();
  if(days.length<2)continue;
  const gaps=days.slice(1).map((d,i)=>Math.round((new Date(d+'T12:00')-new Date(days[i]+'T12:00'))/86400000)).filter(g=>g>0);
  if(!gaps.length)continue;
  const every=Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length),last=days.at(-1),due=Somhouse.addDays(last,every);
  const latest=items.filter(x=>boughtDays(x).includes(last)).sort((a,b)=>String(b.boughtAt).localeCompare(String(a.boughtAt)))[0];
  const key='rebuy:'+itemName(latest.title)+':'+last;
  if(due<=Somhouse.addDays(today,REBUY_SOON)&&!dismissed.has(key))out.push({item:latest,every,last,due,key,times:days.length});
 }
 return out.sort((a,b)=>a.due.localeCompare(b.due));
}
function rebuyCard(){
 if(shared?.readOnly)return '';
 const list=rebuyList(),today=Somhouse.localDateTime().slice(0,10);if(!list.length)return '';
 const md=d=>`${Number(d.slice(5,7))}/${Number(d.slice(8))}`;
 const rows=list.map(x=>`<div class="check-row"><p><strong>${esc(x.item.title.trim())}</strong> · ${esc(x.item.quantity)}<br>보통 ${x.every}일마다 샀어요 (${x.times}번) · 마지막 ${md(x.last)} → ${x.due<today?`${md(x.due)}쯤 살 때였어요`:x.due===today?'오늘쯤 살 때예요':`${md(x.due)}쯤 살 때예요`}</p><div class="actions"><button type="button" class="secondary small" data-rebuy="${esc(x.item.id)}">살 것에 다시 넣기</button><button type="button" class="plain small" data-check-ok="${esc(x.key)}">이번엔 괜찮아요</button></div></div>`).join('');
 return `<section class="card checks-card" aria-label="곧 살 때예요"><h2>🛒 곧 살 때예요</h2><p class="caption">‘✓ 샀어요’를 누른 날짜로 같은 이름의 물건을 보통 며칠마다 샀는지 계산해요. 두 번 이상 산 물건만 보여요.</p>${rows}</section>`;
}

// ⑥ How much the baby takes per feeding, week by week (the last 4 weeks of 7 days ending today):
// bottle feedings with ml, and timed breastfeeding minutes.
function amountTrend(now=new Date()){
 const today=Somhouse.localDateTime(now).slice(0,10),current=Somhouse.localDateTime(now);
 return [0,1,2,3].map(w=>{
  const to=Somhouse.addDays(today,-7*w),from=Somhouse.addDays(to,-6);
  const feeds=data.records.filter(x=>x.type==='feeding'&&x.date<=current&&x.date.slice(0,10)>=from&&x.date.slice(0,10)<=to);
  const ml=feeds.map(x=>Somhouse.feedingVolume(x.amount)).filter(v=>v!==null),min=feeds.map(x=>Somhouse.feedingMinutes(x.amount)).filter(v=>v!==null);
  const avg=list=>list.length?Math.round(list.reduce((a,b)=>a+b,0)/list.length):null;
  return {from,to,ml:avg(ml),mlCount:ml.length,minutes:avg(min),minuteCount:min.length};
 }).reverse();
}
function amountTrendView(){
 const weeks=amountTrend();if(!weeks.some(w=>w.mlCount||w.minuteCount))return '';
 const max=Math.max(1,...weeks.map(w=>w.ml||0)),md=d=>`${Number(d.slice(5,7))}/${Number(d.slice(8))}`;
 const rows=weeks.map(w=>`<tr><th scope="row">${md(w.from)}~${md(w.to)}</th><td>${w.ml!==null?`${w.ml}ml <small>(${w.mlCount}회)</small>`:'—'}</td><td>${w.minutes!==null?`${w.minutes}분 <small>(${w.minuteCount}회)</small>`:'—'}</td><td aria-hidden="true"><div class="stats-bar"><span style="width:${w.ml?Math.min(100,w.ml/max*100):0}%"></span></div></td></tr>`).join('');
 const known=weeks.filter(w=>w.ml!==null),change=known.length>=2?known.at(-1).ml-known[0].ml:null;
 return `<section class="card"><h2>1회 평균 수유량 (주별)</h2><p class="caption">최근 4주를 7일씩 나눠 한 번에 먹은 양의 평균을 보여요. 분유·혼합은 ml가 있는 기록만, 직수는 분으로 기록된 것만 계산해요.${change!==null?` ${known.at(-1)===weeks[3]?'이번 주는':`${md(known.at(-1).from)}~${md(known.at(-1).to)}은`} ${md(known[0].from)}~${md(known[0].to)}보다 ${change>=0?`${change}ml 많아요`:`${-change}ml 적어요`}.`:''}</p><table class="stats-table"><thead><tr><th scope="col">기간</th><th scope="col">분유 1회</th><th scope="col">직수 1회</th><th scope="col">비교</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

// ⑦ Two weeks for the pediatrician: daily feeding, sleep and diapers, hospital visits and upcoming
// appointments, on one screen that also prints. Ⓐ/Ⓒ: the AI can write a two-line summary and questions to ask,
// from the numbers only (hospital notes go only when the family turns that on).
const REPORT_DAYS=14,report={memos:false,text:'',by:'',at:'',status:'',working:false};
function reportReset(){Object.assign(report,{memos:false,text:'',by:'',at:'',status:'',working:false});}
const HOSPITAL_WORDS=/병원|소아과|의원|진료|접종|검진|예방/;
function reportData(now=new Date()){
 const current=Somhouse.localDateTime(now),today=current.slice(0,10),from=Somhouse.addDays(today,-(REPORT_DAYS-1));
 const days=Array.from({length:REPORT_DAYS},(_,i)=>Somhouse.addDays(from,i)).map(day=>{
  const feeds=data.records.filter(x=>x.type==='feeding'&&x.date.slice(0,10)===day&&x.date<=current);
  const ml=feeds.map(x=>Somhouse.feedingVolume(x.amount)).filter(v=>v!==null),min=feeds.map(x=>Somhouse.feedingMinutes(x.amount)).filter(v=>v!==null);
  const sleep=Somhouse.sleepDay(data.records,day,now),diaper=Somhouse.diaperDay(data.records,day,now);
  return {day,feeds:feeds.length,ml:ml.length?Math.round(ml.reduce((a,b)=>a+b,0)):null,breastMinutes:min.length?Math.round(min.reduce((a,b)=>a+b,0)):null,
   sleep:sleep.recorded?sleep.total:null,longest:sleep.longest||null,naps:sleep.naps,diapers:diaper.count,pee:diaper.pee,poo:diaper.poo};
 });
 const avg=(f,keep=x=>true)=>{const list=days.filter(keep).map(f).filter(v=>v!==null);return list.length?list.reduce((a,b)=>a+b,0)/list.length:null;};
 const visits=data.records.filter(x=>x.type==='hospital'&&x.date.slice(0,10)>=Somhouse.addDays(today,-60)&&x.date<=current).sort((a,b)=>b.date.localeCompare(a.date));
 const coming=data.schedule.filter(x=>x.date>=current&&x.date.slice(0,10)<=Somhouse.addDays(today,30)&&HOSPITAL_WORDS.test(`${x.title} ${x.place||''} ${x.memo||''}`)).sort((a,b)=>a.date.localeCompare(b.date));
 return {from,to:today,days,visits,coming,poo:Somhouse.lastPoo(data.records,now),
  avg:{feeds:avg(x=>x.feeds,x=>x.feeds||x.sleep!==null||x.diapers),ml:avg(x=>x.ml),sleep:avg(x=>x.sleep),longest:avg(x=>x.longest),diapers:avg(x=>x.diapers,x=>x.diapers),poo:avg(x=>x.poo,x=>x.diapers)}};
}
function reportView(){
 const r=reportData(),md=d=>`${Number(d.slice(5,7))}/${Number(d.slice(8))}`,hm=m=>m===null||m===undefined?'—':Somhouse.duration(Math.round(m)),one=v=>v===null?'—':v.toFixed(1);
 const kids=children().length?` · ${children().map(esc).join(', ')}`:'';
 const cards=[['하루 수유',r.avg.feeds===null?'—':`${one(r.avg.feeds)}회`],['하루 분유',r.avg.ml===null?'—':`${Math.round(r.avg.ml)}ml`],['하루 수면',hm(r.avg.sleep)],['평균 가장 긴 잠',hm(r.avg.longest)],['하루 기저귀',r.avg.diapers===null?'—':`${one(r.avg.diapers)}회 · 대변 ${one(r.avg.poo)}회`],['마지막 대변',r.poo?r.poo.date.slice(5).replace('-','/').replace('T',' '):'기록 없음']];
 const rows=[...r.days].reverse().map(x=>`<tr><th scope="row">${md(x.day)} ${weekdays[new Date(x.day+'T12:00').getDay()]}</th><td>${x.feeds?`${x.feeds}회`:'—'}${x.ml!==null?`<br><small>${x.ml}ml</small>`:''}${x.breastMinutes!==null?`<br><small>직수 ${x.breastMinutes}분</small>`:''}</td><td>${hm(x.sleep)}${x.longest?`<br><small>최장 ${hm(x.longest)}</small>`:''}</td><td>${x.diapers?`${x.diapers}회<br><small>소${x.pee}·대${x.poo}</small>`:'—'}</td></tr>`).join('');
 const visits=r.visits.length?r.visits.map(x=>`<li>${esc(x.date.slice(5).replace('-','/').replace('T',' '))} · ${esc(x.hospital)} · ${esc(x.reason)}${x.memo?` <span class="caption">${esc(x.memo)}</span>`:''}</li>`).join(''):'<li class="caption">최근 60일 병원 방문 기록이 없어요.</li>';
 const coming=r.coming.length?r.coming.map(x=>`<li>${esc(x.date.slice(5).replace('-','/').replace('T',' '))} · ${esc(x.title)}${x.place?` · ${esc(x.place)}`:''}</li>`).join(''):'<li class="caption">30일 안에 병원 관련 일정이 없어요.</li>';
 const picked=aiHelpOption();
 const ai=picked?`<section class="card ai-help no-print-empty"><h2>✨ 소아과에 물어볼 것 정리</h2><p class="caption">위 숫자를 ${esc(aiName(picked))}에게 보내 두 줄 요약과 물어볼 질문을 받아요. 의료 판단은 하지 않고, 진료 때 참고할 질문만 정리해요.</p><div class="actions no-print"><button type="button" class="${report.memos?'':'secondary '}small" data-report-memos="1">병원 메모 함께 보내기: ${report.memos?'켜짐':'꺼짐'}</button><button type="button" data-report-ai="1"${report.working?' disabled':''}>${report.working?'정리하는 중…':report.text?'다시 정리':'정리하기'}</button></div>${report.status?`<p class="caption" role="status">${esc(report.status)}</p>`:''}${report.text?`<p class="ai-summary-text">${esc(report.text)}</p><p class="caption">${esc(report.by)} · ${esc(report.at.replace('T',' '))} · AI가 쓴 내용이라 틀릴 수 있어요.</p>`:''}</section>`:'';
 return `<div class="report"><h1>🩺 소아과용 2주 요약</h1><p class="caption">${md(r.from)}~${md(r.to)} (오늘 포함 ${REPORT_DAYS}일)${kids} · 솜하우스 기록으로 만들었어요. 평균은 기록이 있는 날만 계산해요.</p><div class="actions no-print"><button type="button" class="secondary" data-report-print="1">인쇄 · PDF 저장</button><button type="button" class="plain" data-page="stats">← 통계로</button></div><div class="summary-cards stats-cards">${cards.map(([label,value])=>`<div class="summary-card"><p>${label}</p><strong>${esc(value)}</strong></div>`).join('')}</div><section class="card"><h2>날짜별</h2><table class="stats-table report-table"><thead><tr><th scope="col">날짜</th><th scope="col">수유</th><th scope="col">수면</th><th scope="col">기저귀</th></tr></thead><tbody>${rows}</tbody></table></section><section class="card"><h2>병원 방문 (최근 60일)</h2><ul class="report-list">${visits}</ul></section><section class="card"><h2>다가오는 병원 일정 (30일)</h2><ul class="report-list">${coming}</ul></section>${ai}</div>`;
}
function reportPrompt(r){
 const numbers={period:`${r.from}~${r.to}`,daily:r.days.map(x=>({date:x.day,feeds:x.feeds,bottle_ml:x.ml,breast_minutes:x.breastMinutes,sleep_minutes:x.sleep,longest_sleep_minutes:x.longest,diapers:x.diapers,poo:x.poo})),
  hospital_visits:r.visits.map(x=>report.memos?{date:x.date.slice(0,10),reason:x.reason,memo:x.memo||''}:{date:x.date.slice(0,10)})};
 return `아래는 아기 기록을 앱이 날짜별로 계산한 숫자예요(null은 그날 기록 없음). 소아과 진료 전에 보호자가 볼 메모를 한국어로 써 주세요.
첫 부분은 "요약:"으로 시작해 수유·수면·기저귀의 흐름을 두 줄로 쓰고, 다음은 "물어볼 것:"으로 시작해 진료 때 의사에게 물어보면 좋을 질문 3~5개를 목록으로 쓰세요.
숫자에 없는 내용은 추측하지 말고 진단이나 처방은 하지 마세요. 기록이 빠진 날이 많으면 그렇다고 알려 주세요.
숫자: ${JSON.stringify(numbers)}`;
}
async function reportAI(){
 const picked=aiHelpOption(),state=ai;
 if(!picked||report.working)return;
 const r=reportData();
 if(!r.days.some(x=>x.feeds||x.sleep!==null||x.diapers)){report.status='정리할 기록이 아직 없어요.';render();return;}
 report.working=true;report.status=`${aiName(picked)}가 정리하고 있어요…`;render();
 try{
  const answer=await aiHelpAsk(picked,reportPrompt(r));
  if(ai!==state)return;
  Object.assign(report,{text:answer.trim().slice(0,2000),by:aiName(picked),at:Somhouse.localDateTime(),status:''});
 }catch(error){
  if(ai!==state)return;
  if(error.status===401&&picked.mode!=='key'){showLogin(error.message);return;}
  report.status=error.message;
 }finally{if(ai===state){report.working=false;render();}}
}

// ⑧ Stock, two ways tried side by side (one will be removed):
//  A) the shopping list itself: '✓ 샀어요' on a 기저귀 item asks how many diapers it holds, and that item is the stock.
//  B) a stock list of any things at home (기저귀, 분유, 물티슈…) with counts.
// A 기저귀 stock loses one for every diaper change recorded after it was counted; other things go down with −1.
// The Mac follows the same counts (feeding_alarm.diaper_source) for the Calendar reminder and adding 기저귀 to the list.
const STOCK_ITEM='기저귀',STOCK_UNITS=['개','팩','통','병','봉','박스'],STOCK_ALERT_DAYS=3,stockUi={adding:false};
const isDiaper=name=>String(name||'').includes(STOCK_ITEM);
function diapersSince(at,now){return data.records.filter(x=>x.type==='diaper'&&x.date&&x.date>at&&x.date<=now).length;}
// Diapers a day: the last 7 days, over the days with diaper records (at least 3).
function diaperDaily(now){
 const since=Somhouse.localDateTime(new Date(new Date(now+':00').getTime()-7*86400000));
 const recent=data.records.filter(x=>x.type==='diaper'&&x.date&&x.date>since&&x.date<=now),days=new Set(recent.map(x=>x.date.slice(0,10))).size;
 return days>=3?Math.round(recent.length/days*10)/10:null;
}
// When they run out and when to remind (10:00, a few days before; soon after counting if already that low).
function stockForecast(left,at,alertDays,now){
 const daily=diaperDaily(now);if(!daily)return {daily:null,runout:null,alarm:null,due:false};
 const runout=Somhouse.localDateTime(new Date(new Date(now+':00').getTime()+left/daily*86400000));
 const remind=Somhouse.addDays(runout.slice(0,10),-alertDays)+'T10:00',soonest=Somhouse.localDateTime(new Date(new Date(at+':00').getTime()+5*60000));
 const alarm=remind>soonest?remind:soonest;
 return {daily,runout,alarm,due:alarm<=now};
}
// A: the 기저귀 items counted when bought; together they are the stock, counted from the first of them.
function shoppingStock(now=Somhouse.localDateTime()){
 const items=data.shopping.filter(x=>isDiaper(x.title)&&/^\d+$/.test(x.stockCount||'')&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x.stockAt||''));
 if(!items.length)return null;
 const at=items.map(x=>x.stockAt).sort()[0],left=Math.max(0,items.reduce((s,x)=>s+Number(x.stockCount),0)-diapersSince(at,now));
 const latest=[...items].sort((a,b)=>b.stockAt.localeCompare(a.stockAt))[0];
 return {left,latest,at,...stockForecast(left,at,STOCK_ALERT_DAYS,now)};
}
// B: the stock list with what is left now.
function stockList(now=Somhouse.localDateTime()){
 return (Array.isArray(shared?.settings?.stock)?shared.settings.stock:[]).map(x=>{
  const auto=isDiaper(x.name),left=auto?Math.max(0,x.count-diapersSince(x.at,now)):x.count;
  return {...x,auto,left,...(auto?stockForecast(left,x.at,x.alertDays||STOCK_ALERT_DAYS,now):{due:left<=(x.low??1)})};
 });
}
// What home shows: the stock list's 기저귀 first, else the shopping items.
function diaperStockNow(){return stockList().find(x=>x.auto)||shoppingStock();}
function stockPending(name){return data.shopping.some(x=>x.done!=='yes'&&itemName(x.title).includes(itemName(name)));}
function stockLine(){
 const p=diaperStockNow();if(!p)return '';
 return `<span class="guess">${p.due?'⚠️ ':''}남은 기저귀 약 ${p.left}개${p.daily?` · ${Math.floor(p.left/p.daily)}일분`:''}</span>`;
}
// A: shown on the shopping item that was bought last.
function shoppingStockBadge(x){
 const p=shoppingStock();if(!p||p.latest.id!==x.id)return '';
 return ` <span class="badge">A안 · 남은 약 ${p.left}개${p.daily?` · ${Math.floor(p.left/p.daily)}일분`:''}</span>${p.due?' <span class="badge warn">살 때예요</span>':''}`;
}
function stockCard(){
 if(shared?.readOnly)return '';
 const list=stockList(),md=v=>`${Number(v.slice(5,7))}/${Number(v.slice(8,10))}`;
 const rows=list.map(x=>{
  const how=x.auto?(x.daily?`기록마다 자동 −1 · 하루 ${x.daily}개 · 약 ${Math.floor(x.left/x.daily)}일분 (${md(x.runout)}쯤 다 써요)`:'기록마다 자동 −1 · 기록이 3일 쌓이면 며칠분인지 알려 드려요'):'';
  const due=x.due?`<span class="badge warn">살 때예요</span>${stockPending(x.name)?' <span class="caption">구매 목록에 있어요</span>':` <button type="button" class="small" data-stock-list="${esc(x.id)}">구매 목록에 넣기</button>`}`:'';
  return `<div class="stock-row"><p><strong>${esc(x.name)}</strong> <b>${esc(x.left)}${esc(x.unit)}</b>${how?`<br><span class="caption">${esc(how)}</span>`:''}${due?`<br>${due}`:''}</p><div class="actions">${x.auto?'':`<button type="button" class="secondary small" data-stock-use="${esc(x.id)}">−1</button>`}<button type="button" class="secondary small" data-stock-buy="${esc(x.id)}">＋ 산 만큼</button><button type="button" class="plain small" data-stock-set="${esc(x.id)}">수량 고치기</button><button type="button" class="plain small" data-stock-remove="${esc(x.id)}" aria-label="${esc(x.name)} 지우기">✕</button></div></div>`;
 }).join('');
 const form=`<div class="stock-form"><div class="stock-fields"><label class="field">이름<input id="stock-name" maxlength="30" placeholder="예: 기저귀, 분유, 물티슈"></label><label class="field">지금 수량<input id="stock-count" type="number" inputmode="numeric" min="0" max="10000" placeholder="예: 60"></label><label class="field">단위<select id="stock-unit">${STOCK_UNITS.map(u=>`<option>${u}</option>`).join('')}</select></label></div><div class="actions"><button type="button" data-stock-new="1">추가</button><button type="button" class="plain" data-stock-adding="0">취소</button></div></div>`;
 return `<section class="card stock-card" aria-label="재고"><h2>🗃️ 재고 <span class="badge">B안</span></h2><p class="caption">집에 있는 물건과 수량을 적어 두세요. 이름에 ‘기저귀’가 들어가면 기저귀를 기록할 때마다 1개씩 자동으로 줄고, 나머지는 쓸 때 −1을 눌러요. 적어지면 ‘살 때예요’로 알려 드려요. (A안: 아래 구매 목록에서 기저귀에 ‘✓ 샀어요’를 누르고 개수를 넣으면 그 항목에 남은 개수가 보여요.)</p>${rows||'<p class="caption">아직 재고가 없어요.</p>'}${stockUi.adding?form:'<div class="actions"><button type="button" class="secondary small" data-stock-adding="1">＋ 재고 항목 추가</button></div>'}</section>`;
}
async function stockRequest(body,done){
 if(busy||!shared?.token||shared.readOnly)return false;
 const token=shared.token;busy=true;connectionView();
 try{
  const result=await shared.request('/api/stock','POST',body);
  if(shared.token!==token)return false;
  if(valid(result.data))data=result.data;
  if(result.settings)shared.settings={...shared.settings,...result.settings};
  if('google_status' in result){shared.sources=result.sources||shared.sources;shared.googleStatus=result.google_status||null;}
  stockUi.adding=false;message(done);return true;
 }catch(error){if(shared.token===token){if(error.status===401)showLogin(error.message);else{message(error.message);alert(error.message);}}return false;}
 finally{busy=false;connectionView();render();}
}
function askCount(text,value=''){
 if(typeof prompt!=='function')return null;
 const answer=prompt(text,String(value));if(answer===null)return null;
 const n=Number(String(answer).trim());
 if(!Number.isInteger(n)||n<0||n>10000){alert('0~10000 사이의 숫자로 입력해 주세요.');return null;}
 return n;
}
// After '✓ 샀어요' on a 기저귀 item: how many diapers. A keeps them on that item; B adds them to its 기저귀.
async function stockBought(item){
 if(!isDiaper(item.title))return;
 const guess=(String(item.quantity).match(/(\d+)\s*개/)||[])[1]||'';
 const n=askCount('기저귀 몇 개예요? 재고로 세어 둘게요 (기록할 때마다 1개씩 줄어요).',guess);
 if(!n)return;
 const saved=data.shopping.find(x=>x.id===item.id)||item;
 if(await changeItem('shopping',{...saved,stockCount:String(n),stockAt:Somhouse.localDateTime()}))message(`기저귀 ${n}개를 재고로 세어 둘게요.`);
 const b=stockList().find(x=>x.auto);
 if(b)await stockRequest({action:'buy',id:b.id,add:n},`재고 목록의 ${b.name}에 ${n}개를 더했어요.`);else render();
}

// Called from the app's click handler; true when the click was ours.
async function insightsClick(b){
 const d=b.dataset||{};
 if(d.checkOk){dismissCheck(d.checkOk);render();return true;}
 if(d.stockAdding){stockUi.adding=d.stockAdding==='1';render();return true;}
 if(d.stockNew){
  const name=String(document.querySelector('#stock-name')?.value||'').trim(),count=Number(String(document.querySelector('#stock-count')?.value??'').trim()),unit=document.querySelector('#stock-unit')?.value||'개';
  if(!name||!Number.isInteger(count)||count<0||count>10000){alert('이름과 지금 수량(0~10000)을 입력해 주세요.');return true;}
  await stockRequest({action:'add',name,count,unit},`${name} ${count}${unit}을 재고에 넣었어요.${isDiaper(name)?' 기저귀를 기록할 때마다 1개씩 줄어요.':''}`);return true;
 }
 const target=id=>stockList().find(x=>x.id===id);
 if(d.stockUse){const x=target(d.stockUse);if(x)await stockRequest({action:'use',id:x.id},`${x.name} 1${x.unit}을 썼어요.`);return true;}
 if(d.stockBuy){const x=target(d.stockBuy);if(!x)return true;const n=askCount(`${x.name} 몇 ${x.unit} 샀어요? 지금 수량에 더할게요.`,'1');if(n)await stockRequest({action:'buy',id:x.id,add:n},`${x.name} ${n}${x.unit}을 더했어요.`);return true;}
 if(d.stockSet){const x=target(d.stockSet);if(!x)return true;const n=askCount(`${x.name} 지금 몇 ${x.unit} 있어요?`,x.left);if(n!==null)await stockRequest({action:'set',id:x.id,count:n},`${x.name}을 ${n}${x.unit}로 고쳤어요.`);return true;}
 if(d.stockRemove){const x=target(d.stockRemove);if(x&&confirm(`재고에서 ${x.name}을 지울까요?`))await stockRequest({action:'remove',id:x.id},`재고에서 ${x.name}을 지웠어요.`);return true;}
 if(d.stockList){const x=target(d.stockList);if(x&&!stockPending(x.name)&&await changeItem('shopping',{id:newId(),title:x.name,quantity:'1',done:'no',memo:'솜하우스 재고 알림'}))render();return true;}
 if(d.reportMemos){report.memos=!report.memos;render();return true;}
 if(d.reportAi){await reportAI();return true;}
 if(d.reportPrint){if(typeof print==='function')print();return true;}
 if(d.rebuy){const x=data.shopping.find(item=>item.id===d.rebuy);if(x&&await changeItem('shopping',{...x,done:'no'}))render();return true;}
 if(d.checkRemove){
  const x=data.records.find(r=>r.id===d.checkRemove);if(!x)return true;
  if(!confirm(`${x.date.replace('T',' ')} 기록을 지울까요?`))return true;
  if(await changeItem('records',x,true)){dismissCheck(d.checkKey);render();}
  return true;
 }
 if(d.checkAdd){
  const [from,to]=d.checkAdd.split('|'),middle=Somhouse.localDateTime(new Date((new Date(from+':00').getTime()+new Date(to+':00').getTime())/2));
  openForm('feeding',null,{date:middle});return true;
 }
 return false;
}
