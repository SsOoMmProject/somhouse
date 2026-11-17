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
 assert.match(b.get('#google-status').innerHTML,/음성 기록 2건/);
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
 assert.match(b.get('#content').innerHTML,/확인할 음성 입력이 없어요/);
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
