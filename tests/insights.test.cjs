const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browser,blank}=require('./helpers/browser.cjs');

// A family whose records are already on the Mac; `open` shows a page after the first load.
function family(records=[],extra={}){
 const server={data:{...blank(),records,...extra},imported:new Set(),failure:null,readGate:null};
 const b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'mom'},server});
 const open=async page=>{await b.settle();b.context.location.hash='#'+page;b.events.get('hashchange')();await b.settle();return b.get('#content').innerHTML;};
 const click=dataset=>b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset}}});
 const day=n=>b.eval(`Somhouse.addDays(Somhouse.localDateTime().slice(0,10),${n})`);
 const load=async(kind,items)=>{await b.settle();server.data[kind].push(...items);await b.eval('refreshShared(true)');};
 return {b,server,open,click,day,load};
}

test('stats show sleep and diaper sections for the chosen period',async()=>{
 const f=family();
 const y=f.day(-1),t=f.day(-2);
 await f.load('records',[
  {id:'n',type:'sleep',date:t+'T21:00',end:y+'T05:30',category:'밤잠',memo:''},
  {id:'a',type:'sleep',date:y+'T10:00',end:y+'T11:15',category:'낮잠',memo:''},
  {id:'d1',type:'diaper',date:y+'T08:00',category:'둘 다',memo:''},{id:'d2',type:'diaper',date:y+'T09:00',category:'소변',memo:''}]);
 const html=await f.open('stats');
 assert.match(html,/<h2 class="section-head">수면<\/h2>/);
 // Two days with sleep: (3h + 6h45m) / 2 → 4시간 52분 (rounded).
 assert.match(html,/하루 평균 수면<\/p><strong>4시간 53분<\/strong>/);
 assert.match(html,/7일 중 가장 긴 잠<\/p><strong>8시간 30분<\/strong>/);
 assert.match(html,new RegExp(`<time datetime="${y}">${y.slice(5)}</time></th><td>6시간 45분</td><td>1회 · 1시간 15분</td><td>1시간 15분</td>`));
 assert.match(html,/<h2 class="section-head">기저귀<\/h2>/);
 assert.match(html,/하루 평균 기저귀<\/p><strong>2\.0회<\/strong>/);
 assert.match(html,/마지막 대변<\/p><strong>[^<]+ 전<\/strong>/);
 assert.match(html,new RegExp(`<time datetime="${y}">${y.slice(5)}</time></th><td>2회</td><td>2</td><td>1</td>`));
});

test('home suggests the other side to start breastfeeding after a timed feed',async()=>{
 const f=family();
 const now=f.b.eval('Somhouse.localDateTime()'),hourAgo=f.b.eval('Somhouse.localDateTime(new Date(Date.now()-3600000))');
 let html=await f.open('home');
 assert.match(html,/<button class="secondary small" data-timer="start" data-side="좌">🤱 왼쪽부터<\/button><button class="secondary small" data-timer="start" data-side="우">오른쪽부터/);
 await f.load('records',[{id:'t',type:'feeding',date:hourAgo,category:'모유',amount:'15분',memo:'직수 타이머 · 좌 8분 · 우 7분',firstSide:'좌',lastSide:'우'}]);
 html=await f.open('home');
 assert.match(html,new RegExp(`지난 직수 ${hourAgo.slice(11)} · 왼쪽→오른쪽 · 이번엔 <b>오른쪽</b>부터`));
 // The suggested side comes first and stands out.
 assert.match(html,/<button class="small" data-timer="start" data-side="우">🤱 오른쪽부터<\/button><button class="secondary small" data-timer="start" data-side="좌">왼쪽부터/);
 // Older than a day: no suggestion.
 assert.equal(f.b.eval(`nextSide('${f.day(2)}T${now.slice(11)}')`),null);
});

test('records to double-check: a double entry and a long stretch with nothing recorded',async()=>{
 const f=family();
 const at=h=>f.b.eval(`Somhouse.localDateTime(new Date(Date.now()-${h}*3600000))`);
 const twinA=at(20),twinB=f.b.eval(`Somhouse.localDateTime(new Date(Date.now()-20*3600000+3*60000))`);
 await f.load('records',[
  {id:'v',type:'feeding',date:twinA,category:'분유',amount:'120ml',memo:'음성'},
  {id:'w',type:'feeding',date:twinB,category:'분유',amount:'120ml',memo:''},
  {id:'x',type:'feeding',date:at(12),category:'분유',amount:'100ml',memo:''},
  {id:'s',type:'sleep',date:at(11),end:at(4),category:'밤잠',memo:''},
  {id:'y',type:'diaper',date:at(3),category:'소변',memo:''}]);
 let html=await f.open('records');
 assert.match(html,/🔎 확인해 볼 기록/);
 assert.match(html,/같은 기록이 두 번 있어요/);
 assert.match(html,/data-check-remove="w"/);
 // 20h → 12h ago has nothing for 8 hours; the sleep covers 11h → 4h ago, so that is not a gap.
 assert.equal((html.match(/동안 기록이 없어요/g)||[]).length,1);
 assert.match(html,/7시간 57분 동안 기록이 없어요/);
 // "둘 다 맞아요" hides it on this device; removing the later one deletes it.
 await f.click({checkOk:f.b.eval("recordChecks().find(x=>x.kind==='gap').key")});
 html=f.b.get('#content').innerHTML;
 assert.doesNotMatch(html,/동안 기록이 없어요/);
 await f.click({checkRemove:'w',checkKey:f.b.eval("recordChecks()[0].key")});
 assert.equal(f.server.data.records.some(x=>x.id==='w'),false);
 assert.doesNotMatch(f.b.get('#content').innerHTML,/확인해 볼 기록/);
});

test('buying again: purchase days are kept and a usual gap suggests the next time',async()=>{
 const f=family();
 const today=f.day(0),d=n=>f.day(n);
 await f.load('shopping',[
  {id:'a',title:'기저귀',quantity:'1팩',done:'yes',boughtAt:[d(-20),d(-11)].join(',')},
  {id:'b',title:' 기저귀 ',quantity:'2팩',done:'yes',boughtAt:d(-2)},
  {id:'c',title:'물티슈',quantity:'1',done:'no',boughtAt:[d(-30),d(-20)].join(',')},
  {id:'e',title:'분유',quantity:'1통',done:'yes',boughtAt:d(-1)}]);
 let html=await f.open('shopping');
 // 기저귀: bought d-20, d-11, d-2 → every 9 days → due d+7, not yet.
 assert.doesNotMatch(html,/곧 살 때예요/);
 assert.deepEqual(JSON.parse(JSON.stringify(f.b.eval(`rebuyList('${d(6)}').map(x=>[x.item.id,x.every,x.due])`))),[['b',9,d(7)]]);
 // 물티슈 is already on the list; 분유 was bought once only.
 html=f.b.eval(`(()=>{const real=rebuyList;rebuyList=()=>real('${d(6)}');const h=rebuyCard();rebuyList=real;return h;})()`);
 assert.match(html,/<strong>기저귀<\/strong> · 2팩<br>보통 9일마다 샀어요 \(3번\)/);
 await f.click({rebuy:'b'});
 assert.equal(f.server.data.shopping.find(x=>x.id==='b').done,'no');
 // ✓ 샀어요 adds today to the purchase days.
 await f.b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset:{action:'toggle',key:'shopping',id:'b'}}}});
 const b=f.server.data.shopping.find(x=>x.id==='b');
 assert.deepEqual([b.done,b.boughtAt],['yes',[d(-2),today].join(',')]);
});

test('the per-feeding amount is shown week by week for 4 weeks',async()=>{
 const f=family();
 const d=n=>f.day(n);
 await f.load('records',[
  {id:'1',type:'feeding',date:d(-22)+'T08:00',category:'분유',amount:'90ml',memo:''},
  {id:'2',type:'feeding',date:d(-21)+'T08:00',category:'분유',amount:'100ml',memo:''},
  {id:'3',type:'feeding',date:d(-3)+'T08:00',category:'분유',amount:'120ml',memo:''},
  {id:'4',type:'feeding',date:d(-1)+'T08:00',category:'분유',amount:'130ml',memo:''},
  {id:'5',type:'feeding',date:d(-1)+'T10:00',category:'모유',amount:'15분',memo:''},
  {id:'6',type:'feeding',date:d(-1)+'T12:00',category:'기타',amount:'조금',memo:''}]);
 const weeks=JSON.parse(f.b.eval('JSON.stringify(amountTrend())'));
 assert.deepEqual(weeks.map(w=>[w.ml,w.mlCount,w.minutes]),[[95,2,null],[null,0,null],[null,0,null],[125,2,15]]);
 const html=await f.open('stats');
 assert.match(html,/1회 평균 수유량 \(주별\)/);
 assert.match(html,new RegExp(`이번 주는 ${Number(d(-27).slice(5,7))}/${Number(d(-27).slice(8))}~${Number(d(-21).slice(5,7))}/${Number(d(-21).slice(8))}보다 30ml 많아요`));
 assert.match(html,/<td>125ml <small>\(2회\)<\/small><\/td><td>15분 <small>\(1회\)<\/small><\/td>/);
});

test('a two-week summary for the pediatrician, with AI questions from the numbers only',async()=>{
 const f=family();
 f.b.context.localStorage.setItem('somhouse-ai-keys-v1',JSON.stringify({'http://127.0.0.1:8787|mom':{antigravity:{key:'AIza'+'c'.repeat(35),model:'gemini-3.8-flash',models:['gemini-3.8-flash']}}}));
 const base=f.b.context.fetch,asked=[];
 f.b.context.fetch=async(url,options)=>{
  if(url.includes(':generateContent')){asked.push(JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).question);return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:'요약: 잘 먹고 있어요.\n물어볼 것:\n- 밤잠이 짧은데 괜찮을까요?'}]}}]})};}
  if(url.endsWith('/api/ai'))return {ok:true,json:async()=>({enabled:false,homeOnly:true,providers:[{id:'antigravity',name:'Antigravity',company:'Google',enabled:false}]})};
  return base(url,options);
 };
 const y=f.day(-1),soon=f.day(3);
 await f.load('records',[
  {id:'a',type:'feeding',date:y+'T08:00',category:'분유',amount:'120ml',memo:'PRIVATE-FEED'},
  {id:'b',type:'feeding',date:y+'T11:00',category:'모유',amount:'15분',memo:''},
  {id:'s',type:'sleep',date:y+'T13:00',end:y+'T14:30',category:'낮잠',memo:''},
  {id:'d',type:'diaper',date:y+'T09:00',category:'둘 다',memo:''},
  {id:'h',type:'hospital',date:f.day(-10)+'T10:00',hospital:'튼튼소아과',reason:'예방접종',memo:'열 37.8도'}]);
 await f.load('schedule',[{id:'v',date:soon+'T10:30',title:'소아과 2차 접종',place:'튼튼소아과',who:'아기',memo:''},{id:'m',date:soon+'T12:00',title:'친구 만남',who:'엄마',memo:''}]);
 let html=await f.open('stats');
 assert.match(html,/data-page="report">🩺 소아과용 2주 요약 보기/);
 html=await f.open('report');
 assert.match(html,/<h1>🩺 소아과용 2주 요약<\/h1>/);
 assert.match(html,/하루 분유<\/p><strong>120ml<\/strong>/);
 assert.match(html,new RegExp(`${Number(y.slice(5,7))}/${Number(y.slice(8))} .</th><td>2회<br><small>120ml</small><br><small>직수 15분</small></td><td>1시간 30분<br><small>최장 1시간 30분</small></td><td>1회<br><small>소1·대1</small></td>`));
 assert.match(html,/튼튼소아과 · 예방접종 <span class="caption">열 37\.8도<\/span>/);
 assert.match(html,/소아과 2차 접종 · 튼튼소아과/);
 assert.doesNotMatch(html,/친구 만남/);
 await f.b.settle();html=f.b.get('#content').innerHTML;
 assert.match(html,/✨ 소아과에 물어볼 것 정리/);
 // Without the switch, hospital notes and record memos stay home.
 await f.click({reportAi:'1'});await f.b.settle();
 assert.doesNotMatch(asked[0],/PRIVATE|37\.8|예방접종/);
 assert.match(asked[0],/"bottle_ml":120/);
 assert.match(f.b.get('#content').innerHTML,/<p class="ai-summary-text">요약: 잘 먹고 있어요\.\n물어볼 것:\n- 밤잠이 짧은데 괜찮을까요\?<\/p>/);
 await f.click({reportMemos:'1'});
 await f.click({reportAi:'1'});await f.b.settle();
 assert.match(asked[1],/"memo":"열 37\.8도"/);
 assert.doesNotMatch(asked[1],/PRIVATE/);
});
