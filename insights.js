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

// Called from the app's click handler; true when the click was ours.
async function insightsClick(b){
 const d=b.dataset||{};
 if(d.checkOk){dismissCheck(d.checkOk);render();return true;}
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
