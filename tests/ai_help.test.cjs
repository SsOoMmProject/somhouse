const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browser,blank}=require('./helpers/browser.cjs');
const providers=connected=>[
 {id:'codex',name:'Codex',company:'OpenAI',enabled:connected.includes('codex'),model:null,recordSummaries:false},
 {id:'claude',name:'Claude',company:'Anthropic',enabled:connected.includes('claude'),model:'sonnet',recordSummaries:false},
 {id:'antigravity',name:'Antigravity',company:'Google',enabled:connected.includes('antigravity'),model:null,recordSummaries:false},
];
const GEMINI='https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';
// A family with a Gemini key on this phone; `reply` is what Gemini answers, `mac` what the Mac's AI answers.
function family({reply='{"items":[]}',mac=null,connected=[],key=true,readOnly=false,googleStatus}={}){
 const server={data:blank(),imported:new Set(),failure:null,readGate:null,readOnly,googleStatus};
 const b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'mom'},server});
 if(key)b.context.localStorage.setItem('somhouse-ai-keys-v1',JSON.stringify({'http://127.0.0.1:8787|mom':{antigravity:{key:'AIza'+'c'.repeat(35),model:'gemini-3.8-flash',models:['gemini-3.8-flash']}}}));
 const base=b.context.fetch,asked=[];
 b.context.fetch=async(url,options)=>{
  if(url===GEMINI){asked.push(JSON.parse(options.body));return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:typeof reply==='function'?reply():reply}]}}]})};}
  if(url.endsWith('/api/ai')){
   if(options.method==='GET')return {ok:true,json:async()=>({enabled:connected.length>0,homeOnly:!connected.length,providers:providers(connected)})};
   asked.push(JSON.parse(options.body));return {ok:true,json:async()=>({answer:mac})};
  }
  return base(url,options);
 };
 const open=async page=>{await b.settle();b.context.location.hash='#'+page;b.events.get('hashchange')();await b.settle();await b.settle();};
 const click=dataset=>b.events.get('click')({target:{closest:sel=>sel==='a'?null:{dataset}}});
 const type=(k,value)=>b.events.get('input')({target:{dataset:{aiInput:k},value}});
 return {b,asked,open,click,type,html:()=>b.get('#content').innerHTML};
}

test('a sentence becomes records to check; only complete ones save at once',async()=>{
 const f=family({reply:'```json\n'+JSON.stringify({items:[
  {type:'feeding',date:'2000-01-01T03:00',category:'분유',amount:'120',memo:''},
  {type:'sleep',date:'2000-01-01T04:00',end:'',category:'밤잠',memo:''},
  {type:'diaper',date:'2000-01-01T04:10',category:'설사',memo:''},
  {type:'weather',date:'2000-01-01T04:10'},
 ]})+'\n```'});
 await f.open('records');
 assert.match(f.html(),/✨ 한 줄로 기록하기/);
 assert.match(f.html(),/Gemini가 정리하면 확인하고 저장해요/);
 f.type('records','새벽 3시 분유 120 먹고 4시에 잠, 기저귀 갈았어');
 await f.click({aiRun:'records'});await f.b.settle();
 // The prompt carries the time now and the sentence; nothing else from the family.
 const prompt=JSON.parse(f.asked[0].contents.at(-1).parts[0].text).question;
 assert.match(prompt,/지금은 \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.요일\)/);
 assert.match(prompt,/문장: 새벽 3시 분유 120 먹고 4시에 잠, 기저귀 갈았어$/);
 assert.ok(prompt.length<2000);
 const html=f.html();
 assert.match(html,/🍼 분유 · 120ml/);
 assert.match(html,/😴 수면 · 밤잠/);
 assert.match(html,/종류를 골라 주세요/);
 assert.doesNotMatch(html,/weather/);
 assert.match(html,/data-ai-save="records">2건 저장/);
 await f.click({aiSave:'records'});await f.b.settle();
 const saved=f.b.server.data.records;
 assert.deepEqual(saved.map(x=>[x.type,x.date,x.category,x.amount||'']).sort(),[['feeding','2000-01-01T03:00','분유','120ml'],['sleep','2000-01-01T04:00','밤잠','']]);
 assert.match(f.html(),/2건 저장했어요\. 남은 항목은 고쳐서 저장해 주세요/);
 // The unsure diaper opens the form to fix.
 await f.click({aiEdit:'records:0'});
 assert.equal(f.b.get('#dialog').open,true);
 assert.match(f.b.get('#formtitle').textContent,/기저귀/);
 assert.doesNotMatch(f.html(),/data-ai-save/);
});

test('unsure times and future times must be fixed before saving',()=>{
 const f=family();
 const items=f.b.eval(`aiRecordItems({items:[
  {type:'feeding',date:'어제쯤',category:'모유',amount:'15'},
  {type:'feeding',date:'2026-11-21T23:00',category:'분유',amount:'90ml'},
  {type:'hospital',date:'2026-11-21T09:00',hospital:'소아과',reason:''},
  {type:'sleep',date:'2026-11-21T09:00',end:'2026-11-21T08:00',category:'꿀잠'},
 ]},'2026-11-21T10:00')`);
 const plain=JSON.parse(JSON.stringify(items));
 assert.deepEqual(plain.map(x=>x.problems),[['시각을 확인해 주세요'],['지금보다 늦은 시각이에요'],['병원과 방문 이유를 채워 주세요'],[]]);
 assert.equal(items[0].record.amount,'15분');
 assert.equal(items[0].record.date,'2026-11-21T10:00');
 // A wake time before the start is dropped; an unknown sleep kind follows the hour.
 assert.deepEqual([items[3].record.end,items[3].record.category],['','낮잠']);
 assert.equal(f.b.eval(`aiRecordItems(null,'2026-11-21T10:00').length`),0);
 assert.throws(()=>f.b.eval(`aiJSON('잘 모르겠어요')`),/읽지 못했어요/);
});

test('the cards stay hidden without an AI, for guests, and on the shopping list',async()=>{
 let f=family({key:false});
 await f.open('records');
 assert.doesNotMatch(f.html(),/한 줄로 기록하기/);
 f=family();
 await f.open('shopping');
 assert.doesNotMatch(f.html(),/ai-help/);
 f=family({readOnly:true});
 await f.open('records');
 assert.doesNotMatch(f.html(),/한 줄로 기록하기/);
});

test('the typed sentence survives a refresh from another phone',async()=>{
 const f=family();
 await f.open('records');
 f.type('records','분유 100');
 f.b.server.data.records.push({id:'other',type:'diaper',date:'2026-11-21T09:00',category:'소변',memo:''});
 await f.b.eval('refreshShared(true)');
 assert.match(f.html(),/>분유 100<\/textarea>/);
});

test('the Mac answers for the original family when no key is on this phone',async()=>{
 const f=family({key:false,connected:['claude'],mac:JSON.stringify({items:[{type:'diaper',date:'2000-01-01T09:00',category:'대변',memo:''}]})});
 await f.open('records');
 assert.match(f.html(),/Claude가 정리하면/);
 f.type('records','9시 응가');
 await f.click({aiRun:'records'});await f.b.settle();
 assert.deepEqual(Object.keys(f.asked[0]).sort(),['provider','question','scope']);
 assert.equal(f.asked[0].scope,'none');
 assert.match(f.html(),/💩 기저귀 · 대변/);
});

test('a review item the rules could not read opens the form with the AI reading',async()=>{
 const f=family({reply:JSON.stringify({items:[{type:'feeding',date:'2026-11-21T07:30',category:'분유',amount:'90',memo:''}]}),
  googleStatus:{review:1,review_items:[{key:'k1',title:'아침에 분유 구십',when:'2026-11-21T07:30',source:'Calendar',status:'확인 필요',suggest:{}}]}});
 await f.open('review');
 assert.match(f.html(),/data-ai-review="k1">✨ AI로 해석/);
 await f.click({aiReview:'k1'});await f.b.settle();
 assert.match(JSON.parse(f.asked[0].contents[0].parts[0].text).question,/지금은 2026-11-21 07:30/);
 assert.equal(f.b.get('#dialog').open,true);
 assert.match(f.b.get('#formtitle').textContent,/확인 필요 정정 · 수유 기록/);
 assert.match(f.b.get('#fields').innerHTML,/value="90"/);
 assert.match(f.b.get('#fields').innerHTML,/음성 원문: 아침에 분유 구십/);
});

test('a sentence or a photo becomes schedule entries to check',async()=>{
 const f=family({reply:JSON.stringify({items:[
  {date:'2099-12-01T10:30',title:'소아과 예방접종',place:'튼튼소아과',who:'아기',memo:'수첩 챙기기',time_unknown:false},
  {date:'2099-12-03T09:00',title:'문화센터',place:'',who:'이웃집',memo:'',time_unknown:true},
  {date:'',title:'',place:'',who:'',memo:''},
 ]})});
 f.b.context.FileReader=class{readAsDataURL(){this.result='data:image/jpeg;base64,UEhPVE8=';this.onload();}};
 await f.open('schedule');
 assert.match(f.html(),/✨ 문장이나 사진으로 일정 만들기/);
 assert.match(f.html(),/data-ai-image="schedule"/);
 await f.b.events.get('change')({target:{dataset:{aiImage:'schedule'},files:[{type:'image/jpeg',name:'예약.jpg',size:1000}]}});
 assert.match(f.html(),/<span class="badge">예약\.jpg<\/span>/);
 f.type('schedule','다음 주 화요일 예방접종');
 await f.click({aiRun:'schedule'});await f.b.settle();
 const parts=f.asked[0].contents.at(-1).parts;
 assert.deepEqual(parts[0],{inlineData:{mimeType:'image/jpeg',data:'UEhPVE8='}});
 assert.match(JSON.parse(parts[1].text).question,/사진과 문장에서 가족 일정을 찾아/);
 const html=f.html();
 assert.match(html,/소아과 예방접종 · 튼튼소아과/);
 // An unknown "who" becomes 가족; an unknown time is a note, not a blocker; an empty entry must be fixed.
 assert.match(html,/who-가족">가족<\/span> 문화센터/);
 assert.match(html,/시각을 몰라 09:00으로 넣었어요/);
 assert.match(html,/일정 이름을 입력해 주세요/);
 await f.click({aiSave:'schedule'});await f.b.settle();
 assert.deepEqual(f.b.server.data.schedule.map(x=>[x.date,x.title,x.who]).sort(),[['2099-12-01T10:30','소아과 예방접종','아기'],['2099-12-03T09:00','문화센터','가족']]);
 assert.equal(f.b.server.data.schedule[0].type,undefined);
 // The photo stays until every entry is handled.
 assert.match(f.html(),/예약\.jpg/);
 await f.click({aiDrop:'schedule:0'});
 assert.doesNotMatch(f.html(),/data-ai-cancel/);
});

test('only an own-key AI is offered photos; the Mac gets text only',async()=>{
 const f=family({key:false,connected:['claude'],mac:JSON.stringify({items:[]})});
 await f.open('schedule');
 assert.doesNotMatch(f.html(),/data-ai-image/);
 assert.match(f.html(),/사진은 내 API 키로 연결한 AI만 읽을 수 있어요/);
 f.b.eval("aiHelp.schedule.image={mime:'image/jpeg',data:'x',name:'a.jpg'}");
 await f.click({aiRun:'schedule'});await f.b.settle();
 assert.equal(f.asked.length,0);
 assert.match(f.html(),/사진은 AI 탭에서 내 API 키로 연결한 AI만 읽을 수 있어요/);
 f.b.eval("aiHelp.schedule.image=null");
 f.type('schedule','내일 3시 미용실');
 await f.click({aiRun:'schedule'});await f.b.settle();
 assert.match(f.html(),/일정으로 바꿀 내용을 찾지 못했어요/);
});

test('the weekly summary sends only the numbers the app computed',async()=>{
 const f=family({reply:'수유는 하루 2회로 지난주보다 늘었어요.\n수면은 비슷해요.\n기저귀는 기록이 적어요.'});
 const day=n=>f.b.eval(`Somhouse.addDays(Somhouse.localDateTime().slice(0,10),${n})`);
 f.b.server.data.records.push(
  {id:'a',type:'feeding',date:day(-1)+'T08:00',category:'분유',amount:'100ml',memo:'PRIVATE'},
  {id:'b',type:'feeding',date:day(-2)+'T08:00',category:'모유',amount:'14분',memo:''},
  {id:'c',type:'feeding',date:day(-9)+'T08:00',category:'분유',amount:'70ml',memo:''},
  {id:'d',type:'sleep',date:day(-3)+'T13:00',end:day(-3)+'T14:24',category:'낮잠',memo:''},
  {id:'e',type:'diaper',date:day(-1)+'T09:00',category:'둘 다',memo:''},
  {id:'today',type:'feeding',date:day(0)+'T00:01',category:'분유',amount:'999ml',memo:''});
 await f.b.settle();await f.b.eval('refreshShared(true)');
 await f.open('stats');
 assert.match(f.html(),/✨ AI 주간 요약/);
 await f.click({aiSummary:'1'});await f.b.settle();
 const question=JSON.parse(f.asked[0].contents[0].parts[0].text).question;
 const numbers=JSON.parse(question.slice(question.indexOf('숫자: ')+4));
 assert.deepEqual(numbers.this_week,{from:day(-7),to:day(-1),days_with_records:3,feedings_per_day:0.3,measured_ml_per_day:14.3,breastfeeding_minutes_per_day:2,sleep_hours_per_day:0.2,diapers_per_day:0.1,poo_per_day:0.1});
 assert.equal(numbers.last_week.measured_ml_per_day,10);
 // Today's partial day and record text never go.
 assert.doesNotMatch(question,/PRIVATE|999/);
 assert.match(f.html(),/<p class="ai-summary-text">수유는 하루 2회로 지난주보다 늘었어요\.\n수면은 비슷해요\./);
 assert.match(f.html(),/Gemini · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
 assert.match(f.html(),/다시 요약/);
});

test('the summary waits for some records',async()=>{
 const f=family();
 await f.open('stats');
 await f.click({aiSummary:'1'});await f.b.settle();
 assert.equal(f.asked.length,0);
 assert.match(f.html(),/요약할 기록이 아직 없어요/);
});

test('a stats button opens the AI tab with that summary chosen',async()=>{
 const f=family({reply:'답'});
 const day=f.b.eval('Somhouse.localDateTime().slice(0,10)');
 await f.b.settle();
 f.b.server.data.records.push({id:'s',type:'sleep',date:day+'T00:10',end:day+'T01:10',category:'밤잠',memo:'PRIVATE'});
 await f.b.eval('refreshShared(true)');
 await f.open('stats');
 assert.match(f.html(),/data-ai-ask-scope="sleep">😴 수면 기록으로 묻기/);
 await f.click({aiAskScope:'sleep'});
 assert.equal(f.b.context.location.hash,'ai');
 f.b.context.location.hash='#ai';f.b.events.get('hashchange')();await f.b.settle();await f.b.settle();
 assert.equal(f.b.get('#ai-scope').value,'sleep');
 const form=f.b.get('#ai-form');form.values={question:'잠은 충분해?',scope:f.b.get('#ai-scope').value};
 await form.onsubmit({preventDefault(){},target:form});
 const sent=JSON.parse(f.asked.at(-1).contents.at(-1).parts[0].text);
 assert.equal(sent.records.scope,'sleep');
 assert.deepEqual(sent.records.summary[day],{count:1,minutes:60});
 assert.doesNotMatch(JSON.stringify(sent),/PRIVATE/);
});
