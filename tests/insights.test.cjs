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
