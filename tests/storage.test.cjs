const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browser,family}=require('./helpers/browser.cjs');
test('corrupt legacy source is preserved while shared records remain usable',async()=>{
 const b=browser({raw:'{broken'});await b.login();
 assert.equal(b.local.get('somhouse-v1'),'{broken');assert.equal(b.eval('sharedReady'),true);
 assert.equal(b.calls.filter(x=>x.url.endsWith('/api/merge')).length,0);
 assert.ok(b.get('#connection-status').textContent.includes('원본은 보존'));
});
test('blocked legacy reads never cause a destructive replacement',async()=>{
 const raw=JSON.stringify({records:[],schedule:[],shopping:[{id:'original',title:'원본',quantity:'1'}]});
 const b=browser({raw});b.blockRead();await b.login();
 assert.equal(b.local.get('somhouse-v1'),raw);assert.equal(b.eval('sharedReady'),true);
 assert.equal(b.calls.filter(x=>x.url.endsWith('/api/merge')).length,0);
});
test('shared mutations work even when local storage writes are unavailable',async()=>{
 const b=browser();b.blockWrite();const original=b.local.get('somhouse-v1');await b.login();
 assert.equal(await b.eval("changeItem('shopping',{id:'server',title:'서버 저장',quantity:'1'})"),true);
 assert.equal(b.local.get('somhouse-v1'),original);assert.equal(b.eval('data.shopping[0].id'),'server');
});
test('source links appear for the signed-in family and disappear on logout',async()=>{
 const server=family();
 server.sources={tasks:'https://tasks.google.com/',sheet:'https://docs.google.com/spreadsheets/d/test-sheet/edit',
                 calendar:'https://calendar.google.com/calendar/'};
 const view=browser({server}), links=view.get('#raw-sources');
 assert.equal(links.hidden,true);
 await view.login();
 assert.equal(links.hidden,false);
 assert.match(links.innerHTML,/https:\/\/docs\.google\.com\/spreadsheets\/d\/test-sheet\/edit/);
 assert.match(links.innerHTML,/https:\/\/tasks\.google\.com\//);
 assert.match(links.innerHTML,/https:\/\/calendar\.google\.com\/calendar\//);
 view.eval("showLogin('로그아웃했어요.')");
 assert.equal(links.hidden,true);
 assert.equal(links.innerHTML,'');
});

test('Google failures are visible after polling and cleared on logout',async()=>{
 const server=family();
 server.googleStatus={auth_state:'reconnect_required',review:2,services:{sheets:{pending:3,retrying:1,failed:1,last_success:null}}};
 const b=browser({server});await b.login();
 assert.match(b.get('#google-status').innerHTML,/재연결이 필요/);
 assert.match(b.get('#google-status').innerHTML,/실패 1건/);
 assert.match(b.get('#google-status').innerHTML,/음성·캘린더 입력 2건/);
 server.googleStatus={auth_state:'ready',review:0,services:{}};
 await b.eval('refreshShared(true)');
 assert.doesNotMatch(b.get('#google-status').innerHTML,/재연결이 필요/);
 b.eval("showLogin('로그아웃')");
 assert.equal(b.get('#google-status').hidden,true);
 assert.equal(b.get('#google-status').innerHTML,'');
});

test('feeding statistics render both periods without a manual sync action',async()=>{
 const b=browser();await b.login();
 b.eval("page='stats';render()");
 assert.match(b.get('#content').innerHTML,/최근 7일/);
 assert.equal((b.get('#content').innerHTML.match(/scope="row"/g)||[]).length,7);
 await b.events.get('click')({target:{closest:()=>({dataset:{statsDays:'30'}})}});
 assert.match(b.get('#content').innerHTML,/최근 30일/);
 assert.equal((b.get('#content').innerHTML.match(/scope="row"/g)||[]).length,30);
 assert.doesNotMatch(b.get('#content').innerHTML,/시트 동기화/);
});

test('recent feeding button only prefills the form and never saves by itself',async()=>{
 const server=family();
 server.data.records.push({id:'old',type:'feeding',date:'2026-01-01T09:00',category:'분유',amount:'120ml',memo:''});
 const b=browser({server});await b.login();
 b.eval("page='home';render()");
 assert.match(b.get('#content').innerHTML,/data-repeat-category="분유" data-repeat-amount="120ml"/);
 const writes=()=>b.calls.filter(x=>['PUT','DELETE'].includes(x.options?.method)).length;
 const before=writes();
 await b.events.get('click')({target:{closest:()=>({dataset:{repeatCategory:'분유',repeatAmount:'120ml'}})}});
 assert.equal(b.get('#dialog').open,true);
 assert.equal(b.eval('editing'),null);
 assert.match(b.get('#fields').innerHTML,/<option selected>분유<\/option>/);
 assert.match(b.get('#fields').innerHTML,/name="amount" type="text" value="120ml"/);
 assert.doesNotMatch(b.get('#fields').innerHTML,/value="2026-01-01T09:00"/);
 assert.equal(writes(),before);
});

test('healthy Google status is one folded line and is not rewritten while unchanged',async()=>{
 const server=family();
 server.googleStatus={auth_state:'ready',review:0,errors:[],services:{
  sheets:{pending:0,retrying:0,failed:0,last_success:'2026-11-16T12:03:44'},
  tasks:{pending:1,retrying:0,failed:0,last_success:'2026-11-16T11:00:00'}}};
 const b=browser({server});await b.login();
 const status=b.get('#google-status');
 assert.match(status.innerHTML,/Google 연동 정상<\/strong> · 전송 대기 1건 · 마지막 전송 2026-11-16 12:03/);
 assert.match(status.innerHTML,/<details><summary>자세히 보기<\/summary>/);
 // Simulate the browser reflecting an opened <details>; an unchanged poll must not reset it.
 status.innerHTML=status.innerHTML.replace('<details>','<details open="">');
 await b.eval('refreshShared(true)');
 assert.match(status.innerHTML,/<details open="">/);
 server.googleStatus={...server.googleStatus,services:{sheets:{pending:0,retrying:0,failed:2,last_success:null}}};
 await b.eval('refreshShared(true)');
 assert.match(status.innerHTML,/<strong>Google 연동 상태<\/strong><ul>/);
 assert.match(status.innerHTML,/실패 2건/);
 assert.doesNotMatch(status.innerHTML,/<details/);
});

test('unit-less feedings show no preset and ask before saving',async()=>{
 const server=family();
 server.data.records.push({id:'t1',type:'feeding',date:'2026-01-01T09:00',category:'모유',amount:'2',memo:''});
 const b=browser({server});await b.login();
 b.eval("page='home';render()");
 assert.doesNotMatch(b.get('#content').innerHTML,/data-repeat-category/);
 const asked=[];b.context.confirm=text=>{asked.push(text);return false;};
 b.eval("openForm('feeding')");
 b.get('#form').values={date:'2026-01-02T09:00',category:'모유',amount:'3',memo:''};
 const before=b.calls.length;
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 assert.equal(asked.length,1);assert.match(asked[0],/단위가 없어요/);
 assert.equal(b.calls.length,before);
 b.get('#form').values.amount='60ml';
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 assert.equal(asked.length,1);
 assert.ok(b.server.data.records.some(x=>x.amount==='60ml'));
});

test('review inputs can be saved from a prefilled form or dismissed on the web',async()=>{
 const server=family();
 const entry=(key,title)=>({key,source:'Calendar',title,when:'2026-11-17T07:12',status:'확인 필요',suggest:{category:'기타',amount:'100ml'}});
 server.googleStatus={auth_state:'ready',review:2,errors:[],services:{},review_items:[entry('calendar:a','수유 100미리 병원'),entry('tasks:b','솜하우스 수유 조금')]};
 const b=browser({server});await b.login();
 assert.match(b.get('#google-status').innerHTML,/data-page="review">확인 필요 2건 정리하기/);
 b.eval("page='review';render()");
 const html=b.get('#content').innerHTML;
 assert.match(html,/수유 100미리 병원/);assert.match(html,/data-review-key="tasks:b" data-review-action="dismiss"/);
 const click=dataset=>b.events.get('click')({target:{closest:()=>({dataset})}});
 await click({reviewKey:'calendar:a',reviewAction:'save'});
 assert.equal(b.get('#dialog').open,true);
 assert.match(b.get('#formtitle').textContent,/확인 필요 정정/);
 assert.match(b.get('#fields').innerHTML,/name="date" type="datetime-local" value="2026-11-17T07:12"/);
 assert.match(b.get('#fields').innerHTML,/name="amount" type="text" value="100ml"/);
 assert.match(b.get('#fields').innerHTML,/음성 원문: 수유 100미리 병원/);
 b.get('#form').values={date:'2026-11-17T07:12',category:'분유',amount:'100ml',memo:''};
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 assert.deepEqual(server.reviews.map(x=>[x.key,x.action,x.kind,x.item?.amount]),[['calendar:a','save','records','100ml']]);
 assert.equal(b.eval('data.records.length'),1);
 assert.equal(b.calls.filter(x=>x.options?.method==='PUT').length,0);
 b.get('#dialog').open=false;b.eval("reviewKey=''");
 await click({reviewKey:'tasks:b',reviewAction:'dismiss'});
 assert.deepEqual(server.reviews.at(-1),{key:'tasks:b',action:'dismiss'});
 assert.match(b.get('#content').innerHTML,/확인할 입력이 없어요/);
 // An ordinary add after a review still goes through the normal save path.
 b.eval("openForm('feeding')");
 b.get('#form').values={date:'2026-11-17T09:00',category:'분유',amount:'90ml',memo:''};
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 assert.equal(b.calls.filter(x=>x.options?.method==='PUT').length,1);
});

test('voice and calendar help appears only when the Calendar intake is connected',async()=>{
 const plain=browser();await plain.login();plain.eval("page='home';render()");
 assert.doesNotMatch(plain.get('#content').innerHTML,/voice-help/);
 const server=family();server.sources={calendar:'https://calendar.google.com/calendar/'};
 const b=browser({server});await b.login();b.eval("page='home';render()");
 assert.match(b.get('#content').innerHTML,/<details class="voice-help">/);
 assert.match(b.get('#content').innerHTML,/수유 100ml/);
});

test('unclear feeding kinds are settled with one tap, learned, and can be forgotten',async()=>{
 const server=family();server.sources={calendar:'https://calendar.google.com/calendar/'};
 server.data.records.push(
  {id:'a',type:'feeding',date:'2026-11-17T07:12',category:'기타',amount:'100ml',memo:'음성 원문: 부유 100ml',confirm:'category',heard:'부유'},
  {id:'b',type:'feeding',date:'2026-11-17T09:00',category:'기타',amount:'80ml',memo:'',confirm:'category'},
  {id:'c',type:'feeding',date:'2026-11-17T10:00',category:'분유',amount:'120ml',memo:''});
 const b=browser({server});await b.login();b.eval("page='home';render()");
 let html=b.get('#content').innerHTML;
 assert.match(html,/종류를 골라 주세요 · 2건/);assert.match(html,/들린 말 ‘부유’/);
 assert.match(html,/data-confirm-id="a" data-confirm-category="분유"/);
 assert.doesNotMatch(html,/data-confirm-id="c"/);
 const click=dataset=>b.events.get('click')({target:{closest:()=>({dataset})}});
 await click({confirmId:'a',confirmCategory:'분유'});
 assert.deepEqual(server.confirms,[{id:'a',category:'분유'}]);
 assert.match(b.get('#connection-status').textContent,/‘부유’는 분유로 기억/);
 html=b.get('#content').innerHTML;
 assert.match(html,/종류를 골라 주세요 · 1건/);assert.match(html,/‘부유’→분유 <button class="plain" data-forget="부유">잊기/);
 await click({confirmId:'b',confirmCategory:'주스'});
 assert.equal(server.confirms.length,1);
 await click({confirmId:'b',confirmCategory:'기타'});
 assert.doesNotMatch(b.get('#content').innerHTML,/종류를 골라 주세요/);
 await click({forget:'부유'});
 assert.deepEqual(server.confirms.at(-1),{forget:'부유'});
 assert.doesNotMatch(b.get('#content').innerHTML,/data-forget/);
 // Editing a flagged feeding in the form also counts as checked.
 server.data.records.push({id:'d',type:'feeding',date:'2026-11-17T11:00',category:'기타',amount:'60ml',memo:'',confirm:'category',heard:'머유'});
 await b.eval('refreshShared(true)');
 b.eval("openForm('feeding',data.records.find(x=>x.id==='d'))");
 b.get('#form').values={date:'2026-11-17T11:00',category:'모유',amount:'60ml',memo:''};
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 const saved=server.data.records.find(x=>x.id==='d');
 assert.equal(saved.category,'모유');assert.equal('confirm' in saved,false);assert.equal(saved.heard,'머유');
 assert.match(b.get('#connection-status').textContent,/‘머유’는 모유로 기억/);
 // A wrong pick is fixed by editing again: the remembered word follows the record.
 b.get('#dialog').open=false;
 b.eval("openForm('feeding',data.records.find(x=>x.id==='d'))");
 b.get('#form').values={date:'2026-11-17T11:00',category:'분유',amount:'60ml',memo:''};
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 assert.equal(b.eval('shared.aliases["머유"]'),'분유');
 assert.match(b.get('#connection-status').textContent,/‘머유’는 분유로 기억/);
 // Saving again without changing the kind does not repeat the notice.
 b.get('#dialog').open=false;
 b.eval("openForm('feeding',data.records.find(x=>x.id==='d'))");
 b.get('#form').values={date:'2026-11-17T11:00',category:'분유',amount:'70ml',memo:''};
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 assert.doesNotMatch(b.get('#connection-status').textContent,/기억할게요/);
});

test('review cards explain why an input waits and name their buttons by situation',async()=>{
 const server=family();
 const entry=(key,title,status,suggest)=>({key,source:'Calendar',title,when:'2026-11-17T15:40',status,suggest});
 server.googleStatus={auth_state:'ready',review:3,errors:[],services:{},review_items:[
  entry('calendar:a','뷰유','확인 필요',{category:'분유',amount:''}),
  entry('calendar:b','수유 100미리 병원','확인 필요',{category:'기타',amount:'100ml'}),
  entry('calendar:c','뷰유 10미리','웹 기록 유지',{category:'분유',amount:'10ml'})]};
 const b=browser({server});await b.login();b.eval("page='review';render()");
 const html=b.get('#content').innerHTML;
 assert.doesNotMatch(html,/수유로 저장/);
 assert.match(html,/추정 분유<br>양이 없어서 저장하지 않았어요/);
 assert.match(html,/추정 100ml<br>내용을 확실히 알 수 없어/);
 assert.match(html,/data-review-key="calendar:a" data-review-action="save">내용 확인하고 저장/);
 assert.match(html,/추정 분유 10ml<br>웹에서 고친 기록과 캘린더 일정의 내용이 서로 달라요/);
 assert.match(html,/data-review-key="calendar:c" data-review-action="save">캘린더 내용으로 고치기/);
 assert.match(html,/data-review-key="calendar:c" data-review-action="dismiss">지금 기록 그대로 두기/);
 await b.events.get('click')({target:{closest:()=>({dataset:{reviewKey:'calendar:a',reviewAction:'save'}})}});
 assert.match(b.get('#fields').innerHTML,/<option selected>분유<\/option>/);
 assert.match(b.get('#fields').innerHTML,/name="amount" type="text" value=""/);
});

test('the family calendar sits above the menu and shows feedings, schedules, dated shopping and Google events',async()=>{
 const server=family();const today=new Date();const pad=n=>String(n).padStart(2,'0');
 const key=`${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
 server.data.records.push({id:'a',type:'feeding',date:key+'T00:01',category:'분유',amount:'100ml',memo:'음성 원문: 뷰유'});
 server.data.schedule.push({id:'s1',date:key+'T19:00',title:'저녁 약속',who:'엄마',memo:''},{id:'s2',date:key+'T08:00',title:'소아과',memo:''});
 server.data.shopping.push({id:'p1',title:'기저귀',quantity:'1팩',date:key,done:'no'},{id:'p2',title:'물티슈',quantity:'2개',done:'no'});
 server.calendarEvents=[{id:'g1',date:key+'T18:30',end:key+'T20:00',allDay:false,title:'아빠 회식',link:'https://www.google.com/calendar/event?eid=x'},{id:'g2',date:key,end:key,allDay:true,title:'<b>휴가</b>',link:''}];
 const b=browser({server});await b.login();b.eval("page='home';render()");
 let html=b.get('#content').innerHTML;
 assert.doesNotMatch(html,/cal-grid/);
 for(const label of ['오늘','어제','이번 주','지난주'])assert.match(html,new RegExp(`<p>${label}<span`));
 assert.match(html,/<strong>1회 · 100ml<\/strong>/);
 html=b.get('#dashboard').innerHTML;assert.equal(b.get('#dashboard').hidden,false);
 assert.match(html,new RegExp(`data-cal-day="${key}" aria-label="${key} 수유 1회 일정 2건 구매 1건 구글 2건"`));
 assert.match(html,/🍼1 100<\/span><span class="mark plan">📅2<\/span><span class="mark shop">🛒1<\/span><span class="mark gcal">📆2/);
 assert.doesNotMatch(html,/오늘의 수유<\/h2>/);
 const click=dataset=>b.events.get('click')({target:{closest:()=>({dataset})}});
 await click({calDay:key});
 html=b.get('#dashboard').innerHTML;
 assert.match(html,/📆 Google 캘린더 2건<\/h4><p>18:30 · 아빠 회식 <a href="https:\/\/www.google.com\/calendar\/event\?eid=x"/);
 assert.match(html,/종일 · &lt;b&gt;휴가&lt;\/b&gt;<\/p>/);
 assert.match(html,/📅 일정 2건<\/h4><p>08:00 · 소아과/);
 assert.match(html,/19:00 · <span class="who who-엄마">엄마<\/span> 저녁 약속/);
 assert.match(html,/🍼 수유 1회 · 100ml<\/h4>/);assert.match(html,/🛒 구매 예정 1건<\/h4><p>기저귀 · 1팩/);
 assert.doesNotMatch(html,/물티슈 · 2개 <button/);
 await click({addOn:'schedule'});
 assert.match(b.get('#fields').innerHTML,new RegExp(`name="date" type="datetime-local" value="${key}T09:00"`));
 assert.match(b.get('#fields').innerHTML,/<select name="who" required><option >가족/);
 b.get('#dialog').open=false;
 await click({addOn:'shopping'});
 assert.match(b.get('#fields').innerHTML,new RegExp(`name="date" type="date" value="${key}"`));
 b.get('#dialog').open=false;
 const next=new Date(today.getFullYear(),today.getMonth()+1,1),nextKey=`${next.getFullYear()}-${pad(next.getMonth()+1)}`;
 await click({calMonth:nextKey});
 html=b.get('#dashboard').innerHTML;
 assert.match(html,new RegExp(`${next.getFullYear()}년 ${next.getMonth()+1}월`));assert.match(html,/이번 달로/);assert.doesNotMatch(html,/cal-detail/);
 // The stats page keeps the summary cards and tables, without the calendar.
 b.eval("page='stats';render()");
 assert.match(b.get('#content').innerHTML,/summary-cards/);assert.match(b.get('#dashboard').innerHTML,/cal-grid/);
 // A new shopping item starts without a date; schedule items keep their who.
 b.eval("openForm('shopping')");
 assert.match(b.get('#fields').innerHTML,/name="date" type="date" value=""/);
 b.get('#dialog').open=false;
 b.eval("showLogin('로그아웃')");
 assert.equal(b.get('#dashboard').hidden,true);assert.equal(b.get('#dashboard').innerHTML,'');
 assert.deepEqual(JSON.parse(b.eval('JSON.stringify([shared.calendarEvents,shared.aliases])')),[[],{}]);
});

test('Google links keep the connected account and reject other addresses',async()=>{
 const server=family();
 server.sources={tasks:'https://tasks.google.com/?authuser=ssoomm.project@gmail.com',
  sheet:'https://docs.google.com/spreadsheets/d/abc/edit?authuser=ssoomm.project@gmail.com',
  calendar:'https://calendar.google.com/calendar/r?authuser=ssoomm.project@gmail.com'};
 const b=browser({server});await b.login();
 const html=b.get('#raw-sources').innerHTML;
 assert.match(html,/href="https:\/\/calendar\.google\.com\/calendar\/r\?authuser=ssoomm\.project@gmail\.com"[^>]*>Google 캘린더/);
 assert.match(html,/tasks\.google\.com\/\?authuser=ssoomm/);assert.match(html,/edit\?authuser=ssoomm/);
 server.sources={calendar:'https://calendar.google.com/calendar/r?authuser=x@y.com&next=https://evil.example',tasks:'https://evil.example/',sheet:'https://docs.google.com/spreadsheets/d/abc/edit?x=1'};
 await b.eval('refreshShared(true)');
 assert.equal(b.get('#raw-sources').innerHTML,'');
 server.calendarEvents=[{id:'g',date:'2026-11-17T21:30',end:'2026-11-17T22:30',allDay:false,title:'엄마약속',link:'javascript:alert(1)'}];
 await b.eval('refreshShared(true)');b.eval("calendarDay='2026-11-17';calendarMonth='2026-11';render()");
 assert.match(b.get('#dashboard').innerHTML,/21:30 · 엄마약속<\/p>/);
 b.eval("page='home';render()");
 assert.match(b.get('#content').innerHTML,/<button class="secondary" data-add="feeding">수유 기록<\/button>/);
});

test('home puts recent feedings under their own heading and the voice help after the summaries',async()=>{
 const server=family();server.sources={calendar:'https://calendar.google.com/calendar/r'};
 server.data.records.push({id:'a',type:'feeding',date:'2026-01-01T09:00',category:'분유',amount:'100ml',memo:''});
 const b=browser({server});await b.login();b.eval("page='home';render()");
 const html=b.get('#content').innerHTML;
 assert.match(html,/<section class="repeat" aria-labelledby="repeat-title"><h2 id="repeat-title">최근 수유 다시 기록<\/h2><div class="quick"><button class="secondary" data-repeat-category="분유"/);
 assert.match(html,/<summary>ⓘ 음성·캘린더 입력 도움말 <span class="caption">기억한 말 관리<\/span><\/summary>/);
 assert.ok(html.indexOf('summary-cards')<html.indexOf('voice-help'));
 assert.ok(html.indexOf('repeat-title')<html.indexOf('summary-cards'));
});

test('calendar marks Korean holidays and substitutes, and upcoming mixes Somhouse and Google events',async()=>{
 const server=family();const today=new Date();const pad=n=>String(n).padStart(2,'0');
 const ym=`${today.getFullYear()}-${pad(today.getMonth()+1)}`,day=n=>`${ym}-${pad(n)}`;
 const future=new Date(today.getTime()+3*86400000),fkey=`${future.getFullYear()}-${pad(future.getMonth()+1)}-${pad(future.getDate())}`;
 server.holidays=[{date:day(3),name:'개천절',substitute:false},{date:day(5),name:'개천절',substitute:true}];
 server.calendarEvents=[{id:'g',date:fkey+'T19:00',end:fkey+'T21:00',allDay:false,title:'아빠 저녁',link:'https://www.google.com/calendar/event?eid=a'},
                        {id:'old',date:'2000-01-01T09:00',end:'2000-01-01T10:00',allDay:false,title:'지난 일정',link:''}];
 server.data.schedule.push({id:'s',date:fkey+'T08:00',title:'소아과',who:'엄마',memo:''});
 const b=browser({server});await b.login();b.eval("page='home';render()");
 const board=b.get('#dashboard').innerHTML;
 assert.match(board,new RegExp(`class="cal-day red[^"]*" data-cal-day="${day(3)}" aria-label="[^"]* 개천절"><span class="num">3</span><span class="holiday">개천절</span>`));
 assert.match(board,new RegExp(`data-cal-day="${day(5)}"[^>]*><span class="num">5</span><span class="holiday">대체공휴일\\(개천절\\)</span>`));
 const sunday=[...Array(28).keys()].map(i=>i+1).find(n=>new Date(today.getFullYear(),today.getMonth(),n).getDay()===0);
 assert.match(board,new RegExp(`class="cal-day red[^"]*" data-cal-day="${day(sunday)}"`));
 await b.events.get('click')({target:{closest:()=>({dataset:{calDay:day(5)}})}});
 assert.match(b.get('#dashboard').innerHTML,new RegExp(`<h3>${day(5)} · <span class="holiday-name">대체공휴일\\(개천절\\)</span></h3>`));
 const html=b.get('#content').innerHTML;
 const upcoming=html.slice(html.indexOf('다가오는 일정'),html.indexOf('구매 예정</h2>'));
 assert.ok(upcoming.indexOf('소아과')<upcoming.indexOf('아빠 저녁'));
 assert.match(upcoming,/<strong>아빠 저녁<\/strong> <span class="badge gcal">📆 Google<\/span>/);
 assert.match(upcoming,/Google에서 열기/);assert.doesNotMatch(upcoming,/지난 일정/);
});

test('sleep records are entered, confirmed, totalled and shown on the calendar',async()=>{
 const server=family();const today=new Date();const pad=n=>String(n).padStart(2,'0');
 const key=`${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
 server.data.records.push({id:'n',type:'sleep',date:key+'T00:10',end:key+'T01:40',category:'밤잠',memo:''},
  {id:'g',type:'sleep',date:key+'T00:30',end:'',category:'밤잠',memo:'',confirm:'category'});
 const b=browser({server});await b.login();b.eval("page='home';render()");
 let html=b.get('#content').innerHTML;
 assert.match(html,/data-add="sleep">수면<\/button>/);
 assert.match(html,/😴 [0-9-]+ 00:30 · 깬 시각 미입력<\/strong> · 시각으로 추정: 밤잠/);
 assert.match(html,/data-confirm-id="g" data-confirm-category="낮잠">낮잠/);
 assert.match(html,/<span class="sleep-line">😴 2회 · 1시간 30분<\/span>/);
 assert.match(b.get('#dashboard').innerHTML,/<span class="mark sleep">😴1h 30m<\/span>/);
 const click=dataset=>b.events.get('click')({target:{closest:()=>({dataset})}});
 await click({confirmId:'g',confirmCategory:'낮잠'});
 assert.deepEqual(server.confirms.at(-1),{id:'g',category:'낮잠'});
 await click({calDay:key});
 assert.match(b.get('#dashboard').innerHTML,/😴 수면 2회<\/h4><p>밤잠 · 00:10~01:40 \(1시간 30분\)/);
 await click({add:'sleep'});
 assert.match(b.get('#formtitle').textContent,/수면 기록/);
 assert.match(b.get('#fields').innerHTML,/<select name="category" required><option >낮잠<\/option><option >밤잠/);
 b.get('#form').values={date:key+'T13:00',end:key+'T13:45',category:'낮잠',memo:''};
 await b.get('#form').onsubmit({preventDefault(){},target:b.get('#form')});
 const saved=server.data.records.find(x=>x.date===key+'T13:00');
 assert.deepEqual([saved.type,saved.category,saved.end],['sleep','낮잠',key+'T13:45']);
 b.eval("page='records';render()");
 assert.match(b.get('#content').innerHTML,/수면 · 낮잠 · 13:00~13:45 \(45분\)/);
 assert.match(b.get('#content').innerHTML,/<option value="sleep" >수면<\/option>/);
});

test('one record of an unknown type still blocks a broken payload, but every known type loads',async()=>{
 const server=family();
 server.data.records.push({id:'s',type:'sleep',date:'2026-11-17T13:00',end:'',category:'낮잠',memo:''},
  {id:'f',type:'feeding',date:'2026-11-17T09:00',category:'분유',amount:'100ml',memo:''},
  {id:'h',type:'hospital',date:'2026-11-17T10:00',hospital:'솜소아과',reason:'접종',memo:''});
 const b=browser({server});await b.login();
 assert.equal(b.eval('sharedReady'),true);assert.equal(b.eval('data.records.length'),3);
 assert.equal(b.eval("valid({records:[{id:'x',type:'nap',date:'d'}],schedule:[],shopping:[]})"),false);
 assert.equal(b.eval("valid({records:[{id:'x',type:'sleep',date:'d'}],schedule:[],shopping:[]})"),false);
});
