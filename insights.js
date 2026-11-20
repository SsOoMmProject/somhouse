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
  if(shared?.settings?.diaperStock&&items.some(x=>String(x.title).includes(STOCK_ITEM)))continue; // the stock card handles it
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

// ⑧ Diaper stock, set up on the shopping tab: diapers left = the count entered minus every diaper change since;
// the days left come from the average of the last 7 days (days with diaper records, at least 3). The same rule as
// feeding_alarm.stock_plan on the Mac, which also sends the Calendar reminder and adds 기저귀 to the list.
const STOCK_ITEM='기저귀',stockUi={editing:false};
function stockPlan(now=Somhouse.localDateTime()){
 const s=shared?.settings?.diaperStock;if(!s||!Number.isInteger(s.count)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s.at||''))return null;
 const diapers=data.records.filter(x=>x.type==='diaper'&&x.date&&x.date<=now);
 const left=Math.max(0,s.count-diapers.filter(x=>x.date>s.at).length);
 const since=Somhouse.localDateTime(new Date(new Date(now+':00').getTime()-7*86400000)),recent=diapers.filter(x=>x.date>since);
 const days=new Set(recent.map(x=>x.date.slice(0,10))).size,daily=days>=3?Math.round(recent.length/days*10)/10:null;
 let runout=null,alarm=null;
 if(daily){
  runout=Somhouse.localDateTime(new Date(new Date(now+':00').getTime()+left/daily*86400000));
  const remind=Somhouse.addDays(runout.slice(0,10),-(s.alertDays||3))+'T10:00',soonest=Somhouse.localDateTime(new Date(new Date(s.at+':00').getTime()+5*60000));
  alarm=remind>soonest?remind:soonest;
 }
 return {setting:s,left,daily,runout,alarm,due:Boolean(alarm&&alarm<=now)};
}
function stockPending(){return data.shopping.some(x=>x.done!=='yes'&&String(x.title).includes(STOCK_ITEM));}
function stockLine(){
 const p=stockPlan();if(!p)return '';
 return `<span class="guess">${p.due?'⚠️ ':''}남은 기저귀 약 ${p.left}개${p.daily?` · ${Math.floor(p.left/p.daily)}일분`:''}</span>`;
}
function stockCard(){
 if(shared?.readOnly)return '';
 const p=stockPlan(),md=v=>`${Number(v.slice(5,7))}/${Number(v.slice(8,10))}`,calendar=Boolean(shared?.googleStatus?.diaper_stock);
 const form=s=>`<div class="stock-form"><div class="stock-fields"><label class="field">팩당 매수<input id="stock-per-pack" type="number" inputmode="numeric" min="1" max="300" value="${esc(s?.perPack||'')}" placeholder="포장에 적힌 매수"></label><label class="field">남은 팩<input id="stock-packs" type="number" inputmode="decimal" min="0" max="50" step="0.5" placeholder="뜯은 팩은 0.5"></label><label class="field">낱개 (선택)<input id="stock-loose" type="number" inputmode="numeric" min="0" max="1000" placeholder="0"></label><label class="field">구매 알림<select id="stock-alert">${[2,3,5,7].map(d=>`<option value="${d}"${(s?.alertDays||3)===d?' selected':''}>다 쓰기 ${d}일 전</option>`).join('')}</select></label></div><div class="actions"><button type="button" data-stock-save="1">재고 저장</button>${s?'<button type="button" class="plain" data-stock-cancel="1">취소</button>':''}</div></div>`;
 const intro='<p class="caption">팩당 매수와 남은 양을 알려 주면 기저귀 기록 1번에 1개씩 빼고, 다 쓰기 전에 살 때를 알려 드려요. 매수는 제품과 단계마다 달라요(보통 신생아·작은 단계일수록 한 팩에 더 많이 들어 있어요). 포장에 적힌 숫자를 넣어 주세요.</p>';
 if(!p)return `<section class="card stock-card" aria-label="기저귀 재고"><h2>🧷 기저귀 재고</h2>${intro}${form(null)}</section>`;
 const s=p.setting,forecast=p.daily?`하루 평균 ${p.daily}개를 써서 <strong>약 ${Math.floor(p.left/p.daily)}일분</strong>, ${md(p.runout)}쯤 다 써요.`:'기저귀 기록이 3일 이상 쌓이면 언제쯤 다 쓸지 알려 드려요.';
 const remind=p.alarm?`구매 알림: <strong>${md(p.alarm)} ${p.alarm.slice(11)}</strong> (다 쓰기 ${s.alertDays}일 전) · ${calendar?'Google 캘린더로 알려 드리고 구매 목록에 기저귀를 넣어 둘게요.':'그날 홈과 이 화면에서 알려 드려요.'}`:'';
 const due=p.due&&!stockPending()?`<div class="stock-due"><strong>기저귀 살 때예요</strong><button type="button" class="small" data-stock-list="1">구매 목록에 넣기</button></div>`:'';
 return `<section class="card stock-card" aria-label="기저귀 재고"><h2>🧷 기저귀 재고</h2><p>남은 기저귀 <strong>약 ${p.left}개</strong> <span class="caption">(팩당 ${esc(s.perPack)}개 · ${esc(s.at.slice(5).replace('-','/').replace('T',' '))}에 ${esc(s.count)}개로 입력)</span></p><p>${forecast}</p>${remind?`<p class="caption">${remind}</p>`:''}${due}${stockUi.editing?form(s):`<div class="actions"><button type="button" class="secondary small" data-stock-add="1">＋ 산 팩 더하기</button><button type="button" class="plain small" data-stock-edit="1">남은 양 다시 입력</button><button type="button" class="plain small" data-stock-off="1">재고 관리 끄기</button></div>`}</section>`;
}
async function stockRequest(body,done){
 if(busy||!shared?.token||shared.readOnly)return false;
 const token=shared.token;busy=true;connectionView();
 try{
  const result=await shared.request('/api/diaper-stock','POST',body);
  if(shared.token!==token)return false;
  if(valid(result.data))data=result.data;
  if(result.settings)shared.settings={...shared.settings,...result.settings};
  if('google_status' in result){shared.sources=result.sources||shared.sources;shared.googleStatus=result.google_status||null;}
  stockUi.editing=false;message(done);return true;
 }catch(error){if(shared.token===token){if(error.status===401)showLogin(error.message);else{message(error.message);alert(error.message);}}return false;}
 finally{busy=false;connectionView();render();}
}
function stockValue(id){const v=String(document.querySelector('#'+id)?.value??'').trim();return v===''?null:Number(v);}
// After '✓ 샀어요' on a diaper item: how many packs, to add to the stock.
async function stockBought(item){
 const s=shared?.settings?.diaperStock;
 if(!s||!String(item.title).includes(STOCK_ITEM))return;
 const answer=prompt(`기저귀 몇 팩 샀어요? 재고에 더할게요 (팩당 ${s.perPack}개).`,String(parseFloat(item.quantity)||1));
 if(answer===null)return;
 const packs=Number(String(answer).trim());
 if(!(packs>=0.5&&packs<=50)){alert('산 팩 수를 0.5~50 사이로 입력해 주세요.');return;}
 await stockRequest({add:packs},`기저귀 ${packs}팩(${Math.round(packs*s.perPack)}개)을 재고에 더했어요.`);
}

// Called from the app's click handler; true when the click was ours.
async function insightsClick(b){
 const d=b.dataset||{};
 if(d.checkOk){dismissCheck(d.checkOk);render();return true;}
 if(d.stockSave){
  const perPack=stockValue('stock-per-pack'),packs=stockValue('stock-packs'),loose=stockValue('stock-loose')??0,alertDays=Number(document.querySelector('#stock-alert')?.value||3);
  if(!Number.isInteger(perPack)||perPack<1||perPack>300||packs===null||!(packs>=0&&packs<=50)||!Number.isInteger(loose)||loose<0||loose>1000){alert('팩당 매수(1~300)와 남은 팩(0~50, 뜯은 팩은 0.5)을 입력해 주세요.');return true;}
  await stockRequest({perPack,packs,loose,alertDays},`기저귀 ${Math.round(packs*perPack)+loose}개로 재고를 맞췄어요. 기저귀 기록 1번에 1개씩 빼요.`);return true;
 }
 if(d.stockEdit){stockUi.editing=true;render();return true;}
 if(d.stockCancel){stockUi.editing=false;render();return true;}
 if(d.stockOff){if(confirm('기저귀 재고 관리를 끌까요? 구매 알림도 멈춰요.'))await stockRequest({off:true},'기저귀 재고 관리를 껐어요.');return true;}
 if(d.stockAdd){
  const s=shared?.settings?.diaperStock;if(!s)return true;
  const answer=prompt(`몇 팩을 더할까요? (팩당 ${s.perPack}개)`,'1');if(answer===null)return true;
  const packs=Number(String(answer).trim());if(!(packs>=0.5&&packs<=50)){alert('팩 수를 0.5~50 사이로 입력해 주세요.');return true;}
  await stockRequest({add:packs},`기저귀 ${packs}팩(${Math.round(packs*s.perPack)}개)을 재고에 더했어요.`);return true;
 }
 if(d.stockList){if(!stockPending()&&await changeItem('shopping',{id:newId(),title:STOCK_ITEM,quantity:'1팩',done:'no',memo:'솜하우스 재고 알림'}))render();return true;}
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
